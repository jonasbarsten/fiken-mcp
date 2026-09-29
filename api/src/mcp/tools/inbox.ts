import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { type ToolContext } from "../server.js";
import { companySlug, paged, paging, withCompany } from "./common.js";

interface FikenInboxDocument {
  documentId: number;
  name: string;
  filename: string;
  status: unknown;
  createdAt: string;
}

export function registerInbox(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "list_inbox",
    {
      title: "List inbox documents",
      description:
        "Documents in the company's inbox (bilag) not yet used as documentation. The upload widget puts receipts here; " +
        "documentId is what create_purchase takes as inboxDocumentId.",
      inputSchema: z.object({
        companySlug,
        ...paging,
        status: z.enum(["unused", "used", "all"]).default("unused").describe("Filter to documents that are unused, used, or all"),
        name: z.string().optional().describe("Filter by document name"),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ companySlug: slug, page, pageSize, status, name }) => {
      return withCompany(ctx, slug, async () => {
        const { items, total } = await ctx.fiken.list<FikenInboxDocument>(`/companies/${slug}/inbox`, {
          page,
          pageSize,
          status,
          name,
          sortBy: "createdDate desc",
        });
        return paged(
          items.map((d) => ({ documentId: d.documentId, name: d.name, filename: d.filename, status: d.status, createdAt: d.createdAt })),
          total,
          page,
          pageSize,
        );
      });
    },
  );
}
