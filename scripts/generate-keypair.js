// Prints a new Ed25519 key pair for signing Unflat licence keys.
//   node scripts/generate-keypair.js
//
// LICENCE_PRIVATE_KEY → set as an environment variable on Netlify (never commit it).
// LICENCE_PUBLIC_KEY  → paste into the plugin (PUBLIC_KEY in plugin-snippet/verifyLicence.ts).
//
// Run this once. Generating a new pair later means keys you've already sold stop verifying
// unless the plugin keeps the old public key too.

import { generateKeyPairSync } from "node:crypto";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const priv = privateKey.export({ format: "jwk" }); // d = 32-byte seed, base64url
const pub = publicKey.export({ format: "jwk" }); // x = 32-byte public key, base64url

console.log("LICENCE_PRIVATE_KEY=" + priv.d);
console.log("LICENCE_PUBLIC_KEY=" + pub.x);
console.log("\nKeep the private key secret. Store a copy in your password manager as well as on Netlify.");
