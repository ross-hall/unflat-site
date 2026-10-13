# Stripe integration — to do before launch

The code is done and tested against a mock of Stripe's API. These are the steps only you can do in Stripe, Resend and Netlify. Do them in **test mode** first, then repeat the Stripe ones in live mode.

## 1. Turn on Managed Payments
- [ ] Stripe Dashboard → Settings → Managed Payments: activate it and accept the Managed Payments terms. Sessions are refused until you do.

## 2. Create the two products
Product catalogue → Create product, once for each:

| Product | Price | Tax code | Env var for its price ID |
|---|---|---|---|
| Unflat Personal | £10.00 GBP, one-off | Software as a service – business use (must say "Eligible for Managed Payments") | `PRICE_ID_PERSONAL` |
| Unflat Studio (5 users) | £39.00 GBP, one-off | Same | `PRICE_ID_STUDIO` |

- [ ] Leave tax behaviour as "exclusive" (the default), so VAT is added on top. That matches the site's "Prices exclude VAT where applicable".
- [ ] Copy each price ID (`price_…`, not the product ID).
- [ ] When the launch price ends, add a £15 price to Personal and put its ID **first** in `PRICE_ID_PERSONAL`, keeping the old one after a comma: `price_new15,price_old10`. Checkout charges the first; old thank-you links and webhook retries still recognise the old one. Keys already sold keep working in the plugin either way.

## 3. Licence signing key
- [ ] Run `npm install` then `npm run keys`.
- [ ] `LICENCE_PRIVATE_KEY` → Netlify env var, plus a copy in your password manager.
- [ ] `LICENCE_PUBLIC_KEY` → the plugin (see README, "Plugin side").
- [ ] Use the same key pair for test and live mode, so test keys verify in the plugin too.

## 4. Netlify (checkout subdomain)
The main site is in Framer; Netlify only runs checkout, the thank-you page and the webhook.
- [ ] Create the site from this folder (or its Git repo). No build command; publish directory `public`.
- [ ] Netlify → Domain management → add `buy.unflat.app` (or whatever subdomain you like). At your domain's DNS, add the CNAME record Netlify shows you. Framer keeps the main domain; the two don't clash.
- [ ] Add every variable from `.env.example`. `DOMAIN` is the subdomain (`https://buy.unflat.app`), `SITE_URL` is the Framer site (`https://unflat.app`).

## 4b. Framer
- [ ] Buy buttons: link to the full addresses, `https://buy.unflat.app/api/checkout?tier=personal` and `https://buy.unflat.app/api/checkout?tier=studio`, opening in the same tab.
- [ ] Give the pricing section the ID `pricing`, so Stripe's back link and the error page land on `https://unflat.app/#pricing`.
- [ ] Nothing else in Framer needs code. The thank-you page lives on the subdomain.

## 5. Webhook (one endpoint only)
- [ ] Developers → Webhooks → Add destination → Account events.
- [ ] URL: `https://<your domain>/api/stripe-webhook`
- [ ] Events: `checkout.session.completed` and `checkout.session.async_payment_succeeded` (the second covers bank-based payment methods that settle later).
- [ ] Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.

## 6. Email
- [ ] Resend: add and verify your sending domain, create an API key → `RESEND_API_KEY`.
- [ ] Set `EMAIL_FROM` to an address on that domain.

## 7. Test (test mode)
- [ ] Click **Buy** on the Framer site (or open `https://buy.unflat.app/api/checkout?tier=personal` directly). You should land on Stripe Checkout showing tax for the billing address.
- [ ] Pay with `4242 4242 4242 4242`, any future expiry, any CVC. Try a few billing countries to see VAT change.
- [ ] Check `/thanks` shows a key, Copy works, and the email arrives with the same key.
- [ ] Paste the key into the plugin: it should show Personal, 1 seat.
- [ ] Repeat with **Buy Studio** (5 seats).
- [ ] Declined card: `4000 0000 0000 0002`. 3D Secure: `4000 0025 0000 3155`.
- [ ] Click back on Stripe Checkout: you should return to the Framer site's pricing section.

## 8. Go live
- [ ] Switch the Dashboard to live mode; repeat steps 1, 2 and 5 (live has its own products, price IDs and webhook secret).
- [ ] Swap `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `PRICE_ID_PERSONAL` and `PRICE_ID_STUDIO` for the live values in Netlify, then redeploy.
- [ ] Do one real £10 purchase and refund it from the Dashboard.

## Reference: what the checkout sends
`ui_mode: hosted_page`, `mode: payment`, one line item, `managed_payments.enabled: true`, `billing_address_collection: auto`, `phone_number_collection.enabled: false`, `allow_promotion_codes: false`, `submit_type: auto`, `integration_identifier: hosted_web_0001`, `origin_context: web`, success and cancel URLs. It deliberately sends no `automatic_tax`, `tax_id_collection`, `payment_method_types` or `invoice_creation`: Managed Payments rejects those.

No API version is pinned. Managed Payments became generally available in API version `2026-04-22.dahlia`, and stripe-node 23 uses `2026-09-30.endive`, so the `2026-02-25.preview` header in Stripe's setup prompt isn't needed.
