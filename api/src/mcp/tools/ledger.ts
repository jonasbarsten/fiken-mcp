import { z } from "zod";
import { defineOperation, type Operation } from "../operations.js";
import { errorText, toolJson } from "../context.js";
import { companySlug, CONFIRM, defined, gatewayCall, isoDate, ORE, paged, paging, toolText, withCompany } from "./common.js";

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

interface FikenTransaction {
  transactionId: number;
  createdDate: string;
  lastModifiedDate: string;
  description: string;
  type: string;
  deleted?: boolean;
  entries?: FikenJournalEntry[];
}

function trimJournalEntry(j: FikenJournalEntry) {
  return {
    journalEntryId: j.journalEntryId,
    journalEntryNumber: j.journalEntryNumber,
    date: j.date,
    description: j.description,
    lines: j.lines.map((l) => ({ amount: l.amount, account: l.account, vatCode: l.vatCode, debitAccount: l.debitAccount, creditAccount: l.creditAccount })),
    attachments: (j.attachments ?? []).length,
  };
}

function trimTransactionSummary(t: FikenTransaction) {
  return {
    transactionId: t.transactionId,
    createdDate: t.createdDate,
    lastModifiedDate: t.lastModifiedDate,
    description: t.description,
    type: t.type,
    entries: (t.entries ?? []).length,
  };
}

const journalEntryLine = z
  .object({
    amount: z.number().int().positive().describe(`Amount moved. ${ORE}`),
    debitAccount: z.string().min(1).optional().describe("Account code to debit, from list_accounts (via fiken_read); bank accounts look like 1920:10001"),
    creditAccount: z.string().min(1).optional().describe("Account code to credit, from list_accounts (via fiken_read)"),
  })
  .strict();

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
          items.map(trimJournalEntry),
          total,
          page,
          pageSize,
        );
      });
    },
  }),

  defineOperation({
    name: "get_journal_entry",
    concept: "ledger",
    kind: "read",
    destructive: false,
    title: "Get journal entry",
    description: `One journal entry (bilag) with its lines. ${ORE}`,
    input: z.object({ companySlug, journalEntryId: z.number().int().describe("Journal entry id, from get_journal_entries (via fiken_read)") }),
    async run(ctx, { companySlug: slug, journalEntryId }) {
      return withCompany(ctx, slug, async () => toolJson(trimJournalEntry(await ctx.fiken.json<FikenJournalEntry>(`/companies/${slug}/journalEntries/${journalEntryId}`))));
    },
  }),

  defineOperation({
    name: "create_journal_entry",
    concept: "ledger",
    kind: "write",
    destructive: true,
    title: "Create journal entry",
    description:
      "Book a manual journal entry (fri postering): corrections, depreciation, salary, transfers between accounts. " +
      "Each line moves amount (øre) to debitAccount and/or from creditAccount; debits and credits must balance. " +
      `Fiken prefixes the description with 'Fri postering registrert via API: '. No VAT: book VAT through create_purchase or create_sale (via fiken_write). ${ORE} ${CONFIRM}`,
    input: z.object({
      companySlug,
      description: z.string().min(1).max(169).describe("At most 169 characters: Fiken's 200-character limit includes its ~31-character prefix"),
      date: isoDate.describe("Entry date (YYYY-MM-DD)"),
      lines: z.array(journalEntryLine).min(1),
      open: z.boolean().optional().describe("Whether the entry is left open"),
    }),
    async run(ctx, { companySlug: slug, description, date, lines, open }) {
      let debit = 0;
      let credit = 0;
      for (const l of lines) {
        if (l.debitAccount === undefined && l.creditAccount === undefined) return toolText("Every line needs a debitAccount or a creditAccount.");
        if (l.creditAccount === undefined) debit += l.amount;
        else if (l.debitAccount === undefined) credit += l.amount;
      }
      if (debit !== credit) return toolText(`The entry does not balance: debit ${debit} øre, credit ${credit} øre.`);
      return withCompany(ctx, slug, async () => {
        const { id } = await ctx.fiken.create(`/companies/${slug}/generalJournalEntries`, defined({ description, open, journalEntries: [{ description, date, lines }] }));
        try {
          return toolJson(trimJournalEntry(await ctx.fiken.json<FikenJournalEntry>(`/companies/${slug}/journalEntries/${id}`)));
        } catch (err) {
          return toolText(
            `Journal entry ${id} was created; fetching it back failed: ${errorText(err)}. Do not create it again; ` +
              `${gatewayCall("fiken_read", "get_journal_entries", { companySlug: slug, dateGe: date, dateLe: date })} finds it.`,
          );
        }
      });
    },
  }),

  defineOperation({
    name: "create_accrual",
    concept: "ledger",
    kind: "write",
    destructive: true,
    title: "Create accrual",
    description:
      "Spread a sale or purchase line over several months (periodisering). Exactly one of saleId and purchaseId. The line must be on a " +
      "result account (3000-7999). Purchases accrue to 1397, 1700, 1710, 1742, 1743, 1744, 1749 or 2961; sales to 1530 or 2965. " +
      `Sales with sales-cost lines cannot be accrued. ${CONFIRM}`,
    input: z.object({
      companySlug,
      saleId: z.number().int().optional().describe("Sale id, from list_sales (via fiken_read)"),
      purchaseId: z.number().int().optional().describe("Purchase id, from list_purchases (via fiken_read)"),
      lineId: z.number().int().describe("The line to spread, from get_sale or get_purchase (via fiken_read)"),
      startDate: isoDate.describe("First month of the accrual (YYYY-MM-DD)"),
      periods: z.number().int().min(2).max(120).describe("Number of monthly periods, 2 to 120"),
      account: z.string().min(1).optional().describe("Account to accrue to; see the description for the allowed codes"),
    }),
    async run(ctx, { companySlug: slug, saleId, purchaseId, lineId, startDate, periods, account }) {
      if ((saleId === undefined) === (purchaseId === undefined)) return toolText("Give exactly one of saleId and purchaseId.");
      const path = saleId !== undefined ? `sales/${saleId}` : `purchases/${purchaseId}`;
      return withCompany(ctx, slug, async () => {
        const { id } = await ctx.fiken.create(`/companies/${slug}/${path}/accruals`, defined({ lineId, startDate, periods, account }));
        return toolJson({ accrualId: id });
      });
    },
  }),

  defineOperation({
    name: "list_transactions",
    concept: "ledger",
    kind: "read",
    destructive: false,
    title: "List transactions",
    description: "Transactions (each groups the journal entries one action created), optionally by created date. get_transaction (via fiken_read) shows the entries.",
    input: z.object({
      companySlug,
      ...paging,
      createdDateGe: isoDate.optional().describe("Only transactions created on or after this date (YYYY-MM-DD)"),
      createdDateLe: isoDate.optional().describe("Only transactions created on or before this date (YYYY-MM-DD)"),
    }),
    async run(ctx, { companySlug: slug, page, pageSize, createdDateGe, createdDateLe }) {
      return withCompany(ctx, slug, async () => {
        const { items, total } = await ctx.fiken.list<FikenTransaction>(`/companies/${slug}/transactions`, { page, pageSize, createdDateGe, createdDateLe });
        return paged(items.map(trimTransactionSummary), total, page, pageSize);
      });
    },
  }),

  defineOperation({
    name: "get_transaction",
    concept: "ledger",
    kind: "read",
    destructive: false,
    title: "Get transaction",
    description: `One transaction with its journal entries. ${ORE}`,
    input: z.object({ companySlug, transactionId: z.number().int().describe("Transaction id, from list_transactions (via fiken_read)") }),
    async run(ctx, { companySlug: slug, transactionId }) {
      return withCompany(ctx, slug, async () => {
        const t = await ctx.fiken.json<FikenTransaction>(`/companies/${slug}/transactions/${transactionId}`);
        return toolJson({ ...trimTransactionSummary(t), deleted: t.deleted, entries: (t.entries ?? []).map(trimJournalEntry) });
      });
    },
  }),
];
