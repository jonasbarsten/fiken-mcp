import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { DOCUMENT_HTML } from "../../assets.js";
import type { Config } from "../../config.js";
import { issueViewTicket } from "../../document/ticket.js";
import { counted, type ToolContext } from "../context.js";
import { pickTarget, targetSchema } from "./attachments.js";
import { companySlug, toolText, withCompany } from "./common.js";

/** One stable URI for the widget, never versioned per build (see UPLOAD_RESOURCE_URI). */
export const SHOW_DOCUMENT_RESOURCE_URI = "ui://fiken-mcp/document.html";

const DESCRIPTION =
  "Show an inbox document (inboxDocumentId) or an attachment (attachmentUuid from get_attachments via fiken_read, with " +
  "exactly one of purchaseId, saleId, invoiceId, journalEntryId) to the user as an image or PDF in the chat. Only the " +
  "user sees it; to read an inbox document's content yourself, use get_inbox_document (via fiken_read).";

const inputSchema = z
  .object({
    companySlug,
    inboxDocumentId: z.number().int().optional().describe("documentId from list_inbox"),
    attachmentUuid: z.string().min(1).optional().describe("uuid from get_attachments (via fiken_read); give the id it was listed under too"),
    ...targetSchema,
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

interface FikenInboxDocument {
  filename: string;
  documentUrl: string;
}

interface FikenAttachment {
  uuid?: string;
  filename?: string;
  /** For API credentials; the other URL Fiken lists needs a Fiken login in the browser. */
  downloadUrl?: string;
}

const NEED_ONE = toolText(
  "Give exactly one document: inboxDocumentId, or attachmentUuid together with exactly one of purchaseId, saleId, invoiceId, journalEntryId.",
);

export function registerDocumentViewTool(server: McpServer, ctx: ToolContext, publicUrl: string, cfg: Config): void {
  const documentUrl = `${publicUrl}/document`;
  const claims = { fikenAccessToken: ctx.fikenAccessToken, anonId: ctx.anonId, exp: ctx.exp };

  /** The file URL comes from Fiken's answer, never from the model, and is sealed into the ticket; only the ticket goes out. */
  const shown = (slug: string, fileUrl: string, filename: string, text: string): CallToolResult => ({
    content: [{ type: "text", text }],
    structuredContent: { documentUrl, ticket: issueViewTicket(cfg, claims, slug, fileUrl), filename },
  });

  registerAppTool(
    server,
    "show_document",
    {
      title: "Show a document",
      description: DESCRIPTION,
      inputSchema,
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: SHOW_DOCUMENT_RESOURCE_URI } },
    },
    counted(ctx, "show_document", async ({ companySlug: slug, inboxDocumentId, attachmentUuid, ...ids }: Input) => {
      if (inboxDocumentId !== undefined) {
        if (attachmentUuid !== undefined || Object.values(ids).some((v) => v !== undefined)) return NEED_ONE;
        return withCompany(ctx, slug, async () => {
          const doc = await ctx.fiken.json<FikenInboxDocument>(`/companies/${slug}/inbox/${inboxDocumentId}`);
          return shown(slug, doc.documentUrl, doc.filename, `Viser ${doc.filename} fra innboksen. Innholdet kan leses med get_inbox_document (via fiken_read).`);
        });
      }
      const target = pickTarget(ids);
      if (attachmentUuid === undefined || !target) return NEED_ONE;
      return withCompany(ctx, slug, async () => {
        const items = await ctx.fiken.json<FikenAttachment[]>(`/companies/${slug}/${target.segment}/${target.id}/attachments`);
        const att = items.find((a) => a.uuid === attachmentUuid);
        if (!att) return toolText(`No attachment ${attachmentUuid} on ${target.key} ${target.id}; list them with get_attachments (via fiken_read).`);
        if (!att.downloadUrl) return toolText(`Fiken gives no download URL for attachment ${attachmentUuid}; ask the user to open it in Fiken.`);
        const filename = att.filename ?? "vedlegg";
        return shown(slug, att.downloadUrl, filename, `Viser vedlegget ${filename}.`);
      });
    }),
  );

  registerAppResource(
    server,
    "Document viewer widget",
    SHOW_DOCUMENT_RESOURCE_URI,
    { description: "Shows an inbox document or an attachment (image or PDF) from Fiken." },
    async () => ({
      contents: [
        {
          uri: SHOW_DOCUMENT_RESOURCE_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: DOCUMENT_HTML,
          _meta: { ui: { csp: { connectDomains: [publicUrl] } } },
        },
      ],
    }),
  );
}
