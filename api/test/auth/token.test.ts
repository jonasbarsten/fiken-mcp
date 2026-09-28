import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { clearCimdCache } from "../../src/auth/cimd.js";
import { issueTokens, readAccessToken, readRefreshToken } from "../../src/auth/tokens.js";
import { testConfig } from "../../src/config.js";
import { signBlob } from "../../src/crypto/blob.js";
import { pkceChallenge } from "../../src/crypto/pkce.js";

const CLAUDE_CB = "https://claude.ai/api/mcp/auth_callback";

function fikenFake() {
  const calls: Array<{ url: string; body: URLSearchParams | null }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? new URLSearchParams(init.body) : null;
    calls.push({ url, body });
    if (url.endsWith("/oauth/token")) {
      if (body?.get("code") === "BAD" || body?.get("refresh_token") === "REVOKED") {
        return Response.json({ error: "invalid_grant", error_description: "no" }, { status: 400 });
      }
      const suffix = body?.get("grant_type") === "refresh_token" ? "2" : "1";
      return Response.json({ access_token: "FA" + suffix, refresh_token: "FR" + suffix, token_type: "bearer", expires_in: 86157 });
    }
    if (url.endsWith("/user")) return Response.json({ name: "Jonas", email: "jonas@example.com" });
    return new Response("unexpected " + url, { status: 500 });
  };
  return { fetchImpl, calls };
}

async function setup() {
  const fiken = fikenFake();
  const cfg = testConfig({ fetch: fiken.fetchImpl });
  const app = createApp(cfg);
  const reg = await app.request("/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [CLAUDE_CB] }),
  });
  const clientId = (await reg.json()).client_id as string;
  const codeBlob = signBlob(
    { k: "d", fc: "FIKENCODE", fs: "fstate", cc: pkceChallenge("verifier-123"), ru: CLAUDE_CB, exp: Math.floor(Date.now() / 1000) + 300 },
    cfg.keys,
  );
  return { app, cfg, clientId, codeBlob, fiken };
}

function form(fields: Record<string, string>) {
  return { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() };
}

describe("POST /token authorization_code", () => {
  it("exchanges a valid code and returns wrapped tokens with no-store", async () => {
    const { app, cfg, clientId, codeBlob, fiken } = await setup();
    const res = await app.request("/token", form({ grant_type: "authorization_code", code: codeBlob, code_verifier: "verifier-123", redirect_uri: CLAUDE_CB, client_id: clientId }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("pragma")).toBe("no-cache");
    const body = await res.json();
    expect(body.token_type).toBe("bearer");
    expect(body.expires_in).toBe(3600);
    const access = readAccessToken(cfg, body.access_token);
    expect(access.fikenAccessToken).toBe("FA1");
    expect(access.anonId).toMatch(/^[0-9a-f]{32}$/);
    expect(readRefreshToken(cfg, body.refresh_token)).toEqual({ fikenRefreshToken: "FR1", anonId: access.anonId });
    const tokenCall = fiken.calls.find((c) => c.url.endsWith("/oauth/token"));
    expect(tokenCall?.body?.get("code")).toBe("FIKENCODE");
    expect(tokenCall?.body?.get("state")).toBe("fstate");
    expect(fiken.calls.some((c) => c.url.endsWith("/user"))).toBe(true);
    expect((await cfg.usage.globalStats()).totalUsers).toBe(1);

    const codeBlob2 = signBlob(
      { k: "d", fc: "FIKENCODE", fs: "fstate", cc: pkceChallenge("verifier-123"), ru: CLAUDE_CB, exp: Math.floor(Date.now() / 1000) + 300 },
      cfg.keys,
    );
    const res2 = await app.request("/token", form({ grant_type: "authorization_code", code: codeBlob2, code_verifier: "verifier-123", redirect_uri: CLAUDE_CB, client_id: clientId }));
    expect(res2.status).toBe(200);
    expect((await cfg.usage.globalStats()).totalUsers).toBe(1);
  });

  it("rejects a wrong verifier, wrong redirect uri, wrong client, garbage code", async () => {
    const { app, codeBlob, clientId } = await setup();
    const base = { grant_type: "authorization_code", code: codeBlob, redirect_uri: CLAUDE_CB, client_id: clientId };
    expect((await app.request("/token", form({ ...base, code_verifier: "wrong" }))).status).toBe(400);
    expect((await app.request("/token", form({ ...base, code_verifier: "verifier-123", redirect_uri: "https://evil.example/cb" }))).status).toBe(400);
    expect((await app.request("/token", form({ ...base, code_verifier: "verifier-123", client_id: "garbage" }))).status).toBe(400);
    expect((await app.request("/token", form({ ...base, code_verifier: "verifier-123", code: "garbage" }))).status).toBe(400);
  });

  it("answers a JSON body with non-string fields with an OAuth error, not a crash", async () => {
    const { app, codeBlob, clientId } = await setup();
    const res = await app.request("/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "authorization_code", code: codeBlob, code_verifier: 123, redirect_uri: CLAUDE_CB, client_id: clientId }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");
    for (const body of ["null", "[]", '"x"', "{bad json"]) {
      const odd = await app.request("/token", { method: "POST", headers: { "content-type": "application/json" }, body });
      expect(odd.status).toBe(400);
      expect((await odd.json()).error).toBe("unsupported_grant_type");
    }
  });

  it("refuses an expired code, a code without exp, and a state blob presented as code", async () => {
    const { app, cfg, clientId } = await setup();
    const base = { grant_type: "authorization_code", code_verifier: "verifier-123", redirect_uri: CLAUDE_CB, client_id: clientId };
    const expired = signBlob({ k: "d", fc: "FIKENCODE", fs: "fs", cc: pkceChallenge("verifier-123"), ru: CLAUDE_CB, exp: Math.floor(Date.now() / 1000) - 1 }, cfg.keys);
    const res = await app.request("/token", form({ ...base, code: expired }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");

    const noExp = signBlob({ k: "d", fc: "FIKENCODE", fs: "fs", cc: pkceChallenge("verifier-123"), ru: CLAUDE_CB }, cfg.keys);
    expect((await app.request("/token", form({ ...base, code: noExp }))).status).toBe(400);

    const state = signBlob({ k: "s", ru: CLAUDE_CB, cc: pkceChallenge("verifier-123"), cs: "s", n: "n", exp: Math.floor(Date.now() / 1000) + 300 }, cfg.keys);
    expect((await app.request("/token", form({ ...base, code: state }))).status).toBe(400);
  });

  it("refuses a code whose redirect uri belongs to another registered client", async () => {
    const { app, codeBlob } = await setup();
    const chatgpt = "https://chatgpt.com/connector_platform_oauth_redirect";
    const reg = await app.request("/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [chatgpt] }) });
    const otherClient = (await reg.json()).client_id as string;
    const res = await app.request("/token", form({ grant_type: "authorization_code", code: codeBlob, code_verifier: "verifier-123", redirect_uri: CLAUDE_CB, client_id: otherClient }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");
  });

  it("re-checks the allowlist, so a client signed for a redirect uri that is no longer allowed cannot redeem a code", async () => {
    const { app, cfg } = await setup();
    const evil = "https://evil.example/cb";
    const evilClient = signBlob({ k: "c", ru: [evil], n: "Evil" }, cfg.keys);
    const evilCode = signBlob({ k: "d", fc: "FIKENCODE", fs: "fs", cc: pkceChallenge("verifier-123"), ru: evil, exp: Math.floor(Date.now() / 1000) + 300 }, cfg.keys);
    const res = await app.request("/token", form({ grant_type: "authorization_code", code: evilCode, code_verifier: "verifier-123", redirect_uri: evil, client_id: evilClient }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");
  });

  it("relays Fiken's invalid_grant", async () => {
    const { app, cfg, clientId } = await setup();
    const bad = signBlob({ k: "d", fc: "BAD", fs: "s", cc: pkceChallenge("v"), ru: CLAUDE_CB, exp: Math.floor(Date.now() / 1000) + 300 }, cfg.keys);
    const res = await app.request("/token", form({ grant_type: "authorization_code", code: bad, code_verifier: "v", redirect_uri: CLAUDE_CB, client_id: clientId }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");
  });
});

describe("POST /token authorization_code with a client id metadata document", () => {
  const DOC_URL = "https://claude.ai/.well-known/mcp-client.json";

  /** Fiken's fake endpoints plus the published identity document at DOC_URL. */
  function cimdSetup(redirectUris: string[]) {
    const fiken = fikenFake();
    const doc = { client_id: DOC_URL, client_name: "Claude", redirect_uris: redirectUris };
    const cfg = testConfig({ fetch: async (input, init) => (String(input) === DOC_URL ? Response.json(doc) : fiken.fetchImpl(input, init)) });
    const codeBlob = signBlob(
      { k: "d", fc: "FIKENCODE", fs: "fstate", cc: pkceChallenge("verifier-123"), ru: CLAUDE_CB, exp: Math.floor(Date.now() / 1000) + 300 },
      cfg.keys,
    );
    return { app: createApp(cfg), cfg, codeBlob };
  }

  beforeEach(() => clearCimdCache());

  it("exchanges a code for a client that published its identity", async () => {
    const { app, cfg, codeBlob } = cimdSetup([CLAUDE_CB]);
    const res = await app.request("/token", form({ grant_type: "authorization_code", code: codeBlob, code_verifier: "verifier-123", redirect_uri: CLAUDE_CB, client_id: DOC_URL }));
    expect(res.status).toBe(200);
    expect(readAccessToken(cfg, (await res.json()).access_token).fikenAccessToken).toBe("FA1");
  });

  it("refuses a code whose redirect uri the document does not list", async () => {
    const { app, codeBlob } = cimdSetup(["https://chatgpt.com/connector_platform_oauth_redirect"]);
    const res = await app.request("/token", form({ grant_type: "authorization_code", code: codeBlob, code_verifier: "verifier-123", redirect_uri: CLAUDE_CB, client_id: DOC_URL }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");
  });
});

describe("POST /token refresh_token", () => {
  it("refreshes with Fiken on every renewal and keeps the anonymous id", async () => {
    const { app, cfg, clientId, codeBlob, fiken } = await setup();
    const first = await (await app.request("/token", form({ grant_type: "authorization_code", code: codeBlob, code_verifier: "verifier-123", redirect_uri: CLAUDE_CB, client_id: clientId }))).json();
    const before = fiken.calls.length;
    const res = await app.request("/token", form({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: clientId }));
    expect(res.status).toBe(200);
    const refreshCall = fiken.calls.slice(before).find((c) => c.body?.get("grant_type") === "refresh_token");
    expect(refreshCall?.body?.get("refresh_token")).toBe("FR1");
    const body = await res.json();
    expect(readAccessToken(cfg, body.access_token)).toMatchObject({ fikenAccessToken: "FA2", anonId: readAccessToken(cfg, first.access_token).anonId });
    expect(readRefreshToken(cfg, body.refresh_token).fikenRefreshToken).toBe("FR2");
  });

  it("relays invalid_grant when Fiken has revoked the grant", async () => {
    const { app, cfg } = await setup();
    const revoked = issueTokens(cfg, { access_token: "x", refresh_token: "REVOKED", expires_in: 1 }, "anon", 0);
    const bad = await app.request("/token", form({ grant_type: "refresh_token", refresh_token: revoked.refresh_token }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("invalid_grant");
  });

  it("rejects unknown grant types", async () => {
    const { app } = await setup();
    const res = await app.request("/token", form({ grant_type: "password" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("unsupported_grant_type");
  });
});
