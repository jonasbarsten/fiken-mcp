import { randomBytes, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Config } from "../config.js";
import { BlobError, signBlob, verifyBlob } from "../crypto/blob.js";
import { verifyPkce } from "../crypto/pkce.js";
import { FikenOAuthError, exchangeFikenCode, fetchFikenUser, fikenAuthorizeUrl } from "../fiken/oauth.js";
import { anonymousId } from "./anon.js";
import { clientLabel, isAllowedRedirectUri } from "./clients.js";
import { consentPage, continuePage } from "./consent.js";
import { issueTokens, renewTokens } from "./tokens.js";

interface ClientWire { k: "c"; ru: string[]; n: string }

export function readClientId(cfg: Config, clientId: string): { redirectUris: string[]; name: string } {
  const wire = verifyBlob<Partial<ClientWire>>(clientId, cfg.keys);
  if (wire.k !== "c" || !Array.isArray(wire.ru)) throw new BlobError("invalid");
  return { redirectUris: wire.ru, name: typeof wire.n === "string" ? wire.n : "" };
}

/** Login state; `n` is a nonce that must match the browser's login cookie at /callback. */
interface StateWire { k: "s"; ru: string; cc: string; cs: string; n: string; exp: number }
export interface CodeWire { k: "d"; fc: string; fs: string; cc: string; ru: string; exp: number }

const LOGIN_WINDOW_SECONDS = 60 * 60;
const CODE_WINDOW_SECONDS = 5 * 60;
const now = () => Math.floor(Date.now() / 1000);

/**
 * Binds the login to the browser that pressed "Fortsett": a state blob
 * pasted into another browser's /callback is refused (RFC 6749 section
 * 10.12, and it would let an attacker skip our consent page).
 */
const LOGIN_COOKIE = "__Host-fmcp_login";
const LOGIN_COOKIE_ATTRS = { path: "/", secure: true, httpOnly: true, sameSite: "Lax" } as const;

function nonceMatches(cookie: string | undefined, expected: string): boolean {
  if (!cookie) return false;
  const a = Buffer.from(cookie);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

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
  // Re-checked on every use so removing a client from clients.ts takes effect at once.
  if (!isAllowedRedirectUri(redirectUri)) return { error: "redirect_uri is not a known MCP client" };
  if (q.code_challenge_method !== "S256" || !q.code_challenge) return { error: "PKCE S256 required" };
  return { ok: { redirectUri, codeChallenge: q.code_challenge, clientState: q.state ?? "", clientName: client.name } };
}

/**
 * form-action stays 'self': the consent form posts to /authorize and the
 * answer is a page, never a redirect. Chrome checks form-action against
 * every hop of a redirect chain after a form post, and Fiken's own login
 * redirects are not ours to allowlist.
 */
const CONSENT_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

/** A JSON body can carry anything; every field the token endpoint reads is a string or "". */
const str = (v: unknown): string => (typeof v === "string" ? v : "");

const TOKEN_FIELDS = ["grant_type", "code", "code_verifier", "redirect_uri", "client_id", "refresh_token"] as const;

function tokenFields(raw: Record<string, unknown>): Record<(typeof TOKEN_FIELDS)[number], string> {
  return Object.fromEntries(TOKEN_FIELDS.map((f) => [f, str(raw[f])])) as Record<(typeof TOKEN_FIELDS)[number], string>;
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
    const cancel = new URL(v.ok.redirectUri);
    cancel.searchParams.set("error", "access_denied");
    cancel.searchParams.set("error_description", "User cancelled");
    cancel.searchParams.set("state", v.ok.clientState);
    const html = consentPage({
      clientLabel: clientLabel(v.ok.redirectUri),
      clientName: v.ok.clientName,
      redirectHost: new URL(v.ok.redirectUri).host,
      fields,
      cancelUrl: cancel.toString(),
    });
    return c.html(html, 200, { "Content-Security-Policy": CONSENT_CSP, "Cache-Control": "no-store" });
  });

  app.post("/authorize", async (c) => {
    const q = Object.fromEntries(new URLSearchParams(await c.req.text())) as Record<string, string>;
    const v = validateAuthorize(cfg, q);
    if ("error" in v) return c.text(v.error, 400);
    const nonce = randomBytes(16).toString("base64url");
    const state: StateWire = { k: "s", ru: v.ok.redirectUri, cc: v.ok.codeChallenge, cs: v.ok.clientState, n: nonce, exp: now() + LOGIN_WINDOW_SECONDS };
    setCookie(c, LOGIN_COOKIE, nonce, { ...LOGIN_COOKIE_ATTRS, maxAge: LOGIN_WINDOW_SECONDS });
    const fikenUrl = fikenAuthorizeUrl(cfg, signBlob(state, cfg.keys));
    return c.html(continuePage(fikenUrl), 200, { "Content-Security-Policy": CONSENT_CSP, "Cache-Control": "no-store" });
  });

  app.get("/callback", (c) => {
    const q = c.req.query();
    let state: StateWire;
    try {
      const wire = verifyBlob<Partial<StateWire>>(q.state ?? "", cfg.keys);
      if (wire.k !== "s" || !wire.ru || !wire.cc || typeof wire.cs !== "string" || typeof wire.n !== "string" || typeof wire.exp !== "number") {
        throw new BlobError("invalid");
      }
      if (!nonceMatches(getCookie(c, LOGIN_COOKIE), wire.n)) throw new BlobError("invalid");
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
    deleteCookie(c, LOGIN_COOKIE, LOGIN_COOKIE_ATTRS);
    return c.redirect(back.toString(), 302);
  });

  app.post("/token", async (c) => {
    const contentType = c.req.header("content-type") ?? "";
    const raw: unknown = contentType.includes("json") ? await c.req.json().catch(() => ({})) : Object.fromEntries(new URLSearchParams(await c.req.text()));
    const fields = tokenFields(raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {});
    const noStore = { "Cache-Control": "no-store", Pragma: "no-cache" };
    const oauthError = (error: string, description: string) => c.json({ error, error_description: description }, 400, noStore);

    try {
      if (fields.grant_type === "authorization_code") {
        let code: CodeWire;
        try {
          const wire = verifyBlob<Partial<CodeWire>>(fields.code, cfg.keys);
          if (wire.k !== "d" || !wire.fc || !wire.cc || !wire.ru || typeof wire.exp !== "number") throw new BlobError("invalid");
          code = wire as CodeWire;
        } catch {
          return oauthError("invalid_grant", "code invalid or expired");
        }
        let client: { redirectUris: string[] };
        try {
          client = readClientId(cfg, fields.client_id);
        } catch {
          return oauthError("invalid_client", "unknown client_id");
        }
        if (fields.redirect_uri !== code.ru || !client.redirectUris.includes(code.ru) || !isAllowedRedirectUri(code.ru)) {
          return oauthError("invalid_grant", "redirect_uri mismatch");
        }
        if (!fields.code_verifier || !verifyPkce(fields.code_verifier, code.cc)) {
          return oauthError("invalid_grant", "PKCE verification failed");
        }
        const fiken = await exchangeFikenCode(cfg, code.fc, code.fs);
        const user = await fetchFikenUser(cfg, fiken.access_token);
        return c.json(issueTokens(cfg, fiken, anonymousId(user.email, cfg.userSalt)), 200, noStore);
      }

      if (fields.grant_type === "refresh_token") {
        try {
          return c.json(await renewTokens(cfg, fields.refresh_token), 200, noStore);
        } catch (err) {
          if (err instanceof BlobError) return oauthError("invalid_grant", "refresh token invalid");
          throw err;
        }
      }

      return oauthError("unsupported_grant_type", "use authorization_code or refresh_token");
    } catch (err) {
      if (err instanceof FikenOAuthError) return oauthError("invalid_grant", err.description ?? err.error);
      throw err;
    }
  });

  return app;
}
