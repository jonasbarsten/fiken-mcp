import { z } from "zod";
import { defineOperation, type Operation } from "../operations.js";
import { toolJson } from "../context.js";
import { companySlug, CONFIRM, defined, isoDate, paged, paging, withCompany } from "./common.js";

const ACTIVITY_ID_SOURCES = "from list_activities (via fiken_read)";
const TIME_USER_ID_SOURCES = "from list_time_users (via fiken_read)";
const TIME_ENTRY_ID_SOURCES = "from list_time_entries (via fiken_read); create_time_entry (via fiken_write) returns one";
const HH_MM = z.string().regex(/^\d{2}:\d{2}$/);

interface FikenTimeUser {
  timeUserId: number;
  name?: string;
  email?: string;
}

interface FikenActivity {
  activityId: number;
  name?: string;
  description?: string;
  billable?: boolean;
  hourlyRate?: number;
  archived?: boolean;
  product?: { productId: number };
  project?: { projectId: number };
}

interface FikenTimeEntry {
  timeEntryId: number;
  date: string;
  hours: number;
  description?: string;
  internalNote?: string;
  startTime?: string;
  endTime?: string;
  invoiced?: boolean;
  invoiceId?: number;
  locked?: boolean;
  activity?: { activityId: number; name?: string };
  project?: { projectId: number };
  timeUser?: { timeUserId: number; name?: string };
}

export const timeOperations: Operation[] = [
  defineOperation({
    name: "list_time_users",
    concept: "time_tracking",
    kind: "read",
    destructive: false,
    title: "List time users",
    description: "The people who log hours in Fiken; timeUserId is what create_time_entry (via fiken_write) needs.",
    input: z.object({ companySlug, ...paging, name: z.string().min(1).optional(), email: z.string().min(1).optional() }),
    async run(ctx, { companySlug: slug, page, pageSize, name, email }) {
      return withCompany(ctx, slug, async () => {
        const { items, total } = await ctx.fiken.list<FikenTimeUser>(`/companies/${slug}/timeUsers`, { page, pageSize, name, email });
        return paged(items.map((u) => ({ timeUserId: u.timeUserId, name: u.name, email: u.email })), total, page, pageSize);
      });
    },
  }),

  defineOperation({
    name: "list_activities",
    concept: "time_tracking",
    kind: "read",
    destructive: false,
    title: "List activities",
    description: "The activities hours are logged on; activityId is what create_time_entry (via fiken_write) needs. hourlyRate is in øre.",
    input: z.object({ companySlug, ...paging }),
    async run(ctx, { companySlug: slug, page, pageSize }) {
      return withCompany(ctx, slug, async () => {
        const { items, total } = await ctx.fiken.list<FikenActivity>(`/companies/${slug}/activities`, { page, pageSize });
        const trimmed = items.map((a) => ({
          activityId: a.activityId,
          name: a.name,
          description: a.description,
          billable: a.billable,
          hourlyRate: a.hourlyRate,
          archived: a.archived,
          productId: a.product?.productId,
          projectId: a.project?.projectId,
        }));
        return paged(trimmed, total, page, pageSize);
      });
    },
  }),

  defineOperation({
    name: "list_time_entries",
    concept: "time_tracking",
    kind: "read",
    destructive: false,
    title: "List time entries",
    description: "Logged hours, with who worked on which activity and project, and whether they are invoiced (invoiced, invoiceId).",
    input: z.object({
      companySlug,
      ...paging,
      dateGe: isoDate.optional().describe("Only entries on or after this date (YYYY-MM-DD)"),
      dateLe: isoDate.optional().describe("Only entries on or before this date (YYYY-MM-DD)"),
      projectId: z.number().int().optional().describe("Project id, from list_projects"),
      activityId: z.number().int().optional().describe(`Activity id, ${ACTIVITY_ID_SOURCES}`),
      timeUserId: z.number().int().optional().describe(`Time user id, ${TIME_USER_ID_SOURCES}`),
      invoiced: z.boolean().optional().describe("true for entries already invoiced, false for those still to invoice"),
    }),
    async run(ctx, { companySlug: slug, page, pageSize, ...filters }) {
      return withCompany(ctx, slug, async () => {
        const { items, total } = await ctx.fiken.list<FikenTimeEntry>(`/companies/${slug}/timeEntries`, { page, pageSize, ...filters });
        const trimmed = items.map((e) => ({
          timeEntryId: e.timeEntryId,
          date: e.date,
          hours: e.hours,
          description: e.description,
          internalNote: e.internalNote,
          startTime: e.startTime,
          endTime: e.endTime,
          invoiced: e.invoiced,
          invoiceId: e.invoiceId,
          locked: e.locked,
          activityId: e.activity?.activityId,
          activityName: e.activity?.name,
          projectId: e.project?.projectId,
          timeUserId: e.timeUser?.timeUserId,
          timeUserName: e.timeUser?.name,
        }));
        return paged(trimmed, total, page, pageSize);
      });
    },
  }),

  defineOperation({
    name: "create_time_entry",
    concept: "time_tracking",
    kind: "write",
    destructive: true,
    title: "Create time entry",
    description: `Log hours on an activity for a time user. description is visible on invoices, internalNote is not. ${CONFIRM}`,
    input: z.object({
      companySlug,
      date: isoDate.describe("Date worked (YYYY-MM-DD)"),
      hours: z.number().positive().describe("Hours worked, e.g. 7.5"),
      activityId: z.number().int().describe(`Activity id, ${ACTIVITY_ID_SOURCES}`),
      timeUserId: z.number().int().describe(`Time user id, ${TIME_USER_ID_SOURCES}`),
      projectId: z.number().int().optional().describe("Project id, from list_projects"),
      description: z.string().optional(),
      startTime: HH_MM.optional().describe("Start time (HH:mm)"),
      internalNote: z.string().optional(),
    }),
    async run(ctx, { companySlug: slug, ...entry }) {
      return withCompany(ctx, slug, async () => {
        const { id } = await ctx.fiken.create(`/companies/${slug}/timeEntries`, defined(entry));
        return toolJson({ timeEntryId: id });
      });
    },
  }),

  defineOperation({
    name: "create_invoice_draft_from_time_entries",
    concept: "time_tracking",
    kind: "write",
    destructive: false,
    title: "Create invoice draft from time entries",
    description:
      "Create an invoice draft from time entries that are not yet invoiced; create_invoice_from_draft (via fiken_write) issues it. " +
      "The entries' hours become the draft's lines. groupBy activity makes one line per activity, activityAndPerson one line per activity and person, none one line per entry. " +
      "NOK only.",
    input: z.object({
      companySlug,
      timeEntryIds: z.array(z.number().int()).min(1).describe(`Time entry ids, ${TIME_ENTRY_ID_SOURCES}`),
      customerId: z.number().int().describe("Customer contact id, from search_contacts"),
      daysUntilDueDate: z.number().int().min(0).describe("Days from the issue date until the invoice is due"),
      bankAccountNumber: z.string().min(1).describe("The bank account number, bankAccountNumber from list_bank_accounts (not the 1920:... code)"),
      groupBy: z.enum(["activity", "activityAndPerson", "none"]).default("activity"),
      includeTimeEntryDescriptions: z.boolean().default(false).describe("Put each entry's description in its invoice line"),
      currency: z.literal("NOK").default("NOK"),
      issueDate: isoDate.optional().describe("Issue date (YYYY-MM-DD); today when omitted"),
      projectId: z.number().int().optional().describe("Project id, from list_projects; taken from the entries when they share one"),
      invoiceText: z.string().optional().describe("Free text printed above the lines"),
      yourReference: z.string().optional(),
      ourReference: z.string().optional(),
    }),
    async run(ctx, { companySlug: slug, ...body }) {
      return withCompany(ctx, slug, async () => {
        const { id } = await ctx.fiken.create(`/companies/${slug}/timeEntries/createInvoiceDraft`, defined(body));
        return toolJson({ draftId: id });
      });
    },
  }),
];
