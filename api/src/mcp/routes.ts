import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { Hono } from "hono";
import { readAccessToken } from "../auth/tokens.js";
import type { Config } from "../config.js";
import { createFikenClient } from "../fiken/client.js";
import { createMcpServer } from "./server.js";

export function mcpRoutes(cfg: Config): Hono {
  const app = new Hono();
  const challenge = `Bearer resource_metadata="${cfg.publicUrl}/.well-known/oauth-protected-resource"`;

  app.post("/mcp", async (c) => {
    const auth = c.req.header("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    let claims;
    try {
      claims = readAccessToken(cfg, token);
    } catch {
      return c.body("Unauthorized", 401, { "WWW-Authenticate": challenge });
    }
    const fiken = createFikenClient({ baseUrl: cfg.fikenBaseUrl, accessToken: claims.fikenAccessToken, fetch: cfg.fetch });
    const server = createMcpServer({ fiken, anonId: claims.anonId });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    const parsedBody = await c.req.json().catch(() => undefined);
    return transport.handleRequest(c.req.raw, { parsedBody });
  });

  app.on(["GET", "DELETE"], "/mcp", (c) => c.text("Method Not Allowed", 405));

  return app;
}
