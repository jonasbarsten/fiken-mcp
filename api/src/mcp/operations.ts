import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import type { z } from "zod";
import { counted, type ToolContext } from "./context.js";

export const CONCEPTS = {
  companies: "Companies the user can access, and their slugs",
  contacts: "Customers and suppliers",
  projects: "Projects that purchases and invoices can be booked on",
  accounts: "Chart of accounts, bank accounts and balances",
  ledger: "Journal entries",
  purchases: "Purchases (bilag) and their receipts",
  sales: "Sales, including invoiced ones",
  invoices: "Invoices and invoice drafts: create, issue, send",
  credit_notes: "Credit notes on issued invoices",
  payments: "Payments on sales and purchases",
  products: "Products and services the company sells",
  inbox: "The company's document inbox",
  attachments: "Files attached to purchases, sales, invoices and journal entries",
  usage: "Your own usage counters on this server",
} as const;
export type Concept = keyof typeof CONCEPTS;

export interface Operation<S extends z.ZodObject = z.ZodObject> {
  name: string;
  concept: Concept;
  kind: "read" | "write";
  /** False for reads and for writes that only prepare something (drafts). */
  destructive: boolean;
  title: string;
  description: string;
  input: S;
  run(ctx: ToolContext, args: z.output<S>): Promise<CallToolResult>;
}

/**
 * Types `run` from the operation's own schema. The result widens to `Operation`
 * without a cast because `run` is declared with method syntax, whose parameters
 * TypeScript checks bivariantly.
 */
export function defineOperation<S extends z.ZodObject>(op: Operation<S>): Operation {
  return op;
}

/**
 * Registers an operation as a real MCP tool, counted under its own name. The input is strict, as
 * through the gateway, so a mistyped key is refused instead of silently dropped.
 */
export function registerOperationTool(server: McpServer, ctx: ToolContext, op: Operation): void {
  server.registerTool(
    op.name,
    {
      title: op.title,
      description: op.description,
      inputSchema: op.input.strict(),
      annotations: op.kind === "read" ? { readOnlyHint: true } : { readOnlyHint: false, destructiveHint: op.destructive },
    },
    counted(ctx, op.name, (args) => op.run(ctx, args as never)),
  );
}
