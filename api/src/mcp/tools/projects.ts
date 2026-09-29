import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ToolContext } from "../server.js";
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

export function registerProjects(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description:
        "Projects (prosjekter) of the company; use projectId when booking a purchase on a project. Filter by completed or name.",
      inputSchema: z.object({
        companySlug,
        ...paging,
        completed: z.boolean().optional().describe("Filter to completed (or not completed) projects"),
        name: z.string().optional().describe("Filter by project name"),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ companySlug: slug, page, pageSize, completed, name }) => {
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
  );
}
