import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { toolJson, type ToolContext } from "../server.js";
import { companySlug, paged, paging, withCompany } from "./common.js";

interface FikenAccount {
  code: string;
  name: string;
}

interface FikenBankAccount {
  bankAccountId: number;
  name: string;
  accountCode?: string;
  type: string;
  inactive: boolean;
}

export function registerAccounts(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "list_accounts",
    {
      title: "List accounts",
      description:
        "Chart of accounts. Expense accounts (kostnadskonti) are 4000–7999; pass range like 4000-7999. Use the code as `account` on a purchase line.",
      inputSchema: z.object({
        companySlug,
        ...paging,
        range: z.string().optional().describe('Account code range, e.g. "4000-7999"'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ companySlug: slug, page, pageSize, range }) => {
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
  );

  server.registerTool(
    "list_bank_accounts",
    {
      title: "List bank accounts",
      description:
        "Bank and payment accounts. accountCode (e.g. 1920:10001) is the paymentAccount a paid cash purchase needs.",
      inputSchema: z.object({ companySlug }),
      annotations: { readOnlyHint: true },
    },
    async ({ companySlug: slug }) => {
      return withCompany(ctx, slug, async () => {
        const { items } = await ctx.fiken.list<FikenBankAccount>(`/companies/${slug}/bankAccounts`);
        return toolJson({
          items: items.map((b) => ({
            bankAccountId: b.bankAccountId,
            name: b.name,
            accountCode: b.accountCode,
            type: b.type,
            inactive: b.inactive,
          })),
        });
      });
    },
  );
}
