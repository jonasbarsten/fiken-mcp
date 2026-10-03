import { describe, expect, it } from "vitest";
import { callJson, connected, fakeFiken } from "./helpers.js";

const sale = { saleId: 9, saleNumber: "S9", date: "2026-09-29", kind: "cash_sale", netAmount: 10000, vatAmount: 2500, currency: "NOK", settled: true, deleted: false, totalPaid: 12500, outstandingBalance: 0,
  lines: [{ description: "Vipps", netPrice: 10000, vat: 2500, vatType: "HIGH", account: "3000", lineId: 1 }], salePayments: [{ paymentId: 1 }] };
const line = { description: "Vipps-salg", netPrice: 10000, vat: 2500, vatType: "HIGH", account: "3000" };

describe("sales", () => {
  it("create_sale books a cash sale and reads it back; validation runs first", async () => {
    const f = fakeFiken([
      { match: /\/sales$/, status: 201, headers: { location: "https://api.test/v2/companies/demo/sales/9" } },
      { match: /\/sales\/9$/, body: sale },
    ]);
    const c = await connected(f.fetchImpl);
    const noPay = await callJson(c, "create_sale", { companySlug: "demo", date: "2026-09-29", kind: "cash_sale", lines: [line] });
    expect(noPay.isError).toBe(true);
    expect(f.calls).toHaveLength(0);
    const typo = await callJson(c, "create_sale", { companySlug: "demo", date: "2026-09-29", kind: "cash_sale", paymentAccount: "1920:10001", paymentDate: "2026-09-29", lines: [{ ...line, netprice: 1 }] });
    expect(typo.isError).toBe(true);
    const ok = await callJson(c, "create_sale", { companySlug: "demo", date: "2026-09-29", kind: "cash_sale", paymentAccount: "1920:10001", paymentDate: "2026-09-29", lines: [line] });
    expect(ok.json()).toMatchObject({ saleId: 9, kind: "cash_sale", payments: 1 });
    expect(JSON.parse(String(f.calls[0]?.init?.body))).toEqual({ date: "2026-09-29", kind: "cash_sale", currency: "NOK", paymentAccount: "1920:10001", paymentDate: "2026-09-29", totalPaid: 12500, lines: [line] });
    const line2 = { description: "Kaffe", netPrice: 4000, vat: 1000, vatType: "HIGH", account: "3000" };
    await callJson(c, "create_sale", { companySlug: "demo", date: "2026-09-29", kind: "cash_sale", paymentAccount: "1920:10001", paymentDate: "2026-09-29", lines: [line, line2] });
    expect(JSON.parse(String(f.calls[2]?.init?.body))).toMatchObject({ totalPaid: 17500 });
  });

  it("create_sale refuses other currencies and fields of the other kind before any call", async () => {
    const f = fakeFiken([]);
    const c = await connected(f.fetchImpl);
    const pay = { paymentAccount: "1920:10001", paymentDate: "2026-09-29" };
    const base = { companySlug: "demo", date: "2026-09-29", lines: [line] };
    expect((await callJson(c, "create_sale", { ...base, kind: "cash_sale", ...pay, currency: "EUR" })).isError).toBe(true);
    const cash = await callJson(c, "create_sale", { ...base, kind: "cash_sale", ...pay, dueDate: "2026-10-13" });
    expect(cash.isError).toBe(true);
    expect(cash.text).toContain("dueDate");
    const ext = await callJson(c, "create_sale", { ...base, kind: "external_invoice", customerId: 7, dueDate: "2026-10-13", paymentFee: 100 });
    expect(ext.isError).toBe(true);
    expect(ext.text).toContain("paymentFee");
    expect(f.calls).toHaveLength(0);
  });

  it("create_sale names the created sale when the read-back fails", async () => {
    const f = fakeFiken([
      { match: /\/sales$/, status: 201, headers: { location: "https://api.test/v2/companies/demo/sales/9" } },
      { match: /\/sales\/9$/, status: 500, body: "x" },
    ]);
    const c = await connected(f.fetchImpl);
    const r = await callJson(c, "create_sale", { companySlug: "demo", date: "2026-09-29", kind: "external_invoice", customerId: 7, dueDate: "2026-10-13", lines: [line] });
    expect(r.text).toContain("Sale 9 was created");
    expect(r.text).toContain('call fiken_read with {"operation":"get_sale"');
  });

  it("get_sale trims the lines and counts the payments", async () => {
    const f = fakeFiken([{ match: /\/sales\/9$/, body: sale }]);
    const c = await connected(f.fetchImpl);
    const r = await callJson(c, "get_sale", { companySlug: "demo", saleId: 9 });
    expect(r.json()).toMatchObject({ saleId: 9, payments: 1, lines: [{ description: "Vipps", netPrice: 10000, vat: 2500, vatType: "HIGH", account: "3000" }] });
    expect(r.json()).toMatchObject({ lines: [{ lineId: 1 }] });
  });

  it("settle_sale (with Fiken's required settledDate) and write_off_sale patch the sale", async () => {
    const f = fakeFiken([{ match: /\/sales\/9\/(settled|writeOff)(\?|$)/, status: 200 }]);
    const c = await connected(f.fetchImpl);
    expect((await callJson(c, "settle_sale", { companySlug: "demo", saleId: 9 })).isError).toBe(true);
    expect(f.calls).toHaveLength(0);
    expect((await callJson(c, "settle_sale", { companySlug: "demo", saleId: 9, settledDate: "2026-09-29" })).json()).toEqual({ saleId: 9, settled: true, settledDate: "2026-09-29" });
    expect(f.calls[0]?.init?.method).toBe("PATCH");
    expect(f.calls[0]?.url).toBe("https://api.test/v2/companies/demo/sales/9/settled?settledDate=2026-09-29");
    expect(f.calls[0]?.init?.body).toBeUndefined();
    const w = await callJson(c, "write_off_sale", { companySlug: "demo", saleId: 9, type: "COLLECTION_FAILED", date: "2026-09-29" });
    expect(w.json()).toEqual({ saleId: 9, writtenOff: true, type: "COLLECTION_FAILED" });
    expect(f.calls[1]?.url).toBe("https://api.test/v2/companies/demo/sales/9/writeOff");
    expect(JSON.parse(String(f.calls[1]?.init?.body))).toEqual({ type: "COLLECTION_FAILED", date: "2026-09-29" });
  });

  it("list_payments needs exactly one target and trims", async () => {
    const f = fakeFiken([{ match: /\/purchases\/8\/payments$/, body: [{ paymentId: 4, date: "2026-09-29", account: "1920:10001", amount: 500, fee: 0, currency: "NOK" }] }]);
    const c = await connected(f.fetchImpl);
    expect((await callJson(c, "list_payments", { companySlug: "demo" })).isError).toBe(true);
    expect((await callJson(c, "list_payments", { companySlug: "demo", saleId: 1, purchaseId: 8 })).isError).toBe(true);
    expect(f.calls).toHaveLength(0);
    expect((await callJson(c, "list_payments", { companySlug: "demo", purchaseId: 8 })).json()).toEqual({ items: [{ paymentId: 4, date: "2026-09-29", account: "1920:10001", amount: 500, fee: 0 }] });
  });
});
