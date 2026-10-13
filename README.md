# Unflat site — checkout and licence keys

The payment side of the Unflat website. The main site is built in Framer, which can't run server code, so this small Netlify site sits on a subdomain (e.g. `buy.unflat.app`) and handles checkout, the thank-you page and the licence email. Its root address redirects to the Framer site.

Start with **STRIPE_INTEGRATION_TODO.md**: it lists everything to set up in Stripe, Resend and Netlify.

## How a purchase works
1. A buy button on the Framer site links to `https://buy.unflat.app/api/checkout?tier=personal` (or `studio`).
2. That function creates a Stripe Checkout Session with Managed Payments switched on and redirects to Stripe. Stripe is the seller of record and works out VAT.
3. After paying, Stripe sends the buyer to `https://buy.unflat.app/thanks?session_id=…`. If they back out, Stripe returns them to the Framer site's `#pricing` section.
4. The thank-you page calls `/api/licence`, which checks the session is paid, reads the tier from the price ID and returns a signed key. The same purchase always gives the same key, so reloading is safe.
5. Separately, Stripe calls `/api/stripe-webhook`, which emails the same key through Resend as a backup.
6. The plugin checks the key offline with the public key. No server, no database.

Key format: `UF1.<base64url(payload)>.<base64url(Ed25519 signature)>`, with payload
`{"v":1,"id":"<session id>","e":"<email>","t":"personal|studio","s":<seats>,"d":"YYYY-MM-DD"}`. The date is the purchase date.

## Files
| Path | What it is |
|---|---|
| `netlify/functions/checkout.mjs` | `GET /api/checkout?tier=…` |
| `netlify/functions/licence.mjs` | `GET /api/licence?session_id=…` |
| `netlify/functions/stripe-webhook.mjs` | `POST /api/stripe-webhook` |
| `netlify/functions/home.mjs` | Redirects the subdomain's root to the Framer site |
| `lib/` | The logic behind those (handlers, licence signing, email, config) |
| `public/thanks.html` | Thank-you page that shows and copies the key |
| `scripts/generate-keypair.js` | Makes the Ed25519 key pair (`npm run keys`) |
| `plugin-snippet/verifyLicence.ts` | Licence check for the plugin |
| `plugin-snippet/dist/verifyLicence.js` | The same, as one file with no imports (`npm run build:plugin`) |
| `test/payments.test.mjs` | End-to-end tests against a mock Stripe API (`npm test`) |

In Framer, link the buy buttons to the full checkout addresses above and give the pricing section the ID `pricing`. If Stripe ever refuses to start a session, the buyer sees a short error page on the subdomain with a "Back to pricing" link, so Framer needs no error handling.

## Run it locally
```bash
npm install
cp .env.example .env          # fill in test-mode values
npx netlify-cli dev           # site and functions on http://localhost:8888
stripe listen --forward-to localhost:8888/api/stripe-webhook   # in a second terminal
```
`stripe listen` prints its own `whsec_…`: use that as `STRIPE_WEBHOOK_SECRET` while testing locally. Then open `http://localhost:8888/api/checkout?tier=personal` and pay with test cards. (`stripe trigger checkout.session.completed` creates a session for a dummy product, so the webhook will correctly ignore it; use a real test checkout instead.)

## Deploy
Connect the folder or repo to Netlify. No build command, publish directory `public`. Functions are found automatically. Add the checkout subdomain and its DNS record, add the environment variables, then add the webhook in Stripe.

The same handlers work on Vercel or Cloudflare with a different three-line wrapper per function, if you ever move.

## Plugin side
1. Put `LICENCE_PUBLIC_KEY` from `npm run keys` into `PUBLIC_KEY` in `verifyLicence.ts` and run `npm run build:plugin`.
2. Master Slides has no bundler, so copy `plugin-snippet/dist/verifyLicence.js` into the plugin and paste its contents at the top of `code.js`. Then:
   ```js
   const result = UnflatLicence.verifyLicence(pastedKey);
   if (result.valid) {
     await figma.clientStorage.setAsync("licence", pastedKey.trim());
     // result.tier, result.seats, result.email, result.date
   } else {
     figma.notify(result.reason);
   }
   ```
3. On start-up, read the stored key with `figma.clientStorage.getAsync("licence")` and verify it again.

It runs in Figma's sandbox: it doesn't use `atob`, `TextDecoder`, `crypto.subtle` or the network (the tests run it in an empty JavaScript realm to prove that). Seats aren't enforced: a key is a signed receipt, which is the right level of protection for a £10 plugin.

## Security notes
- The private key and Stripe secret only live in Netlify's environment variables.
- Webhooks are rejected unless Stripe's signature checks out, and the session is fetched again from Stripe before a key is issued.
- Anyone with a session ID can fetch its key. Session IDs are long and random and only appear in the buyer's own redirect; `/thanks` sends no referrer and isn't cached or indexed.
- If the private key ever leaks, generate a new pair, ship a plugin update that accepts both public keys for a while, and re-send keys to existing buyers.
