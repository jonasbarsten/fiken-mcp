import { describe, expect, it } from "vitest";
import { testConfig } from "../../src/config.js";
import { FikenOAuthError, exchangeFikenCode, fetchFikenUser, fikenAuthorizeUrl, refreshFikenToken } from "../../src/fiken/oauth.js";

function capture(response: Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const cfg = testConfig({
    fetch: async (input, init) => {
      calls.push({ url: String(input), init });
      return response;
    },
  });
  return { cfg, calls };
}

describe("fikenAuthorizeUrl", () => {
  it("builds the authorize url", () => {
    const url = new URL(fikenAuthorizeUrl(testConfig(), "st"));
    expect(url.origin + url.pathname).toBe("https://fiken.test/oauth/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("test-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe("https://fiken-mcp.test/callback");
    expect(url.searchParams.get("state")).toBe("st");
  });
});

describe("exchangeFikenCode", () => {
  it("posts form data with basic auth", async () => {
    const { cfg, calls } = capture(Response.json({ access_token: "a", refresh_token: "r", token_type: "bearer", expires_in: 86157 }));
    const tokens = await exchangeFikenCode(cfg, "CODE", "ST");
    expect(tokens).toEqual({ access_token: "a", refresh_token: "r", expires_in: 86157 });
    expect(calls[0]?.url).toBe("https://fiken.test/oauth/token");
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("authorization")).toBe("Basic " + Buffer.from("test-client-id:test-client-secret").toString("base64"));
    expect(headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    const body = new URLSearchParams(String(calls[0]?.init?.body));
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("CODE");
    expect(body.get("state")).toBe("ST");
    expect(body.get("redirect_uri")).toBe("https://fiken-mcp.test/callback");
  });

  it("surfaces Fiken's oauth error", async () => {
    const { cfg } = capture(Response.json({ error: "invalid_grant", error_description: "expired" }, { status: 400 }));
    const p = exchangeFikenCode(cfg, "x", "y");
    p.catch(() => {}); // Suppress unhandled rejection
    try {
      await p;
      expect.fail("should have thrown");
    } catch (err: any) {
      expect(err).toMatchObject({ error: "invalid_grant", description: "expired" });
      expect(err).toBeInstanceOf(FikenOAuthError);
    }
  });
});

describe("refreshFikenToken", () => {
  it("posts grant_type=refresh_token", async () => {
    const { cfg, calls } = capture(Response.json({ access_token: "a2", refresh_token: "r2", expires_in: 100 }));
    expect(await refreshFikenToken(cfg, "r1")).toEqual({ access_token: "a2", refresh_token: "r2", expires_in: 100 });
    const body = new URLSearchParams(String(calls[0]?.init?.body));
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("r1");
  });
});

describe("fetchFikenUser", () => {
  it("gets /user with the bearer token", async () => {
    const { cfg, calls } = capture(Response.json({ name: "Test", email: "t@x.no" }));
    expect(await fetchFikenUser(cfg, "tok")).toEqual({ name: "Test", email: "t@x.no" });
    expect(calls[0]?.url).toBe("https://api.fiken.test/api/v2/user");
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer tok");
  });
});
