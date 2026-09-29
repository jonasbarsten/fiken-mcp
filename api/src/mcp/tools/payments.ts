import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { counted, toolJson, type ToolContext } from "../server.js";
import { companySlug, CONFIRM, isoDate, ORE, withCompany } from "./common.js";
import { defined, toolText } from "./invoices.js";

export function registerPayments(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "register_payment",
    {
      title: "Register payment",
      description: `Register a payment on a sale (money received) or a purchase (money paid). amount is in NOK. Give exactly one of saleId and purchaseId. ${ORE} ${CONFIRM}`,
      inputSchema: z.object({
        companySlug,
        saleId: z.number().int().optional().describe("Sale id, from list_sales or an invoice's sale"),
        purchaseId: z.number().int().optional().describe("Purchase id, from list_purchases"),
        date: isoDate.describe("Payment date (YYYY-MM-DD)"),
        account: z.string().min(1).describe("Bank account code, from list_bank_accounts"),
        amount: z.number().int().describe(`Amount paid. ${ORE}`),
        fee: z.number().int().optional().describe(`Bank fee. ${ORE}`),
      }),
      annotations: { destructiveHint: true, readOnlyHint: false },
    },
    counted(ctx, "register_payment", async ({ companySlug: slug, saleId, purchaseId, ...payment }) => {
      if ((saleId === undefined) === (purchaseId === undefined)) return toolText("Give exactly one of saleId and purchaseId.");
      return withCompany(ctx, slug, async () => {
        const target = saleId !== undefined ? `sales/${saleId}` : `purchases/${purchaseId}`;
        const { id } = await ctx.fiken.create(`/companies/${slug}/${target}/payments`, defined(payment));
        return toolJson(saleId !== undefined ? { paymentId: id, saleId } : { paymentId: id, purchaseId });
      });
    }),
  );
}
