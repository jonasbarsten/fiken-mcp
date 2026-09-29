import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { defineOperation, type Operation } from "../operations.js";
import { errorText, toolJson } from "../context.js";
import { companySlug, CONFIRM, gatewayCall, isoDate, ORE, paged, paging, toolText, withCompany } from "./common.js";

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

/**
 * The purchase POST already succeeded when this is called: attaching the receipt or reading the purchase back failed.
 * Names the created purchaseId so the model doesn't retry create_purchase and book the receipt twice.
 */
function createdPurchaseFollowUpFailed(slug: string, id: number, pendingInboxDocumentId: number | undefined, err: unknown): CallToolResult {
  const message = errorText(err);
  const text =
    pendingInboxDocumentId !== undefined
      ? `Purchase ${id} was created, but the receipt (inboxDocumentId ${pendingInboxDocumentId}) could not be attached: ${message}. ` +
        `Do not create the purchase again; ` +
        `${gatewayCall("fiken_write", "attach_inbox_document", { companySlug: slug, purchaseId: id, inboxDocumentId: pendingInboxDocumentId })}.`
      : `Purchase ${id} was created (and its receipt attached, if one was given); fetching it back failed: ${message}. ` +
        `Do not create it again; ${gatewayCall("fiken_read", "get_purchase", { companySlug: slug, purchaseId: id })}.`;
  return toolText(text);
}

export const purchasesOperations: Operation[] = [
  defineOperation({
    name: "list_purchases",
    concept: "purchases",
    kind: "read",
    destructive: false,
    title: "List purchases",
    description: `Purchases (bilag) booked in the company. Filter by date range or paid status. ${ORE}`,
    input: z.object({
      companySlug,
      ...paging,
      dateGe: isoDate.optional().describe("Only purchases on or after this date (YYYY-MM-DD)"),
      dateLe: isoDate.optional().describe("Only purchases on or before this date (YYYY-MM-DD)"),
      paid: z.boolean().optional().describe("Filter to paid (or unpaid) purchases"),
    }),
    async run(ctx, { companySlug: slug, page, pageSize, dateGe, dateLe, paid }) {
      return withCompany(ctx, slug, async () => {
        const { items, total } = await ctx.fiken.list<FikenPurchase>(`/companies/${slug}/purchases`, { page, pageSize, dateGe, dateLe, paid });
        return paged(items.map(trimPurchase), total, page, pageSize);
      });
    },
  }),

  defineOperation({
    name: "get_purchase",
    concept: "purchases",
    kind: "read",
    destructive: false,
    title: "Get purchase",
    description: `A single purchase by id, with its attachments. ${ORE}`,
    input: z.object({ companySlug, purchaseId: z.number().int().describe("Purchase id, from list_purchases (via fiken_read)") }),
    async run(ctx, { companySlug: slug, purchaseId }) {
      return withCompany(ctx, slug, async () => {
        const purchase = await ctx.fiken.json<FikenPurchase>(`/companies/${slug}/purchases/${purchaseId}`);
        return toolJson({
          ...trimPurchase(purchase),
          purchaseAttachments: (purchase.purchaseAttachments ?? []).map((a) => ({ uuid: a.uuid, filename: a.filename })),
        });
      });
    },
  }),

  defineOperation({
    name: "create_purchase",
    concept: "purchases",
    kind: "write",
    destructive: true,
    title: "Create purchase",
    description:
      "Book a new purchase (bilag) in Fiken. A cash purchase (kind cash_purchase) needs paymentAccount (an account code from " +
      "list_bank_accounts) and paymentDate; a supplier purchase (kind supplier) needs supplierId (from search_contacts) and dueDate. " +
      "vatType for purchase lines: HIGH (25%), MEDIUM (15%), LOW (12%), NONE, EXEMPT, OUTSIDE. " +
      `${ORE} projectId comes from list_projects. inboxDocumentId attaches an existing inbox document as the receipt and removes it ` +
      `from the inbox. ${CONFIRM}`,
    input: z.object({
      companySlug,
      date: isoDate.describe("Purchase date (YYYY-MM-DD)"),
      kind: z.enum(["cash_purchase", "supplier"]).describe("cash_purchase (paid directly) or supplier (booked against a supplier invoice)"),
      lines: z
        .array(
          z.strictObject({
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
    async run(ctx, {
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
    }) {
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
        // Set while the receipt still has to be attached; cleared once Fiken confirmed it.
        let pendingInboxDocumentId = inboxDocumentId;
        try {
          if (inboxDocumentId !== undefined) {
            // Fiken requires at least one of attachToSale/attachToPayment; both
            // default to false. A receipt always documents the purchase, and for
            // a cash purchase it is the payment proof too.
            await ctx.fiken.attach(`/companies/${slug}/purchases/${id}/attachments`, new FormData(), {
              inboxDocumentId,
              attachToSale: true,
              attachToPayment: kind === "cash_purchase" ? true : undefined,
            });
            pendingInboxDocumentId = undefined;
          }
          const purchase = await ctx.fiken.json<FikenPurchase>(`/companies/${slug}/purchases/${id}`);
          return toolJson({
            ...trimPurchase(purchase),
            purchaseAttachments: (purchase.purchaseAttachments ?? []).map((a) => ({ uuid: a.uuid, filename: a.filename })),
            attachedInboxDocumentId: inboxDocumentId,
          });
        } catch (err) {
          return createdPurchaseFollowUpFailed(slug, id, pendingInboxDocumentId, err);
        }
      });
    },
  }),
];
