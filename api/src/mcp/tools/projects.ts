import { z } from "zod";
import { defineOperation, type Operation } from "../operations.js";
import { toolJson } from "../context.js";
import { companySlug, CONFIRM, defined, isoDate, paged, paging, readBackFailed, toolText, withCompany } from "./common.js";

interface FikenProject {
  projectId: number;
  number: string;
  name: string;
  description?: string;
  completed: boolean;
  startDate?: string;
  endDate?: string;
  contact?: { contactId: number; name: string };
}

const projectIdInput = z.number().int().describe("Project id, from list_projects");

function trimProject(p: FikenProject) {
  return {
    projectId: p.projectId,
    number: p.number,
    name: p.name,
    description: p.description,
    completed: p.completed,
    startDate: p.startDate,
    endDate: p.endDate,
    contact: p.contact ? { contactId: p.contact.contactId, name: p.contact.name } : undefined,
  };
}

const projectReadBackFailed = (slug: string, id: number, did: string, err: unknown) =>
  readBackFailed(`Project ${id}`, did, err, "get_project", { companySlug: slug, projectId: id });

export const projectsOperations: Operation[] = [
  defineOperation({
    name: "list_projects",
    concept: "projects",
    kind: "read",
    destructive: false,
    title: "List projects",
    description:
      "Projects (prosjekter) of the company; use projectId when booking a purchase on a project. Filter by completed or name.",
    input: z.object({
      companySlug,
      ...paging,
      completed: z.boolean().optional().describe("Filter to completed (or not completed) projects"),
      name: z.string().optional().describe("Filter by project name"),
    }),
    async run(ctx, { companySlug: slug, page, pageSize, completed, name }) {
      return withCompany(ctx, slug, async () => {
        const { items, total } = await ctx.fiken.list<FikenProject>(`/companies/${slug}/projects`, { page, pageSize, completed, name });
        return paged(
          items.map((p) => ({
            projectId: p.projectId,
            number: p.number,
            name: p.name,
            description: p.description,
            completed: p.completed,
            startDate: p.startDate,
            endDate: p.endDate,
          })),
          total,
          page,
          pageSize,
        );
      });
    },
  }),

  defineOperation({
    name: "get_project",
    concept: "projects",
    kind: "read",
    destructive: false,
    title: "Get project",
    description: "A single project by id, with its customer contact if it has one.",
    input: z.object({ companySlug, projectId: projectIdInput }),
    async run(ctx, { companySlug: slug, projectId }) {
      return withCompany(ctx, slug, async () => toolJson(trimProject(await ctx.fiken.json<FikenProject>(`/companies/${slug}/projects/${projectId}`))));
    },
  }),

  defineOperation({
    name: "create_project",
    concept: "projects",
    kind: "write",
    destructive: true,
    title: "Create project",
    description: `Create a project (prosjekt). number is the project's own number and must be unique. ${CONFIRM}`,
    input: z.object({
      companySlug,
      number: z.string().min(1).describe("Project number"),
      name: z.string().min(1),
      startDate: isoDate.describe("Start date (YYYY-MM-DD)"),
      description: z.string().optional(),
      endDate: isoDate.optional().describe("End date (YYYY-MM-DD), inclusive"),
      contactId: z.number().int().optional().describe("Customer contact id, from search_contacts"),
      completed: z.boolean().optional(),
    }),
    async run(ctx, { companySlug: slug, ...fields }) {
      return withCompany(ctx, slug, async () => {
        const { id } = await ctx.fiken.create(`/companies/${slug}/projects`, defined(fields));
        try {
          return toolJson(trimProject(await ctx.fiken.json<FikenProject>(`/companies/${slug}/projects/${id}`)));
        } catch (err) {
          return projectReadBackFailed(slug, id, "created", err);
        }
      });
    },
  }),

  defineOperation({
    name: "update_project",
    concept: "projects",
    kind: "write",
    destructive: true,
    title: "Update project",
    description: `Change a project. Only the fields you give change; at least one is required. ${CONFIRM}`,
    input: z.object({
      companySlug,
      projectId: projectIdInput,
      name: z.string().min(1).optional(),
      description: z.string().optional(),
      startDate: isoDate.optional().describe("Start date (YYYY-MM-DD)"),
      endDate: isoDate.optional().describe("End date (YYYY-MM-DD), inclusive"),
      contactId: z.number().int().optional().describe("Customer contact id, from search_contacts"),
      completed: z.boolean().optional(),
    }),
    async run(ctx, { companySlug: slug, projectId, ...fields }) {
      const body = defined(fields);
      if (Object.keys(body).length === 0) return toolText("Give at least one field to change: name, description, startDate, endDate, contactId or completed.");
      return withCompany(ctx, slug, async () => {
        await ctx.fiken.patch(`/companies/${slug}/projects/${projectId}`, body);
        try {
          return toolJson(trimProject(await ctx.fiken.json<FikenProject>(`/companies/${slug}/projects/${projectId}`)));
        } catch (err) {
          return projectReadBackFailed(slug, projectId, "updated", err);
        }
      });
    },
  }),
];
