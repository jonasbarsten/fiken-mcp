import { z } from "zod";
import { defineOperation, type Operation } from "../operations.js";
import { toolJson } from "../context.js";
import { companySlug, CONFIRM, paged, paging, withCompany } from "./common.js";

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

interface FikenContactDetail extends FikenContact {
  phoneNumber?: string;
  address?: {
    streetAddress?: string;
    streetAddressLine2?: string;
    city?: string;
    postCode?: string;
    country?: string;
  };
  bankAccountNumber?: string;
  currency?: string;
}

export const contactsOperations: Operation[] = [
  defineOperation({
    name: "search_contacts",
    concept: "contacts",
    kind: "read",
    destructive: false,
    title: "Search contacts",
    description:
      "Find suppliers or customers. Fiken matches name, organizationNumber and email exactly (case-insensitive), not by substring; " +
      "try the exact name printed on the receipt and create_contact when nothing matches.",
    input: z.object({
      companySlug,
      ...paging,
      name: z.string().optional().describe("Exact contact name to match"),
      organizationNumber: z.string().optional().describe("Exact Norwegian organization number to match"),
      email: z.string().optional().describe("Exact email address to match"),
      supplier: z.boolean().optional().describe("Filter to contacts that are suppliers"),
      customer: z.boolean().optional().describe("Filter to contacts that are customers"),
    }),
    async run(ctx, { companySlug: slug, page, pageSize, name, organizationNumber, email, supplier, customer }) {
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
  }),

  defineOperation({
    name: "get_contact",
    concept: "contacts",
    kind: "read",
    destructive: false,
    title: "Get contact",
    description: "A single contact by id, with the full detail Fiken holds for it (address, contact person, bank account) minus notes and documents.",
    input: z.object({ companySlug, contactId: z.number().int().describe("Contact id, from search_contacts") }),
    async run(ctx, { companySlug: slug, contactId }) {
      return withCompany(ctx, slug, async () => {
        const contact = await ctx.fiken.json<FikenContactDetail>(`/companies/${slug}/contacts/${contactId}`);
        return toolJson({
          contactId: contact.contactId,
          name: contact.name,
          email: contact.email,
          phoneNumber: contact.phoneNumber,
          organizationNumber: contact.organizationNumber,
          supplier: contact.supplier,
          customer: contact.customer,
          supplierNumber: contact.supplierNumber,
          customerNumber: contact.customerNumber,
          inactive: contact.inactive,
          address: contact.address
            ? {
                streetAddress: contact.address.streetAddress,
                streetAddressLine2: contact.address.streetAddressLine2,
                city: contact.address.city,
                postCode: contact.address.postCode,
                country: contact.address.country,
              }
            : undefined,
          bankAccountNumber: contact.bankAccountNumber,
          currency: contact.currency,
        });
      });
    },
  }),

  defineOperation({
    name: "create_contact",
    concept: "contacts",
    kind: "write",
    destructive: false,
    title: "Create contact",
    description: `Create a new supplier or customer contact in Fiken. ${CONFIRM}`,
    input: z.object({
      companySlug,
      name: z.string().min(1).describe("Contact name"),
      organizationNumber: z.string().optional().describe("Norwegian organization number"),
      email: z.string().optional().describe("Email address"),
      phoneNumber: z.string().optional().describe("Phone number"),
      supplier: z.boolean().default(true).describe("Whether this contact is a supplier"),
      customer: z.boolean().default(false).describe("Whether this contact is a customer"),
    }),
    async run(ctx, { companySlug: slug, name, organizationNumber, email, phoneNumber, supplier, customer }) {
      return withCompany(ctx, slug, async () => {
        const body: Record<string, unknown> = { name };
        if (organizationNumber !== undefined) body.organizationNumber = organizationNumber;
        if (email !== undefined) body.email = email;
        if (phoneNumber !== undefined) body.phoneNumber = phoneNumber;
        body.supplier = supplier;
        body.customer = customer;
        const { id } = await ctx.fiken.create(`/companies/${slug}/contacts`, body);
        return toolJson({ contactId: id });
      });
    },
  }),
];
