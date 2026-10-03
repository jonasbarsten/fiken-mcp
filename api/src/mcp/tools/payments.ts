import { z } from "zod";
import { defineOperation, type Operation } from "../operations.js";
import { toolJson } from "../context.js";
import { companySlug, CONFIRM, defined, isoDate, ORE, toolText, withCompany } from "./common.js";

interface FikenPayment {
  paymentId: number;
  date: string;
  account: string;
  amount: number;
  fee?: number;
}

export const paymentsOperations: Operation[] = [
  defineOperation({
    name: "list_payments",
    concept: "payments",
    kind: "read",
    destructive: false,
    title: "List payments",
    description: `Payments registered on one sale or one purchase. Give exactly one of saleId and purchaseId. ${ORE}`,
    input: z.object({
      companySlug,
      saleId: z.number().int().optional().describe("Sale id, from list_sales (via fiken_read)"),
      purchaseId: z.number().int().optional().describe("Purchase id, from list_purchases (via fiken_read)"),
    }),
    async run(ctx, { companySlug: slug, saleId, purchaseId }) {
      if ((saleId === undefined) === (purchaseId === undefined)) return toolText("Give exactly one of saleId and purchaseId.");
      return withCompany(ctx, slug, async () => {
        const target = saleId !== undefined ? `sales/${saleId}` : `purchases/${purchaseId}`;
        const payments = await ctx.fiken.json<FikenPayment[]>(`/companies/${slug}/${target}/payments`);
        return toolJson({ items: payments.map((p) => ({ paymentId: p.paymentId, date: p.date, account: p.account, amount: p.amount, fee: p.fee })) });
      });
    },
  }),

  defineOperation({
    name: "register_payment",
    concept: "payments",
    kind: "write",
    destructive: true,
    title: "Register payment",
    description:
      "Register a payment on a sale (money received) or a purchase (money paid). Give exactly one of saleId and purchaseId; " +
      "get_invoice and list_invoices (via fiken_read) give an invoice's saleId. NOK sales and purchases only: amount is what was paid, in øre. " +
      `Register payments on sales or purchases in other currencies in Fiken itself. ${CONFIRM}`,
    input: z.object({
      companySlug,
      saleId: z.number().int().optional().describe("Sale id, from list_sales (via fiken_read), or the saleId on get_invoice or list_invoices (both via fiken_read)"),
      purchaseId: z.number().int().optional().describe("Purchase id, from list_purchases (via fiken_read)"),
      date: isoDate.describe("Payment date (YYYY-MM-DD)"),
      account: z.string().min(1).describe("Bank account code, from list_bank_accounts"),
      amount: z.number().int().positive().describe(`Amount paid. ${ORE}`),
      fee: z.number().int().nonnegative().optional().describe(`Bank fee. ${ORE}`),
    }),
    async run(ctx, { companySlug: slug, saleId, purchaseId, ...payment }) {
      if ((saleId === undefined) === (purchaseId === undefined)) return toolText("Give exactly one of saleId and purchaseId.");
      return withCompany(ctx, slug, async () => {
        const target = saleId !== undefined ? `sales/${saleId}` : `purchases/${purchaseId}`;
        const { id } = await ctx.fiken.create(`/companies/${slug}/${target}/payments`, defined(payment));
        return toolJson(saleId !== undefined ? { paymentId: id, saleId } : { paymentId: id, purchaseId });
      });
    },
  }),
];
