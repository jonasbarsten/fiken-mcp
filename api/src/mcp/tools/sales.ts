import { z } from "zod";
import { defineOperation, type Operation } from "../operations.js";
import { companySlug, isoDate, ORE, paged, paging, withCompany } from "./common.js";

interface FikenSale {
  saleId: number;
  saleNumber: string;
  date: string;
  kind: string;
  netAmount: number;
  vatAmount: number;
  currency: string;
  settled: boolean;
  deleted?: boolean;
  totalPaid: number;
  outstandingBalance: number;
  dueDate?: string;
  customer?: { contactId: number; name: string };
}

function trimSale(s: FikenSale) {
  return {
    saleId: s.saleId,
    saleNumber: s.saleNumber,
    date: s.date,
    kind: s.kind,
    netAmount: s.netAmount,
    vatAmount: s.vatAmount,
    currency: s.currency,
    settled: s.settled,
    deleted: s.deleted,
    totalPaid: s.totalPaid,
    outstandingBalance: s.outstandingBalance,
    dueDate: s.dueDate,
    customer: s.customer ? { contactId: s.customer.contactId, name: s.customer.name } : undefined,
  };
}

export const salesOperations: Operation[] = [
  defineOperation({
    name: "list_sales",
    concept: "sales",
    kind: "read",
    destructive: false,
    title: "List sales",
    description: `Sales (salg) in the company, including invoiced ones: outstandingBalance is what the customer still owes. saleId is what register_payment and attach_inbox_document take. ${ORE}`,
    input: z.object({
      companySlug,
      ...paging,
      dateGe: isoDate.optional().describe("Only sales on or after this date (YYYY-MM-DD)"),
      dateLe: isoDate.optional().describe("Only sales on or before this date (YYYY-MM-DD)"),
      settled: z.boolean().optional().describe("Filter to settled (or unsettled) sales"),
      contactId: z.number().int().optional().describe("Only sales to this customer, from search_contacts"),
    }),
    async run(ctx, { companySlug: slug, page, pageSize, dateGe, dateLe, settled, contactId }) {
      return withCompany(ctx, slug, async () => {
        const { items, total } = await ctx.fiken.list<FikenSale>(`/companies/${slug}/sales`, { page, pageSize, dateGe, dateLe, settled, contactId });
        return paged(items.map(trimSale), total, page, pageSize);
      });
    },
  }),
];
