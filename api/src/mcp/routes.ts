import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { Hono } from "hono";
import { readAccessToken } from "../auth/tokens.js";
import type { Config } from "../config.js";
import { createFikenClient } from "../fiken/client.js";
import { createMcpServer } from "./server.js";

export function mcpRoutes(cfg: Config): Hono {
  const app = new Hono();
  const challenge = `Bearer error="invalid_token", resource_metadata="${cfg.publicUrl}/.well-known/oauth-protected-resource"`;

  app.post("/mcp", async (c) => {
    const auth = c.req.header("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    let claims;
    try {
      claims = readAccessToken(cfg, token);
    } catch {
      return c.body("Unauthorized", 401, { "WWW-Authenticate": challenge });
    }
    const session = { fikenUnauthorized: false, wrote: false };
    const fiken = createFikenClient({ baseUrl: cfg.fikenBaseUrl, accessToken: claims.fikenAccessToken, fetch: cfg.fetch, onWrite: () => { session.wrote = true; } });
    const server = createMcpServer(
      { fiken, anonId: claims.anonId, fikenAccessToken: claims.fikenAccessToken, exp: claims.exp, usage: cfg.usage, session },
      cfg.publicUrl,
      cfg,
    );
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    const parsedBody = await c.req.json().catch(() => undefined);
    // Batches are gone from the current MCP spec, and a batch could mix a write with a call that trips the 401 flag.
    if (Array.isArray(parsedBody)) return c.text("Bad Request", 400);
    const res = await transport.handleRequest(c.req.raw, { parsedBody });
    if (session.fikenUnauthorized) return c.json({ error: "invalid_token" }, 401, { "WWW-Authenticate": challenge });
    return res;
  });

  app.on(["GET", "DELETE"], "/mcp", (c) => c.text("Method Not Allowed", 405));

  return app;
}
