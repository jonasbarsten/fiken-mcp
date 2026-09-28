import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { toolJson, type ToolContext } from "../server.js";
import { companySlug, paged, paging, withCompany } from "./common.js";

interface FikenContact {
  contactId: number;
  name: string;
  organizationNumber?: string;
  email?: string;
  supplier: boolean;
  customer: boolean;
  supplierNumber?: number;
  customerNumber?: number;
  inactive?: boolean;
}

export function registerContacts(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "search_contacts",
    {
      title: "Search contacts",
      description:
        "Find suppliers or customers. Fiken matches name, organizationNumber and email exactly (case-insensitive), not by substring; " +
        "try the exact name printed on the receipt and create_contact when nothing matches.",
      inputSchema: z.object({
        companySlug,
        ...paging,
        name: z.string().optional().describe("Exact contact name to match"),
        organizationNumber: z.string().optional().describe("Exact Norwegian organization number to match"),
        email: z.string().optional().describe("Exact email address to match"),
        supplier: z.boolean().optional().describe("Filter to contacts that are suppliers"),
        customer: z.boolean().optional().describe("Filter to contacts that are customers"),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ companySlug: slug, page, pageSize, name, organizationNumber, email, supplier, customer }) => {
      return withCompany(ctx, slug, async () => {
        const { items, total } = await ctx.fiken.list<FikenContact>(`/companies/${slug}/contacts`, {
          page,
          pageSize,
          name,
          organizationNumber,
          email,
          supplier,
          customer,
        });
        return paged(
          items.map((c) => ({
            contactId: c.contactId,
            name: c.name,
            organizationNumber: c.organizationNumber,
            email: c.email,
            supplier: c.supplier,
            customer: c.customer,
            supplierNumber: c.supplierNumber,
            customerNumber: c.customerNumber,
            inactive: c.inactive,
          })),
          total,
          page,
          pageSize,
        );
      });
    },
  );

  server.registerTool(
    "get_contact",
    {
      title: "Get contact",
      description: "A single contact by id, with the full detail Fiken holds for it (address, contact person, bank account) minus notes and documents.",
      inputSchema: z.object({ companySlug, contactId: z.number().int().describe("Contact id, from search_contacts") }),
      annotations: { readOnlyHint: true },
    },
    async ({ companySlug: slug, contactId }) => {
      return withCompany(ctx, slug, async () => {
        const contact = await ctx.fiken.json<Record<string, unknown>>(`/companies/${slug}/contacts/${contactId}`);
        const { notes: _notes, documents: _documents, ...rest } = contact;
        return toolJson(rest);
      });
    },
  );
}
