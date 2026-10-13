// Shared settings for the Unflat payment functions.
// Every secret comes from environment variables (see .env.example). Nothing is hard-coded.

export const TIERS = {
  personal: { seats: 1, priceEnv: "PRICE_ID_PERSONAL" },
  studio: { seats: 5, priceEnv: "PRICE_ID_STUDIO" },
};

export class ConfigError extends Error {}

export function requireEnv(env, name) {
  const value = env[name];
  if (!value || !String(value).trim()) throw new ConfigError(`Missing environment variable ${name}`);
  return String(value).trim();
}

function normaliseOrigin(value) {
  let origin = String(value).trim();
  if (!/^https?:\/\//i.test(origin)) origin = `https://${origin}`;
  return origin.replace(/\/+$/, "");
}

// Where these functions and the thank-you page live (the Netlify site), e.g. "https://buy.unflat.app".
// Uses DOMAIN when set (with or without https://), then Netlify's URL, then the request itself.
export function siteOrigin(env, request) {
  return normaliseOrigin(env.DOMAIN || env.URL || new URL(request.url).origin);
}

// The main website (built in Framer), e.g. "https://unflat.app". Stripe's back link and the
// "Back to pricing" link go here. Falls back to siteOrigin if SITE_URL isn't set.
export function mainSiteUrl(env, request) {
  return env.SITE_URL ? normaliseOrigin(env.SITE_URL) : siteOrigin(env, request);
}

// A PRICE_ID_* variable can hold several comma-separated IDs, current price first,
// e.g. "price_15pounds,price_10pounds_launch". Checkout charges the first one; licences
// are issued for any of them, so old purchases keep working after a price change.
function priceIds(env, name) {
  return String(env[name] || "").split(",").map((s) => s.trim()).filter(Boolean);
}

export function priceIdForTier(env, tier) {
  const t = TIERS[tier];
  if (!t) return null;
  const ids = priceIds(env, t.priceEnv);
  if (!ids.length) throw new ConfigError(`Missing environment variable ${t.priceEnv}`);
  return ids[0];
}

// Works out which tier a paid price belongs to. Returns null for any other product.
export function tierForPriceId(env, priceId) {
  for (const [tier, t] of Object.entries(TIERS)) {
    if (priceIds(env, t.priceEnv).includes(priceId)) return { tier, seats: t.seats };
  }
  return null;
}

export function supportEmail(env) {
  return (env.SUPPORT_EMAIL || "").trim();
}
