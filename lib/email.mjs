// Emails the licence key through Resend's REST API (no SDK needed).
// The Idempotency-Key means a webhook retry for the same purchase doesn't send a second email.

import { requireEnv, supportEmail } from "./config.mjs";

const TIER_LABEL = { personal: "Personal (1 user)", studio: "Studio (5 users)" };

export async function sendLicenceEmail({ env, to, key, tier, sessionId, fetchImpl = fetch }) {
  const apiKey = requireEnv(env, "RESEND_API_KEY");
  const support = supportEmail(env);
  const from = (env.EMAIL_FROM || "").trim() || `Unflat <${support}>`;

  const text = [
    "Thanks for buying Unflat.",
    "",
    "Your licence key:",
    "",
    key,
    "",
    `Licence: ${TIER_LABEL[tier] || tier}`,
    "",
    "To activate it:",
    "1. Open Unflat in Figma.",
    "2. Go to Settings.",
    "3. Paste the key.",
    "",
    "Keep this email somewhere safe. You'll need the key if you reinstall the plugin.",
    support ? `Questions? Reply to this email or write to ${support}.` : "",
  ].join("\n");

  const html = `<!doctype html><html><body style="margin:0;background:#F4F2EE;font-family:Inter,Helvetica,Arial,sans-serif;color:#14151A">
<div style="max-width:520px;margin:0 auto;padding:32px 24px">
<p style="font-size:20px;font-weight:700;letter-spacing:-0.02em;margin:0 0 16px">Thanks for buying Unflat</p>
<p style="font-size:15px;line-height:1.5;margin:0 0 12px">Here's your licence key:</p>
<p style="font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:13px;line-height:1.5;word-break:break-all;background:#FFFFFF;border:1px solid #E4E1DB;border-radius:8px;padding:14px;margin:0 0 16px">${key}</p>
<p style="font-size:14px;color:#5B5E66;margin:0 0 16px">Licence: ${TIER_LABEL[tier] || tier}</p>
<ol style="font-size:15px;line-height:1.6;padding-left:20px;margin:0 0 16px"><li>Open Unflat in Figma.</li><li>Go to Settings.</li><li>Paste the key.</li></ol>
<p style="font-size:14px;line-height:1.5;color:#5B5E66;margin:0">Keep this email somewhere safe. You'll need the key if you reinstall the plugin.${support ? ` Questions? Reply to this email or write to <a href="mailto:${support}" style="color:#14151A">${support}</a>.` : ""}</p>
</div></body></html>`;

  const res = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `unflat-licence-${sessionId}`,
    },
    body: JSON.stringify({
      from,
      to: [to],
      reply_to: support || undefined,
      subject: "Your Unflat licence key",
      text,
      html,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Resend returned ${res.status}: ${detail.slice(0, 300)}`);
  }
}
