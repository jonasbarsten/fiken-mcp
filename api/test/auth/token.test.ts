import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
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
    expect(readRefreshToken(cfg, body.refresh_token)).toMatchObject({ fikenRefreshToken: "FR1", fikenAccessToken: "FA1", anonId: access.anonId });
    const tokenCall = fiken.calls.find((c) => c.url.endsWith("/oauth/token"));
    expect(tokenCall?.body?.get("code")).toBe("FIKENCODE");
    expect(tokenCall?.body?.get("state")).toBe("fstate");
    expect(fiken.calls.some((c) => c.url.endsWith("/user"))).toBe(true);
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

  it("relays Fiken's invalid_grant", async () => {
    const { app, cfg, clientId } = await setup();
    const bad = signBlob({ k: "d", fc: "BAD", fs: "s", cc: pkceChallenge("v"), ru: CLAUDE_CB, exp: Math.floor(Date.now() / 1000) + 300 }, cfg.keys);
    const res = await app.request("/token", form({ grant_type: "authorization_code", code: bad, code_verifier: "v", redirect_uri: CLAUDE_CB, client_id: clientId }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");
  });
});

describe("POST /token refresh_token", () => {
  it("renews without calling Fiken while the wrapped token is fresh", async () => {
    const { app, cfg, clientId, codeBlob, fiken } = await setup();
    const first = await (await app.request("/token", form({ grant_type: "authorization_code", code: codeBlob, code_verifier: "verifier-123", redirect_uri: CLAUDE_CB, client_id: clientId }))).json();
    const before = fiken.calls.length;
    const res = await app.request("/token", form({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: clientId }));
    expect(res.status).toBe(200);
    expect(fiken.calls.length).toBe(before);
    const body = await res.json();
    expect(readAccessToken(cfg, body.access_token)).toMatchObject({ fikenAccessToken: "FA1", anonId: readAccessToken(cfg, first.access_token).anonId });
  });

  it("calls Fiken when the wrapped token is old, and relays invalid_grant when revoked", async () => {
    const { app, cfg } = await setup();
    const old = issueTokens(cfg, { access_token: "FA0", refresh_token: "FR0", expires_in: 100 }, "anon", Math.floor(Date.now() / 1000) - 50);
    const res = await app.request("/token", form({ grant_type: "refresh_token", refresh_token: old.refresh_token }));
    expect(res.status).toBe(200);
    expect(readAccessToken(cfg, (await res.json()).access_token).fikenAccessToken).toBe("FA2");

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
