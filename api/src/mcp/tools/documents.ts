import { z } from "zod";
import { FikenError } from "../../fiken/client.js";
import type { ToolContext } from "../context.js";
import { defined } from "./common.js";

/**
 * What invoices, credit notes, offers, order confirmations and recurring invoices share: line input,
 * invoice-like drafts, sending and number counters. Lives apart from invoices.ts so every document
 * type can import it without an import cycle.
 */

/** Invoice-like amounts follow the document's currency, not always NOK. */
export const LINE_MONEY = "Amounts are integers in the invoice currency's smallest unit (øre for NOK).";

/** Strict, so a mistyped key (netPrice, discunt) is refused instead of silently dropped. */
export const invoiceLine = z.strictObject({
  productId: z.number().int().optional().describe("Product id, from list_products (via fiken_read); supplies description, price, VAT type and income account"),
  description: z.string().min(1).optional(),
  quantity: z.number().positive(),
  unitPrice: z.number().int().optional().describe("Net price per unit, in the invoice currency's smallest unit (øre for NOK)"),
  vatType: z.string().min(1).optional().describe("Sales VAT type: HIGH (25%), MEDIUM (15%), LOW (12%), NONE, EXEMPT, OUTSIDE, EXEMPT_IMPORT_EXPORT"),
  incomeAccount: z.string().min(1).optional().describe("Income account code, e.g. 3000; from list_accounts range 3000-3999"),
  discount: z.number().min(0).max(100).optional().describe("Percent"),
});

export type InvoiceLine = z.infer<typeof invoiceLine>;

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

export function invoiceLines(lines: InvoiceLine[]): Array<Record<string, unknown>> {
  return lines.map((l) => defined(l));
}

/** A line of an issued invoice or credit note, as Fiken returns it. */
export interface FikenInvoiceLine {
  description?: string;
  productName?: string;
  quantity: number;
  unitPrice: number;
  net: number;
  vat: number;
  vatType: string;
  incomeAccount?: string;
}

/** The result fields of an issued invoice's or credit note's line. */
export function trimInvoiceLine(l: FikenInvoiceLine) {
  return {
    description: l.description,
    productName: l.productName,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    net: l.net,
    vat: l.vat,
    vatType: l.vatType,
    incomeAccount: l.incomeAccount,
  };
}

const sendShape = {
  method: z.array(z.enum(["auto", "email", "ehf", "efaktura", "sms", "letter"])).min(1).default(["auto"]),
  includeDocumentAttachments: z.boolean().default(true),
  recipientEmail: z.string().min(1).optional(),
  recipientName: z.string().min(1).optional(),
  message: z.string().optional(),
  emailSendOption: z.enum(["document_link", "attachment", "auto"]).optional(),
};

/** The input fields every send operation shares (Fiken's sendInvoiceishRequest). */
export function sendDocumentInput(): typeof sendShape {
  return sendShape;
}

export type SendFields = z.infer<z.ZodObject<typeof sendShape>>;

/** POST /<path>/send with the document id and the send fields; resolves once Fiken accepted it. */
export async function sendDocument(
  ctx: ToolContext,
  slug: string,
  path: "invoices" | "creditNotes" | "offers",
  idField: "invoiceId" | "creditNoteId" | "offerId",
  id: number,
  fields: SendFields,
): Promise<void> {
  await ctx.fiken.send(`/companies/${slug}/${path}/send`, defined({ [idField]: id, ...fields }));
}

export type DraftType = "invoice" | "cash_invoice" | "offer" | "order_confirmation" | "repeating_invoice";

/** The invoiceishDraftRequest fields the draft operations take, besides `type`. */
export interface DraftInput {
  customerId: number;
  daysUntilDueDate: number;
  issueDate?: string;
  bankAccountNumber?: string;
  paymentAccount?: string;
  currency?: string;
  ourReference?: string;
  yourReference?: string;
  invoiceText?: string;
  projectId?: number;
  lines?: InvoiceLine[];
  startDate?: string;
  endDate?: string;
  frequency?: { interval: number; intervalUnit: "DAY" | "WEEK" | "MONTH" };
}

/** POST /<path>/drafts with an invoiceishDraftRequest of the given type; returns the draft id from the Location. */
export async function createInvoiceishDraft(
  ctx: ToolContext,
  slug: string,
  path: "invoices" | "offers" | "orderConfirmations",
  type: DraftType,
  input: DraftInput,
): Promise<number> {
  const { lines, ...rest } = input;
  const { id } = await ctx.fiken.create(`/companies/${slug}/${path}/drafts`, defined({ type, ...rest, lines: lines ? invoiceLines(lines) : undefined }));
  return id;
}

interface FikenDraftLine {
  invoiceishDraftLineId?: number;
  lastModifiedDate?: string;
  productId?: number;
  description?: string;
  unitPrice?: number;
  vatType?: string;
  quantity: number;
  discount?: number;
  comment?: string;
  incomeAccount?: string;
}

/** Fiken's invoiceishDraftResult. */
export interface FikenDraft {
  draftId: number;
  uuid?: string;
  type: string;
  lastModifiedDate?: string;
  issueDate?: string;
  daysUntilDueDate?: number;
  invoiceText?: string;
  currency?: string;
  yourReference?: string;
  ourReference?: string;
  orderReference?: string;
  lines?: FikenDraftLine[];
  net?: number;
  gross?: number;
  bankAccountNumber?: string;
  iban?: string;
  bic?: string;
  paymentAccount?: string;
  customers?: Array<{ contactId: number; name?: string }>;
  attachments?: unknown[];
  createdFromInvoiceId?: number;
  projectId?: number;
  roundingType?: string;
  startDate?: string;
  endDate?: string;
  frequency?: { interval: number; intervalUnit: string };
}

export function trimDraft(d: FikenDraft) {
  return {
    draftId: d.draftId,
    uuid: d.uuid,
    type: d.type,
    issueDate: d.issueDate,
    daysUntilDueDate: d.daysUntilDueDate,
    customerId: d.customers?.[0]?.contactId,
    currency: d.currency,
    net: d.net,
    gross: d.gross,
    lines: (d.lines ?? []).length,
  };
}

export function trimDraftDetail(d: FikenDraft) {
  return {
    ...trimDraft(d),
    customers: (d.customers ?? []).map((c) => ({ contactId: c.contactId, name: c.name })),
    invoiceText: d.invoiceText,
    yourReference: d.yourReference,
    ourReference: d.ourReference,
    orderReference: d.orderReference,
    bankAccountNumber: d.bankAccountNumber,
    paymentAccount: d.paymentAccount,
    projectId: d.projectId,
    createdFromInvoiceId: d.createdFromInvoiceId,
    lastModifiedDate: d.lastModifiedDate,
    lines: (d.lines ?? []).map((l) => ({
      productId: l.productId,
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      discount: l.discount,
      vatType: l.vatType,
      incomeAccount: l.incomeAccount,
      comment: l.comment,
    })),
    attachments: (d.attachments ?? []).length,
  };
}

/**
 * The invoiceishDraftRequest that leaves a draft as it is: every request field the result carries,
 * the first customer as customerId, lines without their read-only id and date. Read-only result
 * fields (draftId, lastModifiedDate, net, gross, attachments, createdFromInvoiceId) are left out.
 */
export function draftRequest(d: FikenDraft): Record<string, unknown> {
  return defined({
    type: d.type,
    uuid: d.uuid,
    issueDate: d.issueDate,
    daysUntilDueDate: d.daysUntilDueDate,
    invoiceText: d.invoiceText,
    yourReference: d.yourReference,
    ourReference: d.ourReference,
    orderReference: d.orderReference,
    lines: d.lines?.map((l) =>
      defined({
        productId: l.productId,
        description: l.description,
        unitPrice: l.unitPrice,
        vatType: l.vatType,
        quantity: l.quantity,
        discount: l.discount,
        comment: l.comment,
        incomeAccount: l.incomeAccount,
      }),
    ),
    currency: d.currency,
    bankAccountNumber: d.bankAccountNumber,
    iban: d.iban,
    bic: d.bic,
    paymentAccount: d.paymentAccount,
    customerId: d.customers?.[0]?.contactId,
    projectId: d.projectId,
    roundingType: d.roundingType,
    startDate: d.startDate,
    endDate: d.endDate,
    frequency: d.frequency,
  });
}

/**
 * The counter's current value (the last number used), or null when the series was never started:
 * Fiken answers 404, or 409 "counter not initialized". Any other error, and an answer without a
 * numeric value, is thrown.
 */
export async function readCounter(ctx: ToolContext, slug: string, path: "invoices" | "creditNotes"): Promise<number | null> {
  let counter: { value?: unknown };
  try {
    counter = await ctx.fiken.json<{ value?: unknown }>(`/companies/${slug}/${path}/counter`);
  } catch (err) {
    if (err instanceof FikenError && (err.status === 404 || (err.status === 409 && /counter/i.test(err.body)))) return null;
    throw err;
  }
  if (typeof counter.value !== "number") throw new FikenError(502, "Fiken answered the counter without a numeric value.");
  return counter.value;
}
