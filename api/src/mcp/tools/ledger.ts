import { z } from "zod";
import { defineOperation, type Operation } from "../operations.js";
import { companySlug, isoDate, ORE, paged, paging, withCompany } from "./common.js";

interface FikenAccountBalance {
  code: string;
  name: string;
  balance: number;
}

interface FikenBankBalance {
  bankAccountId: number;
  bankAccountCode: string;
  date: string;
  amount: number;
  source: string;
}

interface FikenJournalEntry {
  journalEntryId: number;
  journalEntryNumber: number;
  date: string;
  description: string;
  lines: Array<{ amount: number; account?: string; vatCode?: string; debitAccount?: string; creditAccount?: string }>;
  attachments?: unknown[];
}

export const ledgerOperations: Operation[] = [
  defineOperation({
    name: "account_balances",
    concept: "accounts",
    kind: "read",
    destructive: false,
    title: "Account balances",
    description: `Balance per account on a date (saldo), e.g. range 3000-3999 for income. date is required. ${ORE}`,
    input: z.object({
      companySlug,
      ...paging,
      date: isoDate.describe("Balance date (YYYY-MM-DD)"),
      range: z
        .string()
        .trim()
        .regex(/^\d{4}(-\d{4})?$/, "range is one account code like 1920 or two like 3000-3999")
        .optional()
        .describe('Account code range, e.g. "3000-3999"; a single code like "1920" means just that account'),
    }),
    async run(ctx, { companySlug: slug, page, pageSize, date, range }) {
      return withCompany(ctx, slug, async () => {
        const [fromAccount, toAccount] = range === undefined ? [undefined, undefined] : range.includes("-") ? range.split("-") : [range, range];
        const { items, total } = await ctx.fiken.list<FikenAccountBalance>(`/companies/${slug}/accountBalances`, {
          page,
          pageSize,
          date,
          fromAccount,
          toAccount,
        });
        return paged(
          items.map((a) => ({ code: a.code, name: a.name, balance: a.balance })),
          total,
          page,
          pageSize,
        );
      });
    },
  }),

  defineOperation({
    name: "bank_balances",
    concept: "accounts",
    kind: "read",
    destructive: false,
    title: "Bank balances",
    description: `Balance of each bank account on a date (today when left out). ${ORE}`,
    input: z.object({
      companySlug,
      ...paging,
      date: isoDate.optional().describe("Balance date (YYYY-MM-DD); today when left out"),
    }),
    async run(ctx, { companySlug: slug, page, pageSize, date }) {
      return withCompany(ctx, slug, async () => {
        const { items, total } = await ctx.fiken.list<FikenBankBalance>(`/companies/${slug}/bankBalances`, { page, pageSize, date });
        return paged(
          items.map((b) => ({ bankAccountId: b.bankAccountId, bankAccountCode: b.bankAccountCode, date: b.date, amount: b.amount, source: b.source })),
          total,
          page,
          pageSize,
        );
      });
    },
  }),

  defineOperation({
    name: "get_journal_entries",
    concept: "ledger",
    kind: "read",
    destructive: false,
    title: "Get journal entries",
    description: `Journal entries (bilag/posteringer) in a date range; journalEntryId is what attach_inbox_document (via fiken_write) takes. ${ORE}`,
    input: z.object({
      companySlug,
      ...paging,
      dateGe: isoDate.optional().describe("Only entries on or after this date (YYYY-MM-DD)"),
      dateLe: isoDate.optional().describe("Only entries on or before this date (YYYY-MM-DD)"),
    }),
    async run(ctx, { companySlug: slug, page, pageSize, dateGe, dateLe }) {
      return withCompany(ctx, slug, async () => {
        const { items, total } = await ctx.fiken.list<FikenJournalEntry>(`/companies/${slug}/journalEntries`, { page, pageSize, dateGe, dateLe });
        return paged(
          items.map((j) => ({
            journalEntryId: j.journalEntryId,
            journalEntryNumber: j.journalEntryNumber,
            date: j.date,
            description: j.description,
            lines: j.lines.map((l) => ({ amount: l.amount, account: l.account, vatCode: l.vatCode, debitAccount: l.debitAccount, creditAccount: l.creditAccount })),
            attachments: (j.attachments ?? []).length,
          })),
          total,
          page,
          pageSize,
        );
      });
    },
  }),
];
