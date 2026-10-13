// Offline licence check for the Unflat Figma plugin.
//
// Verifies keys of the form UF1.<base64url(payload)>.<base64url(Ed25519 signature)>
// issued by /api/licence. No network call, no Web Crypto, no atob/TextDecoder, so it runs
// in Figma's plugin sandbox (code.js) as well as in the UI iframe.
//
// The only dependency is tweetnacl (pure JS, public domain). If the plugin has no bundler,
// use dist/verifyLicence.js instead: `npm run build:plugin` makes a self-contained copy that
// exposes a global `UnflatLicence.verifyLicence`.

import nacl from "tweetnacl";

// Paste LICENCE_PUBLIC_KEY from scripts/generate-keypair.js here.
export const PUBLIC_KEY = "LJbqJqJJ8cmFJzpl1xzgv_UigugP96sgKr8QK7Qz_bA";

export type Tier = "personal" | "studio";

export interface LicenceResult {
  valid: boolean;
  email?: string;
  tier?: Tier;
  seats?: number;
  /** Purchase date, YYYY-MM-DD. Useful for "12 months of updates". */
  date?: string;
  /** Checkout Session ID, handy for support. */
  id?: string;
  /** Why the key was rejected, in words you can show the user. */
  reason?: string;
}

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function base64urlDecode(input: string): Uint8Array | null {
  const s = input.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  if (s.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < s.length; i++) {
    const v = B64URL.indexOf(s.charAt(i));
    if (v < 0) return null;
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buffer >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

function utf8Decode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i++];
    let cp: number;
    if (b < 0x80) cp = b;
    else if (b < 0xe0) cp = ((b & 0x1f) << 6) | (bytes[i++] & 0x3f);
    else if (b < 0xf0) cp = ((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
    else cp = ((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
    out += String.fromCodePoint(cp);
  }
  return out;
}

const INVALID = "This licence key isn't valid. Check you copied all of it.";

export function verifyLicence(key: string, publicKey: string = PUBLIC_KEY): LicenceResult {
  // People paste keys with stray spaces or line breaks from emails.
  const cleaned = String(key || "").replace(/\s+/g, "");
  const parts = cleaned.split(".");
  if (parts.length !== 3 || parts[0] !== "UF1") return { valid: false, reason: INVALID };

  const pub = base64urlDecode(publicKey);
  if (!pub || pub.length !== 32) return { valid: false, reason: "The plugin's public key isn't set up." };

  const payloadBytes = base64urlDecode(parts[1]);
  const signature = base64urlDecode(parts[2]);
  if (!payloadBytes || !signature || signature.length !== 64) return { valid: false, reason: INVALID };

  if (!nacl.sign.detached.verify(payloadBytes, signature, pub)) return { valid: false, reason: INVALID };

  let payload: { v?: number; id?: string; e?: string; t?: string; s?: number; d?: string };
  try {
    payload = JSON.parse(utf8Decode(payloadBytes));
  } catch {
    return { valid: false, reason: INVALID };
  }
  if (payload.v !== 1) return { valid: false, reason: "This key is for a newer version of Unflat. Update the plugin." };
  if (payload.t !== "personal" && payload.t !== "studio") return { valid: false, reason: INVALID };

  return {
    valid: true,
    email: payload.e || "",
    tier: payload.t,
    seats: typeof payload.s === "number" ? payload.s : payload.t === "studio" ? 5 : 1,
    date: payload.d,
    id: payload.id,
  };
}
