import { z } from "zod";
import { defineOperation, type Operation } from "../operations.js";
import { toolJson } from "../context.js";
import { companySlug, CONFIRM, paged, paging, withCompany } from "./common.js";

const INVOICE_DRAFT_ID_SOURCES = "from list_invoice_drafts (via fiken_read); create_invoice_draft (via fiken_write) returns one";
const RECURRING_ID_SOURCES = "from list_recurring_invoices (via fiken_read); create_recurring_invoice_from_draft (via fiken_write) returns one";

interface FikenRecurringJob {
  jobId: number;
  active: boolean;
  customerId: number;
  nextDate?: string;
  endDate?: string;
  frequency?: { interval: number; intervalUnit: string };
  net?: number;
  gross?: number;
  currency?: string;
  generatedInvoiceIds?: number[];
}

interface FikenRecurringInvoice {
  recurringInvoiceId: number;
  active: boolean;
  createdDate?: string;
  daysUntilDueDate?: number;
  description?: string;
  jobs?: FikenRecurringJob[];
}

function trimJob(j: FikenRecurringJob) {
  return {
    jobId: j.jobId,
    active: j.active,
    customerId: j.customerId,
    nextDate: j.nextDate,
    endDate: j.endDate,
    frequency: j.frequency,
    net: j.net,
    gross: j.gross,
    currency: j.currency,
    invoices: (j.generatedInvoiceIds ?? []).length,
  };
}

export const recurringOperations: Operation[] = [
  defineOperation({
    name: "list_recurring_invoices",
    concept: "recurring_invoices",
    kind: "read",
    destructive: false,
    title: "List recurring invoices",
    description:
      "Recurring invoices (repeterende faktura). Each has one job per customer, with the job id that set_recurring_invoice_job (via fiken_write) needs, " +
      "its schedule (nextDate, endDate, frequency), whether it is active (false when paused) and how many invoices it has issued (invoices). Amounts are in the invoice currency's smallest unit (øre for NOK).",
    input: z.object({
      companySlug,
      ...paging,
      customerId: z.number().int().optional().describe("Customer contact id, from search_contacts"),
      active: z.boolean().optional().describe("true for recurring invoices with a running job, false for paused ones"),
    }),
    async run(ctx, { companySlug: slug, page, pageSize, customerId, active }) {
      return withCompany(ctx, slug, async () => {
        const { items, total } = await ctx.fiken.list<FikenRecurringInvoice>(`/companies/${slug}/recurringInvoices`, { page, pageSize, customerId, active });
        const trimmed = items.map((r) => ({
          recurringInvoiceId: r.recurringInvoiceId,
          active: r.active,
          createdDate: r.createdDate,
          daysUntilDueDate: r.daysUntilDueDate,
          description: r.description,
          jobs: (r.jobs ?? []).map(trimJob),
        }));
        return paged(trimmed, total, page, pageSize);
      });
    },
  }),

  defineOperation({
    name: "create_recurring_invoice_from_draft",
    concept: "recurring_invoices",
    kind: "write",
    destructive: true,
    title: "Create recurring invoice from draft",
    description:
      "Turn an invoice draft into a recurring invoice. The draft must be type repeating_invoice (create it with create_invoice_draft (via fiken_write)). " +
      `Invoices are then issued, and sent as the company's settings say, on the schedule without further confirmation. ${CONFIRM}`,
    input: z.object({ companySlug, draftId: z.number().int().describe(`Invoice draft id, ${INVOICE_DRAFT_ID_SOURCES}`) }),
    async run(ctx, { companySlug: slug, draftId }) {
      return withCompany(ctx, slug, async () => {
        const { id } = await ctx.fiken.create(`/companies/${slug}/invoices/drafts/${draftId}/createRecurringInvoice`, undefined);
        return toolJson({ recurringInvoiceId: id });
      });
    },
  }),

  defineOperation({
    name: "set_recurring_invoice_job",
    concept: "recurring_invoices",
    kind: "write",
    destructive: true,
    title: "Pause, resume or stop a recurring invoice job",
    description:
      "Pause, resume or stop the job of a recurring invoice. pause holds the schedule and resume continues it; stop is final: the job never issues another invoice and cannot be restarted. " +
      `${CONFIRM}`,
    input: z.object({
      companySlug,
      recurringInvoiceId: z.number().int().describe(`Recurring invoice id, ${RECURRING_ID_SOURCES}`),
      jobId: z.number().int().describe("Job id, jobs[].jobId from list_recurring_invoices (via fiken_read)"),
      action: z.enum(["pause", "resume", "stop"]),
    }),
    async run(ctx, { companySlug: slug, recurringInvoiceId, jobId, action }) {
      return withCompany(ctx, slug, async () => {
        await ctx.fiken.send(`/companies/${slug}/recurringInvoices/${recurringInvoiceId}/jobs/${jobId}/${action}`, undefined);
        return toolJson({ recurringInvoiceId, jobId, action });
      });
    },
  }),
];
