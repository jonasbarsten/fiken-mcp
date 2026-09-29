import { describe, expect, it } from "vitest";
import { CONCEPTS } from "../../src/mcp/operations.js";
import { CONFIRM } from "../../src/mcp/tools/common.js";
import { memoryUsageStore } from "../../src/usage/memory.js";
import { connected, fakeFiken } from "./helpers.js";

type Block = { type: string; text?: string };
async function call(c: Awaited<ReturnType<typeof connected>>, name: string, args: Record<string, unknown>) {
  const r = await c.callTool({ name, arguments: args });
  const text = (r.content as Block[])[0]?.text ?? "";
  return { isError: r.isError === true, text, json: () => JSON.parse(text) as unknown };
}

describe("gateway", () => {
  it("lists only the hot path, the gateway and the upload tools", async () => {
    const c = await connected(fakeFiken([]).fetchImpl);
    expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual([
      "create_purchase", "fiken_explore", "fiken_read", "fiken_write", "list_accounts", "list_bank_accounts",
      "list_companies", "list_inbox", "list_projects", "search_contacts",
    ]);
  });

  it("explores concepts, then a concept's operations with JSON Schema inputs", async () => {
    const c = await connected(fakeFiken([]).fetchImpl);
    const root = (await call(c, "fiken_explore", {})).json() as { concepts: Array<{ name: string; operations: string[] }> };
    expect(root.concepts.find((x) => x.name === "invoices")?.operations).toContain("send_invoice");
    const inv = (await call(c, "fiken_explore", { path: "invoices" })).json() as { operations: Array<{ name: string; kind: string; input: { properties: Record<string, unknown> } }> };
    const send = inv.operations.find((o) => o.name === "send_invoice");
    expect(send?.kind).toBe("write");
    expect(Object.keys(send?.input.properties ?? {})).toEqual(expect.arrayContaining(["companySlug", "invoiceId", "method"]));
    expect((await call(c, "fiken_explore", { path: "send_invoice" })).json()).toMatchObject({ name: "send_invoice", kind: "write" });
    const bad = await call(c, "fiken_explore", { path: "invoicez" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("Concepts: ");
  });

  it("marks the gateway tools read-only or destructive, and fiken_write asks for confirmation", async () => {
    const c = await connected(fakeFiken([]).fetchImpl);
    const { tools } = await c.listTools();
    const tool = (name: string) => tools.find((t) => t.name === name);
    expect(tool("fiken_explore")?.annotations).toEqual({ readOnlyHint: true });
    expect(tool("fiken_read")?.annotations).toEqual({ readOnlyHint: true });
    expect(tool("fiken_write")?.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
    expect(tool("fiken_write")?.description?.endsWith(CONFIRM)).toBe(true);
  });

  it("returns compact explore text whose schemas refuse extra keys", async () => {
    const c = await connected(fakeFiken([]).fetchImpl);
    for (const concept of Object.keys(CONCEPTS)) {
      const explored = await call(c, "fiken_explore", { path: concept });
      expect(explored.text.length, concept).toBeLessThan(12000);
    }
    const inv = await call(c, "fiken_explore", { path: "invoices" });
    const ops = (inv.json() as { operations: Array<{ name: string; input: Record<string, unknown> }> }).operations;
    const send = ops.find((o) => o.name === "send_invoice");
    expect(send?.input.additionalProperties).toBe(false);
    expect(send?.input).not.toHaveProperty("$schema");
  });

  it("runs a hot-path operation through fiken_read with the same result as the tool", async () => {
    const f = fakeFiken([{ match: /\/accounts\?/, body: [{ code: "1920", name: "Bank" }] }]);
    const c = await connected(f.fetchImpl);
    const direct = await call(c, "list_accounts", { companySlug: "demo" });
    const viaGateway = await call(c, "fiken_read", { operation: "list_accounts", args: { companySlug: "demo" } });
    expect(viaGateway.isError).toBe(false);
    expect(viaGateway.text).toBe(direct.text);
  });

  it("runs a read through fiken_read and counts it under the operation's name", async () => {
    const usage = memoryUsageStore();
    const f = fakeFiken([{ match: /\/sales\?/, headers: { "Fiken-Api-Result-Count": "0" }, body: [] }]);
    const c = await connected(f.fetchImpl, { usage });
    const r = await call(c, "fiken_read", { operation: "list_sales", args: { companySlug: "demo" } });
    expect(r.json()).toEqual({ items: [], total: 0, page: 0, pageSize: 25 });
    expect((await usage.userMonths("anon"))[0]?.tools).toEqual({ list_sales: 1 });
  });

  it("refuses the wrong gateway, an unknown operation and bad args before any Fiken call", async () => {
    const usage = memoryUsageStore();
    const f = fakeFiken([]);
    const c = await connected(f.fetchImpl, { usage });
    const wrong = await call(c, "fiken_read", { operation: "send_invoice", args: { companySlug: "demo", invoiceId: 1 } });
    expect(wrong).toMatchObject({ isError: true, text: "send_invoice is a write operation; call it with fiken_write." });
    const mirror = await call(c, "fiken_write", { operation: "list_sales", args: { companySlug: "demo" } });
    expect(mirror.text).toBe("list_sales is a read operation; call it with fiken_read.");
    const unknown = await call(c, "fiken_read", { operation: "list_salez", args: {} });
    expect(unknown.text).toBe('Unknown operation "list_salez". Call fiken_explore to see what exists.');
    const invalid = await call(c, "fiken_read", { operation: "get_invoice", args: { companySlug: "demo", invoiceId: "77", invoiceID: 77 } });
    expect(invalid.isError).toBe(true);
    expect(invalid.text).toContain("Invalid arguments for get_invoice");
    expect(invalid.text).toContain("Expected input:");
    expect(f.calls).toHaveLength(0);
    expect((await usage.userMonths("anon"))[0]).toMatchObject({ calls: 4, errors: 4, tools: { fiken_read: 3, fiken_write: 1 } });
  });

  it("refuses keys outside args, and args that are not a JSON object, with a hint and no Fiken call", async () => {
    const usage = memoryUsageStore();
    const f = fakeFiken([]);
    const c = await connected(f.fetchImpl, { usage });
    const hint = 'Put the operation\'s inputs under args, for example {"operation":"list_invoices","args":{"companySlug":"..."}}.';
    const stray = await call(c, "fiken_read", { operation: "list_sales", companySlug: "demo" });
    expect(stray).toMatchObject({ isError: true, text: hint });
    const strayWrite = await call(c, "fiken_write", { operation: "send_invoice", args: { companySlug: "demo", invoiceId: 1 }, invoiceId: 1 });
    expect(strayWrite).toMatchObject({ isError: true, text: hint });
    const badString = await call(c, "fiken_read", { operation: "list_sales", args: "{companySlug: demo}" });
    expect(badString).toMatchObject({ isError: true, text: hint });
    expect(f.calls).toHaveLength(0);
    expect((await usage.userMonths("anon"))[0]).toMatchObject({ calls: 3, errors: 3, tools: { fiken_read: 2, fiken_write: 1 } });
  });

  it("accepts args given as a JSON string", async () => {
    const f = fakeFiken([{ match: /\/sales\?/, headers: { "Fiken-Api-Result-Count": "0" }, body: [] }]);
    const c = await connected(f.fetchImpl);
    const r = await call(c, "fiken_read", { operation: "list_sales", args: '{"companySlug":"demo"}' });
    expect(r.isError).toBe(false);
    expect(r.json()).toEqual({ items: [], total: 0, page: 0, pageSize: 25 });
  });

  it("advertises fiken_read and fiken_write as strict at the top level, with args an object", async () => {
    const c = await connected(fakeFiken([]).fetchImpl);
    const { tools } = await c.listTools();
    for (const name of ["fiken_read", "fiken_write"]) {
      const schema = tools.find((t) => t.name === name)?.inputSchema as { additionalProperties?: unknown; properties: Record<string, { type?: string }> };
      expect(schema.additionalProperties, name).toBe(false);
      expect(schema.properties.args?.type, name).toBe("object");
    }
  });

  it("tells the model that only listed tools can be called by name", async () => {
    const c = await connected(fakeFiken([]).fetchImpl);
    const usage = (await call(c, "fiken_explore", {})).json() as { usage: string };
    expect(usage.usage).toContain("only the tools in your tool list can be called by name");
    expect(usage.usage).not.toContain("used directly");
  });

  it("runs a write through fiken_write with the same validation and write guard", async () => {
    const session = { fikenUnauthorized: false, wrote: false };
    const f = fakeFiken([
      { match: /\/invoices$/, status: 201, headers: { location: "https://api.test/v2/companies/demo/invoices/77" } },
      { match: /\/invoices\/77$/, status: 401, body: "expired" },
    ]);
    const c = await connected(f.fetchImpl, { session });
    const line = { description: "Konsulenttimer", quantity: 1, unitPrice: 100000, vatType: "HIGH", incomeAccount: "3000" };
    const r = await call(c, "fiken_write", { operation: "create_invoice", args: {
      companySlug: "demo", customerId: 7, issueDate: "2026-09-29", dueDate: "2026-10-13", bankAccountCode: "1920:10001", lines: [line],
    } });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Invoice 77 was created");
    expect(r.text).toContain('call fiken_read with {"operation":"get_invoice","args":{"companySlug":"demo","invoiceId":77}}');
    expect(session.fikenUnauthorized).toBe(false);
  });
});
