import { describe, expect, it } from "vitest";
import { callJson, connected, fakeFiken } from "./helpers.js";

const entry = { journalEntryId: 21, journalEntryNumber: 51, date: "2026-09-29", description: "Fri postering registrert via API: Avskrivning", lines: [{ amount: 100000, account: "6000" }, { amount: -100000, account: "1200" }], attachments: [] };
const transaction = { transactionId: 77, createdDate: "2026-09-29", lastModifiedDate: "2026-09-29", description: "Avskrivning", type: "General Journal Entry", deleted: false, entries: [entry] };

describe("manual journal entries", () => {
  it("refuses an entry that does not balance, before any call", async () => {
    const f = fakeFiken([]);
    const c = await connected(f.fetchImpl);
    const r = await callJson(c, "create_journal_entry", { companySlug: "demo", description: "Avskrivning", date: "2026-09-29",
      lines: [{ amount: 100000, debitAccount: "6000" }, { amount: 90000, creditAccount: "1200" }] });
    expect(r).toMatchObject({ isError: true, text: "The entry does not balance: debit 100000 øre, credit 90000 øre." });
    const noAccount = await callJson(c, "create_journal_entry", { companySlug: "demo", description: "x", date: "2026-09-29", lines: [{ amount: 1 }, { amount: 1, creditAccount: "1200" }] });
    expect(noAccount.isError).toBe(true);
    expect(f.calls).toHaveLength(0);
  });

  it("refuses line projects and a too long description, before any call", async () => {
    const f = fakeFiken([]);
    const c = await connected(f.fetchImpl);
    const ok = [{ amount: 100, debitAccount: "6000" }, { amount: 100, creditAccount: "1200" }];
    const proj = await callJson(c, "create_journal_entry", { companySlug: "demo", description: "x", date: "2026-09-29", lines: [{ ...ok[0], projectId: 1 }, ok[1]] });
    expect(proj.isError).toBe(true);
    const long = await callJson(c, "create_journal_entry", { companySlug: "demo", description: "x".repeat(170), date: "2026-09-29", lines: ok });
    expect(long.isError).toBe(true);
    expect(f.calls).toHaveLength(0);
  });

  it("passes VAT codes through and leaves the balance to Fiken when a line has one", async () => {
    const f = fakeFiken([
      { match: /\/generalJournalEntries$/, status: 201, headers: { location: "https://api.test/v2/companies/demo/transactions/77" } },
      { match: /\/transactions\/77$/, body: transaction },
    ]);
    const c = await connected(f.fetchImpl);
    // Debit is net (100 000 øre plus 25 % VAT), credit is gross: they do not sum to equal, Fiken books the VAT.
    const lines = [{ amount: 100000, debitAccount: "6540", debitVatCode: 1 }, { amount: 125000, creditAccount: "2911" }];
    const r = await callJson(c, "create_journal_entry", { companySlug: "demo", description: "Utlegg Ola", date: "2026-10-05", lines });
    expect(r.isError).toBe(false);
    const body = JSON.parse(String(f.calls[0]!.init!.body)) as { journalEntries: Array<{ lines: unknown[] }> };
    expect(body.journalEntries[0]!.lines).toEqual(lines);
  });

  it("still refuses an unbalanced entry without VAT codes, and a negative VAT code", async () => {
    const f = fakeFiken([]);
    const c = await connected(f.fetchImpl);
    const r = await callJson(c, "create_journal_entry", { companySlug: "demo", description: "x", date: "2026-10-05",
      lines: [{ amount: 100, debitAccount: "6000" }, { amount: 90, creditAccount: "1200" }] });
    expect(r).toMatchObject({ isError: true, text: "The entry does not balance: debit 100 øre, credit 90 øre." });
    const neg = await callJson(c, "create_journal_entry", { companySlug: "demo", description: "x", date: "2026-10-05",
      lines: [{ amount: 100, debitAccount: "6000", debitVatCode: -1 }, { amount: 100, creditAccount: "1200" }] });
    expect(neg.isError).toBe(true);
    expect(f.calls).toHaveLength(0);
  });

  it("posts one entry and reads it back", async () => {
    const f = fakeFiken([
      { match: /\/generalJournalEntries$/, status: 201, headers: { location: "https://api.test/v2/companies/demo/transactions/77" } },
      { match: /\/transactions\/77$/, body: transaction },
    ]);
    const c = await connected(f.fetchImpl);
    const lines = [{ amount: 100000, debitAccount: "6000" }, { amount: 100000, creditAccount: "1200" }];
    const r = await callJson(c, "create_journal_entry", { companySlug: "demo", description: "Avskrivning", date: "2026-09-29", lines });
    expect(r.json()).toMatchObject({ journalEntryId: 21, journalEntryNumber: 51 });
    expect(f.calls[1]?.url).toBe("https://api.test/v2/companies/demo/transactions/77");
    expect(JSON.parse(String(f.calls[0]?.init?.body))).toEqual({ description: "Avskrivning", journalEntries: [{ description: "Avskrivning", date: "2026-09-29", lines }] });
  });

  it("returns every journal entry of the transaction when there are several", async () => {
    const f = fakeFiken([
      { match: /\/generalJournalEntries$/, status: 201, headers: { location: "https://api.test/v2/companies/demo/transactions/77" } },
      { match: /\/transactions\/77$/, body: { ...transaction, entries: [entry, { ...entry, journalEntryId: 22 }] } },
    ]);
    const c = await connected(f.fetchImpl);
    const lines = [{ amount: 100000, debitAccount: "6000" }, { amount: 100000, creditAccount: "1200" }];
    const r = await callJson(c, "create_journal_entry", { companySlug: "demo", description: "Avskrivning", date: "2026-09-29", lines });
    const json = r.json() as { transactionId: number; journalEntries: Array<{ journalEntryId: number }> };
    expect(json.transactionId).toBe(77);
    expect(json.journalEntries.map((j) => j.journalEntryId)).toEqual([21, 22]);
  });

  it("a line with both accounts balances by itself", async () => {
    const f = fakeFiken([
      { match: /\/generalJournalEntries$/, status: 201, headers: { location: "https://api.test/v2/companies/demo/transactions/77" } },
      { match: /\/transactions\/77$/, body: transaction },
    ]);
    const c = await connected(f.fetchImpl);
    const r = await callJson(c, "create_journal_entry", { companySlug: "demo", description: "Overføring", date: "2026-09-29", lines: [{ amount: 5000, debitAccount: "1920:10002", creditAccount: "1920:10001" }] });
    expect(r.isError).toBe(false);
  });

  it("sends open only when given, and names the created entry when the read-back fails", async () => {
    const f = fakeFiken([
      { match: /\/generalJournalEntries$/, status: 201, headers: { location: "https://api.test/v2/companies/demo/transactions/77" } },
      { match: /\/transactions\/77$/, status: 500, body: "x" },
    ]);
    const c = await connected(f.fetchImpl);
    const lines = [{ amount: 100, debitAccount: "6000" }, { amount: 100, creditAccount: "1200" }];
    const r = await callJson(c, "create_journal_entry", { companySlug: "demo", description: "A", date: "2026-09-29", lines, open: true });
    expect(JSON.parse(String(f.calls[0]?.init?.body))).toMatchObject({ open: true });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("transaction 77 was created");
    expect(r.text).toContain("Do not create it again");
    expect(r.text).toContain("get_transaction");
  });
});

describe("journal entry and transaction reads", () => {
  it("get_journal_entry trims one entry", async () => {
    const f = fakeFiken([{ match: /\/journalEntries\/21$/, body: entry }]);
    const c = await connected(f.fetchImpl);
    const r = await callJson(c, "get_journal_entry", { companySlug: "demo", journalEntryId: 21 });
    expect(r.json()).toMatchObject({ journalEntryId: 21, journalEntryNumber: 51, attachments: 0 });
  });

  it("list_transactions filters by created date", async () => {
    const f = fakeFiken([{ match: /\/transactions\?/, body: [transaction] }]);
    const c = await connected(f.fetchImpl);
    const r = await callJson(c, "list_transactions", { companySlug: "demo", createdDateGe: "2026-09-01" });
    expect(f.calls[0]?.url).toContain("createdDateGe=2026-09-01");
    expect(r.json()).toMatchObject({ items: [{ transactionId: 77, type: "General Journal Entry", entries: 1 }] });
  });

  it("get_transaction includes its journal entries", async () => {
    const f = fakeFiken([{ match: /\/transactions\/77$/, body: transaction }]);
    const c = await connected(f.fetchImpl);
    const r = await callJson(c, "get_transaction", { companySlug: "demo", transactionId: 77 });
    expect(r.json()).toMatchObject({ transactionId: 77, deleted: false, entries: [{ journalEntryId: 21, journalEntryNumber: 51, date: "2026-09-29" }] });
  });
});
