import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { type Context, Hono } from "hono";
import { readAccessToken } from "../auth/tokens.js";
import type { Config } from "../config.js";
import { createFikenClient } from "../fiken/client.js";
import { type ConnectorOptions, parseConnectorOptions } from "./options.js";
import { createMcpServer } from "./server.js";

export function mcpRoutes(cfg: Config): Hono {
  const app = new Hono();

  /**
   * Serves `/mcp` and `/mcp/<options>`. The challenge mirrors the raw path the client used
   * (so its metadata's resource matches it exactly); the options are parsed from Hono's
   * decoded param, so a comma sent as %2C works too.
   */
  const handle = async (c: Context, withOptions: boolean) => {
    const metadataPath = withOptions ? new URL(c.req.url).pathname : "";
    const challenge = `Bearer error="invalid_token", resource_metadata="${cfg.publicUrl}/.well-known/oauth-protected-resource${metadataPath}"`;
    const auth = c.req.header("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    let claims;
    try {
      claims = readAccessToken(cfg, token);
    } catch {
      return c.body("Unauthorized", 401, { "WWW-Authenticate": challenge });
    }
    let options: ConnectorOptions = { readOnly: false };
    if (withOptions) {
      const parsed = parseConnectorOptions(c.req.param("options") ?? "");
      if ("error" in parsed) return c.json({ error: "invalid_connector_options", message: parsed.error }, 400);
      options = parsed.ok;
    }
    const session = { fikenUnauthorized: false, wrote: false };
    const fiken = createFikenClient({ baseUrl: cfg.fikenBaseUrl, fileBaseUrl: cfg.fikenFileBaseUrl, accessToken: claims.fikenAccessToken, fetch: cfg.fetch, onWrite: () => { session.wrote = true; } });
    const server = createMcpServer(
      { fiken, anonId: claims.anonId, fikenAccessToken: claims.fikenAccessToken, exp: claims.exp, usage: cfg.usage, session },
      cfg.publicUrl,
      cfg,
      options,
    );
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    const parsedBody = await c.req.json().catch(() => undefined);
    // Batches are gone from the current MCP spec, and a batch could mix a write with a call that trips the 401 flag.
    if (Array.isArray(parsedBody)) return c.text("Bad Request", 400);
    const res = await transport.handleRequest(c.req.raw, { parsedBody });
    if (session.fikenUnauthorized) return c.json({ error: "invalid_token" }, 401, { "WWW-Authenticate": challenge });
    return res;
  };

  app.post("/mcp", (c) => handle(c, false));
  app.post("/mcp/:options", (c) => handle(c, true));

  app.on(["GET", "DELETE"], ["/mcp", "/mcp/:options"], (c) => c.text("Method Not Allowed", 405));

  return app;
}
