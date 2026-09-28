import { Hono } from "hono";
import { ICON_PNG } from "./assets.js";

/** The connector icon that serverInfo.icons points at. Public: clients fetch it before any login. */
export function iconRoutes(): Hono {
  const app = new Hono();
  app.get("/icon.png", (c) => c.body(ICON_PNG, 200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" }));
  return app;
}
