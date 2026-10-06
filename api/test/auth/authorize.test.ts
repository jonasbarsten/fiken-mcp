import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { clearCimdCache } from "../../src/auth/cimd.js";
import { testConfig } from "../../src/config.js";
import { keyRingFromParameter, signBlob, verifyBlob } from "../../src/crypto/blob.js";
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

const LOGIN_COOKIE = "__Host-fmcp_login";

/** Parses the login cookie's value out of a Set-Cookie header. */
function loginCookieValue(res: Response): string {
  const header = res.headers.get("set-cookie") ?? "";
  const m = new RegExp(`(?:^|, ?)${LOGIN_COOKIE}=([^;]*)`).exec(header);
  return m?.[1] ?? "";
}

const get = (p: Record<string, string>, target = app) => target.request(`/authorize?${new URLSearchParams(p)}`);
const post = (p: Record<string, string>, cookie?: string, target = app) =>
  target.request("/authorize", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(p).toString(),
  });

/** What a browser holds after viewing the consent page: the login cookie and the nonce field the form will echo. */
async function consent(p: Record<string, string>, target = app) {
  const res = await get(p, target);
  const html = await res.text();
  const nonce = /name="nonce" value="([^"]+)"/.exec(html)?.[1] ?? "";
  return { res, html, nonce, cookie: `${LOGIN_COOKIE}=${loginCookieValue(res)}` };
}

/** Presses "Fortsett" the way a browser does: consent page first, then the form post with cookie and nonce. */
async function pressContinue(p: Record<string, string>, target = app) {
  const seen = await consent(p, target);
  return { seen, res: await post({ ...p, nonce: seen.nonce }, seen.cookie, target) };
}

describe("GET /authorize (consent)", () => {
  it("renders a consent page naming the client, with the parameters as hidden fields, escaped", async () => {
    const res = await get(params(await register()));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("content-security-policy")).toContain("form-action 'self';");
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

  it("issues the login nonce as a __Host- cookie and as a hidden field", async () => {
    const { res, html, nonce } = await consent(params(await register()));
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(html).toContain(`name="nonce" value="${nonce}"`);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(new RegExp(`^${LOGIN_COOKIE}=${nonce}; `));
    for (const attr of ["Max-Age=3600", "Path=/", "HttpOnly", "Secure", "SameSite=Lax"]) expect(cookie).toContain(attr);
    expect(cookie).not.toMatch(/Domain=/i);
    const again = await consent(params(await register()));
    expect(again.nonce).not.toBe(nonce);
  });

  it("does not repeat the client name when the label already says it", async () => {
    const html = await (await get(params(await register("Claude")))).text();
    expect(html).toContain("<strong>Claude (claude.ai)</strong>");
    expect(html).not.toContain("via");
  });

  it("rejects an unregistered redirect uri, a bad client id and a missing challenge", async () => {
    expect((await get(params(await register(), { redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect" }))).status).toBe(400);
    expect((await get(params("garbage"))).status).toBe(400);
    expect((await get(params(await register(), { code_challenge_method: "plain" }))).status).toBe(400);
  });

  it("accepts a loopback redirect on any port when the client registered it without one (ChatGPT Desktop)", async () => {
    const res = await app.request("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Codex", redirect_uris: ["http://127.0.0.1/callback/abc"] }),
    });
    const clientId = (await res.json()).client_id as string;
    expect((await get(params(clientId, { redirect_uri: "http://127.0.0.1:61234/callback/abc" }))).status).toBe(200);
    expect((await get(params(clientId, { redirect_uri: "http://127.0.0.1:61234/callback/other" }))).status).toBe(400);
  });

  it("re-checks the allowlist, so a client id signed for a redirect uri that is no longer allowed is refused", async () => {
    const evil = "https://evil.example/cb";
    const clientId = signBlob({ k: "c", ru: [evil], n: "Evil" }, cfg.keys);
    expect((await get(params(clientId, { redirect_uri: evil }))).status).toBe(400);
    expect((await post(params(clientId, { redirect_uri: evil }))).status).toBe(400);
  });

  it("refuses a client id signed under a kid that is not in the ring", async () => {
    const otherRing = keyRingFromParameter(`t9:${"9".repeat(64)}`);
    const clientId = signBlob({ k: "c", ru: [CLAUDE_CB], n: "x" }, otherRing);
    expect((await get(params(clientId))).status).toBe(400);
  });
});

/** The Fiken URL the continue page navigates to, from its meta refresh. */
function fikenUrlFrom(html: string): string {
  const m = /<meta http-equiv="refresh" content="0;url=([^"]+)">/.exec(html);
  if (!m) throw new Error("no meta refresh in continue page");
  return m[1]!.replace(/&amp;/g, "&");
}

describe("POST /authorize", () => {
  it("answers with a page that sends the browser to Fiken with a signed one-hour state bound to the login cookie", async () => {
    const { seen, res } = await pressContinue(params(await register()));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    // A page, not a redirect: Chrome would check a redirect chain against form-action.
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("content-security-policy")).toContain("form-action 'self';");
    const html = await res.text();
    expect(html).toContain("Klikk her hvis du ikke blir sendt videre");
    const loc = new URL(fikenUrlFrom(html));
    expect(loc.origin + loc.pathname).toBe("https://fiken.test/oauth/authorize");
    expect(loc.searchParams.get("client_id")).toBe("test-client-id");
    expect(loc.searchParams.get("redirect_uri")).toBe("https://fiken-mcp.test/callback");
    const state = verifyBlob<Record<string, unknown>>(loc.searchParams.get("state")!, cfg.keys);
    expect(state).toMatchObject({ k: "s", ru: CLAUDE_CB, cc: pkceChallenge("verifier-123"), cs: "client-state" });
    expect(state.exp as number).toBeGreaterThan(Date.now() / 1000 + 3500);
    expect(state.n).toBe(seen.nonce);
  });

  it("refuses a form post that does not carry the consent page's cookie and nonce (CSRF)", async () => {
    const p = params(await register());
    const seen = await consent(p);
    expect((await post({ ...p, nonce: seen.nonce })).status).toBe(400); // no cookie: a cross-site post under SameSite=Lax
    expect((await post(p, seen.cookie)).status).toBe(400); // no field
    expect((await post({ ...p, nonce: "x".repeat(22) }, seen.cookie)).status).toBe(400); // wrong field
    const other = await consent(params(await register()));
    expect((await post({ ...p, nonce: seen.nonce }, other.cookie)).status).toBe(400); // another browser's cookie
    expect((await post({ ...p, nonce: seen.nonce }, seen.cookie)).status).toBe(200);
  });

  it("re-validates everything", async () => {
    expect((await pressContinue(params("garbage"))).res.status).toBe(400);
    const p = params(await register());
    const seen = await consent(p);
    expect((await post({ ...p, redirect_uri: "https://evil.example/cb", nonce: seen.nonce }, seen.cookie)).status).toBe(400);
  });
});

describe("GET /callback", () => {
  /** Runs POST /authorize and returns what the browser carries to /callback: Fiken's state and our login cookie. */
  async function login() {
    const { seen, res } = await pressContinue(params(await register()));
    return { fs: new URL(fikenUrlFrom(await res.text())).searchParams.get("state")!, cookie: seen.cookie };
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

  it("refuses a state signed without exp or with a non-string client state", async () => {
    const noExp = signBlob({ k: "s", ru: CLAUDE_CB, cc: "c", cs: "s", n: "nonce" }, cfg.keys);
    expect((await callback(`code=x&state=${encodeURIComponent(noExp)}`, `${LOGIN_COOKIE}=nonce`)).status).toBe(400);
    const badCs = signBlob({ k: "s", ru: CLAUDE_CB, cc: "c", cs: 42, n: "nonce", exp: Math.floor(Date.now() / 1000) + 60 }, cfg.keys);
    expect((await callback(`code=x&state=${encodeURIComponent(badCs)}`, `${LOGIN_COOKIE}=nonce`)).status).toBe(400);
  });

  it("refuses a client id blob presented as state", async () => {
    const clientId = await register();
    const res = await callback(`code=x&state=${encodeURIComponent(clientId)}`, `${LOGIN_COOKIE}=nonce`);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Invalid login state");
  });
});

describe("a client id metadata document as client_id", () => {
  const DOC_URL = "https://claude.ai/.well-known/mcp-client.json";

  /** Serves the published identity document; anything else behaves like the default test config. */
  function serving(redirectUris: string[]) {
    const doc = { client_id: DOC_URL, client_name: "Claude", redirect_uris: redirectUris };
    const cfg = testConfig({
      fetch: async (input) => (String(input) === DOC_URL ? Response.json(doc) : new Response("unexpected fetch", { status: 500 })),
    });
    return { cfg, app: createApp(cfg) };
  }
  const claude = serving([CLAUDE_CB]);

  beforeEach(() => clearCimdCache());

  it("renders the consent page for a published identity", async () => {
    const res = await get(params(DOC_URL), claude.app);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Claude (claude.ai)");
  });

  it("refuses a redirect uri the document does not list", async () => {
    const res = await get(params(DOC_URL, { redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect" }), claude.app);
    expect(res.status).toBe(400);
  });

  it("re-checks our allowlist, so a document listing a redirect uri we do not allow is refused", async () => {
    const evil = "https://evil.example/cb";
    const res = await get(params(DOC_URL, { redirect_uri: evil }), serving([evil]).app);
    expect(res.status).toBe(400);
  });

  it("carries the published identity through consent, form post and callback", async () => {
    const { seen, res } = await pressContinue(params(DOC_URL), claude.app);
    expect(res.status).toBe(200);
    const fs = new URL(fikenUrlFrom(await res.text())).searchParams.get("state")!;
    const cb = await claude.app.request(`/callback?code=FIKENCODE&state=${encodeURIComponent(fs)}`, { headers: { cookie: seen.cookie } });
    expect(cb.status).toBe(302);
    const loc = new URL(cb.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe(CLAUDE_CB);
    expect(verifyBlob<Record<string, unknown>>(loc.searchParams.get("code")!, claude.cfg.keys)).toMatchObject({ k: "d", fc: "FIKENCODE", ru: CLAUDE_CB });
  });
});
