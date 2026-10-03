import { z } from "zod";
import { defineOperation, type Operation } from "../operations.js";
import { companySlug, paged, paging, withCompany } from "./common.js";

interface FikenProject {
  projectId: number;
  number: string;
  name: string;
  description?: string;
  completed: boolean;
  startDate?: string;
  endDate?: string;
}

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
];
