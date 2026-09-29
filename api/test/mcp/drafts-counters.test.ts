import { describe, expect, it } from "vitest";
import { callJson, connected, fakeFiken } from "./helpers.js";

/** Answers GET and POST on the same path differently, and records every request. */
function methodAwareFiken(answers: Record<string, { status: number; body?: unknown }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    const a = answers[init?.method ?? "GET"];
    if (!a) return new Response("unexpected", { status: 500 });
    return new Response(a.body === undefined ? null : JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, calls };
}

const draft = {
  draftId: 12, uuid: "u-12", type: "invoice", lastModifiedDate: "2026-09-28", issueDate: "2026-09-29", daysUntilDueDate: 14,
  invoiceText: "Takk", currency: "NOK", yourReference: "Ola", ourReference: "Kari", orderReference: "PO-1",
  lines: [{ invoiceishDraftLineId: 1, lastModifiedDate: "2026-09-28", productId: 3, description: "Spade", unitPrice: 30000, vatType: "HIGH", quantity: 2, discount: 10, comment: "Stor", incomeAccount: "3000" }],
  net: 54000, gross: 67500, bankAccountNumber: "12345678903", iban: "NO9386011117947", bic: "DNBANOKK", paymentAccount: "1920:10001",
  customers: [{ contactId: 7, name: "Kunde AS", email: "k@x.no" }], attachments: [{ identifier: "a" }], createdFromInvoiceId: 70, projectId: 4, roundingType: "none",
};

describe("counters", () => {
  it("initialize_counter never touches an existing series", async () => {
    const f = fakeFiken([{ match: /\/creditNotes\/counter$/, body: { value: 10005 } }]);
    const c = await connected(f.fetchImpl);
    const r = await callJson(c, "initialize_counter", { companySlug: "demo", kind: "credit_note", value: 1 });
    expect(r).toMatchObject({ isError: true, text: "The credit_note counter already exists (next number 10005); it cannot be changed here." });
    expect(f.calls.every((x) => (x.init?.method ?? "GET") === "GET")).toBe(true);
  });

  it("initialize_counter starts a missing series", async () => {
    const f = methodAwareFiken({ GET: { status: 404, body: "not found" }, POST: { status: 201 } });
    const c = await connected(f.fetchImpl);
    const r = await callJson(c, "initialize_counter", { companySlug: "demo", kind: "invoice", value: 10001 });
    expect(r.isError).toBe(false);
    const post = f.calls.find((x) => x.init?.method === "POST");
    expect(post?.url).toBe("https://api.test/v2/companies/demo/invoices/counter");
    expect(JSON.parse(String(post?.init?.body))).toEqual({ value: 10001 });
  });

  it("initialize_counter treats a 409 'counter not initialized' as missing", async () => {
    const f = methodAwareFiken({ GET: { status: 409, body: "counter not initialized" }, POST: { status: 201 } });
    const c = await connected(f.fetchImpl);
    const r = await callJson(c, "initialize_counter", { companySlug: "demo", kind: "credit_note", value: 1 });
    expect(r.isError).toBe(false);
    expect(f.calls.find((x) => x.init?.method === "POST")?.url).toBe("https://api.test/v2/companies/demo/creditNotes/counter");
  });

  it("get_counters maps a missing counter to null", async () => {
    const f = fakeFiken([
      { match: /\/invoices\/counter$/, body: { value: 10042 } },
      { match: /\/creditNotes\/counter$/, status: 404, body: "not found" },
    ]);
    const c = await connected(f.fetchImpl);
    expect((await callJson(c, "get_counters", { companySlug: "demo" })).json()).toEqual({ invoice: 10042, creditNote: null });
  });
});

describe("credit notes", () => {
  it("send_credit_note defaults to auto with attachments, like send_invoice", async () => {
    const f = fakeFiken([{ match: /\/creditNotes\/send$/, status: 200 }]);
    const c = await connected(f.fetchImpl);
    expect((await callJson(c, "send_credit_note", { companySlug: "demo", creditNoteId: 5 })).json()).toEqual({ creditNoteId: 5, sent: true, method: ["auto"] });
    expect(JSON.parse(String(f.calls[0]?.init?.body))).toEqual({ creditNoteId: 5, method: ["auto"], includeDocumentAttachments: true });
  });

  it("list_credit_notes passes the filters and trims", async () => {
    const note = { creditNoteId: 5, creditNoteNumber: 3, issueDate: "2026-09-29", net: -100000, vat: -25000, gross: -125000, currency: "NOK", associatedInvoiceId: 77,
      customer: { contactId: 7, name: "Kunde AS", email: "k" }, address: { city: "Oslo" }, lines: [] };
    const f = fakeFiken([{ match: /\/creditNotes\?/, body: [note], headers: { "fiken-api-result-count": "1" } }]);
    const c = await connected(f.fetchImpl);
    const r = await callJson(c, "list_credit_notes", { companySlug: "demo", customerId: 7, settled: false });
    expect(r.json()).toEqual({ items: [{ creditNoteId: 5, creditNoteNumber: 3, issueDate: "2026-09-29", net: -100000, vat: -25000, gross: -125000, currency: "NOK", associatedInvoiceId: 77, customer: { contactId: 7, name: "Kunde AS" } }], total: 1, page: 0, pageSize: 25 });
    expect(f.calls[0]?.url).toBe("https://api.test/v2/companies/demo/creditNotes?page=0&pageSize=25&customerId=7&settled=false");
  });
});

describe("invoice drafts", () => {
  it("list_invoice_drafts trims each draft", async () => {
    const f = fakeFiken([{ match: /\/invoices\/drafts\?/, body: [draft], headers: { "fiken-api-result-count": "1" } }]);
    const c = await connected(f.fetchImpl);
    expect((await callJson(c, "list_invoice_drafts", { companySlug: "demo" })).json()).toEqual({
      items: [{ draftId: 12, uuid: "u-12", type: "invoice", issueDate: "2026-09-29", daysUntilDueDate: 14, customerId: 7, currency: "NOK", net: 54000, gross: 67500, lines: 1 }],
      total: 1, page: 0, pageSize: 25,
    });
  });

  it("update_invoice_draft overlays the given fields and sends the rest back", async () => {
    const f = fakeFiken([{ match: /\/invoices\/drafts\/12$/, body: draft }]);
    const c = await connected(f.fetchImpl);
    const r = await callJson(c, "update_invoice_draft", { companySlug: "demo", draftId: 12, invoiceText: "Ny tekst" });
    expect(r.json()).toMatchObject({ draftId: 12, customerId: 7 });
    const put = f.calls.find((x) => x.init?.method === "PUT");
    expect(put?.url).toBe("https://api.test/v2/companies/demo/invoices/drafts/12");
    expect(JSON.parse(String(put?.init?.body))).toEqual({
      type: "invoice", uuid: "u-12", issueDate: "2026-09-29", daysUntilDueDate: 14, invoiceText: "Ny tekst", yourReference: "Ola", ourReference: "Kari", orderReference: "PO-1",
      lines: [{ productId: 3, description: "Spade", unitPrice: 30000, vatType: "HIGH", quantity: 2, discount: 10, comment: "Stor", incomeAccount: "3000" }],
      currency: "NOK", bankAccountNumber: "12345678903", iban: "NO9386011117947", bic: "DNBANOKK", paymentAccount: "1920:10001", customerId: 7, projectId: 4, roundingType: "none",
    });
  });

  it("update_invoice_draft replaces lines only when given, validates them, and refuses an empty update before any call", async () => {
    const f = fakeFiken([{ match: /\/invoices\/drafts\/12$/, body: draft }]);
    const c = await connected(f.fetchImpl);
    expect((await callJson(c, "update_invoice_draft", { companySlug: "demo", draftId: 12 })).isError).toBe(true);
    expect((await callJson(c, "update_invoice_draft", { companySlug: "demo", draftId: 12, lines: [{ quantity: 1, description: "x" }] })).text).toContain("missing unitPrice");
    expect(f.calls).toHaveLength(0);
    const line = { description: "Timer", quantity: 3, unitPrice: 100000, vatType: "HIGH", incomeAccount: "3000" };
    await callJson(c, "update_invoice_draft", { companySlug: "demo", draftId: 12, customerId: 8, lines: [line] });
    const body = JSON.parse(String(f.calls.find((x) => x.init?.method === "PUT")?.init?.body));
    expect(body).toMatchObject({ customerId: 8, lines: [line], invoiceText: "Takk" });
  });
});
