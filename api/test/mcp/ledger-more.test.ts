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

  it("refuses VAT codes, line projects and a too long description, before any call", async () => {
    const f = fakeFiken([]);
    const c = await connected(f.fetchImpl);
    const ok = [{ amount: 100, debitAccount: "6000" }, { amount: 100, creditAccount: "1200" }];
    const vat = await callJson(c, "create_journal_entry", { companySlug: "demo", description: "x", date: "2026-09-29", lines: [{ amount: 100, debitAccount: "6000", debitVatCode: 1 }, ok[1]] });
    expect(vat.isError).toBe(true);
    const proj = await callJson(c, "create_journal_entry", { companySlug: "demo", description: "x", date: "2026-09-29", lines: [{ ...ok[0], projectId: 1 }, ok[1]] });
    expect(proj.isError).toBe(true);
    const long = await callJson(c, "create_journal_entry", { companySlug: "demo", description: "x".repeat(170), date: "2026-09-29", lines: ok });
    expect(long.isError).toBe(true);
    expect(f.calls).toHaveLength(0);
  });

  it("posts one entry and reads it back", async () => {
    const f = fakeFiken([
      { match: /\/generalJournalEntries$/, status: 201, headers: { location: "https://api.test/v2/companies/demo/journalEntries/21" } },
      { match: /\/journalEntries\/21$/, body: entry },
    ]);
    const c = await connected(f.fetchImpl);
    const lines = [{ amount: 100000, debitAccount: "6000" }, { amount: 100000, creditAccount: "1200" }];
    const r = await callJson(c, "create_journal_entry", { companySlug: "demo", description: "Avskrivning", date: "2026-09-29", lines });
    expect(r.json()).toMatchObject({ journalEntryId: 21, journalEntryNumber: 51 });
    expect(JSON.parse(String(f.calls[0]?.init?.body))).toEqual({ description: "Avskrivning", journalEntries: [{ description: "Avskrivning", date: "2026-09-29", lines }] });
  });

  it("a line with both accounts balances by itself", async () => {
    const f = fakeFiken([
      { match: /\/generalJournalEntries$/, status: 201, headers: { location: "https://api.test/v2/companies/demo/journalEntries/21" } },
      { match: /\/journalEntries\/21$/, body: entry },
    ]);
    const c = await connected(f.fetchImpl);
    const r = await callJson(c, "create_journal_entry", { companySlug: "demo", description: "Overføring", date: "2026-09-29", lines: [{ amount: 5000, debitAccount: "1920:10002", creditAccount: "1920:10001" }] });
    expect(r.isError).toBe(false);
  });

  it("sends open only when given, and names the created entry when the read-back fails", async () => {
    const f = fakeFiken([
      { match: /\/generalJournalEntries$/, status: 201, headers: { location: "https://api.test/v2/companies/demo/journalEntries/21" } },
      { match: /\/journalEntries\/21$/, status: 500, body: "x" },
    ]);
    const c = await connected(f.fetchImpl);
    const lines = [{ amount: 100, debitAccount: "6000" }, { amount: 100, creditAccount: "1200" }];
    const r = await callJson(c, "create_journal_entry", { companySlug: "demo", description: "A", date: "2026-09-29", lines, open: true });
    expect(JSON.parse(String(f.calls[0]?.init?.body))).toMatchObject({ open: true });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Journal entry 21 was created");
    expect(r.text).toContain("get_journal_entries");
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
