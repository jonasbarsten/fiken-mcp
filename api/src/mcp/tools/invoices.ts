import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { counted, errorText, toolJson, type ToolContext } from "../server.js";
import { companySlug, CONFIRM, defined, isoDate, ORE, paged, paging, toolText, withCompany } from "./common.js";

/** Invoice and credit note amounts follow the invoice's currency, not always NOK. */
const LINE_MONEY = "Amounts are integers in the invoice currency's smallest unit (øre for NOK).";

interface FikenInvoiceLine {
  description?: string;
  productName?: string;
  quantity: number;
  unitPrice: number;
  net: number;
  vat: number;
  vatType: string;
  incomeAccount?: string;
}

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

export const invoiceLine = z.object({
  productId: z.number().int().optional().describe("Product id from list_products; supplies description, price, VAT type and income account"),
  description: z.string().min(1).optional(),
  quantity: z.number().positive(),
  unitPrice: z.number().int().optional().describe("Net price per unit, in the invoice currency's smallest unit (øre for NOK)"),
  vatType: z.string().min(1).optional().describe("Sales VAT type: HIGH (25%), MEDIUM (15%), LOW (12%), NONE, EXEMPT, OUTSIDE, EXEMPT_IMPORT_EXPORT"),
  incomeAccount: z.string().min(1).optional().describe("Income account code, e.g. 3000; from list_accounts range 3000-3999"),
  discount: z.number().min(0).max(100).optional().describe("Percent"),
});

type InvoiceLine = z.infer<typeof invoiceLine>;

const LINE_FIELDS = ["description", "unitPrice", "vatType", "incomeAccount"] as const;

/**
 * Names the problem of every line that lacks a field Fiken needs; undefined when all lines are complete.
 * A line with a productId inherits its fields from the product, except unitPrice when `requireUnitPrice`
 * is set (credit note lines).
 */
export function missingLineFields(lines: InvoiceLine[], opts: { requireUnitPrice?: boolean } = {}): string | undefined {
  const problems: string[] = [];
  lines.forEach((l, i) => {
    if (l.productId !== undefined) {
      if (opts.requireUnitPrice && l.unitPrice === undefined) problems.push(`Line ${i + 1} is missing unitPrice.`);
      return;
    }
    const missing = LINE_FIELDS.filter((f) => l[f] === undefined);
    if (missing.length > 0) problems.push(`Line ${i + 1} has no productId and is missing ${missing.join(", ")}.`);
  });
  return problems.length > 0 ? problems.join(" ") : undefined;
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
    lines: (i.lines ?? []).map((l) => ({
      description: l.description,
      productName: l.productName,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      net: l.net,
      vat: l.vat,
      vatType: l.vatType,
      incomeAccount: l.incomeAccount,
    })),
    attachments: (i.attachments ?? []).length,
  };
}

export function invoiceLines(lines: InvoiceLine[]): Array<Record<string, unknown>> {
  return lines.map((l) => defined(l));
}

/** The invoice POST already succeeded when this is called; names the invoiceId so the model doesn't issue it twice. */
function createdInvoiceFollowUpFailed(id: number, err: unknown): CallToolResult {
  return toolText(`Invoice ${id} was created; fetching it back failed: ${errorText(err)}. Do not create it again; use get_invoice with invoiceId ${id}.`);
}

async function readBack(ctx: ToolContext, slug: string, id: number): Promise<CallToolResult> {
  try {
    return toolJson(trimInvoiceDetail(await ctx.fiken.json<FikenInvoice>(`/companies/${slug}/invoices/${id}`)));
  } catch (err) {
    return createdInvoiceFollowUpFailed(id, err);
  }
}

export function registerInvoices(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "list_invoices",
    {
      title: "List invoices",
      description: `Issued invoices (faktura). Filter by issue date range, customer, settled status or invoice number. ${ORE}`,
      inputSchema: z.object({
        companySlug,
        ...paging,
        issueDateGe: isoDate.optional().describe("Only invoices issued on or after this date (YYYY-MM-DD)"),
        issueDateLe: isoDate.optional().describe("Only invoices issued on or before this date (YYYY-MM-DD)"),
        customerId: z.number().int().optional().describe("Customer contact id, from search_contacts"),
        settled: z.boolean().optional().describe("true for paid invoices, false for outstanding ones"),
        invoiceNumber: z.number().int().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    counted(ctx, "list_invoices", async ({ companySlug: slug, page, pageSize, issueDateGe, issueDateLe, customerId, settled, invoiceNumber }) => {
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
    }),
  );

  server.registerTool(
    "get_invoice",
    {
      title: "Get invoice",
      description: `A single invoice by id, with its lines. ${ORE}`,
      inputSchema: z.object({ companySlug, invoiceId: z.number().int().describe("Invoice id, from list_invoices") }),
      annotations: { readOnlyHint: true },
    },
    counted(ctx, "get_invoice", async ({ companySlug: slug, invoiceId }) => {
      return withCompany(ctx, slug, async () => {
        return toolJson(trimInvoiceDetail(await ctx.fiken.json<FikenInvoice>(`/companies/${slug}/invoices/${invoiceId}`)));
      });
    }),
  );

  server.registerTool(
    "create_invoice",
    {
      title: "Create invoice",
      description:
        "Issue an invoice (faktura) in Fiken: it gets an invoice number and is booked at once, but it is not sent; use send_invoice for that. " +
        "An issued invoice cannot be deleted, only credited. bankAccountCode comes from list_bank_accounts; customerId is a contact with " +
        "customer true (search_contacts). A cash invoice (cash true) needs paymentAccount. Each line needs productId, or description, " +
        `unitPrice, vatType and incomeAccount. ${LINE_MONEY} ${CONFIRM}`,
      inputSchema: z.object({
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
      annotations: { destructiveHint: true, readOnlyHint: false },
    },
    counted(ctx, "create_invoice", async ({ companySlug: slug, lines, cash, paymentAccount, ...rest }) => {
      const missing = missingLineFields(lines);
      if (missing) return toolText(missing);
      if (cash && paymentAccount === undefined) return toolText("A cash invoice needs paymentAccount (from list_bank_accounts).");
      return withCompany(ctx, slug, async () => {
        const { id } = await ctx.fiken.create(`/companies/${slug}/invoices`, defined({ ...rest, cash, paymentAccount, lines: invoiceLines(lines) }));
        return readBack(ctx, slug, id);
      });
    }),
  );

  server.registerTool(
    "create_invoice_draft",
    {
      title: "Create invoice draft",
      description: "Create an invoice draft the user can review in Fiken before it is issued; create_invoice_from_draft issues it.",
      inputSchema: z.object({
        companySlug,
        customerId: z.number().int().describe("Customer contact id, from search_contacts"),
        daysUntilDueDate: z.number().int().min(0).describe("Days from the issue date until the invoice is due"),
        type: z.enum(["invoice", "cash_invoice"]).default("invoice"),
        issueDate: isoDate.optional().describe("Issue date (YYYY-MM-DD)"),
        lines: z.array(invoiceLine).optional().describe(`Draft lines. ${LINE_MONEY}`),
        paymentAccount: z.string().min(1).optional().describe("Bank account code, from list_bank_accounts; cash invoices only"),
        currency: z.string().min(1).default("NOK"),
        ourReference: z.string().optional(),
        yourReference: z.string().optional(),
        invoiceText: z.string().optional().describe("Free text printed on the invoice"),
        projectId: z.number().int().optional().describe("Project id, from list_projects"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    counted(ctx, "create_invoice_draft", async ({ companySlug: slug, lines, ...rest }) => {
      const missing = lines ? missingLineFields(lines) : undefined;
      if (missing) return toolText(missing);
      return withCompany(ctx, slug, async () => {
        const { id } = await ctx.fiken.create(`/companies/${slug}/invoices/drafts`, defined({ ...rest, lines: lines ? invoiceLines(lines) : undefined }));
        return toolJson({ draftId: id });
      });
    }),
  );

  server.registerTool(
    "create_invoice_from_draft",
    {
      title: "Issue invoice from draft",
      description: `Issue the invoice from a draft. The invoice is booked and numbered but not sent. ${CONFIRM}`,
      inputSchema: z.object({ companySlug, draftId: z.number().int().describe("Draft id, from create_invoice_draft") }),
      annotations: { destructiveHint: true, readOnlyHint: false },
    },
    counted(ctx, "create_invoice_from_draft", async ({ companySlug: slug, draftId }) => {
      return withCompany(ctx, slug, async () => {
        const { id } = await ctx.fiken.create(`/companies/${slug}/invoices/drafts/${draftId}/createInvoice`, undefined);
        return readBack(ctx, slug, id);
      });
    }),
  );

  server.registerTool(
    "send_invoice",
    {
      title: "Send invoice",
      description:
        "Send an issued invoice to the customer (email, EHF, eFaktura, SMS or letter; auto follows the customer's and company's settings). " +
        `The customer receives it at once; this cannot be undone. ${CONFIRM}`,
      inputSchema: z.object({
        companySlug,
        invoiceId: z.number().int().describe("Invoice id, from list_invoices, create_invoice or create_invoice_from_draft"),
        method: z.array(z.enum(["auto", "email", "ehf", "efaktura", "sms", "letter"])).min(1).default(["auto"]),
        includeDocumentAttachments: z.boolean().default(true),
        recipientEmail: z.string().min(1).optional(),
        recipientName: z.string().min(1).optional(),
        message: z.string().optional(),
        emailSendOption: z.enum(["document_link", "attachment", "auto"]).optional(),
      }),
      annotations: { destructiveHint: true, readOnlyHint: false },
    },
    counted(ctx, "send_invoice", async ({ companySlug: slug, ...body }) => {
      return withCompany(ctx, slug, async () => {
        await ctx.fiken.send(`/companies/${slug}/invoices/send`, defined(body));
        return toolJson({ invoiceId: body.invoiceId, sent: true, method: body.method });
      });
    }),
  );
}
