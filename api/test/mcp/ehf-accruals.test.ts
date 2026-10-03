import { describe, expect, it } from "vitest";
import { callJson, connected, fakeFiken } from "./helpers.js";

const ehf = {
  ehfDocumentId: 31, documentType: "invoice", status: "unprocessed", issueDate: "2026-09-01", dueDate: "2026-09-30", invoiceNumber: "F-100",
  supplierName: "Leverandør AS", supplierOrganizationNumber: "999888777", supplierContactId: 5, currency: "NOK",
  net: 10000, vat: 2500, gross: 12500, amountDue: 12500, kid: "1234", accountNumber: "11112233334", iban: "NO93", bic: "DNBANOKK",
  description: "Kontorrekvisita", purchaseId: undefined, createdAt: "2026-09-02T10:00:00Z",
  documentUrl: "https://api.test/v2/files/f31", xmlUrl: "https://api.test/v2/files/x31",
  documentUrlWithFikenNormalUserCredentials: "https://fiken.test/a", xmlUrlWithFikenNormalUserCredentials: "https://fiken.test/b",
  lines: [{ description: "Papir", net: 10000, vat: 2500, vatType: "HIGH" }],
};

describe("EHF inbox", () => {
  it("list_ehf_documents sends the filters and trims the items", async () => {
    const f = fakeFiken([{ match: /\/ehf\?/, body: [ehf], headers: { "fiken-api-result-count": "1" } }]);
    const c = await connected(f.fetchImpl);
    const r = await callJson(c, "list_ehf_documents", { companySlug: "demo", status: "unprocessed", issueDateGe: "2026-09-01", issueDateLe: "2026-09-30" });
    expect(f.calls[0]?.url).toContain("status=unprocessed");
    expect(f.calls[0]?.url).toContain("issueDateGe=2026-09-01");
    expect(f.calls[0]?.url).toContain("issueDateLe=2026-09-30");
    const body = r.json() as { items: Array<Record<string, unknown>> };
    expect(body.items[0]).toEqual({
      ehfDocumentId: 31, documentType: "invoice", status: "unprocessed", issueDate: "2026-09-01", dueDate: "2026-09-30", invoiceNumber: "F-100",
      supplierName: "Leverandør AS", supplierOrganizationNumber: "999888777", supplierContactId: 5, currency: "NOK",
      net: 10000, vat: 2500, gross: 12500, amountDue: 12500, purchaseId: undefined,
    });
    expect(JSON.stringify(body)).not.toContain("documentUrl");
  });

  it("get_ehf_document adds the payment details and lines", async () => {
    const f = fakeFiken([{ match: /\/ehf\/31$/, body: ehf }]);
    const c = await connected(f.fetchImpl);
    const r = await callJson(c, "get_ehf_document", { companySlug: "demo", ehfDocumentId: 31 });
    expect(r.json()).toMatchObject({
      ehfDocumentId: 31, kid: "1234", accountNumber: "11112233334", iban: "NO93", bic: "DNBANOKK", description: "Kontorrekvisita",
      lines: [{ description: "Papir", net: 10000, vat: 2500, vatType: "HIGH" }],
    });
    expect(JSON.stringify(r.json())).not.toContain("Url");
  });
});

describe("attach_inbox_document with an EHF document", () => {
  const created = { status: 201 };

  it("sends ehfDocumentId instead of inboxDocumentId for purchases, sales and journal entries", async () => {
    const f = fakeFiken([{ match: /\/attachments\?/, ...created }]);
    const c = await connected(f.fetchImpl);
    expect((await callJson(c, "attach_inbox_document", { companySlug: "demo", purchaseId: 77, ehfDocumentId: 31 })).json()).toEqual({ purchaseId: 77, ehfDocumentId: 31 });
    expect(f.calls[0]?.url).toBe("https://api.test/v2/companies/demo/purchases/77/attachments?ehfDocumentId=31&attachToSale=true&attachToPayment=false");
    expect((await callJson(c, "attach_inbox_document", { companySlug: "demo", saleId: 3, ehfDocumentId: 31 })).json()).toEqual({ saleId: 3, ehfDocumentId: 31 });
    expect(f.calls[1]?.url).toBe("https://api.test/v2/companies/demo/sales/3/attachments?ehfDocumentId=31&attachToSale=true&attachToPayment=false");
    expect((await callJson(c, "attach_inbox_document", { companySlug: "demo", journalEntryId: 11, ehfDocumentId: 31 })).json()).toEqual({ journalEntryId: 11, ehfDocumentId: 31 });
    expect(f.calls[2]?.url).toBe("https://api.test/v2/companies/demo/journalEntries/11/attachments?ehfDocumentId=31");
    for (const call of f.calls) expect(call.url).not.toContain("inboxDocumentId");
  });

  it("needs exactly one of inboxDocumentId and ehfDocumentId, before any call", async () => {
    const f = fakeFiken([]);
    const c = await connected(f.fetchImpl);
    const both = await callJson(c, "attach_inbox_document", { companySlug: "demo", purchaseId: 77, inboxDocumentId: 9, ehfDocumentId: 31 });
    expect(both.isError).toBe(true);
    expect(both.text).toContain("exactly one of inboxDocumentId and ehfDocumentId");
    const neither = await callJson(c, "attach_inbox_document", { companySlug: "demo", purchaseId: 77 });
    expect(neither.isError).toBe(true);
    expect(neither.text).toContain("exactly one of inboxDocumentId and ehfDocumentId");
    expect(f.calls).toHaveLength(0);
  });

  it("refuses an EHF document on an invoice before any call", async () => {
    const f = fakeFiken([]);
    const c = await connected(f.fetchImpl);
    const r = await callJson(c, "attach_inbox_document", { companySlug: "demo", invoiceId: 77, ehfDocumentId: 31 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("An EHF document cannot be attached to an invoice.");
    expect(f.calls).toHaveLength(0);
  });
});

describe("accruals", () => {
  const body = { lineId: 5, startDate: "2026-10-01", periods: 12, account: "1749" };

  it("create_accrual posts to the sale or purchase and returns the accrual id", async () => {
    const f = fakeFiken([{ match: /\/accruals$/, status: 201, headers: { location: "https://api.test/v2/companies/demo/sales/9/accruals/44" } }]);
    const c = await connected(f.fetchImpl);
    const sale = await callJson(c, "create_accrual", { companySlug: "demo", saleId: 9, ...body });
    expect(sale.json()).toEqual({ accrualId: 44 });
    expect(f.calls[0]?.url).toBe("https://api.test/v2/companies/demo/sales/9/accruals");
    expect(JSON.parse(String(f.calls[0]?.init?.body))).toEqual(body);
    await callJson(c, "create_accrual", { companySlug: "demo", purchaseId: 77, lineId: 5, startDate: "2026-10-01", periods: 2, account: "1700" });
    expect(f.calls[1]?.url).toBe("https://api.test/v2/companies/demo/purchases/77/accruals");
    expect(JSON.parse(String(f.calls[1]?.init?.body))).toEqual({ lineId: 5, startDate: "2026-10-01", periods: 2, account: "1700" });
  });

  it("needs account, exactly one of saleId and purchaseId and at least two periods, before any call", async () => {
    const f = fakeFiken([]);
    const c = await connected(f.fetchImpl);
    const both = await callJson(c, "create_accrual", { companySlug: "demo", saleId: 9, purchaseId: 77, ...body });
    expect(both.isError).toBe(true);
    expect(both.text).toContain("exactly one of saleId and purchaseId");
    const neither = await callJson(c, "create_accrual", { companySlug: "demo", ...body });
    expect(neither.isError).toBe(true);
    expect((await callJson(c, "create_accrual", { companySlug: "demo", saleId: 9, ...body, periods: 1 })).isError).toBe(true);
    const { account: _account, ...noAccount } = body;
    expect((await callJson(c, "create_accrual", { companySlug: "demo", saleId: 9, ...noAccount })).isError).toBe(true);
    expect(f.calls).toHaveLength(0);
  });
});

describe("line ids", () => {
  it("get_purchase and get_sale expose lineId on lines", async () => {
    const f = fakeFiken([
      { match: /\/purchases\/77$/, body: { purchaseId: 77, date: "2026-09-01", kind: "cash_purchase", paid: true, currency: "NOK", lines: [{ lineId: 3, description: "Skruer", netPrice: 10000, vat: 2500, account: "6540", vatType: "HIGH" }] } },
      { match: /\/sales\/9$/, body: { saleId: 9, saleNumber: "S9", date: "2026-09-29", kind: "cash_sale", netAmount: 10000, vatAmount: 2500, currency: "NOK", settled: true, totalPaid: 12500, outstandingBalance: 0, lines: [{ lineId: 4, description: "Vipps", netPrice: 10000, vat: 2500, vatType: "HIGH", account: "3000" }] } },
    ]);
    const c = await connected(f.fetchImpl);
    expect((await callJson(c, "get_purchase", { companySlug: "demo", purchaseId: 77 })).json()).toMatchObject({ lines: [{ lineId: 3, description: "Skruer" }] });
    expect((await callJson(c, "get_sale", { companySlug: "demo", saleId: 9 })).json()).toMatchObject({ lines: [{ lineId: 4, description: "Vipps" }] });
  });
});
