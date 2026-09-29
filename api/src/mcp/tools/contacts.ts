import { z } from "zod";
import { defineOperation, type Operation } from "../operations.js";
import { errorText, toolJson } from "../context.js";
import { companySlug, CONFIRM, defined, gatewayCall, paged, paging, toolText, withCompany } from "./common.js";

/** Fields Fiken computes or manages elsewhere; the contact PUT must not carry them. */
const READ_ONLY_CONTACT_FIELDS = [
  "contactId", "createdDate", "lastModifiedDate", "customerNumber", "supplierNumber", "customerAccountCode", "supplierAccountCode",
  "notes", "documents", "contactPerson",
];

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

function trimContact(contact: FikenContactDetail) {
  return {
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
  };
}

interface FikenContactPerson {
  contactPersonId: number;
  name: string;
  email: string;
  phoneNumber?: string;
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
      "try the exact name printed on the receipt and create_contact (via fiken_write) when nothing matches.",
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
        return toolJson(trimContact(await ctx.fiken.json<FikenContactDetail>(`/companies/${slug}/contacts/${contactId}`)));
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

  defineOperation({
    name: "update_contact",
    concept: "contacts",
    kind: "write",
    destructive: true,
    title: "Update contact",
    description:
      "Change a contact. Only the fields you give change, everything else Fiken holds stays as it is; at least one is required. " +
      "Address fields merge into the existing address. " +
      "Fiken does not return a contact's currency or member number, so an update may reset them; if the contact has either set, pass it again. " +
      `Contact persons are managed with add_contact_person (via fiken_write). ${CONFIRM}`,
    input: z.object({
      companySlug,
      contactId: z.number().int().describe("Contact id, from search_contacts"),
      name: z.string().min(1).optional(),
      email: z.string().optional(),
      organizationNumber: z.string().optional(),
      phoneNumber: z.string().optional(),
      customer: z.boolean().optional(),
      supplier: z.boolean().optional(),
      inactive: z.boolean().optional().describe("true deactivates the contact"),
      bankAccountNumber: z.string().optional(),
      currency: z.string().regex(/^[A-Z]{3}$/).optional().describe("ISO 4217 code, e.g. EUR: the default foreign currency for invoices to this contact"),
      memberNumberString: z.string().optional().describe("Member number"),
      daysUntilInvoicingDueDate: z.number().int().optional().describe("Default number of days until an invoice to this contact is due"),
      address: z
        .strictObject({
          streetAddress: z.string().optional(),
          streetAddressLine2: z.string().optional(),
          city: z.string().optional(),
          postCode: z.string().optional(),
          country: z.string().optional(),
        })
        .optional(),
    }),
    async run(ctx, { companySlug: slug, contactId, address, ...fields }) {
      const changes = defined(fields);
      const addressChanges = defined(address ?? {});
      if (Object.keys(changes).length === 0 && Object.keys(addressChanges).length === 0) {
        return toolText(
          "Give at least one field to change: name, email, organizationNumber, phoneNumber, customer, supplier, inactive, bankAccountNumber, currency, memberNumberString, daysUntilInvoicingDueDate or address.",
        );
      }
      return withCompany(ctx, slug, async () => {
        const path = `/companies/${slug}/contacts/${contactId}`;
        // Fiken's PUT replaces the whole contact, so what the caller did not give is sent back unchanged.
        // Fiken has no ETag: an edit made in Fiken between this GET and the PUT is overwritten.
        const current = await ctx.fiken.json<Record<string, unknown>>(path);
        const body = Object.fromEntries(Object.entries(current).filter(([key]) => !READ_ONLY_CONTACT_FIELDS.includes(key)));
        Object.assign(body, changes);
        if (Object.keys(addressChanges).length > 0) body.address = { ...(current.address as object | undefined), ...addressChanges };
        await ctx.fiken.put(path, body);
        try {
          return toolJson(trimContact(await ctx.fiken.json<FikenContactDetail>(path)));
        } catch (err) {
          return toolText(
            `Contact ${contactId} was updated; fetching it back failed: ${errorText(err)}. Do not repeat it; ` +
              `${gatewayCall("fiken_read", "get_contact", { companySlug: slug, contactId })}.`,
          );
        }
      });
    },
  }),

  defineOperation({
    name: "list_contact_persons",
    concept: "contacts",
    kind: "read",
    destructive: false,
    title: "List contact persons",
    description: "The contact persons (kontaktpersoner) of a contact.",
    input: z.object({ companySlug, contactId: z.number().int().describe("Contact id, from search_contacts") }),
    async run(ctx, { companySlug: slug, contactId }) {
      return withCompany(ctx, slug, async () => {
        const persons = await ctx.fiken.json<FikenContactPerson[]>(`/companies/${slug}/contacts/${contactId}/contactPerson`);
        return toolJson({
          items: persons.map((p) => ({ contactPersonId: p.contactPersonId, name: p.name, email: p.email, phoneNumber: p.phoneNumber })),
        });
      });
    },
  }),

  defineOperation({
    name: "add_contact_person",
    concept: "contacts",
    kind: "write",
    destructive: false,
    title: "Add contact person",
    description: `Add a contact person to a contact. Fiken requires name and email. ${CONFIRM}`,
    input: z.object({
      companySlug,
      contactId: z.number().int().describe("Contact id, from search_contacts"),
      name: z.string().min(1),
      email: z.string().min(1),
      phoneNumber: z.string().optional(),
    }),
    async run(ctx, { companySlug: slug, contactId, ...person }) {
      return withCompany(ctx, slug, async () => {
        const { id } = await ctx.fiken.create(`/companies/${slug}/contacts/${contactId}/contactPerson`, defined(person));
        return toolJson({ contactPersonId: id });
      });
    },
  }),
];
