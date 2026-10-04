import { describe, expect, it } from "vitest";
import { connected, fakeFiken } from "./helpers.js";

type Block = { type: string; text?: string };
type Preview = {
  operation: string;
  title: string;
  summary: Array<{ label: string; value: string }>;
  lines?: { columns: string[]; rows: string[][] };
  totals?: Array<{ label: string; value: string }>;
  checks: "ok" | string[];
};

const NBSP = " ";
const outlay = [
  { amount: 100000, debitAccount: "6540", debitVatCode: 1 },
  { amount: 125000, creditAccount: "2911" },
];

async function preview(operation: string, args: Record<string, unknown>, opts?: Parameters<typeof connected>[1]) {
  const f = fakeFiken([]);
  const c = await connected(f.fetchImpl, opts);
  const r = await c.callTool({ name: "preview_booking", arguments: { operation, args } });
  const text = (r.content as Block[])[0]?.text ?? "";
  return { r, text, f, p: r.structuredContent as Preview | undefined };
}

describe("preview_booking", () => {
  it("is a read-only widget tool with the stable resource", async () => {
    const c = await connected(fakeFiken([]).fetchImpl);
    const tool = (await c.listTools()).tools.find((t) => t.name === "preview_booking")!;
    expect(tool.annotations?.readOnlyHint).toBe(true);
    expect((tool._meta as { ui: { resourceUri: string } }).ui.resourceUri).toBe("ui://fiken-mcp/preview.html");
    const res = await c.readResource({ uri: "ui://fiken-mcp/preview.html" });
    expect(res.contents[0]!.mimeType).toContain("text/html");
  });

  it("is not offered on read-only connections or where the write is not visible", async () => {
    const readOnly = await connected(fakeFiken([]).fetchImpl, { options: { readOnly: true } });
    expect((await readOnly.listTools()).tools.map((t) => t.name)).not.toContain("preview_booking");
    const invoicesOnly = await preview("create_journal_entry", { companySlug: "a", description: "x", date: "2026-10-01", lines: outlay }, { options: { readOnly: false, concepts: new Set(["invoices"]) } });
    expect(invoicesOnly.r.isError).toBe(true);
    expect(invoicesOnly.text).toContain("Unknown operation");
  });

  it("refuses an unknown operation and a read", async () => {
    const unknown = await preview("nope", {});
    expect(unknown.r.isError).toBe(true);
    expect(unknown.text).toContain("Unknown operation");
    const read = await preview("list_sales", { companySlug: "a" });
    expect(read.r.isError).toBe(true);
    expect(read.text).toContain("only previews writes");
  });

  it("previews the outlay entry with kroner, the VAT note and no Fiken call", async () => {
    const { r, p, text, f } = await preview("create_journal_entry", { companySlug: "demo", description: "Utlegg", date: "2026-10-01", lines: outlay });
    expect(r.isError).toBeFalsy();
    expect(p!.checks).toBe("ok");
    expect(p!.lines!.columns).toContain("debitAccount");
    const amountIdx = p!.lines!.columns.indexOf("amount");
    expect(p!.lines!.rows.map((row) => row[amountIdx])).toEqual([`1${NBSP}000,00${NBSP}kr`, `1${NBSP}250,00${NBSP}kr`]);
    expect(p!.totals).toContainEqual({ label: "Mva", value: "Fiken beregner mva" });
    expect(p!.summary).toContainEqual({ label: "Foretak", value: "demo" });
    expect(text.endsWith("Ingenting er ført ennå.")).toBe(true);
    expect(f.calls).toHaveLength(0);
  });

  it("reports an unbalanced entry without VAT codes", async () => {
    const { r, p, text, f } = await preview("create_journal_entry", {
      companySlug: "demo",
      description: "x",
      date: "2026-10-01",
      lines: [{ amount: 100, debitAccount: "6540" }, { amount: 90, creditAccount: "2911" }],
    });
    expect(r.isError).toBeFalsy();
    expect(p!.checks).toEqual(["The entry does not balance: debit 100 øre, credit 90 øre."]);
    expect(text).toContain("Kan ikke føres slik:");
    expect(text.endsWith("Ingenting er ført ennå.")).toBe(true);
    expect(f.calls).toHaveLength(0);
  });

  it("shows a schema failure as a check, not a crash", async () => {
    const { r, p, f } = await preview("create_journal_entry", { companySlug: "demo", description: "x", date: "2026-10-01", lines: [] });
    expect(r.isError).toBeFalsy();
    expect(Array.isArray(p!.checks)).toBe(true);
    expect((p!.checks as string[])[0]).toContain("lines");
    expect(f.calls).toHaveLength(0);
  });

  it("previews create_purchase with a summary and kroner", async () => {
    const { p, text, f } = await preview("create_purchase", {
      companySlug: "demo",
      date: "2026-10-01",
      kind: "cash_purchase",
      paymentAccount: "1920:10001",
      paymentDate: "2026-10-01",
      lines: [{ description: "Kaffe", netPrice: 10000, vat: 2500, account: "6860", vatType: "HIGH" }],
    });
    expect(p!.checks).toBe("ok");
    expect(p!.summary.map((s) => s.label)).toEqual(expect.arrayContaining(["Dato", "Type"]));
    expect(p!.lines!.rows[0]).toContain(`100,00${NBSP}kr`);
    expect(p!.lines!.rows[0]).toContain(`25,00${NBSP}kr`);
    expect(text).toContain("| description |");
    expect(f.calls).toHaveLength(0);
  });
});
