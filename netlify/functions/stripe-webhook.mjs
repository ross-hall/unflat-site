import { handleWebhook, stripeFromEnv } from "../../lib/handlers.mjs";

export default async (request) => handleWebhook(request, { stripe: stripeFromEnv(process.env), env: process.env });

export const config = { path: "/api/stripe-webhook" };
