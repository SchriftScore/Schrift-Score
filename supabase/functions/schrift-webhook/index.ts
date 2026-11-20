const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY") || "";
const WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET") || "";

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
async function stripeGetSubscription(id: string) {
  if (!STRIPE_SECRET_KEY) throw new Error("Stripe secret key is not configured.");
  const response = await fetch("https://api.stripe.com/v1/subscriptions/" + encodeURIComponent(id), {
    headers: { Authorization: "Bearer " + STRIPE_SECRET_KEY }
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || "Could not retrieve the Stripe subscription.");
  return data;
}
function equalBytes(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
async function verifySignature(raw: string, header: string) {
  if (!WEBHOOK_SECRET) throw new Error("Stripe webhook signing secret is not configured.");
  const parts = header.split(",").map(x => x.trim());
  const timestamp = parts.find(x => x.startsWith("t="))?.slice(2);
  const signatures = parts.filter(x => x.startsWith("v1=")).map(x => x.slice(3));
  if (!timestamp || !signatures.length || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(timestamp + "." + raw)));
  return signatures.some(sig => {
    if (!/^[0-9a-f]{64}$/i.test(sig)) return false;
    const supplied = new Uint8Array(sig.match(/.{2}/g)!.map(v => parseInt(v, 16)));
    return equalBytes(digest, supplied);
  });
}
async function saveSubscription(sub: any, userId: string | null) {
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer?.id;
  let resolvedUser = userId || sub.metadata?.supabase_user_id || null;
  if (!resolvedUser && customerId) resolvedUser = await adminRpc("schrift_find_user_by_customer", { p_customer_id: customerId });
  if (!resolvedUser) throw new Error("Could not match the Stripe subscription to a Schrift Score account.");
  const firstItem = sub.items?.data?.[0];
  const periodEnd = sub.current_period_end || firstItem?.current_period_end || null;
  const status = ["active","trialing","past_due","canceled","unpaid","incomplete","incomplete_expired","paused"].includes(sub.status) ? sub.status : "inactive";
  await adminRpc("schrift_upsert_subscription", {
    p_user_id: resolvedUser,
    p_customer_id: customerId,
    p_subscription_id: sub.id,
    p_price_id: firstItem?.price?.id || null,
    p_status: status,
    p_current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
    p_cancel_at_period_end: !!sub.cancel_at_period_end
  });
}
Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  try {
    const raw = await req.text();
    const signature = req.headers.get("Stripe-Signature") || "";
    if (!(await verifySignature(raw, signature))) return new Response("Invalid signature", { status: 400 });
    const event = JSON.parse(raw);
    const object = event.data?.object || {};
    if (
      event.type === "checkout.session.completed" ||
      event.type === "checkout.session.async_payment_succeeded" ||
      event.type === "checkout.session.async_payment_failed"
    ) {
      const subscriptionId = typeof object.subscription === "string" ? object.subscription : object.subscription?.id;
      // A completed Checkout Session can still be unpaid when a delayed payment method is used.
      // Wait for the asynchronous success/failure event before syncing subscription state.
      if (subscriptionId && !(event.type === "checkout.session.completed" && object.payment_status === "unpaid")) {
        const sub = await stripeGetSubscription(subscriptionId);
        await saveSubscription(sub, object.metadata?.supabase_user_id || object.client_reference_id || null);
      }
    } else if (event.type?.startsWith("customer.subscription.")) {
      let latest = object;
      try { latest = await stripeGetSubscription(object.id); }
      catch (error) { if (event.type !== "customer.subscription.deleted") throw error; }
      await saveSubscription(latest, latest.metadata?.supabase_user_id || object.metadata?.supabase_user_id || null);
    } else if (event.type === "invoice.paid" || event.type === "invoice.payment_failed") {
      const subscriptionId = object.subscription || object.parent?.subscription_details?.subscription;
      const id = typeof subscriptionId === "string" ? subscriptionId : subscriptionId?.id;
      if (id) {
        const sub = await stripeGetSubscription(id);
        await saveSubscription(sub, sub.metadata?.supabase_user_id || null);
      }
    }
    await adminRpc("schrift_record_stripe_event", { p_event_id: event.id, p_event_type: event.type });
    return new Response(JSON.stringify({ received: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (error) {
    return new Response(error instanceof Error ? error.message : "Webhook processing failed.", { status: 500 });
  }
});