import { McpServer } from "@modelcontextprotocol/server";
import type { Config } from "../config.js";
import type { ToolContext } from "./context.js";
import { registerGateway } from "./gateway.js";
import { registerOperationTool } from "./operations.js";
import { OPERATIONS } from "./registry.js";
import { registerUploadTools } from "./tools/upload.js";

/** Operations that stay real tools: the receipts flow on a phone needs them without an explore round trip. */
export const HOT_PATH = ["list_companies", "list_projects", "list_accounts", "list_bank_accounts", "search_contacts", "list_inbox", "create_purchase"] as const;

const HOT = new Set<string>(HOT_PATH);

export function registerAllTools(server: McpServer, ctx: ToolContext): void {
  for (const op of OPERATIONS) if (HOT.has(op.name)) registerOperationTool(server, ctx, op);
  registerGateway(server, ctx, OPERATIONS);
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
