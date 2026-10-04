import { z } from "zod";
import { defineOperation, type Operation } from "../operations.js";
import { toolJson } from "../context.js";
import { companySlug, paged, paging, withCompany } from "./common.js";

interface FikenAccount {
  code: string;
  name: string;
}

interface FikenBankAccount {
  bankAccountId: number;
  name: string;
  accountCode?: string;
  bankAccountNumber?: string;
  type: string;
  inactive: boolean;
}

export const accountsOperations: Operation[] = [
  defineOperation({
    name: "list_accounts",
    concept: "accounts",
    kind: "read",
    destructive: false,
    title: "List accounts",
    description:
      "Chart of accounts. Expense accounts (kostnadskonti) are 4000–7999; pass range like 4000-7999. Use the code as `account` on a purchase line. " +
      "Balances per account: account_balances (via fiken_read). When there are several to choose from, let the user pick with ask_user_choice.",
    input: z.object({
      companySlug,
      ...paging,
      range: z.string().optional().describe('Account code range, e.g. "4000-7999"'),
    }),
    async run(ctx, { companySlug: slug, page, pageSize, range }) {
      return withCompany(ctx, slug, async () => {
        const { items, total } = await ctx.fiken.list<FikenAccount>(`/companies/${slug}/accounts`, { page, pageSize, range });
        return paged(
          items.map((a) => ({ code: a.code, name: a.name })),
          total,
          page,
          pageSize,
        );
      });
    },
  }),

  defineOperation({
    name: "list_bank_accounts",
    concept: "accounts",
    kind: "read",
    destructive: false,
    title: "List bank accounts",
    description:
      "Bank and payment accounts. accountCode (e.g. 1920:10001) is what a cash purchase, create_invoice and register_payment " +
      "(both via fiken_write) take; bankAccountNumber is what create_invoice_draft (via fiken_write) takes.",
    input: z.object({ companySlug }),
    async run(ctx, { companySlug: slug }) {
      return withCompany(ctx, slug, async () => {
        const { items } = await ctx.fiken.list<FikenBankAccount>(`/companies/${slug}/bankAccounts`);
        return toolJson({
          items: items.map((b) => ({
            bankAccountId: b.bankAccountId,
            name: b.name,
            accountCode: b.accountCode,
            bankAccountNumber: b.bankAccountNumber,
            type: b.type,
            inactive: b.inactive,
          })),
        });
      });
    },
  }),
];
