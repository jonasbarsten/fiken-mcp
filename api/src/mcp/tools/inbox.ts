import { z } from "zod";
import { defineOperation, type Operation } from "../operations.js";
import { companySlug, paged, paging, withCompany } from "./common.js";

interface FikenInboxDocument {
  documentId: number;
  name: string;
  filename: string;
  status: unknown;
  createdAt: string;
}

export const inboxOperations: Operation[] = [
  defineOperation({
    name: "list_inbox",
    concept: "inbox",
    kind: "read",
    destructive: false,
    title: "List inbox documents",
    description:
      "Documents in the company's inbox (bilag) not yet used as documentation. The upload widget puts receipts here; " +
      "documentId is what create_purchase takes as inboxDocumentId.",
    input: z.object({
      companySlug,
      ...paging,
      status: z.enum(["unused", "used", "all"]).default("unused").describe("Filter to documents that are unused, used, or all"),
      name: z.string().optional().describe("Filter by document name"),
    }),
    async run(ctx, { companySlug: slug, page, pageSize, status, name }) {
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
  }),
];
