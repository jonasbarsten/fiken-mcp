import { Hono } from "hono";
import type { Config } from "../config.js";
import { BlobError, signBlob, verifyBlob } from "../crypto/blob.js";
import { fikenAuthorizeUrl } from "../fiken/oauth.js";
import { clientLabel, isAllowedRedirectUri } from "./clients.js";
import { consentPage } from "./consent.js";

interface ClientWire { k: "c"; ru: string[]; n: string }

export function readClientId(cfg: Config, clientId: string): { redirectUris: string[]; name: string } {
  const wire = verifyBlob<Partial<ClientWire>>(clientId, cfg.keys);
  if (wire.k !== "c" || !Array.isArray(wire.ru)) throw new BlobError("invalid");
  return { redirectUris: wire.ru, name: typeof wire.n === "string" ? wire.n : "" };
}

interface StateWire { k: "s"; ru: string; cc: string; cs: string; exp: number }
export interface CodeWire { k: "d"; fc: string; fs: string; cc: string; ru: string; exp: number }

const LOGIN_WINDOW_SECONDS = 60 * 60;
const CODE_WINDOW_SECONDS = 5 * 60;
const now = () => Math.floor(Date.now() / 1000);

interface AuthorizeRequest { redirectUri: string; codeChallenge: string; clientState: string; clientName: string }

/** Validates authorize parameters; returns an error message or the validated request. */
function validateAuthorize(cfg: Config, q: Record<string, string | undefined>): { error: string } | { ok: AuthorizeRequest } {
  if (q.response_type !== "code") return { error: "response_type must be code" };
  let client: { redirectUris: string[]; name: string };
  try {
    client = readClientId(cfg, q.client_id ?? "");
  } catch {
    return { error: "invalid client_id" };
  }
  const redirectUri = q.redirect_uri ?? "";
  if (!client.redirectUris.includes(redirectUri)) return { error: "redirect_uri not registered for this client" };
  if (q.code_challenge_method !== "S256" || !q.code_challenge) return { error: "PKCE S256 required" };
  return { ok: { redirectUri, codeChallenge: q.code_challenge, clientState: q.state ?? "", clientName: client.name } };
}

const CONSENT_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

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

  app.get("/authorize", (c) => {
    const q = c.req.query();
    const v = validateAuthorize(cfg, q);
    if ("error" in v) return c.text(v.error, 400);
    const fields: Record<string, string> = {
      response_type: "code",
      client_id: q.client_id ?? "",
      redirect_uri: v.ok.redirectUri,
      code_challenge: v.ok.codeChallenge,
      code_challenge_method: "S256",
      state: v.ok.clientState,
    };
    const html = consentPage({
      clientLabel: clientLabel(v.ok.redirectUri),
      clientName: v.ok.clientName,
      redirectHost: new URL(v.ok.redirectUri).host,
      fields,
    });
    return c.html(html, 200, { "Content-Security-Policy": CONSENT_CSP, "Cache-Control": "no-store" });
  });

  app.post("/authorize", async (c) => {
    const q = Object.fromEntries(new URLSearchParams(await c.req.text())) as Record<string, string>;
    const v = validateAuthorize(cfg, q);
    if ("error" in v) return c.text(v.error, 400);
    const state: StateWire = { k: "s", ru: v.ok.redirectUri, cc: v.ok.codeChallenge, cs: v.ok.clientState, exp: now() + LOGIN_WINDOW_SECONDS };
    return c.redirect(fikenAuthorizeUrl(cfg, signBlob(state, cfg.keys)), 302);
  });

  app.get("/callback", (c) => {
    const q = c.req.query();
    let state: StateWire;
    try {
      const wire = verifyBlob<Partial<StateWire>>(q.state ?? "", cfg.keys);
      if (wire.k !== "s" || !wire.ru || !wire.cc) throw new BlobError("invalid");
      state = wire as StateWire;
    } catch (err) {
      const why = err instanceof BlobError && err.code === "expired" ? "The login took too long and expired." : "Invalid login state.";
      return c.text(`${why} Go back to the app and connect again.`, 400);
    }
    const back = new URL(state.ru);
    if (q.error) {
      back.searchParams.set("error", q.error);
      if (q.error_description) back.searchParams.set("error_description", q.error_description);
      back.searchParams.set("state", state.cs);
      return c.redirect(back.toString(), 302);
    }
    if (!q.code) return c.text("Missing code from Fiken.", 400);
    const code: CodeWire = { k: "d", fc: q.code, fs: q.state ?? "", cc: state.cc, ru: state.ru, exp: now() + CODE_WINDOW_SECONDS };
    back.searchParams.set("code", signBlob(code, cfg.keys));
    back.searchParams.set("state", state.cs);
    return c.redirect(back.toString(), 302);
  });

  return app;
}
