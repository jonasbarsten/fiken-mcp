import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { testConfig } from "../../src/config.js";
import { FikenQueue, createFikenClient } from "../../src/fiken/client.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { readUploadTicket } from "../../src/upload/ticket.js";

async function connectedWithUrl() {
  const fiken = createFikenClient({
    baseUrl: "https://api.test/v2",
    accessToken: "tok",
    fetch: async () => new Response("x", { status: 500 }),
    queue: new FikenQueue(0),
  });
  const server = createMcpServer({ fiken, anonId: "anon", fikenAccessToken: "tok" }, "https://fiken-mcp.test", testConfig());
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
    const sc = r.structuredContent as { uploadUrl: string; ticket: string; companySlug: string };
    expect(sc.uploadUrl).toBe("https://fiken-mcp.test/upload");
    expect(sc.companySlug).toBe("demo");
    expect(readUploadTicket(testConfig(), sc.ticket)).toMatchObject({ fikenAccessToken: "tok", anonId: "anon", companySlug: "demo" });
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

  it("get_upload_url gives a curl command with a query ticket", async () => {
    const c = await connectedWithUrl();
    const r = await c.callTool({ name: "get_upload_url", arguments: { companySlug: "demo" } });
    const text = (r.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain("curl -sS -X POST 'https://fiken-mcp.test/upload?ticket=");
    expect(text).toContain("--data-binary @");
    expect(text).toContain("15 minutes");
  });

  it("registers no upload tools when the server is built without a public url", async () => {
    const fiken = createFikenClient({
      baseUrl: "https://api.test/v2",
      accessToken: "tok",
      fetch: async () => new Response("x", { status: 500 }),
      queue: new FikenQueue(0),
    });
    const server = createMcpServer({ fiken, anonId: "anon", fikenAccessToken: "tok" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(ct);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("upload_receipts");
    expect(names).not.toContain("get_upload_url");
  });
});
