import { describe, expect, it } from "vitest";
import { CONCEPTS } from "../../src/mcp/operations.js";
import { type ConnectorOptions, parseConnectorOptions, visibleOperations } from "../../src/mcp/options.js";
import { OPERATIONS } from "../../src/mcp/registry.js";
import { connected, fakeFiken, mentionedOperations, operationTexts } from "./helpers.js";

function parsed(segment: string): ConnectorOptions {
  const r = parseConnectorOptions(segment);
  if (!("ok" in r)) throw new Error(r.error);
  return r.ok;
}

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

  it("readonly hides every write; a concept filter limits writes only, and every read stays", () => {
    const reads = OPERATIONS.filter((o) => o.kind === "read").map((o) => o.name);
    const ro = visibleOperations(parsed("readonly"));
    expect(ro.map((o) => o.name)).toEqual(reads);
    const inv = visibleOperations(parsed("invoices"));
    expect(inv.filter((o) => o.kind === "read").map((o) => o.name)).toEqual(reads);
    expect(new Set(inv.filter((o) => o.kind === "write").map((o) => o.concept))).toEqual(new Set(["invoices"]));
    expect(inv.map((o) => o.name)).not.toContain("create_contact");
    expect(visibleOperations(parsed("contacts")).map((o) => o.name)).toContain("create_contact");
    expect(visibleOperations(parsed("invoices,readonly")).map((o) => o.name)).toEqual(reads);
  });

  it("keeps visible every operation a visible operation says an id comes from, under every single-concept filter", () => {
    const names = OPERATIONS.map((o) => o.name);
    for (const segment of Object.keys(CONCEPTS)) {
      const visible = new Set(visibleOperations(parsed(segment)).map((o) => o.name));
      for (const op of OPERATIONS.filter((o) => visible.has(o.name))) {
        for (const text of operationTexts(op)) {
          for (const [, clause] of text.matchAll(/(?<![a-z_])from ([^.;]*)/g)) {
            for (const { name } of mentionedOperations(clause!, names)) {
              expect(visible.has(name), `/mcp/${segment}: ${op.name} takes an id from ${name}`).toBe(true);
            }
          }
        }
      }
    }
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
    const fullRoot = (await full.callTool({ name: "fiken_explore", arguments: {} })).content as Array<{ text: string }>;
    expect(JSON.parse(fullRoot[0]!.text).usage).toContain("fiken_write");
    const root = (await c.callTool({ name: "fiken_explore", arguments: {} })).content as Array<{ text: string }>;
    const usage = JSON.parse(root[0]!.text).usage as string;
    expect(usage).toContain("fiken_read");
    expect(usage).not.toContain("fiken_write");
    const r = await c.callTool({ name: "fiken_read", arguments: { operation: "send_invoice", args: { companySlug: "demo", invoiceId: 1 } } });
    expect(r.isError).toBe(true);
    expect(f.calls).toHaveLength(0);
  });
});
