import { handleHome } from "../../lib/handlers.mjs";

// Anyone who lands on the root of the checkout subdomain goes to the main (Framer) site.
export default async (request) => handleHome(request, { env: process.env });

export const config = { path: "/" };
