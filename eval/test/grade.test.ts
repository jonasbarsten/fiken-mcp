import { describe, expect, it } from "vitest";
import type { Case } from "../cases/types.js";
import { accountMatches, behaviourOf, grade, kr, type Trace } from "../src/grade.js";

const outlay: Case["expect"] = {
  operations: ["create_journal_entry", "create_purchase"],
  postings: [
    { side: "debit", account: ["6800", "6810"], net: 40000, vat: "25" },
    { side: "credit", account: ["2911"], amount: 50000 },
  ],
};
const journal = (lines: unknown[]): Trace => ({ calls: [], proposal: { operation: "create_journal_entry", args: { lines }, via: "preview" } });

describe("accountMatches", () => {
  it("matches exactly, or by prefix with a trailing *", () => {
    expect(accountMatches("1920", "1920")).toBe(true);
    expect(accountMatches("1920", "1920:10001")).toBe(false);
    expect(accountMatches("1920*", "1920:10001")).toBe(true);
    expect(accountMatches("2*", "1500")).toBe(false);
  });
});

describe("grade", () => {
  it("passes the right outlay, with an alternative account", () => {
    const g = grade(outlay, journal([{ amount: 40000, debitAccount: "6810", debitVatCode: 1 }, { amount: 50000, creditAccount: "2911" }]));
    expect(g).toMatchObject({ outcome: "pass", problems: [] });
  });

  it("passes a purchase with the same effect", () => {
    const g = grade({ ...outlay, postings: [outlay.postings[0]!, { side: "credit", account: ["1920*"], amount: 50000 }] }, {
      calls: [],
      proposal: { operation: "create_purchase", via: "write", args: { kind: "cash_purchase", paymentAccount: "1920:10001", lines: [{ description: "x", netPrice: 40000, vat: 10000, account: "6800", vatType: "HIGH" }] } },
    });
    expect(g.outcome).toBe("pass");
  });

  it("explains a wrong credit account in Norwegian", () => {
    const g = grade(outlay, journal([{ amount: 40000, debitAccount: "6800", debitVatCode: 1 }, { amount: 50000, creditAccount: "1920:10001" }]));
    expect(g.outcome).toBe("wrong");
    expect(g.problems).toEqual([`Forventet kredit 2911 ${kr(50000)}, fikk kredit 1920:10001 ${kr(50000)}.`]);
  });

  it("reports an unexpected posting when exact, not otherwise", () => {
    const lines = [{ amount: 40000, debitAccount: "6800", debitVatCode: 1 }, { amount: 50000, creditAccount: "2911" }, { amount: 100, debitAccount: "7770", creditAccount: "1920:10001" }];
    expect(grade(outlay, journal(lines)).problems).toEqual([`Uventet debet 7770 ${kr(100)}.`, `Uventet kredit 1920:10001 ${kr(100)}.`]);
    expect(grade({ ...outlay, exact: false }, journal(lines)).outcome).toBe("pass");
  });

  it("reports an unbalanced proposal", () => {
    const g = grade({ operations: ["create_journal_entry"], postings: [], exact: false }, journal([{ amount: 100, debitAccount: "6800" }, { amount: 90, creditAccount: "1920:10001" }]));
    expect(g.problems).toEqual([`Går ikke i balanse: debet ${kr(100)}, kredit ${kr(90)}.`]);
  });

  it("does not check the balance with an unknown VAT code, and says so", () => {
    const g = grade({ operations: ["create_journal_entry"], postings: [], exact: false }, journal([{ amount: 100, debitAccount: "6800", debitVatCode: 11, creditAccount: "1920:10001" }]));
    expect(g.outcome).toBe("pass");
    expect(g.notes).toEqual(["Mva-kode 11 er ukjent for evalueringen; balansen er ikke sjekket."]);
  });

  it("refuses an operation outside the list and checks expected args", () => {
    const g = grade({ operations: ["register_payment"], postings: [], exact: false, args: { saleId: 7 } }, {
      calls: [],
      proposal: { operation: "create_sale", via: "write", args: { saleId: 8, kind: "cash_sale", lines: [], paymentAccount: "1920:10001" } },
    });
    expect(g.problems).toEqual(["Operasjonen create_sale er ikke blant register_payment.", "Forventet saleId 7, fikk 8."]);
  });

  it("grades an operation without a converter on the operation only", () => {
    const g = grade({ operations: ["create_contact"], postings: [] }, { calls: [], proposal: { operation: "create_contact", via: "write", args: { name: "x" } } });
    expect(g).toMatchObject({ outcome: "pass", notes: ["create_contact har ingen omregning til posteringer; bare operasjonen er sjekket."] });
  });

  it("has outcomes for no proposal and an error", () => {
    expect(grade(outlay, { calls: [] }).outcome).toBe("none");
    expect(grade(outlay, { calls: [], error: "boom" })).toMatchObject({ outcome: "error", problems: ["boom"] });
  });
});

describe("behaviourOf", () => {
  it("sees a preview before the first write, a choice and a help article", () => {
    expect(behaviourOf([
      { name: "ask_user_choice", args: {} },
      { name: "fiken_read", args: { operation: "fiken_help_article", args: { slug: "x" } } },
      { name: "preview_booking", args: {} },
      { name: "fiken_write", args: {}, blocked: true },
    ])).toEqual({ previewFirst: true, askChoice: true, readHelp: true });
    expect(behaviourOf([{ name: "fiken_write", args: {}, blocked: true }])).toEqual({ previewFirst: false, askChoice: false, readHelp: false });
  });
});
