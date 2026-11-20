const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY") || "";

const allowedOrigin = (origin: string | null) => {
  if (!origin) return "https://nbaschriftscore.com";
  try {
    const host = new URL(origin).hostname;
    if (host === "nbaschriftscore.com" || host.endsWith(".nbaschriftscore.com") || host.endsWith(".vercel.app") || host === "localhost") return origin;
  } catch (_) {}
  return "https://nbaschriftscore.com";
};
const corsHeaders = (origin: string | null) => ({
  "Access-Control-Allow-Origin": allowedOrigin(origin),
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin"
});
function json(data: unknown, status = 200, origin: string | null = null) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } });
}
async function currentUser(req: Request) {
  const auth = req.headers.get("Authorization");
  if (!auth) throw new Error("Sign in to your Schrift Score account first.");
  const response = await fetch(SUPABASE_URL + "/auth/v1/user", {
    headers: { apikey: SERVICE_KEY, Authorization: auth }
  });
  if (!response.ok) throw new Error("Your session expired. Sign in again.");
  return await response.json();
}
async function confirmedAccountUser(userId: string) {
  const response = await fetch(SUPABASE_URL + "/auth/v1/admin/users/" + encodeURIComponent(userId), {
    headers: { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY }
  });
  if (!response.ok) throw new Error("Unable to verify your account email status.");
  return await response.json();
}
async function adminRpc(name: string, body: Record<string, unknown>) {
  const response = await fetch(SUPABASE_URL + "/rest/v1/rpc/" + name, {
    method: "POST",
    headers: { apikey: SERVICE_KEY, Authorization: "Bearer " + SERVICE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  if (!response.ok) throw new Error("Subscription database request failed: " + text.slice(0, 300));
  return text ? JSON.parse(text) : null;
}
async function stripeRequest(path: string, params?: URLSearchParams, method = "POST") {
  if (!STRIPE_SECRET_KEY) throw new Error("Stripe is not connected to the Schrift Score billing functions yet.");
  const response = await fetch("https://api.stripe.com/v1/" + path, {
    method,
    headers: {
      Authorization: "Bearer " + STRIPE_SECRET_KEY,
      ...(params ? { "Content-Type": "application/x-www-form-urlencoded" } : {})
    },
    body: params ? params.toString() : undefined
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || "Stripe request failed.");
  return data;
}
const PRICE_IDS: Record<string, string> = {
  monthly: "price_1UVk6t3r3nrIy3GuhkxbJigF",
  annual: "price_1UVkGE3r3nrIy3GuawJVUFLR"
};
Deno.serve(async (req: Request) => {
  const origin = req.headers.get("Origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(origin) });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405, origin);
  try {
    const user = await currentUser(req);
    const verifiedUser = await confirmedAccountUser(user.id);
    if (!verifiedUser.email || !verifiedUser.email_confirmed_at) return json({ error: "Confirm your email address before subscribing." }, 403, origin);
    const body = await req.json().catch(() => ({}));
    const plan = body?.plan === "annual" ? "annual" : body?.plan === "monthly" ? "monthly" : null;
    if (!plan) return json({ error: "Choose a valid Schrift Score Plus plan." }, 400, origin);
    const existing = await adminRpc("schrift_get_subscription", { p_user_id: user.id });
    if (existing && ["active", "trialing", "past_due", "unpaid"].includes(existing.status)) {
      return json({ error: "You already have a subscription record. Use Manage Subscription to update your billing." }, 409, origin);
    }
    const form = new URLSearchParams();
    form.set("mode", "subscription");
    form.set("line_items[0][price]", PRICE_IDS[plan]);
    form.set("line_items[0][quantity]", "1");
    form.set("client_reference_id", user.id);
    form.set("metadata[supabase_user_id]", user.id);
    form.set("subscription_data[metadata][supabase_user_id]", user.id);
    form.set("success_url", allowedOrigin(origin) + "/account.html?checkout=success");
    form.set("cancel_url", allowedOrigin(origin) + "/account.html?checkout=cancelled");
    if (existing?.stripe_customer_id) form.set("customer", existing.stripe_customer_id);
    else form.set("customer_email", verifiedUser.email);
    const session = await stripeRequest("checkout/sessions", form);
    return json({ url: session.url }, 200, origin);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to start checkout." }, 400, origin);
  }
});