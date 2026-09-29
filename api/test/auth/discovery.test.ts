import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { readClientId } from "../../src/auth/clients.js";
import { testConfig } from "../../src/config.js";

const cfg = testConfig();
const app = createApp(cfg);

describe("security headers", () => {
  it("sets HSTS and nosniff on every response", async () => {
    const res = await app.request("/");
    expect(res.headers.get("strict-transport-security")).toContain("max-age=");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("discovery", () => {
  it("serves protected resource metadata", async () => {
    const res = await app.request("/.well-known/oauth-protected-resource");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      resource: "https://fiken-mcp.test/mcp",
      authorization_servers: ["https://fiken-mcp.test"],
      bearer_methods_supported: ["header"],
    });
  });

  it("serves authorization server metadata", async () => {
    const res = await app.request("/.well-known/oauth-authorization-server");
    expect(await res.json()).toEqual({
      issuer: "https://fiken-mcp.test",
      authorization_endpoint: "https://fiken-mcp.test/authorize",
      token_endpoint: "https://fiken-mcp.test/token",
      registration_endpoint: "https://fiken-mcp.test/register",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      client_id_metadata_document_supported: true,
    });
  });
});

describe("register", () => {
  const post = (body: unknown) =>
    app.request("/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("returns a signed client id carrying the redirect uris and name", async () => {
    const res = await post({ client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.redirect_uris).toEqual(["https://claude.ai/api/mcp/auth_callback"]);
    expect(body.token_endpoint_auth_method).toBe("none");
    expect(body.client_secret).toBeUndefined();
    expect(readClientId(cfg, body.client_id)).toEqual({ redirectUris: ["https://claude.ai/api/mcp/auth_callback"], name: "Claude" });
  });

  it("rejects redirect uris outside the allowlist", async () => {
    const bad = await post({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback", "https://evil.example/cb"] });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("invalid_redirect_uri");
  });

  it("rejects missing redirect uris", async () => {
    const res = await post({ client_name: "x" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_client_metadata");
  });
});
