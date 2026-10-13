// Licence keys: UF1.<base64url(payload JSON)>.<base64url(Ed25519 signature)>
// Ed25519 signatures are deterministic, and every payload field comes from the Checkout Session,
// so the same session always produces exactly the same key. Reloading /thanks is safe.

import { createPrivateKey, sign } from "node:crypto";
import { requireEnv, tierForPriceId } from "./config.mjs";

const KEY_PREFIX = "UF1";
// DER header that wraps a raw 32-byte Ed25519 seed as a PKCS#8 private key.
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export class LicenceError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// LICENCE_PRIVATE_KEY is the base64url seed printed by scripts/generate-keypair.js.
export function privateKeyFromEnv(env) {
  const seed = Buffer.from(requireEnv(env, "LICENCE_PRIVATE_KEY"), "base64url");
  if (seed.length !== 32) throw new LicenceError(500, "bad_private_key", "LICENCE_PRIVATE_KEY must be a 32-byte Ed25519 seed");
  return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" });
}

// Key order is fixed so the JSON (and therefore the key) is always identical.
export function buildPayload({ sessionId, email, tier, seats, date }) {
  return { v: 1, id: sessionId, e: email, t: tier, s: seats, d: date };
}

export function signLicence(payload, privateKey) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const signature = sign(null, body, privateKey);
  return `${KEY_PREFIX}.${body.toString("base64url")}.${signature.toString("base64url")}`;
}

// Turns a retrieved Checkout Session (with line_items expanded) into a licence.
export function licenceFromSession(session, env) {
  if (session.payment_status !== "paid") {
    throw new LicenceError(202, "not_paid", "Payment hasn't completed yet");
  }
  const priceId = session.line_items?.data?.[0]?.price?.id;
  const match = priceId && tierForPriceId(env, priceId);
  if (!match) throw new LicenceError(404, "not_unflat", "This purchase isn't an Unflat licence");

  const email = session.customer_details?.email || session.customer_email || "";
  const date = new Date(session.created * 1000).toISOString().slice(0, 10);
  const payload = buildPayload({ sessionId: session.id, email, tier: match.tier, seats: match.seats, date });
  return { key: signLicence(payload, privateKeyFromEnv(env)), email, tier: match.tier, seats: match.seats };
}
