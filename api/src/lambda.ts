import { handle } from "hono/aws-lambda";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

// Config (including Parameter Store reads) is loaded once per container.
const handlerPromise = loadConfig().then((cfg) => handle(createApp(cfg)));

export const handler = async (event: Parameters<Awaited<typeof handlerPromise>>[0], context: Parameters<Awaited<typeof handlerPromise>>[1]) =>
  (await handlerPromise)(event, context);
