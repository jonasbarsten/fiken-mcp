import { z } from "zod";
import { defineOperation, type Operation } from "../operations.js";
import { errorText, toolJson } from "../context.js";
import { companySlug, CONFIRM, defined, gatewayCall, isoDate, ORE, paged, paging, toolText, withCompany } from "./common.js";
import { EXEMPT_VS_OUTSIDE } from "./documents.js";

interface FikenSaleLine {
  description: string;
  netPrice: number;
  vat: number;
  vatType: string;
  account?: string;
  lineId: number;
}

interface FikenSale {
  lines?: FikenSaleLine[];
  salePayments?: unknown[];
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

function trimSaleDetail(s: FikenSale) {
  return {
    ...trimSale(s),
    lines: (s.lines ?? []).map((l) => ({ lineId: l.lineId, description: l.description, netPrice: l.netPrice, vat: l.vat, vatType: l.vatType, account: l.account })),
    payments: s.salePayments?.length ?? 0,
  };
}

const saleLine = z
  .object({
    description: z.string().min(1),
    netPrice: z.number().int().describe(`Net amount. ${ORE}`),
    vat: z.number().int().describe(`VAT amount. ${ORE}`),
    vatType: z.string().min(1).describe(`Sales VAT type: HIGH (25%), MEDIUM (15%), LOW (12%), NONE, EXEMPT, OUTSIDE, EXEMPT_IMPORT_EXPORT. ${EXEMPT_VS_OUTSIDE}`),
    account: z.string().min(1).optional().describe("Income account code, from list_accounts"),
    projectId: z.number().int().optional().describe("Project id, from list_projects"),
  })
  .strict();

const WRITE_OFF_TYPES = ["OVERDUE_6_MONTHS", "COLLECTION_FAILED", "CUSTOMER_BANKRUPTCY", "DEEMED_IRRECOVERABLE"] as const;

export const salesOperations: Operation[] = [
  defineOperation({
    name: "get_sale",
    concept: "sales",
    kind: "read",
    destructive: false,
    title: "Get sale",
    description: `One sale with its lines and the number of payments. ${ORE}`,
    input: z.object({ companySlug, saleId: z.number().int().describe("Sale id, from list_sales (via fiken_read)") }),
    async run(ctx, { companySlug: slug, saleId }) {
      return withCompany(ctx, slug, async () => toolJson(trimSaleDetail(await ctx.fiken.json<FikenSale>(`/companies/${slug}/sales/${saleId}`))));
    },
  }),

  defineOperation({
    name: "create_sale",
    concept: "sales",
    kind: "write",
    destructive: true,
    title: "Create sale",
    description:
      "Book income that was not invoiced through Fiken: a cash sale (card terminal, Vipps, cash, paid at once) or an invoice issued in another system (external_invoice). " +
      "It creates no invoice document and sends nothing; if Fiken must issue an invoice to the customer, even one paid at once, use create_invoice (via fiken_write). " +
      "cash_sale needs paymentAccount and paymentDate (and takes no dueDate or kid); external_invoice needs customerId and dueDate (and takes no paymentAccount, paymentDate or paymentFee). " +
      `NOK only; book sales in other currencies in Fiken itself. ${ORE} ${CONFIRM}`,
    input: z.object({
      companySlug,
      date: isoDate.describe("Sale date (YYYY-MM-DD)"),
      kind: z.enum(["cash_sale", "external_invoice"]),
      lines: z.array(saleLine).min(1),
      currency: z.literal("NOK").default("NOK"),
      customerId: z.number().int().optional().describe("Customer contact id, from search_contacts"),
      dueDate: isoDate.optional().describe("Due date (YYYY-MM-DD)"),
      kid: z.string().min(1).optional(),
      paymentAccount: z.string().min(1).optional().describe("Bank account code, from list_bank_accounts"),
      paymentDate: isoDate.optional().describe("Payment date (YYYY-MM-DD)"),
      paymentFee: z.number().int().nonnegative().optional().describe(`Payment fee. ${ORE}`),
      projectId: z.number().int().optional().describe("Project id, from list_projects"),
      saleNumber: z.string().min(1).optional(),
    }),
    async run(ctx, { companySlug: slug, ...sale }) {
      if (sale.kind === "cash_sale") {
        if (sale.paymentAccount === undefined || sale.paymentDate === undefined) return toolText("A cash_sale needs paymentAccount and paymentDate.");
        for (const field of ["dueDate", "kid"] as const) {
          if (sale[field] !== undefined) return toolText(`${field} does not apply to a cash_sale.`);
        }
      } else {
        if (sale.customerId === undefined || sale.dueDate === undefined) return toolText("An external_invoice needs customerId and dueDate.");
        for (const field of ["paymentAccount", "paymentDate", "paymentFee"] as const) {
          if (sale[field] !== undefined) return toolText(`${field} does not apply to an external_invoice.`);
        }
      }
      return withCompany(ctx, slug, async () => {
        // Fiken rejects a cash sale without totalPaid ("Missing field 'totalPaid' for sale marked as paid in NOK").
        const totalPaid = sale.kind === "cash_sale" ? sale.lines.reduce((sum, l) => sum + l.netPrice + l.vat, 0) : undefined;
        const { id } = await ctx.fiken.create(`/companies/${slug}/sales`, defined({ ...sale, totalPaid }));
        try {
          return toolJson(trimSaleDetail(await ctx.fiken.json<FikenSale>(`/companies/${slug}/sales/${id}`)));
        } catch (err) {
          return toolText(
            `Sale ${id} was created; fetching it back failed: ${errorText(err)}. Do not create it again; ` +
              `${gatewayCall("fiken_read", "get_sale", { companySlug: slug, saleId: id })}.`,
          );
        }
      });
    },
  }),

  defineOperation({
    name: "settle_sale",
    concept: "sales",
    kind: "write",
    destructive: true,
    title: "Settle sale",
    description:
      "Mark a sale as settled without registering a payment (for example when it was settled by offsetting). " +
      `To record money received use register_payment (via fiken_write). ${CONFIRM}`,
    input: z.object({
      companySlug,
      saleId: z.number().int().describe("Sale id, from list_sales (via fiken_read)"),
      settledDate: isoDate.describe("Settlement date (YYYY-MM-DD)"),
    }),
    async run(ctx, { companySlug: slug, saleId, settledDate }) {
      return withCompany(ctx, slug, async () => {
        await ctx.fiken.patch(`/companies/${slug}/sales/${saleId}/settled`, undefined, { settledDate });
        return toolJson({ saleId, settled: true, settledDate });
      });
    },
  }),

  defineOperation({
    name: "write_off_sale",
    concept: "sales",
    kind: "write",
    destructive: true,
    title: "Write off sale",
    description: `Book a sale as a loss (tapsføring). The reason must be true for Fiken's rules; the date must be after the sale date. For losses or anything unusual, look it up first with fiken_help_index (via fiken_read). ${CONFIRM}`,
    input: z.object({
      companySlug,
      saleId: z.number().int().describe("Sale id, from list_sales (via fiken_read)"),
      type: z
        .enum(WRITE_OFF_TYPES)
        .describe(
          "Reason for the write-off (tapsføring): " +
            "OVERDUE_6_MONTHS = at least 6 months past due date, and at least 3 reminders or collection notices have been sent; " +
            "COLLECTION_FAILED = debt collection has been attempted without success; " +
            "CUSTOMER_BANKRUPTCY = the customer has been declared bankrupt and the estate cannot cover the outstanding amount; " +
            "DEEMED_IRRECOVERABLE = based on an overall assessment, the receivable will clearly not be collected. " +
            "The sale must not be a cash sale, must not already be written off, settled or deleted, and must have an outstanding balance.",
        ),
      date: isoDate.describe("Write-off date (YYYY-MM-DD)"),
      comment: z.string().min(1).max(200).optional().describe("At most 200 characters (Fiken's limit)"),
    }),
    async run(ctx, { companySlug: slug, saleId, ...writeOff }) {
      return withCompany(ctx, slug, async () => {
        await ctx.fiken.patch(`/companies/${slug}/sales/${saleId}/writeOff`, defined(writeOff));
        return toolJson({ saleId, writtenOff: true, type: writeOff.type });
      });
    },
  }),

  defineOperation({
    name: "list_sales",
    concept: "sales",
    kind: "read",
    destructive: false,
    title: "List sales",
    description: `Sales (salg) in the company, including invoiced ones: outstandingBalance is what the customer still owes. saleId is what register_payment and attach_inbox_document (both via fiken_write) take. ${ORE}`,
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
