import { handleLicence, stripeFromEnv } from "../../lib/handlers.mjs";

export default async (request) => handleLicence(request, { stripe: stripeFromEnv(process.env), env: process.env });

export const config = { path: "/api/licence" };
