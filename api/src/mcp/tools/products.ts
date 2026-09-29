import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { counted, type ToolContext } from "../server.js";
import { companySlug, ORE, paged, paging, withCompany } from "./common.js";

interface FikenProduct {
  productId: number;
  name: string;
  productNumber?: string;
  unitPrice?: number;
  incomeAccount?: string;
  vatType?: string;
  active: boolean;
}

export function registerProducts(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "list_products",
    {
      title: "List products",
      description: `Products and services the company sells; productId goes on an invoice line and supplies its price, VAT type and income account. ${ORE}`,
      inputSchema: z.object({
        companySlug,
        ...paging,
        name: z.string().optional().describe("Only products with this name"),
        active: z.boolean().optional().describe("Filter to active (or inactive) products"),
      }),
      annotations: { readOnlyHint: true },
    },
    counted(ctx, "list_products", async ({ companySlug: slug, page, pageSize, name, active }) => {
      return withCompany(ctx, slug, async () => {
        const { items, total } = await ctx.fiken.list<FikenProduct>(`/companies/${slug}/products`, { page, pageSize, name, active });
        return paged(
          items.map((p) => ({
            productId: p.productId,
            name: p.name,
            productNumber: p.productNumber,
            unitPrice: p.unitPrice,
            incomeAccount: p.incomeAccount,
            vatType: p.vatType,
            active: p.active,
          })),
          total,
          page,
          pageSize,
        );
      });
    }),
  );
}
