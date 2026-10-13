// End-to-end tests for the payment functions against a local mock of the Stripe API.
// The real stripe-node SDK is pointed at the mock, so request encoding is tested too.
//   npm test

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import Stripe from "stripe";
import { handleCheckout, handleHome, handleLicence, handleWebhook, stripeFromEnv } from "../lib/handlers.mjs";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUB = publicKey.export({ format: "jwk" }).x;

const env = {
  STRIPE_SECRET_KEY: "sk_test_mock",
  STRIPE_WEBHOOK_SECRET: "whsec_test_secret",
  LICENCE_PRIVATE_KEY: privateKey.export({ format: "jwk" }).d,
  RESEND_API_KEY: "re_test",
  SUPPORT_EMAIL: "hello@unflat.app",
  PRICE_ID_PERSONAL: "price_personal",
  PRICE_ID_STUDIO: "price_studio",
  DOMAIN: "buy.unflat.app",
  SITE_URL: "https://unflat.app/",
};

// ---- mock Stripe API ----
const sessions = new Map();
const created = [];
let server, stripe;

function session(id, priceId, paymentStatus, email) {
  return {
    id, object: "checkout.session", created: 1792000000, payment_status: paymentStatus,
    customer_details: { email }, url: `https://checkout.stripe.com/c/pay/${id}`,
    line_items: { object: "list", data: [{ price: { id: priceId } }] },
  };
}
sessions.set("cs_test_personalpaid", session("cs_test_personalpaid", "price_personal", "paid", "ross@example.com"));
sessions.set("cs_test_studiopaid", session("cs_test_studiopaid", "price_studio", "paid", "zoë@studio.example"));
sessions.set("cs_test_unpaid", session("cs_test_unpaid", "price_personal", "unpaid", "late@example.com"));
sessions.set("cs_test_otherproduct", session("cs_test_otherproduct", "price_something_else", "paid", "x@example.com"));

before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const send = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
      const url = new URL(req.url, "http://x");
      if (req.method === "POST" && url.pathname === "/v1/checkout/sessions") {
        const params = new URLSearchParams(body);
        created.push({ params, version: req.headers["stripe-version"] });
        if (params.get("line_items[0][price]") === "price_broken") {
          return send(400, { error: { type: "invalid_request_error", message: "Product needs an eligible tax code" } });
        }
        return send(200, { id: "cs_test_new", object: "checkout.session", url: "https://checkout.stripe.com/c/pay/cs_test_new" });
      }
      const m = url.pathname.match(/^\/v1\/checkout\/sessions\/([^/]+)$/);
      if (req.method === "GET" && m) {
        assert.equal(url.searchParams.get("expand[0]"), "line_items");
        const s = sessions.get(m[1]);
        return s ? send(200, s) : send(404, { error: { type: "invalid_request_error", code: "resource_missing", message: "No such checkout.session" } });
      }
      send(404, { error: { type: "invalid_request_error", message: "unmocked " + req.method + " " + url.pathname } });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  stripe = new Stripe(env.STRIPE_SECRET_KEY, { host: "127.0.0.1", port: server.address().port, protocol: "http" });
});
after(() => server.close());

// The plugin verifier, loaded the way Figma's sandbox would see it: an empty realm with
// no window, self, require, atob, TextDecoder or crypto.
function pluginVerifier() {
  const ctx = vm.createContext({});
  vm.runInContext(readFileSync(new URL("../plugin-snippet/dist/verifyLicence.js", import.meta.url), "utf8"), ctx);
  return (key, pub = PUB) => JSON.parse(JSON.stringify(ctx.UnflatLicence.verifyLicence(key, pub)));
}
const req = (path, init) => new Request("https://buy.unflat.app" + path, init);

// ---- checkout ----
test("checkout creates a Managed Payments session and redirects to Stripe", async () => {
  const res = await handleCheckout(req("/api/checkout?tier=personal"), { stripe, env });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "https://checkout.stripe.com/c/pay/cs_test_new");
  const { params, version } = created.at(-1);
  assert.equal(params.get("managed_payments[enabled]"), "true");
  assert.equal(params.get("mode"), "payment");
  assert.equal(params.get("ui_mode"), "hosted_page");
  assert.equal(params.get("line_items[0][price]"), "price_personal");
  assert.equal(params.get("line_items[0][quantity]"), "1");
  assert.equal(params.get("success_url"), "https://buy.unflat.app/thanks?session_id={CHECKOUT_SESSION_ID}");
  assert.equal(params.get("cancel_url"), "https://unflat.app/#pricing");
  assert.equal(params.get("integration_identifier"), "hosted_web_0001");
  assert.equal(params.get("origin_context"), "web");
  for (const banned of ["automatic_tax[enabled]", "tax_id_collection[enabled]", "payment_method_types[0]", "invoice_creation[enabled]"]) {
    assert.equal(params.has(banned), false, `${banned} must not be sent with Managed Payments`);
  }
  console.log("   Stripe-Version sent by SDK:", version);
});

test("checkout uses the studio price for tier=studio", async () => {
  await handleCheckout(req("/api/checkout?tier=studio"), { stripe, env });
  assert.equal(created.at(-1).params.get("line_items[0][price]"), "price_studio");
});

test("after a price change, checkout charges the new price and old purchases still get keys", async () => {
  const changed = { ...env, PRICE_ID_PERSONAL: "price_personal_15, price_personal" };
  await handleCheckout(req("/api/checkout?tier=personal"), { stripe, env: changed });
  assert.equal(created.at(-1).params.get("line_items[0][price]"), "price_personal_15");
  const res = await handleLicence(req("/api/licence?session_id=cs_test_personalpaid"), { stripe, env: changed });
  assert.equal(res.status, 200);
});

test("checkout rejects unknown tiers", async () => {
  for (const t of ["", "enterprise", "__proto__", "toString"]) {
    const res = await handleCheckout(req("/api/checkout?tier=" + t), { stripe, env });
    assert.equal(res.status, 400, `tier=${t}`);
  }
});

test("checkout shows an error page linking back to Framer pricing if Stripe refuses the session", async () => {
  const res = await handleCheckout(req("/api/checkout?tier=personal"), { stripe, env: { ...env, PRICE_ID_PERSONAL: "price_broken" } });
  assert.equal(res.status, 503);
  const html = await res.text();
  assert.ok(html.includes('href="https://unflat.app/#pricing"'));
  assert.ok(html.includes("mailto:hello@unflat.app"));
  assert.ok(html.includes("Nothing was charged"));
});

test("the checkout subdomain's home page redirects to the main site", async () => {
  const res = handleHome(req("/"), { env });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "https://unflat.app/");
});

test("with no Stripe key set, each endpoint fails politely instead of crashing", async () => {
  const bare = { DOMAIN: "buy.unflat.app", SUPPORT_EMAIL: "hello@unflat.app" };
  const s = stripeFromEnv(bare);
  const checkout = await handleCheckout(req("/api/checkout?tier=personal"), { stripe: s, env: bare });
  assert.equal(checkout.status, 503);
  assert.match(await checkout.text(), /Checkout couldn't start/);
  const licence = await handleLicence(req("/api/licence?session_id=cs_test_abc"), { stripe: s, env: bare });
  assert.equal(licence.status, 500);
  assert.equal((await licence.json()).support, "hello@unflat.app");
  const hook = await handleWebhook(req("/api/stripe-webhook", { method: "POST", body: "{}" }), { stripe: s, env: bare });
  assert.equal(hook.status, 500);
});

test("without SITE_URL the home page shows a holding page instead of redirecting to itself", async () => {
  for (const e of [{ ...env, SITE_URL: "" }, { URL: "https://buy.unflat.app" }, { SITE_URL: "https://buy.unflat.app" }]) {
    const res = handleHome(req("/"), { env: e });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Unflat checkout/);
  }
});

// ---- licence ----
test("paid personal session returns a key the plugin accepts", async () => {
  const res = await handleLicence(req("/api/licence?session_id=cs_test_personalpaid"), { stripe, env });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.match(data.key, /^UF1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.deepEqual([data.tier, data.seats, data.email], ["personal", 1, "ross@example.com"]);
  const payload = JSON.parse(Buffer.from(data.key.split(".")[1], "base64url").toString());
  assert.deepEqual(Object.keys(payload), ["v", "id", "e", "t", "s", "d"]);
  assert.equal(payload.d, "2026-10-14");
  const result = pluginVerifier()(data.key);
  assert.deepEqual(result, { valid: true, email: "ross@example.com", tier: "personal", seats: 1, date: "2026-10-14", id: "cs_test_personalpaid" });
});

test("the same session always gives the same key (reload is safe)", async () => {
  const a = await (await handleLicence(req("/api/licence?session_id=cs_test_studiopaid"), { stripe, env })).json();
  const b = await (await handleLicence(req("/api/licence?session_id=cs_test_studiopaid"), { stripe, env })).json();
  assert.equal(a.key, b.key);
  const result = pluginVerifier()(a.key);
  assert.equal(result.valid, true);
  assert.equal(result.tier, "studio");
  assert.equal(result.seats, 5);
  assert.equal(result.email, "zoë@studio.example"); // non-ASCII survives the plugin's own UTF-8 decoder
});

test("licence endpoint handles unpaid, unknown, other-product and malformed sessions", async () => {
  const status = async (id) => (await handleLicence(req("/api/licence?session_id=" + encodeURIComponent(id)), { stripe, env })).status;
  assert.equal(await status("cs_test_unpaid"), 202);
  assert.equal(await status("cs_test_doesnotexist"), 404);
  assert.equal(await status("cs_test_otherproduct"), 404);
  assert.equal(await status("not-a-session"), 400);
  assert.equal(await status("cs_test_abc/../../v1/charges"), 400);
  const res = await handleLicence(req("/api/licence?session_id=cs_test_unpaid"), { stripe, env });
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal((await res.json()).support, "hello@unflat.app");
});

test("plugin rejects tampered, truncated and wrongly signed keys", async () => {
  const { key } = await (await handleLicence(req("/api/licence?session_id=cs_test_personalpaid"), { stripe, env })).json();
  const verify = pluginVerifier();
  const [, p, s] = key.split(".");
  const forged = Buffer.from(JSON.stringify({ v: 1, id: "x", e: "a@b.c", t: "studio", s: 500, d: "2026-01-01" })).toString("base64url");
  assert.equal(verify(`UF1.${forged}.${s}`).valid, false);
  assert.equal(verify(key.slice(0, -4)).valid, false);
  assert.equal(verify(`UF2.${p}.${s}`).valid, false);
  assert.equal(verify("").valid, false);
  assert.equal(verify(key, generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x).valid, false);
  // Pasted from an email with line breaks and spaces: still fine.
  assert.equal(verify(`  ${key.slice(0, 30)}\n${key.slice(30)} `).valid, true);
  assert.match(verify("nonsense").reason, /isn't valid/);
});

// ---- webhook ----
function signed(event) {
  const payload = JSON.stringify(event);
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: env.STRIPE_WEBHOOK_SECRET });
  return req("/api/stripe-webhook", { method: "POST", body: payload, headers: { "stripe-signature": header } });
}
const completed = (id, payment_status = "paid") => ({ id: "evt_1", type: "checkout.session.completed", data: { object: { id, payment_status } } });

test("webhook emails the same key the thank-you page shows", async () => {
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push({ url, init }); return new Response("{}", { status: 200 }); };
  const res = await handleWebhook(signed(completed("cs_test_personalpaid")), { stripe, env, fetchImpl });
  assert.equal(res.status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "https://api.resend.com/emails");
  assert.equal(sent[0].init.headers["Idempotency-Key"], "unflat-licence-cs_test_personalpaid");
  const body = JSON.parse(sent[0].init.body);
  assert.deepEqual(body.to, ["ross@example.com"]);
  const pageKey = (await (await handleLicence(req("/api/licence?session_id=cs_test_personalpaid"), { stripe, env })).json()).key;
  assert.ok(body.text.includes(pageKey));
  assert.ok(body.html.includes(pageKey));
});

test("webhook rejects bad signatures and ignores events it doesn't need", async () => {
  const fetchImpl = async () => assert.fail("should not email");
  const forged = req("/api/stripe-webhook", { method: "POST", body: JSON.stringify(completed("cs_test_personalpaid")), headers: { "stripe-signature": "t=1,v1=deadbeef" } });
  assert.equal((await handleWebhook(forged, { stripe, env, fetchImpl })).status, 400);
  assert.equal((await handleWebhook(signed({ id: "evt_2", type: "charge.refunded", data: { object: {} } }), { stripe, env, fetchImpl })).status, 200);
  assert.equal((await handleWebhook(signed(completed("cs_test_unpaid", "unpaid")), { stripe, env, fetchImpl })).status, 200);
  assert.equal((await handleWebhook(signed(completed("cs_test_otherproduct")), { stripe, env, fetchImpl })).status, 200);
});

test("webhook asks Stripe to retry when the email fails", async () => {
  const fetchImpl = async () => new Response("rate limited", { status: 429 });
  const res = await handleWebhook(signed(completed("cs_test_studiopaid")), { stripe, env, fetchImpl });
  assert.equal(res.status, 500);
});
