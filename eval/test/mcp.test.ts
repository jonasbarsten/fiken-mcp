import { describe, expect, it } from "vitest";
import { LOGIN_EXPIRED, MemoryOAuthProvider, retryOn503 } from "../src/mcp.js";

describe("retryOn503", () => {
  it("retries once after a 503, with the same request", async () => {
    const seen: Array<[string, string | undefined]> = [];
    const statuses = [503, 200];
    const f = retryOn503(async (input, init) => {
      seen.push([String(input), init?.body as string | undefined]);
      return new Response("", { status: statuses.shift() ?? 200 });
    }, async () => {});
    const res = await f("https://x/mcp", { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    expect(seen).toEqual([["https://x/mcp", "{}"], ["https://x/mcp", "{}"]]);
  });
  it("gives up after one retry and passes other statuses through", async () => {
    let calls = 0;
    const f = retryOn503(async () => {
      calls++;
      return new Response("", { status: 503 });
    }, async () => {});
    expect((await f("https://x", {})).status).toBe(503);
    expect(calls).toBe(2);
  });
});

describe("MemoryOAuthProvider", () => {
  it("keeps everything in memory and opens the browser for authorization", () => {
    const opened: string[] = [];
    const p = new MemoryOAuthProvider("http://127.0.0.1:5000/callback", (u) => opened.push(u.toString()));
    expect(p.redirectUrl).toBe("http://127.0.0.1:5000/callback");
    expect(p.clientMetadata.redirect_uris).toEqual(["http://127.0.0.1:5000/callback"]);
    p.saveCodeVerifier("v");
    expect(p.codeVerifier()).toBe("v");
    expect(p.tokens()).toBeUndefined();
    p.redirectToAuthorization(new URL("https://api.test/authorize?x=1"));
    expect(opened).toEqual(["https://api.test/authorize?x=1"]);
  });

  it("after login, a new authorization stops the run instead of opening another tab", () => {
    const opened: string[] = [];
    const p = new MemoryOAuthProvider("http://127.0.0.1:5000/callback", (u) => opened.push(u.toString()));
    p.loggedIn();
    expect(() => p.redirectToAuthorization(new URL("https://api.test/authorize"))).toThrow(LOGIN_EXPIRED);
    expect(opened).toEqual([]);
  });
});
