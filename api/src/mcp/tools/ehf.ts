import { z } from "zod";
import { defineOperation, type Operation } from "../operations.js";
import { toolJson } from "../context.js";
import { companySlug, isoDate, ORE, paged, paging, withCompany } from "./common.js";

const EHF_ID_SOURCES = "from list_ehf_documents (via fiken_read)";

interface FikenEhfLine {
  description?: string;
  net?: number;
  vat?: number;
  vatType?: string;
}

interface FikenEhfDocument {
  ehfDocumentId: number;
  documentType?: string;
  status?: string;
  issueDate?: string;
  dueDate?: string;
  invoiceNumber?: string;
  supplierName?: string;
  supplierOrganizationNumber?: string;
  supplierContactId?: number;
  currency?: string;
  net?: number;
  vat?: number;
  gross?: number;
  amountDue?: number;
  purchaseId?: number;
  kid?: string;
  accountNumber?: string;
  iban?: string;
  bic?: string;
  description?: string;
  lines?: FikenEhfLine[];
}

function trimEhf(d: FikenEhfDocument) {
  return {
    ehfDocumentId: d.ehfDocumentId,
    documentType: d.documentType,
    status: d.status,
    issueDate: d.issueDate,
    dueDate: d.dueDate,
    invoiceNumber: d.invoiceNumber,
    supplierName: d.supplierName,
    supplierOrganizationNumber: d.supplierOrganizationNumber,
    supplierContactId: d.supplierContactId,
    currency: d.currency,
    net: d.net,
    vat: d.vat,
    gross: d.gross,
    amountDue: d.amountDue,
    purchaseId: d.purchaseId,
  };
}

export const ehfOperations: Operation[] = [
  defineOperation({
    name: "list_ehf_documents",
    concept: "ehf",
    kind: "read",
    destructive: false,
    title: "List EHF documents",
    description:
      "Incoming EHF e-invoices and credit notes from suppliers. ehfDocumentId is what attach_inbox_document (via fiken_write) takes. " +
      `Booking one as a purchase is done in Fiken, not here. ${ORE}`,
    input: z.object({
      companySlug,
      ...paging,
      status: z.enum(["unprocessed", "used", "processed", "deleted"]).optional().describe("unprocessed: still in the inbox; used: attached to a record but not booked; processed: booked as a purchase; deleted. All except deleted when left out"),
      issueDateGe: isoDate.optional().describe("Only documents issued on or after this date (YYYY-MM-DD)"),
      issueDateLe: isoDate.optional().describe("Only documents issued on or before this date (YYYY-MM-DD)"),
    }),
    async run(ctx, { companySlug: slug, page, pageSize, status, issueDateGe, issueDateLe }) {
      return withCompany(ctx, slug, async () => {
        const { items, total } = await ctx.fiken.list<FikenEhfDocument>(`/companies/${slug}/ehf`, { page, pageSize, status, issueDateGe, issueDateLe });
        return paged(items.map(trimEhf), total, page, pageSize);
      });
    },
  }),

  defineOperation({
    name: "get_ehf_document",
    concept: "ehf",
    kind: "read",
    destructive: false,
    title: "Get EHF document",
    description: `One incoming EHF document with payment details and lines. ${ORE}`,
    input: z.object({ companySlug, ehfDocumentId: z.number().int().describe(`EHF document id, ${EHF_ID_SOURCES}`) }),
    async run(ctx, { companySlug: slug, ehfDocumentId }) {
      return withCompany(ctx, slug, async () => {
        const d = await ctx.fiken.json<FikenEhfDocument>(`/companies/${slug}/ehf/${ehfDocumentId}`);
        return toolJson({
          ...trimEhf(d),
          kid: d.kid,
          accountNumber: d.accountNumber,
          iban: d.iban,
          bic: d.bic,
          description: d.description,
          lines: (d.lines ?? []).map((l) => ({ description: l.description, net: l.net, vat: l.vat, vatType: l.vatType })),
        });
      });
    },
  }),
];
