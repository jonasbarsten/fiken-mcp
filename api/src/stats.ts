import { Hono } from "hono";
import type { Config } from "./config.js";
import { log } from "./log.js";

export function statsRoutes(cfg: Config): Hono {
  const app = new Hono();

  app.get("/stats", async (c) => {
    try {
      const stats = await cfg.usage.globalStats();
      return c.json(stats, 200, { "Cache-Control": "public, max-age=300" });
    } catch {
      log("stats_failed");
      return c.json({ error: "unavailable" }, 503);
    }
  });

  return app;
}
