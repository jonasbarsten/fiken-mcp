import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { testConfig } from "../src/config.js";
import { signBlob } from "../src/crypto/blob.js";
import { pkceChallenge } from "../src/crypto/pkce.js";

const CLAUDE_CB = "https://claude.ai/api/mcp/auth_callback";
const SECRET_BODY = "user-lookup-failed-with-secret-details";

function captureStdout() {
  const lines: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  return { lines, json: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

/** Fiken that exchanges the code fine but fails /user with a body we must never log. */
function fikenFailingUser() {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/oauth/token")) return Response.json({ access_token: "FA1", refresh_token: "FR1", token_type: "bearer", expires_in: 86157 });
    if (url.endsWith("/user")) return new Response(SECRET_BODY, { status: 500 });
    return new Response("unexpected", { status: 500 });
  };
  return fetchImpl;
}

describe("app", () => {
  afterEach(() => vi.restoreAllMocks());

  it("turns an unexpected error into a bare 500 and logs neither the body nor any token", async () => {
    const cfg = testConfig({ fetch: fikenFailingUser() });
    const app = createApp(cfg);
    const reg = await app.request("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [CLAUDE_CB] }),
    });
    const clientId = (await reg.json()).client_id as string;
    const code = signBlob({ k: "d", fc: "FIKENCODE", fs: "fs", cc: pkceChallenge("verifier-123"), ru: CLAUDE_CB, exp: Math.floor(Date.now() / 1000) + 300 }, cfg.keys);

    const out = captureStdout();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await app.request("/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: "verifier-123", redirect_uri: CLAUDE_CB, client_id: clientId }).toString(),
    });
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Internal error");
    expect(errorSpy).not.toHaveBeenCalled();

    const all = out.lines.join("");
    expect(all).not.toContain(SECRET_BODY);
    expect(all).not.toContain("Bearer");
    expect(all).not.toContain("FA1");
    expect(all).not.toContain(code);
    const events = out.json();
    expect(events.find((e) => e.event === "error")).toMatchObject({ route: "/token", method: "POST", name: "Error" });
    expect(events.find((e) => e.event === "request")).toMatchObject({ route: "/token", method: "POST", status: 500 });
  });

  it("writes one request line per request with id, method, route, status and duration", async () => {
    const app = createApp(testConfig());
    const out = captureStdout();
    expect((await app.request("/")).status).toBe(200);
    expect((await app.request("/nope")).status).toBe(404);
    const events = out.json();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ event: "request", method: "GET", route: "/", status: 200 });
    expect(events[1]).toMatchObject({ event: "request", method: "GET", route: "/nope", status: 404 });
    for (const e of events) {
      expect(typeof e.ms).toBe("number");
      expect(typeof e.requestId).toBe("string");
      expect((e.requestId as string).length).toBeGreaterThan(0);
    }
    expect(events[0]!.requestId).not.toBe(events[1]!.requestId);
  });

  it("uses the API Gateway request id when running behind the Lambda adapter", async () => {
    const app = createApp(testConfig());
    const out = captureStdout();
    await app.request("/", {}, { requestContext: { requestId: "apigw-req-1" } });
    expect(out.json()[0]).toMatchObject({ event: "request", requestId: "apigw-req-1" });
  });

  it("never logs the query string or headers, and survives a path that looks like a secret", async () => {
    const app = createApp(testConfig());
    const out = captureStdout();
    await app.request("/callback?code=v1.k1.aaaa.bbbb&state=v1.k1.cccc.dddd", { headers: { authorization: "Bearer topsecret", cookie: "x=1" } });
    const res = await app.request("/v1.k1.aaaa.bbbb");
    expect(res.status).toBe(404);
    const all = out.lines.join("");
    expect(all).not.toContain("topsecret");
    expect(all).not.toContain("v1.k1");
    expect(all).not.toContain("x=1");
    expect(out.json()).toHaveLength(2);
    expect(out.json()[1]).toMatchObject({ event: "request", status: 404, route: "(unloggable)" });
  });
});
