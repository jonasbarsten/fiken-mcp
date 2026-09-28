import { readFileSync } from "node:fs";
import { Hono } from "hono";

// In source the PNG sits in src/assets; the api stack copies that folder next to
// the bundled index.mjs, so the same relative URL resolves in both places.
const ICON_PNG = new Uint8Array(readFileSync(new URL("./assets/icon.png", import.meta.url)));

/** The connector icon that serverInfo.icons points at. Public: clients fetch it before any login. */
export function iconRoutes(): Hono {
  const app = new Hono();
  app.get("/icon.png", (c) => c.body(ICON_PNG, 200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" }));
  return app;
}
