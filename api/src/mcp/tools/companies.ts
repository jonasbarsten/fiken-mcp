import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { toolError, toolJson, type ToolContext } from "../server.js";

interface FikenCompany {
  name: string;
  slug: string;
  organizationNumber?: string;
}

export function registerCompanies(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "list_companies",
    {
      title: "List companies",
      description: "Lists the Fiken companies the logged-in user can access, with the slug every other tool needs as companySlug.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const companies = await ctx.fiken.json<FikenCompany[]>("/companies");
        return toolJson(companies.map((c) => ({ name: c.name, slug: c.slug, organizationNumber: c.organizationNumber })));
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
