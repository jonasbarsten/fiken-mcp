import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { defineOperation, type Operation } from "../operations.js";
import { errorText, toolJson, type ToolContext } from "../context.js";
import { companySlug, CONFIRM, defined, gatewayCall, INVOICE_ID_SOURCES, isoDate, ORE, paged, paging, toolText, withCompany } from "./common.js";
import {
  createInvoiceishDraft,
  draftRequest,
  type FikenDraft,
  type FikenInvoiceLine,
  invoiceLine,
  invoiceLines,
  LINE_MONEY,
  missingLineFields,
  readCounter,
  sendDocument,
  sendDocumentInput,
  trimDraft,
  trimDraftDetail,
  trimInvoiceLine,
} from "./documents.js";

const DRAFT_ID_SOURCES = "from list_invoice_drafts (via fiken_read); create_invoice_draft (via fiken_write) returns one";

interface FikenInvoice {
  invoiceId: number;
  invoiceNumber: number;
  issueDate: string;
  dueDate: string;
  net: number;
  vat: number;
  gross: number;
  currency: string;
  cash: boolean;
  kid?: string;
  sentManually?: boolean;
  customer?: { contactId: number; name: string };
  sale?: { saleId: number; settled: boolean; outstandingBalance: number };
  lines?: FikenInvoiceLine[];
  attachments?: unknown[];
}

export function trimInvoice(i: FikenInvoice) {
  return {
    invoiceId: i.invoiceId,
    invoiceNumber: i.invoiceNumber,
    issueDate: i.issueDate,
    dueDate: i.dueDate,
    net: i.net,
    vat: i.vat,
    gross: i.gross,
    currency: i.currency,
    cash: i.cash,
    kid: i.kid,
    sentManually: i.sentManually,
    customer: i.customer ? { contactId: i.customer.contactId, name: i.customer.name } : undefined,
    saleId: i.sale?.saleId,
    settled: i.sale?.settled,
    outstandingBalance: i.sale?.outstandingBalance,
  };
}

function trimInvoiceDetail(i: FikenInvoice) {
  return {
    ...trimInvoice(i),
    lines: (i.lines ?? []).map(trimInvoiceLine),
    attachments: (i.attachments ?? []).length,
  };
}

/** The invoice POST already succeeded when this is called; names the invoiceId so the model doesn't issue it twice. */
function createdInvoiceFollowUpFailed(slug: string, id: number, err: unknown): CallToolResult {
  return toolText(
    `Invoice ${id} was created; fetching it back failed: ${errorText(err)}. Do not create it again; ` +
      `${gatewayCall("fiken_read", "get_invoice", { companySlug: slug, invoiceId: id })}.`,
  );
}

async function readBack(ctx: ToolContext, slug: string, id: number): Promise<CallToolResult> {
  try {
    return toolJson(trimInvoiceDetail(await ctx.fiken.json<FikenInvoice>(`/companies/${slug}/invoices/${id}`)));
  } catch (err) {
    return createdInvoiceFollowUpFailed(slug, id, err);
  }
}

export const invoicesOperations: Operation[] = [
  defineOperation({
    name: "list_invoices",
    concept: "invoices",
    kind: "read",
    destructive: false,
    title: "List invoices",
    description: `Issued invoices (faktura). Filter by issue date range, customer, settled status or invoice number. ${ORE}`,
    input: z.object({
      companySlug,
      ...paging,
      issueDateGe: isoDate.optional().describe("Only invoices issued on or after this date (YYYY-MM-DD)"),
      issueDateLe: isoDate.optional().describe("Only invoices issued on or before this date (YYYY-MM-DD)"),
      customerId: z.number().int().optional().describe("Customer contact id, from search_contacts"),
      settled: z.boolean().optional().describe("true for paid invoices, false for outstanding ones"),
      invoiceNumber: z.number().int().optional(),
    }),
    async run(ctx, { companySlug: slug, page, pageSize, issueDateGe, issueDateLe, customerId, settled, invoiceNumber }) {
      return withCompany(ctx, slug, async () => {
        const { items, total } = await ctx.fiken.list<FikenInvoice>(`/companies/${slug}/invoices`, {
          page,
          pageSize,
          issueDateGe,
          issueDateLe,
          customerId,
          settled,
          invoiceNumber,
        });
        return paged(items.map(trimInvoice), total, page, pageSize);
      });
    },
  }),

  defineOperation({
    name: "get_invoice",
    concept: "invoices",
    kind: "read",
    destructive: false,
    title: "Get invoice",
    description: `A single invoice by id, with its lines. ${ORE}`,
    input: z.object({ companySlug, invoiceId: z.number().int().describe("Invoice id, from list_invoices (via fiken_read)") }),
    async run(ctx, { companySlug: slug, invoiceId }) {
      return withCompany(ctx, slug, async () => {
        return toolJson(trimInvoiceDetail(await ctx.fiken.json<FikenInvoice>(`/companies/${slug}/invoices/${invoiceId}`)));
      });
    },
  }),

  defineOperation({
    name: "create_invoice",
    concept: "invoices",
    kind: "write",
    destructive: true,
    title: "Create invoice",
    description:
      "Issue an invoice (faktura) in Fiken: it gets an invoice number and is booked at once, but it is not sent; use send_invoice (via fiken_write) for that. " +
      "An issued invoice cannot be deleted, only credited. bankAccountCode comes from list_bank_accounts; customerId is a contact with " +
      "customer true (search_contacts). A cash invoice (cash true) needs paymentAccount. For income that needs no invoice issued by Fiken (card terminal, Vipps), use create_sale (via fiken_write). Each line needs productId, or description, " +
      `unitPrice, vatType and incomeAccount. ${LINE_MONEY} ${CONFIRM}`,
    input: z.object({
      companySlug,
      customerId: z.number().int().describe("Customer contact id, from search_contacts"),
      issueDate: isoDate.describe("Issue date (YYYY-MM-DD)"),
      dueDate: isoDate.describe("Due date (YYYY-MM-DD)"),
      bankAccountCode: z.string().min(1).describe("Bank account code the customer pays into, from list_bank_accounts"),
      lines: z.array(invoiceLine).min(1),
      cash: z.boolean().default(false).describe("true when the invoice is paid at once; requires paymentAccount"),
      paymentAccount: z.string().min(1).optional().describe("Bank account code the payment went to, from list_bank_accounts; cash invoices only"),
      currency: z.string().min(1).default("NOK"),
      ourReference: z.string().optional(),
      yourReference: z.string().optional(),
      invoiceText: z.string().optional().describe("Free text printed on the invoice"),
      projectId: z.number().int().optional().describe("Project id, from list_projects"),
    }),
    async run(ctx, { companySlug: slug, lines, cash, paymentAccount, ...rest }) {
      const missing = missingLineFields(lines);
      if (missing) return toolText(missing);
      if (cash && paymentAccount === undefined) return toolText("A cash invoice needs paymentAccount (from list_bank_accounts).");
      return withCompany(ctx, slug, async () => {
        const { id } = await ctx.fiken.create(`/companies/${slug}/invoices`, defined({ ...rest, cash, paymentAccount, lines: invoiceLines(lines) }));
        return readBack(ctx, slug, id);
      });
    },
  }),

  defineOperation({
    name: "create_invoice_draft",
    concept: "invoice_drafts",
    kind: "write",
    destructive: false,
    title: "Create invoice draft",
    description:
      "Create an invoice draft the user can review in Fiken before it is issued; create_invoice_from_draft (via fiken_write) issues it. " +
      "type repeating_invoice makes the draft of a recurring invoice (needs startDate and frequency); " +
      "create_recurring_invoice_from_draft (via fiken_write) turns it into the recurring invoice.",
    input: z.object({
      companySlug,
      customerId: z.number().int().describe("Customer contact id, from search_contacts"),
      daysUntilDueDate: z.number().int().min(0).describe("Days from the issue date until the invoice is due"),
      bankAccountNumber: z.string().min(1).describe("The bank account number the customer pays into, bankAccountNumber from list_bank_accounts (not the 1920:... code)"),
      type: z.enum(["invoice", "cash_invoice", "repeating_invoice"]).default("invoice"),
      startDate: isoDate.optional().describe("First issue date (YYYY-MM-DD); repeating_invoice only, and required there"),
      endDate: isoDate.optional().describe("No invoices after this date (YYYY-MM-DD); repeating_invoice only"),
      frequency: z
        .strictObject({ interval: z.number().int().min(1), intervalUnit: z.enum(["DAY", "WEEK", "MONTH"]) })
        .optional()
        .describe("How often an invoice is issued, e.g. { interval: 1, intervalUnit: MONTH } is monthly; repeating_invoice only, and required there"),
      issueDate: isoDate.optional().describe("Issue date (YYYY-MM-DD)"),
      lines: z.array(invoiceLine).optional().describe(`Draft lines. ${LINE_MONEY}`),
      paymentAccount: z.string().min(1).optional().describe("Bank account code, from list_bank_accounts; cash invoices only"),
      currency: z.string().min(1).default("NOK"),
      ourReference: z.string().optional(),
      yourReference: z.string().optional(),
      invoiceText: z.string().optional().describe("Free text printed on the invoice"),
      projectId: z.number().int().optional().describe("Project id, from list_projects"),
    }),
    async run(ctx, { companySlug: slug, type, lines, ...rest }) {
      const missing = lines ? missingLineFields(lines) : undefined;
      if (missing) return toolText(missing);
      if (type === "repeating_invoice") {
        if (rest.startDate === undefined || rest.frequency === undefined) return toolText("A repeating_invoice needs startDate and frequency.");
      } else if (rest.startDate !== undefined || rest.endDate !== undefined || rest.frequency !== undefined) {
        return toolText("startDate, endDate and frequency are for type repeating_invoice only.");
      }
      return withCompany(ctx, slug, async () => {
        return toolJson({ draftId: await createInvoiceishDraft(ctx, slug, "invoices", type, { ...rest, lines }) });
      });
    },
  }),

  defineOperation({
    name: "list_invoice_drafts",
    concept: "invoice_drafts",
    kind: "read",
    destructive: false,
    title: "List invoice drafts",
    description: `Invoice drafts not yet issued. ${LINE_MONEY}`,
    input: z.object({ companySlug, ...paging }),
    async run(ctx, { companySlug: slug, page, pageSize }) {
      return withCompany(ctx, slug, async () => {
        const { items, total } = await ctx.fiken.list<FikenDraft>(`/companies/${slug}/invoices/drafts`, { page, pageSize });
        return paged(items.map(trimDraft), total, page, pageSize);
      });
    },
  }),

  defineOperation({
    name: "get_invoice_draft",
    concept: "invoice_drafts",
    kind: "read",
    destructive: false,
    title: "Get invoice draft",
    description: `A single invoice draft by id, with its lines. ${LINE_MONEY}`,
    input: z.object({ companySlug, draftId: z.number().int().describe(`Draft id, ${DRAFT_ID_SOURCES}`) }),
    async run(ctx, { companySlug: slug, draftId }) {
      return withCompany(ctx, slug, async () => {
        return toolJson(trimDraftDetail(await ctx.fiken.json<FikenDraft>(`/companies/${slug}/invoices/drafts/${draftId}`)));
      });
    },
  }),

  defineOperation({
    name: "update_invoice_draft",
    concept: "invoice_drafts",
    kind: "write",
    destructive: false,
    title: "Update invoice draft",
    description:
      "Change an invoice draft. Only the fields you give change, everything else in the draft stays as it is; at least one is required. " +
      "lines, when given, replace all lines of the draft; each needs productId, or description, unitPrice, vatType and incomeAccount. " +
      `Fiken does not return a draft's contact person, so an update may clear it; if the draft has one, pass contactPersonId again. ${LINE_MONEY}`,
    input: z.object({
      companySlug,
      draftId: z.number().int().describe(`Draft id, ${DRAFT_ID_SOURCES}`),
      customerId: z.number().int().optional().describe("Customer contact id, from search_contacts"),
      contactPersonId: z.number().int().optional().describe("Contact person of the customer, from list_contact_persons (via fiken_read)"),
      daysUntilDueDate: z.number().int().min(0).optional().describe("Days from the issue date until the invoice is due"),
      issueDate: isoDate.optional().describe("Issue date (YYYY-MM-DD)"),
      invoiceText: z.string().optional().describe("Free text printed on the invoice"),
      yourReference: z.string().optional(),
      ourReference: z.string().optional(),
      bankAccountNumber: z.string().min(1).optional().describe("The bank account number the customer pays into, bankAccountNumber from list_bank_accounts (not the 1920:... code)"),
      projectId: z.number().int().optional().describe("Project id, from list_projects"),
      lines: z.array(invoiceLine).min(1).optional().describe("Replaces all lines of the draft"),
    }),
    async run(ctx, { companySlug: slug, draftId, lines, ...fields }) {
      const changes = defined(fields);
      if (Object.keys(changes).length === 0 && lines === undefined) {
        return toolText(
          "Give at least one field to change: customerId, contactPersonId, daysUntilDueDate, issueDate, invoiceText, yourReference, ourReference, bankAccountNumber, projectId or lines.",
        );
      }
      const missing = lines ? missingLineFields(lines) : undefined;
      if (missing) return toolText(missing);
      return withCompany(ctx, slug, async () => {
        const path = `/companies/${slug}/invoices/drafts/${draftId}`;
        // Fiken's PUT replaces the whole draft, so what the caller did not give is sent back unchanged.
        // Fiken has no ETag: an edit made in Fiken between this GET and the PUT is overwritten.
        const current = await ctx.fiken.json<FikenDraft>(path);
        // The request takes one customerId, so a PUT would drop every customer but the first.
        if ((current.customers ?? []).length > 1) return toolText("This draft has several customers; edit it in Fiken.");
        const body = { ...draftRequest(current), ...changes };
        if (lines) body.lines = invoiceLines(lines);
        await ctx.fiken.put(path, body);
        try {
          return toolJson(trimDraftDetail(await ctx.fiken.json<FikenDraft>(path)));
        } catch (err) {
          return toolText(
            `Draft ${draftId} was updated; fetching it back failed: ${errorText(err)}. Do not repeat it; ` +
              `${gatewayCall("fiken_read", "get_invoice_draft", { companySlug: slug, draftId })}.`,
          );
        }
      });
    },
  }),

  defineOperation({
    name: "create_invoice_from_draft",
    concept: "invoice_drafts",
    kind: "write",
    destructive: true,
    title: "Issue invoice from draft",
    description: `Issue the invoice from a draft. The invoice is booked and numbered but not sent. ${CONFIRM}`,
    input: z.object({ companySlug, draftId: z.number().int().describe(`Draft id, ${DRAFT_ID_SOURCES}`) }),
    async run(ctx, { companySlug: slug, draftId }) {
      return withCompany(ctx, slug, async () => {
        const { id } = await ctx.fiken.create(`/companies/${slug}/invoices/drafts/${draftId}/createInvoice`, undefined);
        return readBack(ctx, slug, id);
      });
    },
  }),

  defineOperation({
    name: "send_invoice",
    concept: "invoices",
    kind: "write",
    destructive: true,
    title: "Send invoice",
    description:
      "Send an issued invoice to the customer (email, EHF, eFaktura, SMS or letter; auto follows the customer's and company's settings). " +
      `The customer receives it at once; this cannot be undone. ${CONFIRM}`,
    input: z.object({
      companySlug,
      invoiceId: z.number().int().describe(`Invoice id, ${INVOICE_ID_SOURCES}`),
      ...sendDocumentInput(),
    }),
    async run(ctx, { companySlug: slug, invoiceId, ...fields }) {
      return withCompany(ctx, slug, async () => {
        await sendDocument(ctx, slug, "invoices", "invoiceId", invoiceId, fields);
        return toolJson({ invoiceId, sent: true, method: fields.method });
      });
    },
  }),

  defineOperation({
    name: "get_counters",
    concept: "invoices",
    kind: "read",
    destructive: false,
    title: "Get number counters",
    description:
      "The invoice and credit note number series: current is the last number used, next the number the next one gets. " +
      "null where the series was never started (or when companySlug is wrong, since Fiken answers both with 404).",
    input: z.object({ companySlug }),
    async run(ctx, { companySlug: slug }) {
      return withCompany(ctx, slug, async () => {
        const series = (current: number | null) => (current === null ? null : { current, next: current + 1 });
        const invoice = series(await readCounter(ctx, slug, "invoices"));
        const creditNote = series(await readCounter(ctx, slug, "creditNotes"));
        return toolJson({ invoice, creditNote });
      });
    },
  }),

  defineOperation({
    name: "initialize_counter",
    concept: "invoices",
    kind: "write",
    destructive: true,
    title: "Initialize number counter",
    description:
      "Start the invoice or credit note number series for a company that has never issued one (Fiken answers 409 'counter not initialized' until then). " +
      `An existing series is never changed. ${CONFIRM}`,
    input: z.object({
      companySlug,
      kind: z.enum(["invoice", "credit_note"]),
      firstNumber: z.number().int().positive().describe("The number the first invoice or credit note will get, e.g. 10001"),
    }),
    async run(ctx, { companySlug: slug, kind, firstNumber }) {
      const path = kind === "invoice" ? "invoices" : "creditNotes";
      return withCompany(ctx, slug, async () => {
        const current = await readCounter(ctx, slug, path);
        if (current !== null) {
          return toolText(`The ${kind} counter already exists (current value ${current}, next number ${current + 1}); it cannot be changed here.`);
        }
        // Fiken's counter holds the last number used; the first document gets value + 1.
        await ctx.fiken.send(`/companies/${slug}/${path}/counter`, { value: firstNumber - 1 });
        return toolJson({ kind, initialized: true, firstNumber });
      });
    },
  }),
];
