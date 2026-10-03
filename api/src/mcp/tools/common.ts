import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { FikenError } from "../../fiken/client.js";
import { errorText, noteFikenError, toolError, toolJson, type ToolContext } from "../context.js";

export const companySlug = z.string().min(1).describe("Company slug, from list_companies");
export const paging = {
  page: z.number().int().min(0).default(0).describe("0-based page number"),
  pageSize: z.number().int().min(1).max(100).default(25),
};
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const CONFIRM = "Consequential: before calling, restate the exact action with every value to the user and get explicit confirmation.";
export const ORE = "Amounts are integers in øre (10000 = 100,00 kr).";
/**
 * Where an invoiceId comes from; none of these is a tool of its own, so each names its gateway. The lookup
 * (a read, visible on every connection) is the "from" source; the writes that also return one follow the ";".
 */
export const INVOICE_ID_SOURCES = "from list_invoices (via fiken_read); create_invoice and create_invoice_from_draft (via fiken_write) return one";

/** The exact gateway call a recovery text asks for, e.g. `call fiken_read with {"operation":"get_invoice","args":{...}}`. */
export function gatewayCall(gateway: "fiken_read" | "fiken_write", operation: string, args: Record<string, unknown>): string {
  return `call ${gateway} with ${JSON.stringify({ operation, args })}`;
}

/** A tool error result carrying `text`. */
export function toolText(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** Drops keys whose value is undefined so Fiken only sees what the caller gave. */
export function defined(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
}

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
        const line = companies.some((c) => c.slug === slug)
          ? "The company exists; check the id you passed."
          : `Company "${slug}" was not found. Known company slugs: ${companies.map((c) => c.slug).join(", ")}`;
        return toolText(`${errorText(err)}\n${line}`);
      } catch (innerErr) {
        noteFikenError(ctx, innerErr);
        return toolError(err);
      }
    }
    return toolError(err);
  }
}
