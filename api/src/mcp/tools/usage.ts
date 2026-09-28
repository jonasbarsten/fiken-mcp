import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { counted, toolJson, type ToolContext } from "../server.js";

export function registerUsage(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "my_usage",
    {
      title: "My usage",
      description:
        "Your own pseudonymous monthly call counts on this server: total calls, errors, and a breakdown by tool, for the last " +
        "24 months. anonId is a stable pseudonym derived from your Fiken login; nothing else about you or your accounting data " +
        "is stored. The same counters, summed across every user, are published publicly at GET /stats.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    counted(ctx, "my_usage", async () => {
      const months = await ctx.usage.userMonths(ctx.anonId);
      return toolJson({ anonId: ctx.anonId, months });
    }),
  );
}
