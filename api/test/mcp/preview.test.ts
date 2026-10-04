import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MONEY } from "../../src/mcp/preview.js";
import { OPERATIONS } from "../../src/mcp/registry.js";
import { connected, fakeFiken } from "./helpers.js";

type Block = { type: string; text?: string };
type Preview = {
  operation: string;
  title: string;
  summary: Array<{ label: string; value: string }>;
  lines?: { columns: string[]; rows: string[][] };
  totals?: Array<{ label: string; value: string }>;
  checks: "ok" | string[];
  ref: string;
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
    expect(p!.totals).toContainEqual({ label: "Mva", value: "Fiken legger til mva på sider med mva-kode" });
    expect(p!.totals!.map((t) => t.label)).toEqual(expect.arrayContaining(["Debet (eks. mva)", "Kredit"]));
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

  it("keeps object and array args in the summary", async () => {
    const contact = await preview("update_contact", { companySlug: "demo", contactId: 5, address: { city: "Oslo", postCode: "0150" } });
    expect(contact.p!.checks).toBe("ok");
    expect(contact.p!.summary).toContainEqual({ label: "address", value: JSON.stringify({ city: "Oslo", postCode: "0150" }) });
    const send = await preview("send_invoice", { companySlug: "demo", invoiceId: 7, method: ["email"] });
    expect(send.p!.summary).toContainEqual({ label: "method", value: JSON.stringify(["email"]) });
  });

  it("labels amounts with the document's currency", async () => {
    const invoice = await preview("create_invoice", {
      companySlug: "demo", customerId: 1, issueDate: "2026-10-01", dueDate: "2026-10-15", bankAccountCode: "1920:10001", currency: "EUR",
      lines: [{ description: "Arbeid", quantity: 1, unitPrice: 10000, vatType: "HIGH", incomeAccount: "3000" }],
    });
    expect(invoice.p!.lines!.rows[0]).toContain(`100,00${NBSP}EUR`);
    const credit = await preview("create_credit_note", {
      companySlug: "demo", kind: "partial", issueDate: "2026-10-01", invoiceId: 3,
      lines: [{ description: "Arbeid", quantity: 1, unitPrice: 10000, vatType: "HIGH", incomeAccount: "3000" }],
    });
    expect(credit.p!.lines!.rows[0]).toContain(`100,00${NBSP}(fakturaens valuta)`);
  });

  it("counts a two-sided line on both sides and explains VAT", async () => {
    const both = await preview("create_journal_entry", {
      companySlug: "demo", description: "x", date: "2026-10-01",
      lines: [{ amount: 125000, debitAccount: "6540", creditAccount: "1920:10001" }],
    });
    expect(both.p!.checks).toBe("ok");
    expect(both.p!.totals).toEqual([
      { label: "Debet", value: `1${NBSP}250,00${NBSP}kr` },
      { label: "Kredit", value: `1${NBSP}250,00${NBSP}kr` },
    ]);
  });

  it("does not claim more than it checks", async () => {
    const c = await connected(fakeFiken([]).fetchImpl);
    const tool = (await c.listTools()).tools.find((t) => t.name === "preview_booking")!;
    expect(tool.description).not.toContain("as the write would");
    expect(tool.description).toContain("the write may still be refused");
    expect(tool.description).not.toContain("Fiken may still refuse");
  });

  it("ties the preview to a reference over the operation and the parsed args", async () => {
    const args = { companySlug: "demo", description: "Utlegg", date: "2026-10-01", lines: outlay };
    const a = await preview("create_journal_entry", args);
    expect(a.p!.ref).toMatch(/^[0-9a-f]{6}$/);
    expect(a.text).toContain(`Referanse: ${a.p!.ref}`);
    // The same args in another key order give the same reference.
    const reordered = await preview("create_journal_entry", { lines: outlay, date: "2026-10-01", description: "Utlegg", companySlug: "demo" });
    expect(reordered.p!.ref).toBe(a.p!.ref);
    // A changed amount gives another reference.
    const changed = await preview("create_journal_entry", { ...args, lines: [{ ...outlay[0], amount: 100001 }, outlay[1]] });
    expect(changed.p!.ref).not.toBe(a.p!.ref);
    // Defaults count: leaving out the default currency is the same booking as giving it.
    const purchase = { companySlug: "demo", date: "2026-10-01", kind: "cash_purchase", paymentAccount: "1920:10001", paymentDate: "2026-10-01", lines: [{ description: "Kaffe", netPrice: 10000, vat: 2500, account: "6860", vatType: "HIGH" }] };
    expect((await preview("create_purchase", purchase)).p!.ref).toBe((await preview("create_purchase", { ...purchase, currency: "NOK" })).p!.ref);
  });

  it("tells the model to match the approval's reference before writing", async () => {
    const c = await connected(fakeFiken([]).fetchImpl);
    const tools = (await c.listTools()).tools;
    const description = tools.find((t) => t.name === "preview_booking")!.description!;
    expect(description).toContain("Ja, før dette (ref");
    expect(description).toContain("preview again");
  });

  it("does not label line amounts kr on an update that keeps the draft's currency", async () => {
    const { p } = await preview("update_invoice_draft", {
      companySlug: "demo", draftId: 4,
      lines: [{ description: "Arbeid", quantity: 1, unitPrice: 10000, vatType: "HIGH", incomeAccount: "3000" }],
    });
    expect(p!.checks).toBe("ok");
    expect(p!.lines!.rows[0]).toContain(`100,00${NBSP}(utkastets valuta)`);
  });

  it("labels top-level fees and rates as amounts", async () => {
    const payment = await preview("register_payment", { companySlug: "demo", saleId: 1, date: "2026-10-01", account: "1920:10001", amount: 125000, fee: 2500 });
    expect(payment.p!.summary).toContainEqual({ label: "Gebyr", value: `25,00${NBSP}kr` });
    const activity = await preview("create_activity", { companySlug: "demo", name: "Konsulent", hourlyRate: 125000 });
    expect(activity.p!.summary).toContainEqual({ label: "Timepris", value: `1${NBSP}250,00${NBSP}kr` });
  });

  it("accepts args as a JSON string", async () => {
    const args = { companySlug: "demo", description: "Utlegg", date: "2026-10-01", lines: outlay };
    const asObject = await preview("create_journal_entry", args);
    const f = fakeFiken([]);
    const c = await connected(f.fetchImpl);
    const r = await c.callTool({ name: "preview_booking", arguments: { operation: "create_journal_entry", args: JSON.stringify(args) } });
    expect(r.structuredContent).toEqual(asObject.p);
    const bad = await c.callTool({ name: "preview_booking", arguments: { operation: "create_journal_entry", args: "nope" } });
    expect(bad.isError).toBe(true);
  });

  it("shows defaults the write will use", async () => {
    const { p } = await preview("create_purchase", {
      companySlug: "demo", date: "2026-10-01", kind: "cash_purchase", paymentAccount: "1920:10001", paymentDate: "2026-10-01",
      lines: [{ description: "Kaffe", netPrice: 10000, vat: 2500, account: "6860", vatType: "HIGH" }],
    });
    expect(p!.summary).toContainEqual({ label: "Valuta", value: "NOK" });
  });

  it("keeps a newline in a description from breaking the Markdown", async () => {
    const { text } = await preview("create_journal_entry", {
      companySlug: "demo", description: "a\nb", date: "2026-10-01",
      lines: [{ amount: 100, debitAccount: "6540", creditAccount: "2911", description: "x" }],
    });
    expect(text).toContain("- Beskrivelse: a b");
    const { text: t2 } = await preview("create_purchase", {
      companySlug: "demo", date: "2026-10-01", kind: "cash_purchase", paymentAccount: "1920:10001", paymentDate: "2026-10-01",
      lines: [{ description: "Kaffe\nog te | mer", netPrice: 100, vat: 0, account: "6860", vatType: "NONE" }],
    });
    expect(t2).toContain("Kaffe og te \\| mer");
  });
});

/** Every key of a number field, also inside nested objects and arrays, whose own description says it is in øre. */
function oreKeys(schema: z.ZodType, key: string | undefined, out: Set<string>): void {
  let s: z.ZodType = schema;
  let description = s.description ?? "";
  for (;;) {
    if (s instanceof z.ZodOptional || s instanceof z.ZodNullable) s = s.unwrap() as z.ZodType;
    else if (s instanceof z.ZodDefault) s = s.unwrap() as z.ZodType;
    else break;
    description += ` ${s.description ?? ""}`;
  }
  if (s instanceof z.ZodNumber) {
    if (key !== undefined && description.includes("øre")) out.add(key);
  } else if (s instanceof z.ZodObject) {
    for (const [k, v] of Object.entries(s.shape)) oreKeys(v as z.ZodType, k, out);
  } else if (s instanceof z.ZodArray) {
    oreKeys(s.element as z.ZodType, key, out);
  } else if (s instanceof z.ZodUnion) {
    for (const o of s.options) oreKeys(o as z.ZodType, key, out);
  }
}

describe("preview money keys", () => {
  it("formats every øre field of every write operation as an amount", () => {
    const keys = new Set<string>();
    for (const op of OPERATIONS.filter((o) => o.kind === "write")) oreKeys(op.input, undefined, keys);
    expect([...keys].sort()).toEqual(expect.arrayContaining(["amount", "fee", "gross", "hourlyRate", "net", "netPrice", "paymentFee", "unitPrice", "vat"]));
    for (const key of keys) expect(MONEY.has(key), key).toBe(true);
  });
});
