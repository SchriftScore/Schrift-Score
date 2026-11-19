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
Deno.serve(async (req: Request) => {
  const origin = req.headers.get("Origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(origin) });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405, origin);
  try {
    const user = await currentUser(req);
    const existing = await adminRpc("schrift_get_subscription", { p_user_id: user.id });
    if (!existing?.stripe_customer_id) return json({ error: "No billing profile exists yet for this account." }, 404, origin);
    const form = new URLSearchParams();
    form.set("customer", existing.stripe_customer_id);
    form.set("return_url", "https://nbaschriftscore.com/account.html");
    const session = await stripeRequest("billing_portal/sessions", form);
    return json({ url: session.url }, 200, origin);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to open subscription management." }, 400, origin);
  }
});