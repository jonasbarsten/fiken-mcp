import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { counted, toolJson, type ToolContext } from "../server.js";
import { companySlug, CONFIRM, toolText, withCompany } from "./common.js";

interface FikenInboxDocument {
  filename: string;
  documentUrl: string;
}

interface FikenAttachment {
  uuid: string;
  filename: string;
  type: string;
  identifier: string;
  comment: string;
}

const targetSchema = {
  purchaseId: z.number().int().optional().describe("Purchase id, from list_purchases"),
  saleId: z.number().int().optional().describe("Sale id, from list_sales"),
  invoiceId: z.number().int().optional().describe("Invoice id, from list_invoices, create_invoice or create_invoice_from_draft"),
  journalEntryId: z.number().int().optional().describe("Journal entry id, from get_journal_entries"),
};

type TargetArgs = { purchaseId?: number; saleId?: number; invoiceId?: number; journalEntryId?: number };
type Target = { key: keyof TargetArgs; segment: string; id: number };

const SEGMENTS: Record<keyof TargetArgs, string> = {
  purchaseId: "purchases",
  saleId: "sales",
  invoiceId: "invoices",
  journalEntryId: "journalEntries",
};

/** The single target given, or undefined when none or several are. */
function pickTarget(args: TargetArgs): Target | undefined {
  const given = (Object.keys(SEGMENTS) as Array<keyof TargetArgs>).filter((k) => args[k] !== undefined);
  if (given.length !== 1) return undefined;
  const key = given[0]!;
  return { key, segment: SEGMENTS[key], id: args[key]! };
}

const NEED_ONE_TARGET: CallToolResult = toolText("Give exactly one of purchaseId, saleId, invoiceId, journalEntryId.");

export function registerAttachments(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "attach_inbox_document",
    {
      title: "Attach inbox document",
      description:
        "Attach an inbox document to a booked purchase, sale, invoice or journal entry (exactly one id). Purchases, sales and " +
        "journal entries take it from the inbox; an invoice gets a copy and the document stays in the inbox. An invoice's " +
        "attachments go out with it when sent with includeDocumentAttachments. An invoiceId comes from list_invoices, create_invoice or " +
        `create_invoice_from_draft. ${CONFIRM}`,
      inputSchema: z.object({
        companySlug,
        ...targetSchema,
        inboxDocumentId: z.number().int().describe("Inbox document id, from list_inbox"),
        attachToSale: z.boolean().default(true).describe("Purchases and sales: the document proves the purchase or sale itself (the receipt or invoice)"),
        attachToPayment: z.boolean().default(false).describe("Purchases and sales: the document proves the payment (card slip, bank confirmation)"),
      }),
      annotations: { destructiveHint: true, readOnlyHint: false },
    },
    counted(ctx, "attach_inbox_document", async ({ companySlug: slug, inboxDocumentId, attachToSale, attachToPayment, ...ids }) => {
      const target = pickTarget(ids);
      if (!target) return NEED_ONE_TARGET;
      const base = `/companies/${slug}/${target.segment}/${target.id}/attachments`;
      const result = { [target.key]: target.id, inboxDocumentId };
      if (target.segment === "purchases" || target.segment === "sales") {
        // Fiken refuses an attachment that documents neither; say so before calling.
        if (!attachToSale && !attachToPayment) {
          return toolText("At least one of attachToSale and attachToPayment must be true.");
        }
        return withCompany(ctx, slug, async () => {
          await ctx.fiken.attach(base, new FormData(), { inboxDocumentId, attachToSale, attachToPayment });
          return toolJson(result);
        });
      }
      if (target.segment === "journalEntries") {
        return withCompany(ctx, slug, async () => {
          await ctx.fiken.attach(base, new FormData(), { inboxDocumentId });
          return toolJson(result);
        });
      }
      // Invoices take no inboxDocumentId: copy the file over. download() refuses any URL outside Fiken's API.
      return withCompany(ctx, slug, async () => {
        const doc = await ctx.fiken.json<FikenInboxDocument>(`/companies/${slug}/inbox/${inboxDocumentId}`);
        const { bytes, contentType } = await ctx.fiken.download(doc.documentUrl);
        const form = new FormData();
        form.set("filename", doc.filename);
        form.set("file", new File([bytes], doc.filename, contentType ? { type: contentType } : undefined));
        await ctx.fiken.attach(base, form);
        return toolJson({ ...result, note: "The file was copied onto the invoice; the inbox document stays in the inbox." });
      });
    }),
  );

  server.registerTool(
    "get_attachments",
    {
      title: "Get attachments",
      description:
        "The attachments on a purchase, sale, invoice or journal entry (exactly one id). An invoiceId comes from list_invoices, create_invoice or create_invoice_from_draft.",
      inputSchema: z.object({ companySlug, ...targetSchema }),
      annotations: { readOnlyHint: true },
    },
    counted(ctx, "get_attachments", async ({ companySlug: slug, ...ids }) => {
      const target = pickTarget(ids);
      if (!target) return NEED_ONE_TARGET;
      return withCompany(ctx, slug, async () => {
        const items = await ctx.fiken.json<FikenAttachment[]>(`/companies/${slug}/${target.segment}/${target.id}/attachments`);
        return toolJson({
          items: items.map((a) => ({ uuid: a.uuid, filename: a.filename, type: a.type, identifier: a.identifier, comment: a.comment })),
        });
      });
    }),
  );
}
