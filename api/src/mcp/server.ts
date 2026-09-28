import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import type { Config } from "../config.js";
import { FikenError, type FikenClient } from "../fiken/client.js";
import { registerAccounts } from "./tools/accounts.js";
import { registerCompanies } from "./tools/companies.js";
import { registerContacts } from "./tools/contacts.js";
import { registerInbox } from "./tools/inbox.js";
import { registerProjects } from "./tools/projects.js";
import { registerPurchases } from "./tools/purchases.js";
import { registerUploadTools } from "./tools/upload.js";

export interface ToolContext {
  fiken: FikenClient;
  anonId: string;
  /** The caller's Fiken token, sealed into upload tickets so the widget can post without a session. */
  fikenAccessToken: string;
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

export function registerAllTools(server: McpServer, ctx: ToolContext): void {
  registerCompanies(server, ctx);
  registerProjects(server, ctx);
  registerAccounts(server, ctx);
  registerContacts(server, ctx);
  registerPurchases(server, ctx);
  registerInbox(server, ctx);
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
