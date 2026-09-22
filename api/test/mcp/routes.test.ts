import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { issueTokens } from "../../src/auth/tokens.js";
import { testConfig } from "../../src/config.js";

let fikenCalls = 0;
const cfg = testConfig({
  fetch: async (input) => {
    fikenCalls++;
    if (String(input).endsWith("/companies")) return Response.json([{ name: "A", slug: "a", organizationNumber: "1" }]);
    return new Response("unexpected", { status: 500 });
  },
});
const app = createApp(cfg);
const token = issueTokens(cfg, { access_token: "FA", refresh_token: "FR", expires_in: 3600 }, "anon").access_token;

function rpc(body: unknown, auth = `Bearer ${token}`) {
  return app.request("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(auth ? { authorization: auth } : {}) },
    body: JSON.stringify(body),
  });
}

describe("POST /mcp", () => {
  it("rejects missing and invalid bearer tokens before doing any work", async () => {
    const before = fikenCalls;
    const missing = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_companies", arguments: {} } }, "");
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBe('Bearer resource_metadata="https://fiken-mcp.test/.well-known/oauth-protected-resource"');
    const bad = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_companies", arguments: {} } }, "Bearer nope");
    expect(bad.status).toBe(401);
    expect(fikenCalls).toBe(before);
  });

  it("answers initialize and tools/call as JSON", async () => {
    const init = await rpc({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    });
    expect(init.status).toBe(200);
    expect(init.headers.get("content-type")).toContain("application/json");
    expect((await init.json()).result.serverInfo.name).toBe("fiken-mcp");

    const call = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_companies", arguments: {} } });
    expect(call.status).toBe(200);
    const body = await call.json();
    expect(JSON.parse(body.result.content[0].text)).toEqual([{ name: "A", slug: "a", organizationNumber: "1" }]);
  });

  it("returns 405 for GET and DELETE", async () => {
    expect((await app.request("/mcp", { headers: { authorization: `Bearer ${token}` } })).status).toBe(405);
    expect((await app.request("/mcp", { method: "DELETE", headers: { authorization: `Bearer ${token}` } })).status).toBe(405);
  });
});
