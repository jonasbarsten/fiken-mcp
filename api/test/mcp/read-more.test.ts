import { describe, expect, it } from "vitest";
import { callJson, connected, fakeFiken } from "./helpers.js";

const count = (n: number) => ({ "Fiken-Api-Result-Count": String(n) });

describe("sales, products, balances, journal entries", () => {
  it("list_sales filters and trims", async () => {
    const f = fakeFiken([{ match: /\/sales\?/, headers: count(1), body: [{
      saleId: 3, saleNumber: "10001", date: "2026-09-01", kind: "invoice", netAmount: 10000, vatAmount: 2500, currency: "NOK",
      settled: false, totalPaid: 0, outstandingBalance: 12500, dueDate: "2026-09-15", customer: { contactId: 7, name: "Kunde AS", email: "k@x" },
      lines: [{ x: 1 }], salePayments: [], saleAttachments: [],
    }] }]);
    const c = await connected(f.fetchImpl);
    const r = await callJson(c, "list_sales", { companySlug: "demo", settled: false, dateGe: "2026-09-01" });
    expect(r.json()).toEqual({ items: [{
      saleId: 3, saleNumber: "10001", date: "2026-09-01", kind: "invoice", netAmount: 10000, vatAmount: 2500, currency: "NOK",
      settled: false, totalPaid: 0, outstandingBalance: 12500, dueDate: "2026-09-15", customer: { contactId: 7, name: "Kunde AS" },
    }], total: 1, page: 0, pageSize: 25 });
    expect(f.calls[0]?.url).toBe("https://api.test/v2/companies/demo/sales?page=0&pageSize=25&dateGe=2026-09-01&settled=false");
  });

  it("list_products trims", async () => {
    const f = fakeFiken([{ match: /\/products\?/, headers: count(1), body: [{ productId: 4, name: "Timepris", productNumber: "T1", unitPrice: 120000, incomeAccount: "3000", vatType: "HIGH", active: true, stock: 0, note: "x" }] }]);
    const c = await connected(f.fetchImpl);
    expect((await callJson(c, "list_products", { companySlug: "demo", active: true })).json()).toEqual({
      items: [{ productId: 4, name: "Timepris", productNumber: "T1", unitPrice: 120000, incomeAccount: "3000", vatType: "HIGH", active: true }], total: 1, page: 0, pageSize: 25,
    });
    expect(f.calls[0]?.url).toContain("active=true");
  });

  it("account_balances splits the range and requires a date", async () => {
    const f = fakeFiken([{ match: /\/accountBalances\?/, headers: count(1), body: [{ code: "3000", name: "Salgsinntekt", balance: -500000 }] }]);
    const c = await connected(f.fetchImpl);
    expect((await callJson(c, "account_balances", { companySlug: "demo", date: "2026-09-29", range: "3000-3999" })).json()).toEqual({
      items: [{ code: "3000", name: "Salgsinntekt", balance: -500000 }], total: 1, page: 0, pageSize: 25,
    });
    expect(f.calls[0]?.url).toBe("https://api.test/v2/companies/demo/accountBalances?page=0&pageSize=25&date=2026-09-29&fromAccount=3000&toAccount=3999");
    expect((await callJson(c, "account_balances", { companySlug: "demo", date: "2026-09-29", range: "1920" })).isError).toBe(false);
    expect(f.calls[1]?.url).toContain("fromAccount=1920&toAccount=1920");
    expect((await callJson(c, "account_balances", { companySlug: "demo" })).isError).toBe(true);
    expect(f.calls).toHaveLength(2);
  });

  it("bank_balances and get_journal_entries trim", async () => {
    const f = fakeFiken([
      { match: /\/bankBalances/, headers: count(1), body: [{ bankAccountId: 9, bankAccountCode: "1920:10001", date: "2026-09-29", amount: 1234500, source: "bank" }] },
      { match: /\/journalEntries\?/, headers: count(1), body: [{
        journalEntryId: 11, journalEntryNumber: 5, date: "2026-09-02", description: "Husleie", transactionId: 99,
        lines: [{ amount: 800000, debitAccount: "6300", creditAccount: "1920:10001", vatCode: "0" }], attachments: [{ uuid: "u" }],
      }] },
    ]);
    const c = await connected(f.fetchImpl);
    expect((await callJson(c, "bank_balances", { companySlug: "demo" })).json()).toEqual({
      items: [{ bankAccountId: 9, bankAccountCode: "1920:10001", date: "2026-09-29", amount: 1234500, source: "bank" }], total: 1, page: 0, pageSize: 25,
    });
    expect((await callJson(c, "get_journal_entries", { companySlug: "demo", dateGe: "2026-09-01", dateLe: "2026-09-30" })).json()).toEqual({
      items: [{ journalEntryId: 11, journalEntryNumber: 5, date: "2026-09-02", description: "Husleie", lines: [{ amount: 800000, account: undefined, debitAccount: "6300", creditAccount: "1920:10001" }], attachments: 1 }],
      total: 1, page: 0, pageSize: 25,
    });
    expect(f.calls[1]?.url).toBe("https://api.test/v2/companies/demo/journalEntries?page=0&pageSize=25&dateGe=2026-09-01&dateLe=2026-09-30");
  });
});
