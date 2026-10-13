// Request handlers for the three payment endpoints. They take a standard Request and
// return a standard Response, with Stripe, env and fetch passed in so they can be tested
// without a real Stripe account. The files in netlify/functions wire them up.

import Stripe from "stripe";
import { ConfigError, TIERS, mainSiteUrl, priceIdForTier, requireEnv, siteOrigin, supportEmail } from "./config.mjs";
import { LicenceError, licenceFromSession } from "./licence.mjs";
import { sendLicenceEmail } from "./email.mjs";

export function stripeFromEnv(env) {
  // No apiVersion: the SDK uses the version it was built for (managed_payments is GA from 2026-04-22.dahlia).
  if (env.STRIPE_SECRET_KEY && env.STRIPE_SECRET_KEY.trim()) return new Stripe(env.STRIPE_SECRET_KEY.trim());
  // Without a key, hand back a stand-in that throws a ConfigError when used, so each handler
  // shows its own friendly error instead of the function crashing before it starts.
  const fail = () => { throw new ConfigError("Missing environment variable STRIPE_SECRET_KEY"); };
  const stub = new Proxy(function () {}, { get: () => stub, apply: fail });
  return stub;
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function redirect(location) {
  return new Response(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store" } });
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Shown if Stripe refuses to create a session. The main site is in Framer, which can't read
// a ?checkout=error flag, so the message lives here instead.
function checkoutErrorPage(pricingUrl, support) {
  const contact = support ? ` If it keeps happening, email <a href="mailto:${escapeHtml(support)}">${escapeHtml(support)}</a>.` : "";
  const html = `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Checkout couldn't start — Unflat</title>
<style>:root{--ink:#14151A;--paper:#F4F2EE;--card:#fff;--muted:#5B5E66;--border:#E4E1DB}@media (prefers-color-scheme:dark){:root{--ink:#F4F2EE;--paper:#14151A;--card:#1E1F25;--muted:#A9ABB2;--border:#34363E}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--paper);color:var(--ink);font:400 16px/1.5 Inter,system-ui,sans-serif;padding:16px}main{max-width:440px;background:var(--card);border:1px solid var(--border);border-radius:16px;padding:32px}h1{font-size:24px;letter-spacing:-0.02em;margin:0 0 8px}p{color:var(--muted);margin:0 0 24px}a{color:var(--ink)}a.btn{display:inline-flex;align-items:center;height:44px;padding:0 20px;border-radius:8px;background:#FF5A36;color:#14151A;font-weight:700;text-decoration:none}:focus-visible{outline:2px solid var(--ink);outline-offset:2px}</style></head>
<body><main><h1>Checkout couldn't start</h1><p>Nothing was charged. Please try again in a moment.${contact}</p><a class="btn" href="${escapeHtml(pricingUrl)}">Back to pricing</a></main></body></html>`;
  return new Response(html, { status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

// GET /  →  the main website. This Netlify site only hosts checkout and the thank-you page.
// Until SITE_URL points somewhere else, show a holding page rather than redirecting to itself.
export function handleHome(request, { env }) {
  const target = mainSiteUrl(env, request);
  if (env.SITE_URL && new URL(target).origin !== new URL(request.url).origin) {
    return new Response(null, { status: 302, headers: { Location: `${target}/`, "Cache-Control": "no-store" } });
  }
  const html = `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Unflat checkout</title>
<style>:root{--ink:#14151A;--paper:#F4F2EE;--muted:#5B5E66}@media (prefers-color-scheme:dark){:root{--ink:#F4F2EE;--paper:#14151A;--muted:#A9ABB2}}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--paper);color:var(--ink);font:400 16px/1.5 Inter,system-ui,sans-serif;padding:16px;text-align:center}h1{font-size:22px;letter-spacing:-0.02em;margin:12px 0 4px}p{color:var(--muted);margin:0}.o{stroke:var(--ink)}</style></head>
<body><main><svg width="32" height="32" viewBox="0 0 24 24" aria-hidden="true"><rect class="o" x="2" y="9" width="13" height="13" rx="3" fill="none" stroke-width="2"></rect><rect x="9" y="2" width="13" height="13" rx="3" fill="#FF5A36"></rect></svg><h1>Unflat checkout</h1><p>This address handles payments for the Unflat Figma plugin.</p></main></body></html>`;
  return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

// Retrieves a session with its line items, so the tier can be read from the price ID.
async function fetchSession(stripe, sessionId) {
  return stripe.checkout.sessions.retrieve(sessionId, { expand: ["line_items"] });
}

// GET /api/checkout?tier=personal|studio  →  303 to Stripe-hosted Checkout
export async function handleCheckout(request, { stripe, env }) {
  if (request.method !== "GET" && request.method !== "POST") return json(405, { error: "method_not_allowed" });
  const tier = new URL(request.url).searchParams.get("tier");
  if (!Object.hasOwn(TIERS, tier)) return json(400, { error: "unknown_tier", message: "tier must be personal or studio" });

  const origin = siteOrigin(env, request);
  try {
    const session = await stripe.checkout.sessions.create({
      ui_mode: "hosted_page",
      mode: "payment",
      line_items: [{ price: priceIdForTier(env, tier), quantity: 1 }],
      // Stripe is merchant of record and calculates VAT/sales tax. Don't send automatic_tax,
      // tax_id_collection, payment_method_types or invoice_creation alongside this.
      managed_payments: { enabled: true },
      billing_address_collection: "auto",
      phone_number_collection: { enabled: false },
      allow_promotion_codes: false,
      submit_type: "auto",
      integration_identifier: "hosted_web_0001",
      origin_context: "web",
      metadata: { product: "unflat", tier },
      success_url: `${origin}/thanks?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${mainSiteUrl(env, request)}/#pricing`,
    });
    return redirect(session.url);
  } catch (err) {
    console.error("checkout: could not create session", err?.type || "", err?.message || err);
    return checkoutErrorPage(`${mainSiteUrl(env, request)}/#pricing`, supportEmail(env));
  }
}

// GET /api/licence?session_id=cs_...  →  { key, email, tier, seats }
export async function handleLicence(request, { stripe, env }) {
  const support = supportEmail(env);
  const sessionId = new URL(request.url).searchParams.get("session_id") || "";
  if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId)) {
    return json(400, { error: "bad_session_id", message: "That link doesn't look like an Unflat purchase.", support });
  }
  try {
    const session = await fetchSession(stripe, sessionId);
    const licence = licenceFromSession(session, env);
    return json(200, { ...licence, support });
  } catch (err) {
    if (err instanceof LicenceError) {
      const status = err.status === 202 ? 202 : err.status;
      return json(status, { error: err.code, message: err.message, support });
    }
    if (err?.code === "resource_missing") {
      return json(404, { error: "not_found", message: "We couldn't find that purchase.", support });
    }
    console.error("licence:", err instanceof ConfigError ? err.message : err);
    return json(500, { error: "server_error", message: "Something went wrong on our side.", support });
  }
}

// POST /api/stripe-webhook  →  emails the licence key as a backup to the thank-you page
export async function handleWebhook(request, { stripe, env, fetchImpl = fetch }) {
  if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
  const body = await request.text(); // raw body: needed for the signature check
  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      request.headers.get("stripe-signature") || "",
      requireEnv(env, "STRIPE_WEBHOOK_SECRET"),
    );
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error("webhook:", err.message);
      return json(500, { error: "server_error" });
    }
    return json(400, { error: "bad_signature" });
  }

  const handled = ["checkout.session.completed", "checkout.session.async_payment_succeeded"];
  if (!handled.includes(event.type)) return json(200, { received: true, ignored: event.type });
  // completed can arrive before a delayed payment method settles; async_payment_succeeded covers that case.
  if (event.type === "checkout.session.completed" && event.data.object.payment_status !== "paid") {
    return json(200, { received: true, waiting: "payment not settled" });
  }

  try {
    const session = await fetchSession(stripe, event.data.object.id);
    const licence = licenceFromSession(session, env);
    if (!licence.email) {
      console.error(`webhook: no email on ${session.id}, key not sent`);
      return json(200, { received: true, emailed: false });
    }
    await sendLicenceEmail({ env, to: licence.email, key: licence.key, tier: licence.tier, sessionId: session.id, fetchImpl });
    return json(200, { received: true, emailed: true });
  } catch (err) {
    if (err instanceof LicenceError && err.code === "not_unflat") return json(200, { received: true, ignored: "other product" });
    // A 500 makes Stripe retry; the Resend idempotency key stops duplicate emails.
    console.error("webhook: failed to send licence", err?.message || err);
    return json(500, { error: "send_failed" });
  }
}
