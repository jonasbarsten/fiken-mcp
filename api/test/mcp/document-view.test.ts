import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { testConfig } from "../../src/config.js";
import { readViewTicket } from "../../src/document/ticket.js";
import { FikenQueue, createFikenClient } from "../../src/fiken/client.js";
import { createHelpClient } from "../../src/help/client.js";
import type { ConnectorOptions } from "../../src/mcp/options.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { memoryUsageStore } from "../../src/usage/memory.js";
import { readUploadTicket } from "../../src/upload/ticket.js";
import { fakeFiken, farFutureExp } from "./helpers.js";

type Block = { type: string; text?: string };
const cfg = testConfig();
const DOC_URL = "https://fiken.test/api/v2/files/inbox-7";
const ATT_URL = "https://fiken.test/api/v2/files/att-1";

async function connectedWithUrl(fetchImpl: typeof fetch, opts: { exp?: number; options?: ConnectorOptions; publicUrl?: string } = {}) {
  const fiken = createFikenClient({ baseUrl: cfg.fikenBaseUrl, fileBaseUrl: cfg.fikenFileBaseUrl, accessToken: "tok", fetch: fetchImpl, queue: new FikenQueue(0) });
  const server = createMcpServer(
    { fiken, anonId: "anon", fikenAccessToken: "tok", exp: opts.exp ?? farFutureExp(), usage: memoryUsageStore(), session: { fikenUnauthorized: false, wrote: false }, help: createHelpClient({ fetch: async () => new Response("", { status: 404 }) }) },
    "publicUrl" in opts ? opts.publicUrl : "https://fiken-mcp.test",
    "publicUrl" in opts && opts.publicUrl === undefined ? undefined : cfg,
    opts.options,
  );
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(ct);
  return client;
}

const fiken = () =>
  fakeFiken([
    { match: /\/companies\/demo\/inbox\/7$/, body: { documentId: 7, name: "Taxi", filename: "taxi.pdf", documentUrl: DOC_URL } },
    { match: /\/companies\/demo\/inbox\/8$/, status: 404, body: { message: "not found" } },
    { match: /\/companies\/demo\/inbox\/9$/, body: { documentId: 9, filename: "nourl.pdf" } },
    { match: /\/companies\/demo\/inbox\/10$/, body: { documentId: 10, documentUrl: DOC_URL } },
    { match: /\/companies$/, body: [{ slug: "demo" }] },
    {
      match: /\/companies\/demo\/purchases\/55\/attachments$/,
      body: [
        { uuid: "u-other", filename: "other.png", downloadUrl: "https://fiken.test/api/v2/files/other" },
        { uuid: "u-1", filename: "kvittering.png", downloadUrl: ATT_URL, type: "unspecified" },
        { uuid: "u-nourl", filename: "nourl.png" },
      ],
    },
  ]);

const textOf = (r: { content: unknown }) => (r.content as Block[])[0]!.text!;

describe("show_document", () => {
  it("is a read-only widget tool on the stable resource, served with the public URL as its only connect domain", async () => {
    const c = await connectedWithUrl(fiken().fetchImpl);
    const tool = (await c.listTools()).tools.find((t) => t.name === "show_document")!;
    expect(tool.annotations?.readOnlyHint).toBe(true);
    expect((tool._meta as { ui: { resourceUri: string } }).ui.resourceUri).toBe("ui://fiken-mcp/document.html");
    expect(tool.description).toContain("attachmentUuid");
    const r = await c.readResource({ uri: "ui://fiken-mcp/document.html" });
    const item = r.contents[0] as unknown as { mimeType: string; text: string; _meta: { ui: { csp: { connectDomains: string[] } } } };
    expect(item.mimeType).toBe("text/html;profile=mcp-app");
    expect(item.text).toContain("globalThis.__mcpApps=");
    expect(item._meta.ui.csp.connectDomains).toEqual(["https://fiken-mcp.test"]);
  });

  it("is on read-only and concept-filtered connections, but not without a public URL", async () => {
    const names = async (opts: Parameters<typeof connectedWithUrl>[1]) => (await (await connectedWithUrl(fiken().fetchImpl, opts)).listTools()).tools.map((t) => t.name);
    expect(await names({ options: { readOnly: true } })).toContain("show_document");
    expect(await names({ options: { readOnly: false, concepts: new Set(["invoices"]) } })).toContain("show_document");
    expect(await names({ publicUrl: undefined })).not.toContain("show_document");
  });

  it("looks up an inbox document and returns a view ticket sealed to that company and that file", async () => {
    const f = fiken();
    const c = await connectedWithUrl(f.fetchImpl);
    const r = await c.callTool({ name: "show_document", arguments: { companySlug: "demo", inboxDocumentId: 7 } });
    expect(r.isError).toBeFalsy();
    const sc = r.structuredContent as { documentUrl: string; ticket: string; filename: string };
    expect(sc.documentUrl).toBe("https://fiken-mcp.test/document");
    expect(sc.filename).toBe("taxi.pdf");
    expect(readViewTicket(cfg, sc.ticket)).toMatchObject({ fikenAccessToken: "tok", anonId: "anon", companySlug: "demo", fileUrl: DOC_URL });
    expect(() => readUploadTicket(cfg, sc.ticket)).toThrow();
    expect(textOf(r)).toBe("Viser taxi.pdf fra innboksen. Innholdet kan leses med get_inbox_document (via fiken_read).");
    // Only the lookup: the file itself is fetched by the widget through /document.
    expect(f.calls.map((x) => x.url)).toEqual([`${cfg.fikenBaseUrl}/companies/demo/inbox/7`]);
    expect(JSON.stringify(r)).not.toContain(DOC_URL);
  });

  it("refuses an inbox document without a documentUrl, without a ticket", async () => {
    const c = await connectedWithUrl(fiken().fetchImpl);
    const r = await c.callTool({ name: "show_document", arguments: { companySlug: "demo", inboxDocumentId: 9 } });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toBeUndefined();
    expect(textOf(r)).toContain("nourl.pdf");
  });

  it("names an inbox document without a filename «dokument»", async () => {
    const c = await connectedWithUrl(fiken().fetchImpl);
    const r = await c.callTool({ name: "show_document", arguments: { companySlug: "demo", inboxDocumentId: 10 } });
    expect(r.isError).toBeFalsy();
    expect((r.structuredContent as { filename: string }).filename).toBe("dokument");
    expect(textOf(r)).toBe("Viser dokument fra innboksen. Innholdet kan leses med get_inbox_document (via fiken_read).");
    expect(textOf(r)).not.toContain("undefined");
  });

  it("looks up an attachment by uuid on its purchase and seals Fiken's download URL", async () => {
    const f = fiken();
    const c = await connectedWithUrl(f.fetchImpl);
    const r = await c.callTool({ name: "show_document", arguments: { companySlug: "demo", attachmentUuid: "u-1", purchaseId: 55 } });
    expect(r.isError).toBeFalsy();
    const sc = r.structuredContent as { ticket: string; filename: string };
    expect(sc.filename).toBe("kvittering.png");
    expect(readViewTicket(cfg, sc.ticket).fileUrl).toBe(ATT_URL);
    expect(textOf(r)).toBe("Viser vedlegget kvittering.png.");
    expect(JSON.stringify(r)).not.toContain(ATT_URL);
  });

  it("refuses an unknown attachment or one without a download URL", async () => {
    const c = await connectedWithUrl(fiken().fetchImpl);
    const missing = await c.callTool({ name: "show_document", arguments: { companySlug: "demo", attachmentUuid: "nope", purchaseId: 55 } });
    expect(missing.isError).toBe(true);
    expect(missing.structuredContent).toBeUndefined();
    const noUrl = await c.callTool({ name: "show_document", arguments: { companySlug: "demo", attachmentUuid: "u-nourl", purchaseId: 55 } });
    expect(noUrl.isError).toBe(true);
    expect(noUrl.structuredContent).toBeUndefined();
  });

  it("needs exactly one document: an inboxDocumentId, or an attachmentUuid with exactly one owner id", async () => {
    const f = fiken();
    const c = await connectedWithUrl(f.fetchImpl);
    for (const args of [
      { companySlug: "demo" },
      { companySlug: "demo", inboxDocumentId: 7, attachmentUuid: "u-1", purchaseId: 55 },
      { companySlug: "demo", attachmentUuid: "u-1" },
      { companySlug: "demo", attachmentUuid: "u-1", purchaseId: 55, saleId: 1 },
      { companySlug: "demo", inboxDocumentId: 7, purchaseId: 55 },
    ]) {
      const r = await c.callTool({ name: "show_document", arguments: args });
      expect(r.isError).toBe(true);
      expect(r.structuredContent).toBeUndefined();
    }
    expect(f.calls).toHaveLength(0);
  });

  it("refuses unknown arguments", async () => {
    const c = await connectedWithUrl(fiken().fetchImpl);
    const r = await c.callTool({ name: "show_document", arguments: { companySlug: "demo", inboxDocumentId: 7, documentUrl: "https://evil.example/x" } });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toBeUndefined();
  });

  it("reports a missing inbox document as a tool error without a ticket", async () => {
    const c = await connectedWithUrl(fiken().fetchImpl);
    const r = await c.callTool({ name: "show_document", arguments: { companySlug: "demo", inboxDocumentId: 8 } });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toBeUndefined();
  });

  it("never issues a ticket that outlives the session", async () => {
    const now = Math.floor(Date.now() / 1000);
    const c = await connectedWithUrl(fiken().fetchImpl, { exp: now + 60 });
    const r = await c.callTool({ name: "show_document", arguments: { companySlug: "demo", inboxDocumentId: 7 } });
    const sc = r.structuredContent as { ticket: string };
    expect(readViewTicket(cfg, sc.ticket).exp).toBeLessThanOrEqual(now + 60);
    expect(() => readViewTicket(cfg, sc.ticket, now + 61)).toThrow();
  });
});
