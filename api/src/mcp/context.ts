import type { CallToolResult } from "@modelcontextprotocol/server";
import { FikenError, type FikenClient } from "../fiken/client.js";
import { log } from "../log.js";
import type { UsageStore } from "../usage/store.js";

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

export function errorText(err: unknown): string {
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
