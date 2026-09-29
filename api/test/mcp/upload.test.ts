import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { testConfig } from "../../src/config.js";
import { FikenQueue, createFikenClient } from "../../src/fiken/client.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { memoryUsageStore } from "../../src/usage/memory.js";
import { UPLOAD_TICKET_SECONDS, readUploadTicket } from "../../src/upload/ticket.js";
import { farFutureExp } from "./helpers.js";

async function connectedWithUrl(exp = farFutureExp()) {
  const fiken = createFikenClient({
    baseUrl: "https://api.test/v2",
    accessToken: "tok",
    fetch: async () => new Response("x", { status: 500 }),
    queue: new FikenQueue(0),
  });
  const server = createMcpServer(
    { fiken, anonId: "anon", fikenAccessToken: "tok", exp, usage: memoryUsageStore(), session: { fikenUnauthorized: false, wrote: false } },
    "https://fiken-mcp.test",
    testConfig(),
  );
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(ct);
  return client;
}

describe("upload tools", () => {
  it("upload_receipts returns a ticket bound to the company and points at the stable widget resource", async () => {
    const c = await connectedWithUrl();
    const tool = (await c.listTools()).tools.find((t) => t.name === "upload_receipts")!;
    expect((tool._meta as { ui: { resourceUri: string } }).ui.resourceUri).toBe("ui://fiken-mcp/upload.html");
    const r = await c.callTool({ name: "upload_receipts", arguments: { companySlug: "demo" } });
    const sc = r.structuredContent as { uploadUrl: string; ticket: string; companySlug: string; expiresInSeconds: number };
    expect(sc.uploadUrl).toBe("https://fiken-mcp.test/upload");
    expect(sc.companySlug).toBe("demo");
    expect(sc.expiresInSeconds).toBe(UPLOAD_TICKET_SECONDS);
    expect(readUploadTicket(testConfig(), sc.ticket)).toMatchObject({ fikenAccessToken: "tok", anonId: "anon", companySlug: "demo" });
  });

  it("never issues a ticket that outlives the session it was minted from", async () => {
    const now = Math.floor(Date.now() / 1000);
    const c = await connectedWithUrl(now + 120);
    const r = await c.callTool({ name: "upload_receipts", arguments: { companySlug: "demo" } });
    const sc = r.structuredContent as { ticket: string; expiresInSeconds: number };
    expect(sc.expiresInSeconds).toBeLessThanOrEqual(120);
    expect(sc.expiresInSeconds).toBeGreaterThan(110);
    // Dead once the session is, not fifteen minutes later.
    expect(readUploadTicket(testConfig(), sc.ticket).exp).toBeLessThanOrEqual(now + 120);
    expect(() => readUploadTicket(testConfig(), sc.ticket, now + 121)).toThrow();
  });

  it("serves the widget resource with the connect domain", async () => {
    const c = await connectedWithUrl();
    const r = await c.readResource({ uri: "ui://fiken-mcp/upload.html" });
    // The SDK's union covers text and blob contents; this resource is always the text one.
    const item = r.contents[0] as unknown as { mimeType: string; text: string; _meta: { ui: { csp: { connectDomains: string[] } } } };
    expect(item.mimeType).toBe("text/html;profile=mcp-app");
    expect(item.text).toContain("globalThis.__mcpApps=");
    expect(item._meta.ui.csp.connectDomains).toEqual(["https://fiken-mcp.test"]);
  });

  it("get_upload_url gives a curl command that carries the ticket in a header, never the URL", async () => {
    const c = await connectedWithUrl();
    const r = await c.callTool({ name: "get_upload_url", arguments: { companySlug: "demo" } });
    const text = (r.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain("curl -sS -X POST 'https://fiken-mcp.test/upload' -H 'x-ticket: ");
    expect(text).not.toContain("?ticket=");
    expect(text).toContain("--data-binary @");
    expect(text).toContain("15 minutes");
    expect(text).toContain("4 MB");
  });

  it("registers no upload tools when the server is built without a public url", async () => {
    const fiken = createFikenClient({
      baseUrl: "https://api.test/v2",
      accessToken: "tok",
      fetch: async () => new Response("x", { status: 500 }),
      queue: new FikenQueue(0),
    });
    const server = createMcpServer({
      fiken,
      anonId: "anon",
      fikenAccessToken: "tok",
      exp: farFutureExp(),
      usage: memoryUsageStore(),
      session: { fikenUnauthorized: false, wrote: false },
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(ct);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("upload_receipts");
    expect(names).not.toContain("get_upload_url");
  });
});
