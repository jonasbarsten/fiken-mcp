import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { FikenError, type FikenClient } from "../fiken/client.js";
import { registerCompanies } from "./tools/companies.js";

export interface ToolContext {
  fiken: FikenClient;
  anonId: string;
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

/** `publicUrl` makes serverInfo advertise the connector icon at `<publicUrl>/icon.png`. */
export function createMcpServer(ctx: ToolContext, publicUrl?: string): McpServer {
  const server = new McpServer({
    name: "fiken-mcp",
    version: "0.1.0",
    ...(publicUrl ? { icons: [{ src: `${publicUrl}/icon.png`, mimeType: "image/png", sizes: ["512x512"] }] } : {}),
  });
  registerCompanies(server, ctx);
  return server;
}
