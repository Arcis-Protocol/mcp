import { server } from "../src/server.js";
import { handle } from "hono/vercel";

// Export the Hono app's handler for Vercel
export const GET = handle(server.app);
export const POST = handle(server.app);
export const DELETE = handle(server.app);
