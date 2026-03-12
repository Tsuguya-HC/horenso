import { serve } from "@hono/node-server";
import { app } from "./routes.js";
import { migrate } from "./db.js";

const port = parseInt(process.env.PORT ?? "3000");

await migrate();
console.log(`horenso listening on :${port}`);
serve({ fetch: app.fetch, port });
