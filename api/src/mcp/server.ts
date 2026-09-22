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

export function toolError(err: unknown): CallToolResult {
  const text = err instanceof FikenError ? `Fiken responded ${err.status}: ${err.body}` : `Error: ${err instanceof Error ? err.message : String(err)}`;
  return { content: [{ type: "text", text }], isError: true };
}

export function createMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: "fiken-mcp", version: "0.1.0" });
  registerCompanies(server, ctx);
  return server;
}
