import { McpServer } from "@modelcontextprotocol/server";
import type { Config } from "../config.js";
import type { ToolContext } from "./context.js";
import { registerGateway } from "./gateway.js";
import { type Operation, registerOperationTool } from "./operations.js";
import { type ConnectorOptions, visibleOperations } from "./options.js";
import { SERVER_INSTRUCTIONS } from "./tools/help.js";
import { registerUploadTools } from "./tools/upload.js";

/** Operations that stay real tools: the receipts flow on a phone needs them without an explore round trip. */
export const HOT_PATH = ["list_companies", "list_projects", "list_accounts", "list_bank_accounts", "search_contacts", "list_inbox", "create_purchase"] as const;

const HOT = new Set<string>(HOT_PATH);

/** Registers the visible hot-path operations as real tools and the gateway over everything visible. */
function registerAllTools(server: McpServer, ctx: ToolContext, visible: readonly Operation[]): void {
  for (const op of visible) if (HOT.has(op.name)) registerOperationTool(server, ctx, op);
  registerGateway(server, ctx, visible);
}

/**
 * `publicUrl` makes serverInfo advertise the connector icon at `<publicUrl>/icon.png`.
 * The upload tools need both a public URL (where the widget posts) and the config
 * (whose key ring seals the ticket), so they register only when both are given, and
 * only when the connection may write and sees purchases.
 */
export function createMcpServer(ctx: ToolContext, publicUrl?: string, cfg?: Config, options: ConnectorOptions = { readOnly: false }): McpServer {
  const server = new McpServer(
    {
      name: "fiken-mcp",
      version: "0.1.0",
      ...(publicUrl ? { icons: [{ src: `${publicUrl}/icon.png`, mimeType: "image/png", sizes: ["512x512"] }] } : {}),
    },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerAllTools(server, ctx, visibleOperations(options));
  // The upload tools tell the model to book with create_purchase, so they need purchases and writes.
  const uploads = !options.readOnly && (!options.concepts || options.concepts.has("purchases"));
  if (publicUrl && cfg && uploads) registerUploadTools(server, ctx, publicUrl, cfg);
  return server;
}
