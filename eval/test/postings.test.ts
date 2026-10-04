import { describe, expect, it } from "vitest";
import { toPostings, type Proposal } from "../src/postings.js";

const p = (operation: string, args: Record<string, unknown>): Proposal => ({ operation, args, via: "preview" });

describe("toPostings", () => {
  it("journal entry: a side with VAT code 1 is net at 25 %, a side without is as given", () => {
    const c = toPostings(p("create_journal_entry", { lines: [{ amount: 40000, debitAccount: "6800", debitVatCode: 1 }, { amount: 50000, creditAccount: "2911" }] }));
    expect(c!.postings).toEqual([
      { side: "debit", account: "6800", net: 40000, vat: "25", vatAmount: 10000 },
      { side: "credit", account: "2911", net: 50000, vat: undefined, vatAmount: 0 },
    ]);
    expect(c!.notes).toEqual([]);
  });

  it("journal entry: a two-sided line gives two postings", () => {
    const c = toPostings(p("create_journal_entry", { lines: [{ amount: 8900, debitAccount: "7770", creditAccount: "1920:10001" }] }));
    expect(c!.postings.map((x) => [x.side, x.account, x.net])).toEqual([["debit", "7770", 8900], ["credit", "1920:10001", 8900]]);
  });

  it("journal entry: an unknown VAT code is kept as «kode N» with a note", () => {
    const c = toPostings(p("create_journal_entry", { lines: [{ amount: 1000, debitAccount: "6800", debitVatCode: 11, creditAccount: "1920:10001" }] }));
    expect(c!.postings[0]).toEqual({ side: "debit", account: "6800", net: 1000, vat: "kode 11", vatAmount: 0 });
    expect(c!.notes).toEqual(["Mva-kode 11 er ukjent for evalueringen; balansen er ikke sjekket."]);
  });

  it("cash purchase: lines debit, the payment account credits the gross total", () => {
    const c = toPostings(p("create_purchase", {
      kind: "cash_purchase", paymentAccount: "1920:10001",
      lines: [{ description: "Rekvisita", netPrice: 50000, vat: 12500, account: "6800", vatType: "HIGH" }, { description: "Porto", netPrice: 2000, vat: 0, account: "6940", vatType: "NONE" }],
    }));
    expect(c!.postings).toEqual([
      { side: "debit", account: "6800", net: 50000, vat: "25", vatAmount: 12500 },
      { side: "debit", account: "6940", net: 2000, vat: "0", vatAmount: 0 },
      { side: "credit", account: "1920:10001", net: 64500, vat: undefined, vatAmount: 0 },
    ]);
  });

  it("supplier purchase credits 2400", () => {
    const c = toPostings(p("create_purchase", { kind: "supplier", lines: [{ description: "x", netPrice: 100000, vat: 25000, account: "6550", vatType: "HIGH" }] }));
    expect(c!.postings.at(-1)).toEqual({ side: "credit", account: "2400", net: 125000, vat: undefined, vatAmount: 0 });
  });

  it("cash sale: lines credit, the payment account debits the gross; a fee is noted", () => {
    const c = toPostings(p("create_sale", { kind: "cash_sale", paymentAccount: "1920:10001", paymentFee: 500, lines: [{ description: "Varer", netPrice: 200000, vat: 50000, vatType: "HIGH", account: "3000" }] }));
    expect(c!.postings).toEqual([
      { side: "debit", account: "1920:10001", net: 250000, vat: undefined, vatAmount: 0 },
      { side: "credit", account: "3000", net: 200000, vat: "25", vatAmount: 50000 },
    ]);
    expect(c!.notes).toEqual(["paymentFee er ikke med i posteringene."]);
  });

  it("invoice: quantity × unitPrice less discount, VAT from vatType, 1500 debits the gross", () => {
    const c = toPostings(p("create_invoice", { lines: [{ description: "Rådgivning", quantity: 10, unitPrice: 120000, vatType: "HIGH", incomeAccount: "3000", discount: 10 }] }));
    expect(c!.postings).toEqual([
      { side: "debit", account: "1500", net: 1350000, vat: undefined, vatAmount: 0 },
      { side: "credit", account: "3000", net: 1080000, vat: "25", vatAmount: 270000 },
    ]);
  });

  it("invoice line without unitPrice is noted", () => {
    const c = toPostings(p("create_invoice", { lines: [{ productId: 5, quantity: 1 }] }));
    expect(c!.notes).toEqual(["Linje 1 har ingen unitPrice (produkt); beløpet er ikke kjent."]);
  });

  it("partial credit note swaps the sides; a full one has no postings and a note", () => {
    const partial = toPostings(p("create_credit_note", { kind: "partial", lines: [{ description: "Avslag", quantity: 1, unitPrice: 45600, vatType: "HIGH", incomeAccount: "3000" }] }));
    expect(partial!.postings).toEqual([
      { side: "debit", account: "3000", net: 45600, vat: "25", vatAmount: 11400 },
      { side: "credit", account: "1500", net: 57000, vat: undefined, vatAmount: 0 },
    ]);
    const full = toPostings(p("create_credit_note", { kind: "full", invoiceId: 1 }));
    expect(full).toEqual({ postings: [], notes: ["Full kreditnota: posteringene er fakturaens, motsatt vei."] });
  });

  it("payment on a sale debits the bank and credits 1500; on a purchase debits 2400", () => {
    expect(toPostings(p("register_payment", { saleId: 1, account: "1920:10001", amount: 31250 }))!.postings).toEqual([
      { side: "debit", account: "1920:10001", net: 31250, vat: undefined, vatAmount: 0 },
      { side: "credit", account: "1500", net: 31250, vat: undefined, vatAmount: 0 },
    ]);
    expect(toPostings(p("register_payment", { purchaseId: 1, account: "1920:10001", amount: 100 }))!.postings.map((x) => x.account)).toEqual(["2400", "1920:10001"]);
  });

  it("has no converter for other operations", () => {
    expect(toPostings(p("create_contact", { name: "x" }))).toBeUndefined();
  });
});
