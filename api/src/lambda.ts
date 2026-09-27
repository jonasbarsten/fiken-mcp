import { handle } from "hono/aws-lambda";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

// Runs once per container at init; a failure fails the init, which Lambda reports and retries.
const app = createApp(await loadConfig());
export const handler = handle(app);
