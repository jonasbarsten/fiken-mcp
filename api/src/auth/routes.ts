import { Hono } from "hono";
import type { Config } from "../config.js";
import { BlobError, signBlob, verifyBlob } from "../crypto/blob.js";
import { isAllowedRedirectUri } from "./clients.js";

interface ClientWire { k: "c"; ru: string[]; n: string }

export function readClientId(cfg: Config, clientId: string): { redirectUris: string[]; name: string } {
  const wire = verifyBlob<Partial<ClientWire>>(clientId, cfg.keys);
  if (wire.k !== "c" || !Array.isArray(wire.ru)) throw new BlobError("invalid");
  return { redirectUris: wire.ru, name: typeof wire.n === "string" ? wire.n : "" };
}

export function authRoutes(cfg: Config): Hono {
  const app = new Hono();

  app.get("/.well-known/oauth-protected-resource", (c) =>
    c.json({ resource: `${cfg.publicUrl}/mcp`, authorization_servers: [cfg.publicUrl], bearer_methods_supported: ["header"] }),
  );

  app.get("/.well-known/oauth-authorization-server", (c) =>
    c.json({
      issuer: cfg.publicUrl,
      authorization_endpoint: `${cfg.publicUrl}/authorize`,
      token_endpoint: `${cfg.publicUrl}/token`,
      registration_endpoint: `${cfg.publicUrl}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    }),
  );

  app.post("/register", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { client_name?: unknown; redirect_uris?: unknown };
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || !uris.every((u) => typeof u === "string")) {
      return c.json({ error: "invalid_client_metadata", error_description: "redirect_uris required" }, 400);
    }
    if (!uris.every(isAllowedRedirectUri)) {
      return c.json({ error: "invalid_redirect_uri", error_description: "redirect_uri is not a known MCP client" }, 400);
    }
    const name = typeof body.client_name === "string" ? body.client_name.slice(0, 64) : "";
    const wire: ClientWire = { k: "c", ru: uris, n: name };
    return c.json(
      {
        client_id: signBlob(wire, cfg.keys),
        client_name: name || undefined,
        redirect_uris: uris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
      201,
    );
  });

  return app;
}
