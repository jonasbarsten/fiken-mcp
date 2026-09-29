import { describe, expect, it } from "vitest";
import { parseConnectorOptions, visibleOperations } from "../../src/mcp/options.js";
import { connected, fakeFiken } from "./helpers.js";

describe("connector options", () => {
  it("parses readonly and concepts, and names an unknown word", () => {
    expect(parseConnectorOptions("")).toEqual({ ok: { readOnly: false } });
    expect(parseConnectorOptions("readonly")).toEqual({ ok: { readOnly: true } });
    const both = parseConnectorOptions("Invoices, sales,readonly");
    expect("ok" in both && both.ok.readOnly).toBe(true);
    expect("ok" in both && [...(both.ok.concepts ?? [])].sort()).toEqual(["invoices", "sales"]);
    const bad = parseConnectorOptions("invoicez");
    expect("error" in bad && bad.error).toMatch(/^Unknown connector option "invoicez"\. Use readonly and any of: /);
  });

  it("readonly hides every write; a concept filter keeps companies", () => {
    const ro = parseConnectorOptions("readonly");
    if (!("ok" in ro)) throw new Error("parse");
    expect(visibleOperations(ro.ok).every((o) => o.kind === "read")).toBe(true);
    const inv = parseConnectorOptions("invoices");
    if (!("ok" in inv)) throw new Error("parse");
    expect(new Set(visibleOperations(inv.ok).map((o) => o.concept))).toEqual(new Set(["invoices", "companies"]));
  });

  it("a readonly server lists no writing tool and refuses a write through the gateway", async () => {
    const full = await connected(fakeFiken([]).fetchImpl);
    const fullExplore = await full.callTool({ name: "fiken_explore", arguments: { path: "invoices" } });
    expect((fullExplore.content as Array<{ text: string }>)[0]?.text).toContain('"kind":"write"');

    const f = fakeFiken([]);
    const c = await connected(f.fetchImpl, { options: { readOnly: true } });
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("fiken_write");
    expect(names).not.toContain("create_purchase");
    expect(names).not.toContain("upload_receipts");
    const explore = await c.callTool({ name: "fiken_explore", arguments: { path: "invoices" } });
    expect((explore.content as Array<{ text: string }>)[0]?.text).not.toContain('"kind":"write"');
    const r = await c.callTool({ name: "fiken_read", arguments: { operation: "send_invoice", args: { companySlug: "demo", invoiceId: 1 } } });
    expect(r.isError).toBe(true);
    expect(f.calls).toHaveLength(0);
  });
});
