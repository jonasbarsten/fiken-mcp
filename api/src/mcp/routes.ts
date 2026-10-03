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
   * Serves `/mcp` and `/mcp/<options>`. The options are parsed from Hono's decoded param,
   * so a comma sent as %2C works too. A valid option path's challenge mirrors the raw path
   * the client used (so its metadata's resource matches it exactly); an invalid one gets the
   * plain `/mcp` challenge, since its own metadata would 404 and the client could never log
   * in to see the 400 naming the bad word.
   */
  const handle = async (c: Context, withOptions: boolean) => {
    const parsed = withOptions ? parseConnectorOptions(c.req.param("options") ?? "") : { ok: { readOnly: false } };
    const metadataPath = withOptions && "ok" in parsed ? new URL(c.req.url).pathname : "";
    const challenge = `Bearer error="invalid_token", resource_metadata="${cfg.publicUrl}/.well-known/oauth-protected-resource${metadataPath}"`;
    const auth = c.req.header("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    let claims;
    try {
      claims = readAccessToken(cfg, token);
    } catch {
      return c.body("Unauthorized", 401, { "WWW-Authenticate": challenge });
    }
    if ("error" in parsed) return c.json({ error: "invalid_connector_options", message: parsed.error }, 400);
    const options: ConnectorOptions = parsed.ok;
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
