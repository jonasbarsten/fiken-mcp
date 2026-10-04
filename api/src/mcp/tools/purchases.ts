import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { defineOperation, type Operation } from "../operations.js";
import { errorText, toolJson } from "../context.js";
import { companySlug, CONFIRM, defined, gatewayCall, isoDate, ORE, paged, paging, toolText, withCompany } from "./common.js";

interface FikenPurchaseLine {
  description: string;
  netPrice: number;
  vat: number;
  account: string;
  vatType: string;
  lineId: number;
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

function purchaseDetail(p: FikenPurchase) {
  return {
    ...trimPurchase(p),
    lines: p.lines.map((l) => ({ lineId: l.lineId, description: l.description, netPrice: l.netPrice, vat: l.vat, account: l.account, vatType: l.vatType })),
    purchaseAttachments: (p.purchaseAttachments ?? []).map((a) => ({ uuid: a.uuid, filename: a.filename })),
  };
}

interface FikenPurchaseDraft {
  draftId: number;
  uuid: string;
  invoiceIssueDate?: string;
  dueDate?: string;
  contact?: { contactId: number; name: string };
  cash: boolean;
  paid: boolean;
  lines?: unknown[];
}

const draftLine = z
  .object({
    text: z.string().min(1).max(200).describe("Description of the line"),
    vatType: z.string().min(1).describe("Purchase VAT type: HIGH (25%), MEDIUM (15%), LOW (12%), NONE, RAW_FISH and Fiken's other purchase types"),
    incomeAccount: z.string().min(1).describe("The expense account code, from list_accounts (Fiken calls it incomeAccount on draft lines)"),
    net: z.number().int().describe(`Net amount. ${ORE}`),
    gross: z.number().int().describe(`Gross amount (net plus VAT). ${ORE}`),
    projectId: z.number().int().optional().describe("Project id, from list_projects"),
  })
  .strict();

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
        return toolJson(purchaseDetail(await ctx.fiken.json<FikenPurchase>(`/companies/${slug}/purchases/${purchaseId}`)));
      });
    },
  }),

  defineOperation({
    name: "create_purchase_draft",
    concept: "purchases",
    kind: "write",
    destructive: false,
    title: "Create purchase draft",
    description:
      "Prepare a purchase for the user to review and approve in Fiken, instead of booking it directly with create_purchase. Nothing is booked until then. " +
      "lines use Fiken's draft names: text, net and gross (øre), and incomeAccount for the expense account. " +
      "The user can attach the receipt in Fiken, or create_purchase_from_draft (via fiken_write) books it. " +
      "A draft records no payment: if paid is true, the payment is recorded in Fiken when the draft is approved. " +
      `NOK only. ${ORE}`,
    input: z.object({
      companySlug,
      cash: z.boolean().describe("true for a cash purchase (paid at once), false for a supplier invoice"),
      paid: z.boolean().describe("Whether the purchase has been paid"),
      lines: z.array(draftLine).min(1),
      currency: z.literal("NOK").default("NOK"),
      contactId: z.number().int().optional().describe("Supplier contact id, from search_contacts"),
      invoiceIssueDate: isoDate.optional().describe("Invoice date (YYYY-MM-DD)"),
      dueDate: isoDate.optional().describe("Due date (YYYY-MM-DD)"),
      invoiceNumber: z.string().min(1).optional().describe("The supplier's invoice number"),
      kid: z.string().min(1).optional(),
      projectId: z.number().int().optional().describe("Project id, from list_projects; applies to the whole draft"),
    }),
    async run(ctx, { companySlug: slug, ...draft }) {
      const bad = draft.lines.findIndex((l) => l.gross < l.net);
      if (bad !== -1) return toolText(`Line ${bad + 1}: gross (${draft.lines[bad]?.gross}) is below net (${draft.lines[bad]?.net}); gross is net plus VAT.`);
      return withCompany(ctx, slug, async () => {
        const { id } = await ctx.fiken.create(`/companies/${slug}/purchases/drafts`, defined(draft));
        return toolJson({ draftId: id });
      });
    },
  }),

  defineOperation({
    name: "list_purchase_drafts",
    concept: "purchases",
    kind: "read",
    destructive: false,
    title: "List purchase drafts",
    description: `Purchase drafts waiting in Fiken for approval. draftId is what create_purchase_from_draft (via fiken_write) takes. ${ORE}`,
    input: z.object({ companySlug, ...paging }),
    async run(ctx, { companySlug: slug, page, pageSize }) {
      return withCompany(ctx, slug, async () => {
        const { items, total } = await ctx.fiken.list<FikenPurchaseDraft>(`/companies/${slug}/purchases/drafts`, { page, pageSize });
        const trimmed = items.map((d) => ({
          draftId: d.draftId,
          uuid: d.uuid,
          invoiceIssueDate: d.invoiceIssueDate,
          dueDate: d.dueDate,
          contact: d.contact ? { contactId: d.contact.contactId, name: d.contact.name } : undefined,
          cash: d.cash,
          paid: d.paid,
          lines: (d.lines ?? []).length,
        }));
        return paged(trimmed, total, page, pageSize);
      });
    },
  }),

  defineOperation({
    name: "create_purchase_from_draft",
    concept: "purchases",
    kind: "write",
    destructive: true,
    title: "Book purchase from draft",
    description: `Book the purchase from a draft. The purchase is booked in the accounts. ${CONFIRM}`,
    input: z.object({ companySlug, draftId: z.number().int().describe("Draft id, from list_purchase_drafts (via fiken_read)") }),
    async run(ctx, { companySlug: slug, draftId }) {
      return withCompany(ctx, slug, async () => {
        const { id } = await ctx.fiken.create(`/companies/${slug}/purchases/drafts/${draftId}/createPurchase`, undefined);
        try {
          return toolJson(purchaseDetail(await ctx.fiken.json<FikenPurchase>(`/companies/${slug}/purchases/${id}`)));
        } catch (err) {
          return toolText(
            `Purchase ${id} was created from the draft; fetching it back failed: ${errorText(err)}. Do not create it again; ` +
              `${gatewayCall("fiken_read", "get_purchase", { companySlug: slug, purchaseId: id })}.`,
          );
        }
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
      `from the inbox. For outlays or anything unusual, look it up first with fiken_help_index (via fiken_read). ${CONFIRM}`,
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
