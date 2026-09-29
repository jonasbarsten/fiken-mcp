import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { counted, toolError, toolJson, type ToolContext } from "../server.js";
import { companySlug, CONFIRM, isoDate, ORE, withCompany } from "./common.js";
import { defined, invoiceLine, invoiceLines, missingLineFields, toolText } from "./invoices.js";

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

export function registerCreditNotes(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "create_credit_note",
    {
      title: "Create credit note",
      description:
        "Credit an issued invoice, fully (kind full) or by the given lines (kind partial). The credit note is booked at once and is not sent. " +
        `full needs invoiceId and no lines; partial needs lines and invoiceId or contactId. ${ORE} ${CONFIRM}`,
      inputSchema: z.object({
        companySlug,
        kind: z.enum(["full", "partial"]),
        issueDate: isoDate.describe("Issue date (YYYY-MM-DD)"),
        invoiceId: z.number().int().optional().describe("Invoice to credit, from list_invoices"),
        contactId: z.number().int().optional().describe("Customer contact id; partial only, when no invoiceId"),
        creditNoteText: z.string().optional(),
        lines: z.array(invoiceLine).min(1).optional().describe("Lines to credit; partial only"),
      }),
      annotations: { destructiveHint: true, readOnlyHint: false },
    },
    counted(ctx, "create_credit_note", async ({ companySlug: slug, kind, lines, ...rest }) => {
      if (kind === "full") {
        if (rest.invoiceId === undefined) return toolText("A full credit note needs invoiceId.");
        if (lines) return toolText("A full credit note takes no lines; use kind partial to credit specific lines.");
      } else {
        if (!lines) return toolText("A partial credit note needs lines.");
        if (rest.invoiceId === undefined && rest.contactId === undefined) return toolText("A partial credit note needs invoiceId or contactId.");
        const missing = missingLineFields(lines);
        if (missing) return toolText(missing);
      }
      return withCompany(ctx, slug, async () => {
        const body = kind === "full" ? defined({ issueDate: rest.issueDate, invoiceId: rest.invoiceId, creditNoteText: rest.creditNoteText }) : defined({ ...rest, lines: invoiceLines(lines ?? []) });
        const { id } = await ctx.fiken.create(`/companies/${slug}/creditNotes/${kind}`, body);
        try {
          return toolJson(trimCreditNote(await ctx.fiken.json<FikenCreditNote>(`/companies/${slug}/creditNotes/${id}`)));
        } catch (err) {
          const message = (toolError(err).content[0] as { text: string }).text;
          return toolText(`Credit note ${id} was created; fetching it back failed: ${message}. Do not create it again.`);
        }
      });
    }),
  );
}
