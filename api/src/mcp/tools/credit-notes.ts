import { z } from "zod";
import { defineOperation, type Operation } from "../operations.js";
import { errorText, toolJson } from "../context.js";
import { companySlug, CONFIRM, defined, gatewayCall, isoDate, paged, paging, toolText, withCompany } from "./common.js";
import { invoiceLine, invoiceLines, LINE_MONEY, missingLineFields, sendDocument, sendDocumentInput } from "./documents.js";

const CREDIT_NOTE_ID_SOURCES = "from list_credit_notes (via fiken_read); create_credit_note (via fiken_write) returns one";

interface FikenCreditNote {
  creditNoteId: number;
  creditNoteNumber: number;
  issueDate: string;
  net: number;
  vat: number;
  gross: number;
  currency: string;
  associatedInvoiceId?: number;
  customer?: { contactId: number; name: string };
  kid?: string;
  settled?: boolean;
  creditNoteText?: string;
  yourReference?: string;
  ourReference?: string;
  lines?: Array<{
    description?: string;
    productName?: string;
    quantity: number;
    unitPrice: number;
    net: number;
    vat: number;
    vatType: string;
    incomeAccount?: string;
  }>;
}

function trimCreditNote(n: FikenCreditNote) {
  return {
    creditNoteId: n.creditNoteId,
    creditNoteNumber: n.creditNoteNumber,
    issueDate: n.issueDate,
    net: n.net,
    vat: n.vat,
    gross: n.gross,
    currency: n.currency,
    associatedInvoiceId: n.associatedInvoiceId,
    customer: n.customer ? { contactId: n.customer.contactId, name: n.customer.name } : undefined,
  };
}

function trimCreditNoteDetail(n: FikenCreditNote) {
  return {
    ...trimCreditNote(n),
    kid: n.kid,
    settled: n.settled,
    creditNoteText: n.creditNoteText,
    yourReference: n.yourReference,
    ourReference: n.ourReference,
    lines: (n.lines ?? []).map((l) => ({
      description: l.description,
      productName: l.productName,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      net: l.net,
      vat: l.vat,
      vatType: l.vatType,
      incomeAccount: l.incomeAccount,
    })),
  };
}

export const creditNotesOperations: Operation[] = [
  defineOperation({
    name: "list_credit_notes",
    concept: "credit_notes",
    kind: "read",
    destructive: false,
    title: "List credit notes",
    description: `Issued credit notes (kreditnota). Filter by issue date range, customer or settled status. ${LINE_MONEY}`,
    input: z.object({
      companySlug,
      ...paging,
      issueDateGe: isoDate.optional().describe("Only credit notes issued on or after this date (YYYY-MM-DD)"),
      issueDateLe: isoDate.optional().describe("Only credit notes issued on or before this date (YYYY-MM-DD)"),
      customerId: z.number().int().optional().describe("Customer contact id, from search_contacts"),
      settled: z.boolean().optional().describe("false: credit notes not fully settled"),
    }),
    async run(ctx, { companySlug: slug, page, pageSize, issueDateGe, issueDateLe, customerId, settled }) {
      return withCompany(ctx, slug, async () => {
        const { items, total } = await ctx.fiken.list<FikenCreditNote>(`/companies/${slug}/creditNotes`, { page, pageSize, issueDateGe, issueDateLe, customerId, settled });
        return paged(items.map(trimCreditNote), total, page, pageSize);
      });
    },
  }),

  defineOperation({
    name: "get_credit_note",
    concept: "credit_notes",
    kind: "read",
    destructive: false,
    title: "Get credit note",
    description: `A single credit note by id, with its lines. ${LINE_MONEY}`,
    input: z.object({ companySlug, creditNoteId: z.number().int().describe(`Credit note id, ${CREDIT_NOTE_ID_SOURCES}`) }),
    async run(ctx, { companySlug: slug, creditNoteId }) {
      return withCompany(ctx, slug, async () => {
        return toolJson(trimCreditNoteDetail(await ctx.fiken.json<FikenCreditNote>(`/companies/${slug}/creditNotes/${creditNoteId}`)));
      });
    },
  }),

  defineOperation({
    name: "send_credit_note",
    concept: "credit_notes",
    kind: "write",
    destructive: true,
    title: "Send credit note",
    description:
      "Send an issued credit note to the customer (email, EHF, eFaktura, SMS or letter; auto follows the customer's and company's settings). " +
      `The customer receives it at once; this cannot be undone. ${CONFIRM}`,
    input: z.object({
      companySlug,
      creditNoteId: z.number().int().describe(`Credit note id, ${CREDIT_NOTE_ID_SOURCES}`),
      ...sendDocumentInput(),
    }),
    async run(ctx, { companySlug: slug, creditNoteId, ...fields }) {
      return withCompany(ctx, slug, async () => {
        await sendDocument(ctx, slug, "creditNotes", "creditNoteId", creditNoteId, fields);
        return toolJson({ creditNoteId, sent: true, method: fields.method });
      });
    },
  }),

  defineOperation({
    name: "create_credit_note",
    concept: "credit_notes",
    kind: "write",
    destructive: true,
    title: "Create credit note",
    description:
      "Credit an issued invoice, fully (kind full) or by the given lines (kind partial). The credit note is booked at once and is not sent. " +
      `full needs invoiceId and no lines; partial needs lines (each with unitPrice, even with a productId) and invoiceId or contactId. ` +
      `Amounts are integers in the invoice currency's smallest unit (øre for NOK). ${CONFIRM}`,
    input: z.object({
      companySlug,
      kind: z.enum(["full", "partial"]),
      issueDate: isoDate.describe("Issue date (YYYY-MM-DD)"),
      invoiceId: z.number().int().optional().describe("Invoice to credit, from list_invoices (via fiken_read)"),
      contactId: z.number().int().optional().describe("Customer contact id; partial only, when no invoiceId"),
      creditNoteText: z.string().optional(),
      lines: z.array(invoiceLine).min(1).optional().describe("Lines to credit; partial only"),
    }),
    async run(ctx, { companySlug: slug, kind, lines, ...rest }) {
      if (kind === "full") {
        if (rest.invoiceId === undefined) return toolText("A full credit note needs invoiceId.");
        if (lines) return toolText("A full credit note takes no lines; use kind partial to credit specific lines.");
      } else {
        if (!lines) return toolText("A partial credit note needs lines.");
        if (rest.invoiceId === undefined && rest.contactId === undefined) return toolText("A partial credit note needs invoiceId or contactId.");
        const missing = missingLineFields(lines, { requireUnitPrice: true });
        if (missing) return toolText(missing);
      }
      return withCompany(ctx, slug, async () => {
        const body = kind === "full" ? defined({ issueDate: rest.issueDate, invoiceId: rest.invoiceId, creditNoteText: rest.creditNoteText }) : defined({ ...rest, lines: invoiceLines(lines ?? []) });
        const { id } = await ctx.fiken.create(`/companies/${slug}/creditNotes/${kind}`, body);
        try {
          return toolJson(trimCreditNote(await ctx.fiken.json<FikenCreditNote>(`/companies/${slug}/creditNotes/${id}`)));
        } catch (err) {
          return toolText(
            `Credit note ${id} was created; fetching it back failed: ${errorText(err)}. Do not create it again; ` +
              `${gatewayCall("fiken_read", "get_credit_note", { companySlug: slug, creditNoteId: id })}.`,
          );
        }
      });
    },
  }),
];
