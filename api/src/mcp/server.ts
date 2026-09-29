import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import type { Config } from "../config.js";
import { FikenError, type FikenClient } from "../fiken/client.js";
import { log } from "../log.js";
import type { UsageStore } from "../usage/store.js";
import { registerAccounts } from "./tools/accounts.js";
import { registerCompanies } from "./tools/companies.js";
import { registerContacts } from "./tools/contacts.js";
import { registerCreditNotes } from "./tools/credit-notes.js";
import { registerInbox } from "./tools/inbox.js";
import { registerInvoices } from "./tools/invoices.js";
import { registerLedger } from "./tools/ledger.js";
import { registerPayments } from "./tools/payments.js";
import { registerProducts } from "./tools/products.js";
import { registerProjects } from "./tools/projects.js";
import { registerPurchases } from "./tools/purchases.js";
import { registerSales } from "./tools/sales.js";
import { registerUploadTools } from "./tools/upload.js";
import { registerUsage } from "./tools/usage.js";

export interface ToolContext {
  fiken: FikenClient;
  anonId: string;
  /** The caller's Fiken token, sealed into upload tickets so the widget can post without a session. */
  fikenAccessToken: string;
  /** When the caller's access token expires; an upload ticket never outlives it. */
  exp: number;
  usage: UsageStore;
  /** Per-request flag: set when a Fiken 401 is seen on a path where nothing was written, so `/mcp` can answer HTTP 401. */
  session: { fikenUnauthorized: boolean; wrote: boolean };
}

export function toolJson(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorText(err: unknown): string {
  if (err instanceof FikenError) {
    if (err.status === 401) return "Fiken rejected the login (401). Ask the user to disconnect and reconnect the Fiken connector, then retry.";
    return `Fiken responded ${err.status}: ${err.body}`;
  }
  return `Error: ${err instanceof Error ? err.message : String(err)}`;
}

export function toolError(err: unknown): CallToolResult {
  return { content: [{ type: "text", text: errorText(err) }], isError: true };
}

/**
 * Marks the request's session dead when `err` is a Fiken 401. Call only on
 * paths where nothing was written yet, since setting it makes `/mcp` answer
 * HTTP 401 and the client re-sends the same tools/call.
 */
export function noteFikenError(ctx: ToolContext, err: unknown): void {
  // After a write, a 401 must stay a tool error because the client would re-send the call.
  if (err instanceof FikenError && err.status === 401 && !ctx.session.wrote) ctx.session.fikenUnauthorized = true;
}

/**
 * Wraps a tool handler so every call is counted after it runs: a thrown error
 * becomes `toolError(err)`, then the outcome is recorded against the caller's
 * anonymous id. A usage-store failure is logged and never changes the result
 * or fails the tool.
 */
export function counted<A>(
  ctx: ToolContext,
  name: string,
  handler: (args: A, extra: unknown) => Promise<CallToolResult>,
): (args: A, extra: unknown) => Promise<CallToolResult> {
  return async (args, extra) => {
    let result: CallToolResult;
    try {
      result = await handler(args, extra);
    } catch (err) {
      noteFikenError(ctx, err);
      result = toolError(err);
    }
    try {
      await ctx.usage.recordCall(ctx.anonId, name, result.isError !== true);
    } catch {
      log("usage_failed", { tool: name });
    }
    return result;
  };
}

export function registerAllTools(server: McpServer, ctx: ToolContext): void {
  registerCompanies(server, ctx);
  registerProjects(server, ctx);
  registerAccounts(server, ctx);
  registerContacts(server, ctx);
  registerPurchases(server, ctx);
  registerInbox(server, ctx);
  registerSales(server, ctx);
  registerInvoices(server, ctx);
  registerCreditNotes(server, ctx);
  registerPayments(server, ctx);
  registerProducts(server, ctx);
  registerLedger(server, ctx);
  registerUsage(server, ctx);
}

/**
 * `publicUrl` makes serverInfo advertise the connector icon at `<publicUrl>/icon.png`.
 * The upload tools need both a public URL (where the widget posts) and the config
 * (whose key ring seals the ticket), so they register only when both are given.
 */
export function createMcpServer(ctx: ToolContext, publicUrl?: string, cfg?: Config): McpServer {
  const server = new McpServer({
    name: "fiken-mcp",
    version: "0.1.0",
    ...(publicUrl ? { icons: [{ src: `${publicUrl}/icon.png`, mimeType: "image/png", sizes: ["512x512"] }] } : {}),
  });
  registerAllTools(server, ctx);
  if (publicUrl && cfg) registerUploadTools(server, ctx, publicUrl, cfg);
  return server;
}
