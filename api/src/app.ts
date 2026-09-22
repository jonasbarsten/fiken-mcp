import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { authRoutes } from "./auth/routes.js";
import type { Config } from "./config.js";

export function createApp(cfg: Config): Hono {
  const app = new Hono();
  app.use(
    "*",
    secureHeaders({
      strictTransportSecurity: "max-age=31536000; includeSubDomains",
      xContentTypeOptions: "nosniff",
      contentSecurityPolicy: undefined,
    }),
  );
  app.get("/", (c) => c.text("fiken-mcp\n"));
  app.route("/", authRoutes(cfg));
  return app;
}
