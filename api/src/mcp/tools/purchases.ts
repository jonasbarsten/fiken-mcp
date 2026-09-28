import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { toolJson, type ToolContext } from "../server.js";
import { companySlug, ORE, paged, paging, withCompany } from "./common.js";

interface FikenPurchaseLine {
  description: string;
  netPrice: number;
  vat: number;
  account: string;
  vatType: string;
}

interface FikenPurchase {
  purchaseId: number;
  date: string;
  dueDate?: string;
  kind: string;
  paid: boolean;
  identifier?: string;
  currency: string;
  supplier?: { contactId: number; name: string };
  project?: Array<{ projectId: number; name: string }>;
  lines: FikenPurchaseLine[];
  purchaseAttachments?: Array<{ uuid: string; filename: string }>;
}

function trimPurchase(p: FikenPurchase) {
  return {
    purchaseId: p.purchaseId,
    date: p.date,
    dueDate: p.dueDate,
    kind: p.kind,
    paid: p.paid,
    identifier: p.identifier,
    currency: p.currency,
    supplier: p.supplier ? { contactId: p.supplier.contactId, name: p.supplier.name } : undefined,
    project: p.project?.map((pr) => ({ projectId: pr.projectId, name: pr.name })),
    lines: p.lines.map((l) => ({ description: l.description, netPrice: l.netPrice, vat: l.vat, account: l.account, vatType: l.vatType })),
    attachments: (p.purchaseAttachments ?? []).length,
  };
}

export function registerPurchases(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "list_purchases",
    {
      title: "List purchases",
      description: `Purchases (bilag) booked in the company. Filter by date range or paid status. ${ORE}`,
      inputSchema: z.object({
        companySlug,
        ...paging,
        dateGe: z.string().optional().describe("Only purchases on or after this date (YYYY-MM-DD)"),
        dateLe: z.string().optional().describe("Only purchases on or before this date (YYYY-MM-DD)"),
        paid: z.boolean().optional().describe("Filter to paid (or unpaid) purchases"),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ companySlug: slug, page, pageSize, dateGe, dateLe, paid }) => {
      return withCompany(ctx, slug, async () => {
        const { items, total } = await ctx.fiken.list<FikenPurchase>(`/companies/${slug}/purchases`, { page, pageSize, dateGe, dateLe, paid });
        return paged(items.map(trimPurchase), total, page, pageSize);
      });
    },
  );

  server.registerTool(
    "get_purchase",
    {
      title: "Get purchase",
      description: `A single purchase by id, with its attachments. ${ORE}`,
      inputSchema: z.object({ companySlug, purchaseId: z.number().int().describe("Purchase id, from list_purchases") }),
      annotations: { readOnlyHint: true },
    },
    async ({ companySlug: slug, purchaseId }) => {
      return withCompany(ctx, slug, async () => {
        const purchase = await ctx.fiken.json<FikenPurchase>(`/companies/${slug}/purchases/${purchaseId}`);
        return toolJson({
          ...trimPurchase(purchase),
          purchaseAttachments: (purchase.purchaseAttachments ?? []).map((a) => ({ uuid: a.uuid, filename: a.filename })),
        });
      });
    },
  );
}
