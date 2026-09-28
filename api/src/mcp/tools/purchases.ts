import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { toolJson, type ToolContext } from "../server.js";
import { companySlug, CONFIRM, ORE, paged, paging, withCompany } from "./common.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

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

  server.registerTool(
    "create_purchase",
    {
      title: "Create purchase",
      description:
        "Book a new purchase (bilag) in Fiken. A cash purchase (kind cash_purchase) needs paymentAccount (an account code from " +
        "list_bank_accounts) and paymentDate; a supplier purchase (kind supplier) needs supplierId (from search_contacts) and dueDate. " +
        "vatType for purchase lines: HIGH (25%), MEDIUM (15%), LOW (12%), NONE, EXEMPT, OUTSIDE. " +
        `${ORE} projectId comes from list_projects. inboxDocumentId attaches an existing inbox document as the receipt and removes it ` +
        `from the inbox. ${CONFIRM}`,
      inputSchema: z.object({
        companySlug,
        date: isoDate.describe("Purchase date (YYYY-MM-DD)"),
        kind: z.enum(["cash_purchase", "supplier"]).describe("cash_purchase (paid directly) or supplier (booked against a supplier invoice)"),
        lines: z
          .array(
            z.object({
              description: z.string().min(1),
              netPrice: z.number().int().describe(ORE),
              vat: z.number().int().describe(ORE),
              account: z.string().min(1).describe("Account code, from list_accounts"),
              vatType: z.string().min(1).describe("HIGH, MEDIUM, LOW, NONE, EXEMPT or OUTSIDE"),
            }),
          )
          .min(1)
          .describe("Purchase lines"),
        currency: z.string().min(1).default("NOK"),
        supplierId: z.number().int().optional().describe("Supplier contact id, from search_contacts; required for kind supplier"),
        dueDate: isoDate.optional().describe("Due date (YYYY-MM-DD); required for kind supplier"),
        paymentAccount: z.string().optional().describe("Bank account code, from list_bank_accounts; required for kind cash_purchase"),
        paymentDate: isoDate.optional().describe("Payment date (YYYY-MM-DD); required for kind cash_purchase"),
        identifier: z.string().optional().describe("Free-text reference/identifier"),
        projectId: z.number().int().optional().describe("Project id, from list_projects"),
        inboxDocumentId: z.number().int().optional().describe("Inbox document id, from list_inbox; attaches it as the receipt"),
      }),
      annotations: { destructiveHint: true, readOnlyHint: false },
    },
    async ({
      companySlug: slug,
      date,
      kind,
      lines,
      currency,
      supplierId,
      dueDate,
      paymentAccount,
      paymentDate,
      identifier,
      projectId,
      inboxDocumentId,
    }) => {
      return withCompany(ctx, slug, async () => {
        const body: Record<string, unknown> = { date, kind, currency };
        if (supplierId !== undefined) body.supplierId = supplierId;
        if (dueDate !== undefined) body.dueDate = dueDate;
        if (paymentAccount !== undefined) body.paymentAccount = paymentAccount;
        if (paymentDate !== undefined) body.paymentDate = paymentDate;
        if (identifier !== undefined) body.identifier = identifier;
        if (projectId !== undefined) body.projectId = projectId;
        body.lines = lines;
        const { id } = await ctx.fiken.create(`/companies/${slug}/purchases`, body);
        if (inboxDocumentId !== undefined) {
          await ctx.fiken.upload(`/companies/${slug}/purchases/${id}/attachments`, new FormData(), { inboxDocumentId });
        }
        const purchase = await ctx.fiken.json<FikenPurchase>(`/companies/${slug}/purchases/${id}`);
        return toolJson({
          ...trimPurchase(purchase),
          purchaseAttachments: (purchase.purchaseAttachments ?? []).map((a) => ({ uuid: a.uuid, filename: a.filename })),
          attachedInboxDocumentId: inboxDocumentId,
        });
      });
    },
  );

  server.registerTool(
    "attach_inbox_document",
    {
      title: "Attach inbox document",
      description: `Attach an existing inbox document to an already-booked purchase, removing it from the inbox. ${CONFIRM}`,
      inputSchema: z.object({
        companySlug,
        purchaseId: z.number().int().describe("Purchase id, from list_purchases"),
        inboxDocumentId: z.number().int().describe("Inbox document id, from list_inbox"),
        attachToSale: z.boolean().default(true).describe("Whether the attachment also counts as the sale/purchase documentation"),
      }),
      annotations: { destructiveHint: true, readOnlyHint: false },
    },
    async ({ companySlug: slug, purchaseId, inboxDocumentId, attachToSale }) => {
      return withCompany(ctx, slug, async () => {
        await ctx.fiken.upload(`/companies/${slug}/purchases/${purchaseId}/attachments`, new FormData(), { inboxDocumentId, attachToSale });
        return toolJson({ purchaseId, inboxDocumentId });
      });
    },
  );
}
