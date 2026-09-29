import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { authRoutes } from "./auth/routes.js";
import type { Config } from "./config.js";
import { iconRoutes } from "./icon.js";
import { log, withRequestId, type LogFields } from "./log.js";
import { mcpRoutes } from "./mcp/routes.js";
import { statsRoutes } from "./stats.js";
import { uploadRoutes } from "./upload/routes.js";

/** What hono/aws-lambda puts in c.env; absent when the app runs in tests. */
export interface LambdaEnv {
  Bindings: { requestContext?: { requestId?: string } };
}

/**
 * The logger refuses values that look like secrets. A request path is
 * attacker-chosen, so if it trips the guard we log the line without it
 * rather than fail the request or print the path.
 */
function logGuarded(write: (event: string, fields: LogFields) => void, event: string, fields: LogFields): void {
  try {
    write(event, fields);
  } catch {
    write(event, { ...fields, route: "(unloggable)" });
  }
}

export function createApp(cfg: Config): Hono<LambdaEnv> {
  const app = new Hono<LambdaEnv>();

  app.use("*", async (c, next) => {
    const started = performance.now();
    await next();
    const requestId = c.env?.requestContext?.requestId ?? randomBytes(6).toString("base64url");
    logGuarded(withRequestId(requestId), "request", {
      method: c.req.method,
      route: c.req.path,
      status: c.res.status,
      ms: Math.round(performance.now() - started),
    });
  });

  app.use(
    "*",
    secureHeaders({
      strictTransportSecurity: "max-age=31536000; includeSubDomains",
      xContentTypeOptions: "nosniff",
      contentSecurityPolicy: undefined,
    }),
  );

  // Never err.message or the error itself: a FikenError carries a response body.
  app.onError((err, c) => {
    logGuarded(log, "error", { route: c.req.path, method: c.req.method, name: err.name });
    return c.text("Internal error", 500);
  });

  app.get("/", (c) => c.text("fiken-mcp\n"));
  app.route("/", iconRoutes());
  app.route("/", authRoutes(cfg));
  app.route("/", mcpRoutes(cfg));
  app.route("/", uploadRoutes(cfg));
  app.route("/", statsRoutes(cfg));
  return app;
}
