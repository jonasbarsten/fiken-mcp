import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { testConfig } from "../../src/config.js";
import { signBlob, verifyBlob } from "../../src/crypto/blob.js";
import { pkceChallenge } from "../../src/crypto/pkce.js";

const cfg = testConfig();
const app = createApp(cfg);
const CLAUDE_CB = "https://claude.ai/api/mcp/auth_callback";

async function register(name = "Claude <b>x</b>") {
  const res = await app.request("/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: name, redirect_uris: [CLAUDE_CB] }),
  });
  return (await res.json()).client_id as string;
}

function params(clientId: string, overrides: Record<string, string> = {}) {
  return {
    response_type: "code",
    client_id: clientId,
    redirect_uri: CLAUDE_CB,
    code_challenge: pkceChallenge("verifier-123"),
    code_challenge_method: "S256",
    state: "client-state",
    ...overrides,
  };
}

const get = (p: Record<string, string>) => app.request(`/authorize?${new URLSearchParams(p)}`);
const post = (p: Record<string, string>) =>
  app.request("/authorize", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(p).toString() });

describe("GET /authorize (consent)", () => {
  it("renders a consent page naming the client, with the parameters as hidden fields, escaped", async () => {
    const res = await get(params(await register()));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await res.text();
    expect(html).toContain("Claude (claude.ai)");
    expect(html).toContain("Claude &lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain('name="code_challenge"');
    expect(html).toContain('action="/authorize"');
    expect(html).toContain("fiken.no");
    expect(html).toContain("error=access_denied");
    expect(html).toContain("state=client-state");
    expect(html).not.toContain("javascript:");
  });

  it("rejects an unregistered redirect uri, a bad client id and a missing challenge", async () => {
    expect((await get(params(await register(), { redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect" }))).status).toBe(400);
    expect((await get(params("garbage"))).status).toBe(400);
    expect((await get(params(await register(), { code_challenge_method: "plain" }))).status).toBe(400);
  });
});

const LOGIN_COOKIE = "__Host-fmcp_login";

/** Parses the login cookie's value out of a Set-Cookie header. */
function loginCookieValue(res: Response): string {
  const header = res.headers.get("set-cookie") ?? "";
  const m = new RegExp(`(?:^|, ?)${LOGIN_COOKIE}=([^;]*)`).exec(header);
  return m?.[1] ?? "";
}

describe("POST /authorize", () => {
  it("redirects to Fiken with a signed one-hour state bound to a __Host- cookie", async () => {
    const res = await post(params(await register()));
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://fiken.test/oauth/authorize");
    expect(loc.searchParams.get("client_id")).toBe("test-client-id");
    expect(loc.searchParams.get("redirect_uri")).toBe("https://fiken-mcp.test/callback");
    const state = verifyBlob<Record<string, unknown>>(loc.searchParams.get("state")!, cfg.keys);
    expect(state).toMatchObject({ k: "s", ru: CLAUDE_CB, cc: pkceChallenge("verifier-123"), cs: "client-state" });
    expect(state.exp as number).toBeGreaterThan(Date.now() / 1000 + 3500);

    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(new RegExp(`^${LOGIN_COOKIE}=[A-Za-z0-9_-]{22}; `));
    for (const attr of ["Max-Age=3600", "Path=/", "HttpOnly", "Secure", "SameSite=Lax"]) expect(cookie).toContain(attr);
    expect(cookie).not.toMatch(/Domain=/i);
    expect(state.n).toBe(loginCookieValue(res));
  });

  it("uses a fresh nonce per login", async () => {
    const [a, b] = await Promise.all([post(params(await register())), post(params(await register()))]);
    expect(loginCookieValue(a)).not.toBe(loginCookieValue(b));
  });

  it("re-validates everything", async () => {
    expect((await post(params("garbage"))).status).toBe(400);
    expect((await post(params(await register(), { redirect_uri: "https://evil.example/cb" }))).status).toBe(400);
  });
});

describe("GET /callback", () => {
  /** Runs POST /authorize and returns what the browser carries to /callback: Fiken's state and our login cookie. */
  async function login() {
    const res = await post(params(await register()));
    return { fs: new URL(res.headers.get("location")!).searchParams.get("state")!, cookie: `${LOGIN_COOKIE}=${loginCookieValue(res)}` };
  }
  const callback = (query: string, cookie?: string) => app.request(`/callback?${query}`, { headers: cookie ? { cookie } : {} });

  it("wraps Fiken's code, returns the user to the client and clears the login cookie", async () => {
    const { fs, cookie } = await login();
    const res = await callback(`code=FIKENCODE&state=${encodeURIComponent(fs)}`, cookie);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe(CLAUDE_CB);
    expect(loc.searchParams.get("state")).toBe("client-state");
    const code = verifyBlob<Record<string, unknown>>(loc.searchParams.get("code")!, cfg.keys);
    expect(code).toMatchObject({ k: "d", fc: "FIKENCODE", fs, cc: pkceChallenge("verifier-123"), ru: CLAUDE_CB });
    expect(code.exp as number).toBeLessThan(Date.now() / 1000 + 301);
    const cleared = res.headers.get("set-cookie") ?? "";
    expect(cleared).toMatch(new RegExp(`^${LOGIN_COOKIE}=; `));
    expect(cleared).toContain("Max-Age=0");
  });

  it("passes Fiken's error back to the client", async () => {
    const { fs, cookie } = await login();
    const res = await callback(`error=access_denied&state=${encodeURIComponent(fs)}`, cookie);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("error")).toBe("access_denied");
    expect(loc.searchParams.get("state")).toBe("client-state");
  });

  it("shows an error page for a tampered or expired state", async () => {
    expect((await callback("code=x&state=bad")).status).toBe(400);
    const expired = signBlob({ k: "s", ru: CLAUDE_CB, cc: "c", cs: "s", n: "x", exp: 1 }, cfg.keys);
    const res = await callback(`code=x&state=${encodeURIComponent(expired)}`, `${LOGIN_COOKIE}=x`);
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/expired/i);
  });

  it("refuses a callback without the login cookie", async () => {
    const { fs } = await login();
    const res = await callback(`code=FIKENCODE&state=${encodeURIComponent(fs)}`);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Invalid login state");
  });

  it("refuses a callback whose cookie does not match the state", async () => {
    const { fs } = await login();
    const other = await login();
    const wrong = await callback(`code=FIKENCODE&state=${encodeURIComponent(fs)}`, other.cookie);
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).toContain("Invalid login state");
    const shortValue = await callback(`code=FIKENCODE&state=${encodeURIComponent(fs)}`, `${LOGIN_COOKIE}=abc`);
    expect(shortValue.status).toBe(400);
  });

  it("refuses a state signed without a nonce", async () => {
    const noNonce = signBlob({ k: "s", ru: CLAUDE_CB, cc: "c", cs: "s", exp: Math.floor(Date.now() / 1000) + 60 }, cfg.keys);
    expect((await callback(`code=x&state=${encodeURIComponent(noNonce)}`, `${LOGIN_COOKIE}=`)).status).toBe(400);
  });
});
