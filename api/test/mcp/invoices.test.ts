import { describe, expect, it } from "vitest";
import { getOperation } from "../../src/mcp/registry.js";
import { callJson, connected, fakeFiken } from "./helpers.js";

const invoice77 = {
  invoiceId: 77, invoiceNumber: 10042, issueDate: "2026-09-29", dueDate: "2026-10-13", net: 100000, vat: 25000, gross: 125000,
  currency: "NOK", cash: false, kid: "123", sentManually: false, customer: { contactId: 7, name: "Kunde AS", email: "k@x" },
  sale: { saleId: 3, settled: false, outstandingBalance: 125000 }, invoicePdf: { uuid: "p" },
  lines: [{ description: "Konsulenttimer", quantity: 1, unitPrice: 100000, net: 100000, vat: 25000, vatType: "HIGH", incomeAccount: "3000", grossInNok: 125000 }],
  attachments: [],
};
const trimmed77 = {
  invoiceId: 77, invoiceNumber: 10042, issueDate: "2026-09-29", dueDate: "2026-10-13", net: 100000, vat: 25000, gross: 125000,
  currency: "NOK", cash: false, kid: "123", sentManually: false, customer: { contactId: 7, name: "Kunde AS" }, saleId: 3, settled: false, outstandingBalance: 125000,
};
const line = { description: "Konsulenttimer", quantity: 1, unitPrice: 100000, vatType: "HIGH", incomeAccount: "3000" };
const createArgs = { companySlug: "demo", customerId: 7, issueDate: "2026-09-29", dueDate: "2026-10-13", bankAccountCode: "1920:10001", lines: [line] };

describe("invoices", () => {
  it("list_invoices filters and trims; get_invoice adds lines", async () => {
    const f = fakeFiken([
      { match: /\/invoices\?/, headers: { "Fiken-Api-Result-Count": "1" }, body: [invoice77] },
      { match: /\/invoices\/77$/, body: invoice77 },
    ]);
    const c = await connected(f.fetchImpl);
    expect((await callJson(c, "list_invoices", { companySlug: "demo", settled: false })).json()).toEqual({ items: [trimmed77], total: 1, page: 0, pageSize: 25 });
    expect(f.calls[0]?.url).toBe("https://api.test/v2/companies/demo/invoices?page=0&pageSize=25&settled=false");
    expect((await callJson(c, "get_invoice", { companySlug: "demo", invoiceId: 77 })).json()).toEqual({
      ...trimmed77,
      lines: [{ description: "Konsulenttimer", quantity: 1, unitPrice: 100000, net: 100000, vat: 25000, vatType: "HIGH", incomeAccount: "3000" }],
      attachments: 0,
    });
  });

  it("create_invoice posts the request and reads the invoice back", async () => {
    const f = fakeFiken([
      { match: /\/invoices$/, status: 201, headers: { location: "https://api.test/v2/companies/demo/invoices/77" } },
      { match: /\/invoices\/77$/, body: invoice77 },
    ]);
    const c = await connected(f.fetchImpl);
    const r = await callJson(c, "create_invoice", createArgs);
    expect(r.isError).toBe(false);
    expect(r.json()).toMatchObject({ invoiceId: 77, invoiceNumber: 10042 });
    expect(f.calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(f.calls[0]?.init?.body))).toEqual({
      customerId: 7, issueDate: "2026-09-29", dueDate: "2026-10-13", bankAccountCode: "1920:10001", cash: false, currency: "NOK", lines: [line],
    });
  });

  it("refuses a line without productId that lacks fields, before calling Fiken", async () => {
    const f = fakeFiken([]);
    const c = await connected(f.fetchImpl);
    const r = await callJson(c, "create_invoice", { ...createArgs, lines: [line, { description: "Reise", quantity: 1, vatType: "HIGH" }] });
    expect(r.isError).toBe(true);
    expect(r.text).toBe("Line 2 has no productId and is missing unitPrice, incomeAccount.");
    expect(f.calls).toHaveLength(0);
    const cash = await callJson(c, "create_invoice", { ...createArgs, cash: true });
    expect(cash.isError).toBe(true);
    expect(cash.text).toContain("paymentAccount");
    expect(f.calls).toHaveLength(0);
  });

  it("a failing read-back after the invoice was created names the invoice and never flags an HTTP 401", async () => {
    const session = { fikenUnauthorized: false, wrote: false };
    const f = fakeFiken([
      { match: /\/invoices$/, status: 201, headers: { location: "https://api.test/v2/companies/demo/invoices/77" } },
      { match: /\/invoices\/77$/, status: 401, body: "expired" },
    ]);
    const c = await connected(f.fetchImpl, { session });
    const r = await callJson(c, "create_invoice", createArgs);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Invoice 77 was created");
    expect(r.text).toContain("Do not create it again");
    expect(session.fikenUnauthorized).toBe(false);
    expect(f.calls.some((x) => x.url.endsWith("/user"))).toBe(false);
  });

  it("create_invoice_draft returns the draft id; create_invoice_from_draft issues it", async () => {
    const f = fakeFiken([
      { match: /\/invoices\/drafts$/, status: 201, headers: { location: "https://api.test/v2/companies/demo/invoices/drafts/12" } },
      { match: /\/invoices\/drafts\/12\/createInvoice$/, status: 201, headers: { location: "https://api.test/v2/companies/demo/invoices/77" } },
      { match: /\/invoices\/77$/, body: invoice77 },
    ]);
    const c = await connected(f.fetchImpl);
    const draft = await callJson(c, "create_invoice_draft", { companySlug: "demo", customerId: 7, daysUntilDueDate: 14, bankAccountNumber: "12345678903", lines: [line] });
    expect(draft.json()).toEqual({ draftId: 12 });
    expect(JSON.parse(String(f.calls[0]?.init?.body))).toEqual({ type: "invoice", customerId: 7, daysUntilDueDate: 14, bankAccountNumber: "12345678903", currency: "NOK", lines: [line] });
    const issued = await callJson(c, "create_invoice_from_draft", { companySlug: "demo", draftId: 12 });
    expect(issued.json()).toMatchObject({ invoiceId: 77 });
    expect(f.calls[1]?.init?.body).toBeUndefined();
  });
});

describe("send, credit, pay", () => {
  it("send_invoice defaults to auto with attachments", async () => {
    const f = fakeFiken([{ match: /\/invoices\/send$/, status: 200 }]);
    const c = await connected(f.fetchImpl);
    expect((await callJson(c, "send_invoice", { companySlug: "demo", invoiceId: 77 })).json()).toEqual({ invoiceId: 77, sent: true, method: ["auto"] });
    expect(JSON.parse(String(f.calls[0]?.init?.body))).toEqual({ invoiceId: 77, method: ["auto"], includeDocumentAttachments: true });
  });

  it("create_credit_note full and partial, with validation before any call", async () => {
    const note = { creditNoteId: 5, creditNoteNumber: 3, issueDate: "2026-09-29", net: -100000, vat: -25000, gross: -125000, currency: "NOK", associatedInvoiceId: 77, customer: { contactId: 7, name: "Kunde AS", email: "k" } };
    const f = fakeFiken([
      { match: /\/creditNotes\/full$/, status: 201, headers: { location: "https://api.test/v2/companies/demo/creditNotes/5" } },
      { match: /\/creditNotes\/partial$/, status: 201, headers: { location: "https://api.test/v2/companies/demo/creditNotes/5" } },
      { match: /\/creditNotes\/5$/, body: note },
    ]);
    const c = await connected(f.fetchImpl);
    const full = await callJson(c, "create_credit_note", { companySlug: "demo", kind: "full", issueDate: "2026-09-29", invoiceId: 77 });
    expect(full.json()).toEqual({ creditNoteId: 5, creditNoteNumber: 3, issueDate: "2026-09-29", net: -100000, vat: -25000, gross: -125000, currency: "NOK", associatedInvoiceId: 77, customer: { contactId: 7, name: "Kunde AS" } });
    expect(JSON.parse(String(f.calls[0]?.init?.body))).toEqual({ issueDate: "2026-09-29", invoiceId: 77 });
    const before = f.calls.length;
    expect((await callJson(c, "create_credit_note", { companySlug: "demo", kind: "full", issueDate: "2026-09-29" })).isError).toBe(true);
    expect((await callJson(c, "create_credit_note", { companySlug: "demo", kind: "partial", issueDate: "2026-09-29", invoiceId: 77 })).isError).toBe(true);
    expect((await callJson(c, "create_credit_note", { companySlug: "demo", kind: "partial", issueDate: "2026-09-29", lines: [line] })).isError).toBe(true);
    expect(f.calls.length).toBe(before);
    const partial = await callJson(c, "create_credit_note", { companySlug: "demo", kind: "partial", issueDate: "2026-09-29", invoiceId: 77, lines: [line] });
    expect(partial.isError).toBe(false);
    expect(JSON.parse(String(f.calls[before]?.init?.body))).toEqual({ issueDate: "2026-09-29", invoiceId: 77, lines: [line] });
  });

  it("register_payment on a sale or a purchase, exactly one", async () => {
    const f = fakeFiken([
      { match: /\/sales\/3\/payments$/, status: 201, headers: { location: "https://api.test/v2/companies/demo/sales/3/payments/40" } },
      { match: /\/purchases\/8\/payments$/, status: 201, headers: { location: "https://api.test/v2/companies/demo/purchases/8/payments/41" } },
    ]);
    const c = await connected(f.fetchImpl);
    const pay = { companySlug: "demo", date: "2026-09-29", account: "1920:10001", amount: 125000 };
    expect((await callJson(c, "register_payment", { ...pay, saleId: 3 })).json()).toEqual({ paymentId: 40, saleId: 3 });
    expect(JSON.parse(String(f.calls[0]?.init?.body))).toEqual({ date: "2026-09-29", account: "1920:10001", amount: 125000 });
    expect((await callJson(c, "register_payment", { ...pay, purchaseId: 8, fee: 500 })).json()).toEqual({ paymentId: 41, purchaseId: 8 });
    expect(JSON.parse(String(f.calls[1]?.init?.body))).toMatchObject({ fee: 500 });
    expect((await callJson(c, "register_payment", pay)).isError).toBe(true);
    expect((await callJson(c, "register_payment", { ...pay, saleId: 3, purchaseId: 8 })).isError).toBe(true);
    expect((await callJson(c, "register_payment", { ...pay, saleId: 3, amount: 0 })).isError).toBe(true);
    expect((await callJson(c, "register_payment", { ...pay, saleId: 3, amount: -100 })).isError).toBe(true);
    expect(f.calls).toHaveLength(2);
  });

  it("create_credit_note refuses lines on full and incomplete partial lines, before any call", async () => {
    const f = fakeFiken([]);
    const c = await connected(f.fetchImpl);
    expect((await callJson(c, "create_credit_note", { companySlug: "demo", kind: "full", issueDate: "2026-09-29", invoiceId: 77, lines: [line] })).isError).toBe(true);
    const bad = await callJson(c, "create_credit_note", { companySlug: "demo", kind: "partial", issueDate: "2026-09-29", invoiceId: 77, lines: [{ description: "x", quantity: 1, vatType: "HIGH" }] });
    expect(bad.isError).toBe(true);
    expect(bad.text).toBe("Line 1 has no productId and is missing unitPrice, incomeAccount.");
    expect(f.calls).toHaveLength(0);
  });

  it("refuses a mistyped key in an invoice or credit-note line instead of dropping it", async () => {
    const f = fakeFiken([]);
    const c = await connected(f.fetchImpl);
    const typo = { productId: 5, quantity: 1, netPrice: 50000 };
    const inv = await callJson(c, "create_invoice", { ...createArgs, lines: [typo] });
    expect(inv.isError).toBe(true);
    expect(inv.text).toContain("netPrice");
    const note = await callJson(c, "create_credit_note", { companySlug: "demo", kind: "partial", issueDate: "2026-09-29", invoiceId: 77, lines: [{ ...line, discunt: 10 }] });
    expect(note.isError).toBe(true);
    expect(note.text).toContain("discunt");
    expect(f.calls).toHaveLength(0);
    // The same schema is a real tool's inputSchema, so the real-tool path refuses it too.
    expect(getOperation("create_invoice")?.input.safeParse({ ...createArgs, lines: [typo] }).success).toBe(false);
    expect(getOperation("create_credit_note")?.input.safeParse({ companySlug: "demo", kind: "partial", issueDate: "2026-09-29", invoiceId: 77, lines: [{ ...line, discunt: 10 }] }).success).toBe(false);
  });

  it("a partial credit note needs unitPrice on every line, even with a productId", async () => {
    const f = fakeFiken([]);
    const c = await connected(f.fetchImpl);
    const r = await callJson(c, "create_credit_note", { companySlug: "demo", kind: "partial", issueDate: "2026-09-29", invoiceId: 77, lines: [line, { productId: 4, quantity: 1 }] });
    expect(r.isError).toBe(true);
    expect(r.text).toBe("Line 2 is missing unitPrice.");
    expect(f.calls).toHaveLength(0);
  });

  it("create_credit_note names the id when the read-back fails", async () => {
    const f = fakeFiken([
      { match: /\/creditNotes\/full$/, status: 201, headers: { location: "https://api.test/v2/companies/demo/creditNotes/5" } },
      { match: /\/creditNotes\/5$/, status: 500, body: "boom" },
    ]);
    const c = await connected(f.fetchImpl);
    const res = await callJson(c, "create_credit_note", { companySlug: "demo", kind: "full", issueDate: "2026-09-29", invoiceId: 77 });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("Credit note 5 was created");
    expect(res.text).toContain("Do not create it again");
  });
});
