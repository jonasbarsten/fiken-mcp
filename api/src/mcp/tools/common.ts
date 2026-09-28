import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { FikenError } from "../../fiken/client.js";
import { noteFikenError, toolError, toolJson, type ToolContext } from "../server.js";

export const companySlug = z.string().min(1).describe("Company slug, from list_companies");
export const paging = {
  page: z.number().int().min(0).default(0).describe("0-based page number"),
  pageSize: z.number().int().min(1).max(100).default(25),
};
export const CONFIRM = "Consequential: before calling, restate the exact action with every value to the user and get explicit confirmation.";
export const ORE = "Amounts are integers in øre (10000 = 100,00 kr).";

export function paged<T>(items: T[], total: number | undefined, page: number, pageSize: number): CallToolResult {
  return toolJson({ items, total, page, pageSize });
}

/** Runs a company-scoped call; on a Fiken 404 the error names the slugs the user does have. */
export async function withCompany(ctx: ToolContext, slug: string, fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    noteFikenError(ctx, err);
    if (err instanceof FikenError && err.status === 404) {
      try {
        const companies = await ctx.fiken.json<Array<{ slug: string }>>("/companies");
        const base = toolError(err);
        const text = `${(base.content[0] as { text: string }).text}\nCompany "${slug}" was not found. Known company slugs: ${companies.map((c) => c.slug).join(", ")}`;
        return { content: [{ type: "text", text }], isError: true };
      } catch {
        return toolError(err);
      }
    }
    return toolError(err);
  }
}
