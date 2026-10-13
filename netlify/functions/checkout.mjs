import { handleCheckout, stripeFromEnv } from "../../lib/handlers.mjs";

export default async (request) => handleCheckout(request, { stripe: stripeFromEnv(process.env), env: process.env });

export const config = { path: "/api/checkout" };
