import { z } from "zod";
import { defineOperation, type Operation } from "../operations.js";
import { toolJson } from "../context.js";
import { companySlug, CONFIRM, isoDate, paged, paging, toolText, withCompany } from "./common.js";
import { createInvoiceishDraft, type FikenDraft, invoiceLine, LINE_MONEY, missingLineFields, sendDocument, sendDocumentInput, trimDraft } from "./documents.js";

const OFFER_DRAFT_ID_SOURCES = "from list_offer_drafts (via fiken_read); create_offer_draft (via fiken_write) returns one";
const OFFER_ID_SOURCES = "from list_offers (via fiken_read); create_offer_from_draft (via fiken_write) returns one";
const CONFIRMATION_DRAFT_ID_SOURCES =
  "from list_order_confirmation_drafts (via fiken_read); create_order_confirmation_draft (via fiken_write) returns one";
const CONFIRMATION_ID_SOURCES = "from list_order_confirmations (via fiken_read); create_order_confirmation_from_draft (via fiken_write) returns one";

/** The create_invoice_draft input without `type`, and with the bank account optional: an offer or confirmation is not paid. */
const draftShape = {
  companySlug,
  customerId: z.number().int().describe("Customer contact id, from search_contacts"),
  daysUntilDueDate: z.number().int().min(0).describe("Days from the issue date until the resulting invoice is due"),
  bankAccountNumber: z.string().min(1).optional().describe("The bank account number, bankAccountNumber from list_bank_accounts (not the 1920:... code)"),
  issueDate: isoDate.optional().describe("Issue date (YYYY-MM-DD)"),
  lines: z.array(invoiceLine).optional().describe(`Draft lines. ${LINE_MONEY}`),
  currency: z.string().min(1).default("NOK"),
  ourReference: z.string().optional(),
  yourReference: z.string().optional(),
  invoiceText: z.string().optional().describe("Free text printed on the document"),
  projectId: z.number().int().optional().describe("Project id, from list_projects"),
};

interface FikenOffer {
  offerId: number;
  offerNumber: number;
  date: string;
  net: number;
  vat: number;
  gross: number;
  currency: string;
  contactId?: number;
  archived?: boolean;
  accepted?: string;
}

interface FikenOrderConfirmation {
  confirmationId: number;
  confirmationNumber: number;
  date: string;
  net: number;
  vat: number;
  gross: number;
  currency: string;
  contactId?: number;
  createdInvoice?: number;
  archived?: boolean;
}

export const offersOperations: Operation[] = [
  defineOperation({
    name: "create_offer_draft",
    concept: "offers",
    kind: "write",
    destructive: false,
    title: "Create offer draft",
    description: "Create an offer (tilbud) draft the user can review in Fiken; create_offer_from_draft (via fiken_write) turns it into an offer.",
    input: z.object(draftShape),
    async run(ctx, { companySlug: slug, lines, ...rest }) {
      const missing = lines ? missingLineFields(lines) : undefined;
      if (missing) return toolText(missing);
      return withCompany(ctx, slug, async () => toolJson({ draftId: await createInvoiceishDraft(ctx, slug, "offers", "offer", { ...rest, lines }) }));
    },
  }),

  defineOperation({
    name: "list_offer_drafts",
    concept: "offers",
    kind: "read",
    destructive: false,
    title: "List offer drafts",
    description: `Offer drafts not yet turned into offers. ${LINE_MONEY}`,
    input: z.object({ companySlug, ...paging }),
    async run(ctx, { companySlug: slug, page, pageSize }) {
      return withCompany(ctx, slug, async () => {
        const { items, total } = await ctx.fiken.list<FikenDraft>(`/companies/${slug}/offers/drafts`, { page, pageSize });
        return paged(items.map(trimDraft), total, page, pageSize);
      });
    },
  }),

  defineOperation({
    name: "create_offer_from_draft",
    concept: "offers",
    kind: "write",
    destructive: true,
    title: "Create offer from draft",
    description: `Turn an offer draft into an offer. It is not sent; send_offer (via fiken_write) does that. ${CONFIRM}`,
    input: z.object({ companySlug, draftId: z.number().int().describe(`Offer draft id, ${OFFER_DRAFT_ID_SOURCES}`) }),
    async run(ctx, { companySlug: slug, draftId }) {
      return withCompany(ctx, slug, async () => {
        const { id } = await ctx.fiken.create(`/companies/${slug}/offers/drafts/${draftId}/createOffer`, undefined);
        return toolJson({ offerId: id });
      });
    },
  }),

  defineOperation({
    name: "send_offer",
    concept: "offers",
    kind: "write",
    destructive: true,
    title: "Send offer",
    description:
      "Send an offer to the customer (email, EHF, eFaktura, SMS or letter; auto follows the customer's and company's settings). " +
      `The customer receives it at once; this cannot be undone. ${CONFIRM}`,
    input: z.object({
      companySlug,
      offerId: z.number().int().describe(`Offer id, ${OFFER_ID_SOURCES}`),
      ...sendDocumentInput(),
    }),
    async run(ctx, { companySlug: slug, offerId, ...fields }) {
      return withCompany(ctx, slug, async () => {
        await sendDocument(ctx, slug, "offers", "offerId", offerId, fields);
        return toolJson({ offerId, sent: true, method: fields.method });
      });
    },
  }),

  defineOperation({
    name: "list_offers",
    concept: "offers",
    kind: "read",
    destructive: false,
    title: "List offers",
    description: `Offers (tilbud) made in Fiken. ${LINE_MONEY}`,
    input: z.object({ companySlug, ...paging }),
    async run(ctx, { companySlug: slug, page, pageSize }) {
      return withCompany(ctx, slug, async () => {
        const { items, total } = await ctx.fiken.list<FikenOffer>(`/companies/${slug}/offers`, { page, pageSize });
        const trimmed = items.map((o) => ({
          offerId: o.offerId,
          offerNumber: o.offerNumber,
          date: o.date,
          net: o.net,
          vat: o.vat,
          gross: o.gross,
          currency: o.currency,
          contactId: o.contactId,
          archived: o.archived,
          accepted: o.accepted,
        }));
        return paged(trimmed, total, page, pageSize);
      });
    },
  }),

  defineOperation({
    name: "create_order_confirmation_draft",
    concept: "order_confirmations",
    kind: "write",
    destructive: false,
    title: "Create order confirmation draft",
    description: "Create an order confirmation (ordrebekreftelse) draft the user can review in Fiken; create_order_confirmation_from_draft (via fiken_write) turns it into an order confirmation.",
    input: z.object(draftShape),
    async run(ctx, { companySlug: slug, lines, ...rest }) {
      const missing = lines ? missingLineFields(lines) : undefined;
      if (missing) return toolText(missing);
      return withCompany(ctx, slug, async () =>
        toolJson({ draftId: await createInvoiceishDraft(ctx, slug, "orderConfirmations", "order_confirmation", { ...rest, lines }) }),
      );
    },
  }),

  defineOperation({
    name: "list_order_confirmation_drafts",
    concept: "order_confirmations",
    kind: "read",
    destructive: false,
    title: "List order confirmation drafts",
    description: `Order confirmation drafts not yet turned into order confirmations. ${LINE_MONEY}`,
    input: z.object({ companySlug, ...paging }),
    async run(ctx, { companySlug: slug, page, pageSize }) {
      return withCompany(ctx, slug, async () => {
        const { items, total } = await ctx.fiken.list<FikenDraft>(`/companies/${slug}/orderConfirmations/drafts`, { page, pageSize });
        return paged(items.map(trimDraft), total, page, pageSize);
      });
    },
  }),

  defineOperation({
    name: "create_order_confirmation_from_draft",
    concept: "order_confirmations",
    kind: "write",
    destructive: true,
    title: "Create order confirmation from draft",
    description: `Turn an order confirmation draft into an order confirmation. ${CONFIRM}`,
    input: z.object({ companySlug, draftId: z.number().int().describe(`Order confirmation draft id, ${CONFIRMATION_DRAFT_ID_SOURCES}`) }),
    async run(ctx, { companySlug: slug, draftId }) {
      return withCompany(ctx, slug, async () => {
        const { id } = await ctx.fiken.create(`/companies/${slug}/orderConfirmations/drafts/${draftId}/createOrderConfirmation`, undefined);
        return toolJson({ confirmationId: id });
      });
    },
  }),

  defineOperation({
    name: "list_order_confirmations",
    concept: "order_confirmations",
    kind: "read",
    destructive: false,
    title: "List order confirmations",
    description: `Order confirmations (ordrebekreftelser) made in Fiken; createdInvoice is the invoice made from one. ${LINE_MONEY}`,
    input: z.object({ companySlug, ...paging }),
    async run(ctx, { companySlug: slug, page, pageSize }) {
      return withCompany(ctx, slug, async () => {
        const { items, total } = await ctx.fiken.list<FikenOrderConfirmation>(`/companies/${slug}/orderConfirmations`, { page, pageSize });
        const trimmed = items.map((o) => ({
          confirmationId: o.confirmationId,
          confirmationNumber: o.confirmationNumber,
          date: o.date,
          net: o.net,
          vat: o.vat,
          gross: o.gross,
          currency: o.currency,
          contactId: o.contactId,
          createdInvoice: o.createdInvoice,
          archived: o.archived,
        }));
        return paged(trimmed, total, page, pageSize);
      });
    },
  }),

  defineOperation({
    name: "create_invoice_draft_from_order_confirmation",
    concept: "order_confirmations",
    kind: "write",
    destructive: false,
    title: "Create invoice draft from order confirmation",
    description: "Create an invoice draft from an order confirmation; create_invoice_from_draft (via fiken_write) issues it.",
    input: z.object({ companySlug, confirmationId: z.number().int().describe(`Order confirmation id, ${CONFIRMATION_ID_SOURCES}`) }),
    async run(ctx, { companySlug: slug, confirmationId }) {
      return withCompany(ctx, slug, async () => {
        const { id } = await ctx.fiken.create(`/companies/${slug}/orderConfirmations/${confirmationId}/createInvoiceDraft`, undefined);
        return toolJson({ draftId: id });
      });
    },
  }),
];
