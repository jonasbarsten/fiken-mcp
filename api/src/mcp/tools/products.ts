import { z } from "zod";
import { defineOperation, type Operation } from "../operations.js";
import { toolJson } from "../context.js";
import { companySlug, CONFIRM, defined, ORE, paged, paging, readBackFailed, toolText, withCompany } from "./common.js";

interface FikenProduct {
  productId: number;
  createdDate?: string;
  lastModifiedDate?: string;
  name: string;
  productNumber?: string;
  unitPrice?: number;
  incomeAccount?: string;
  vatType?: string;
  active: boolean;
  note?: string;
  stock?: number;
}

const productFields = {
  name: z.string().min(1),
  unitPrice: z.number().int().optional().describe(`Net unit price. ${ORE}`),
  incomeAccount: z.string().min(1).describe("Income account code, from list_accounts"),
  vatType: z.string().min(1).describe("HIGH, MEDIUM, LOW, EXEMPT, EXEMPT_IMPORT_EXPORT, EXEMPT_REVERSE, OUTSIDE or NONE"),
  productNumber: z.string().optional(),
  note: z.string().max(200).optional(),
};

function trimProduct(p: FikenProduct) {
  return {
    productId: p.productId,
    name: p.name,
    productNumber: p.productNumber,
    unitPrice: p.unitPrice,
    incomeAccount: p.incomeAccount,
    vatType: p.vatType,
    active: p.active,
  };
}

const productDetail = (p: FikenProduct) => ({ ...trimProduct(p), note: p.note, stock: p.stock });

const productReadBackFailed = (slug: string, id: number, did: string, err: unknown) =>
  readBackFailed(`Product ${id}`, did, err, "get_product", { companySlug: slug, productId: id });

export const productsOperations: Operation[] = [
  defineOperation({
    name: "list_products",
    concept: "products",
    kind: "read",
    destructive: false,
    title: "List products",
    description: `Products and services the company sells; productId goes on an invoice line and supplies its price, VAT type and income account. ${ORE}`,
    input: z.object({
      companySlug,
      ...paging,
      name: z.string().optional().describe("Only products with this name"),
      active: z.boolean().optional().describe("Filter to active (or inactive) products"),
    }),
    async run(ctx, { companySlug: slug, page, pageSize, name, active }) {
      return withCompany(ctx, slug, async () => {
        const { items, total } = await ctx.fiken.list<FikenProduct>(`/companies/${slug}/products`, { page, pageSize, name, active });
        return paged(items.map(trimProduct), total, page, pageSize);
      });
    },
  }),

  defineOperation({
    name: "get_product",
    concept: "products",
    kind: "read",
    destructive: false,
    title: "Get product",
    description: `A single product by id, with its note and stock. ${ORE}`,
    input: z.object({ companySlug, productId: z.number().int().describe("Product id, from list_products (via fiken_read)") }),
    async run(ctx, { companySlug: slug, productId }) {
      return withCompany(ctx, slug, async () => toolJson(productDetail(await ctx.fiken.json<FikenProduct>(`/companies/${slug}/products/${productId}`))));
    },
  }),

  defineOperation({
    name: "create_product",
    concept: "products",
    kind: "write",
    destructive: true,
    title: "Create product",
    description: `Create a product or service to put on invoice lines. ${ORE} ${CONFIRM}`,
    input: z.object({ companySlug, ...productFields, active: z.boolean().default(true).describe("Whether the product is in use") }),
    async run(ctx, { companySlug: slug, ...fields }) {
      return withCompany(ctx, slug, async () => {
        const { id } = await ctx.fiken.create(`/companies/${slug}/products`, defined(fields));
        try {
          return toolJson(productDetail(await ctx.fiken.json<FikenProduct>(`/companies/${slug}/products/${id}`)));
        } catch (err) {
          return productReadBackFailed(slug, id, "created", err);
        }
      });
    },
  }),

  defineOperation({
    name: "update_product",
    concept: "products",
    kind: "write",
    destructive: true,
    title: "Update product",
    description: `Change a product. Only the fields you give change, everything else stays as it is; at least one is required. ${ORE} ${CONFIRM}`,
    input: z.object({
      companySlug,
      productId: z.number().int().describe("Product id, from list_products (via fiken_read)"),
      ...z.object(productFields).partial().shape,
      active: z.boolean().optional().describe("Whether the product is in use"),
    }),
    async run(ctx, { companySlug: slug, productId, ...fields }) {
      const changes = defined(fields);
      if (Object.keys(changes).length === 0) {
        return toolText("Give at least one field to change: name, unitPrice, incomeAccount, vatType, active, productNumber or note.");
      }
      return withCompany(ctx, slug, async () => {
        const path = `/companies/${slug}/products/${productId}`;
        // Fiken's PUT replaces the whole product, so what the caller did not give is sent back unchanged.
        // Fiken has no ETag: an edit made in Fiken between this GET and the PUT is overwritten.
        const { productId: _id, createdDate: _created, lastModifiedDate: _modified, ...current } = await ctx.fiken.json<FikenProduct>(path);
        await ctx.fiken.put(path, { ...current, ...changes });
        try {
          return toolJson(productDetail(await ctx.fiken.json<FikenProduct>(path)));
        } catch (err) {
          return productReadBackFailed(slug, productId, "updated", err);
        }
      });
    },
  }),
];
