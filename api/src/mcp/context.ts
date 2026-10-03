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
  /**
   * Per-request state. `fikenUnauthorized` is set when a Fiken 401 is seen on a path where nothing was written
   * and `GET /user` confirms the login is dead, so `/mcp` can answer HTTP 401. `loginChecked` caches that
   * check's outcome ("unknown" when it failed for another reason), so a request makes it at most once.
   */
  session: { fikenUnauthorized: boolean; wrote: boolean; loginChecked?: "valid" | "invalid" | "unknown" };
}

export function toolJson(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

/** `loginValid`: a Fiken 401 came from one endpoint while `GET /user` confirmed the login (see `noteFikenError`). */
export function errorText(err: unknown, opts?: { loginValid?: boolean }): string {
  if (err instanceof FikenError) {
    if (err.status === 401) {
      if (opts?.loginValid) {
        return `Fiken refused this request (401) although the login is valid: ${err.body}. The company may lack the module or permission this needs.`;
      }
      return "Fiken rejected the login (401). Ask the user to disconnect and reconnect the Fiken connector, then retry.";
    }
    return `Fiken responded ${err.status}: ${err.body}`;
  }
  return `Error: ${err instanceof Error ? err.message : String(err)}`;
}

export function toolError(err: unknown, opts?: { loginValid?: boolean }): CallToolResult {
  return { content: [{ type: "text", text: errorText(err, opts) }], isError: true };
}

/**
 * On a Fiken 401 where nothing was written yet, checks the login once per request with
 * `GET /user`: only a 401 there marks the session dead (so `/mcp` answers HTTP 401 and
 * the client re-sends the same tools/call after refreshing). A 401 on one endpoint with a
 * working login, or a check that fails another way, stays a tool error. Resolves true
 * when the login was confirmed valid, so the caller can say the refusal was endpoint-specific.
 */
export async function noteFikenError(ctx: ToolContext, err: unknown): Promise<boolean> {
  // After a write, a 401 must stay a tool error because the client would re-send the call.
  if (!(err instanceof FikenError) || err.status !== 401 || ctx.session.wrote) return false;
  if (ctx.session.loginChecked === undefined) {
    try {
      await ctx.fiken.json("/user");
      ctx.session.loginChecked = "valid";
    } catch (checkErr) {
      ctx.session.loginChecked = checkErr instanceof FikenError && checkErr.status === 401 ? "invalid" : "unknown";
    }
  }
  if (ctx.session.loginChecked === "invalid") ctx.session.fikenUnauthorized = true;
  return ctx.session.loginChecked === "valid";
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
      result = toolError(err, { loginValid: await noteFikenError(ctx, err) });
    }
    try {
      await ctx.usage.recordCall(ctx.anonId, name, result.isError !== true);
    } catch {
      log("usage_failed", { tool: name });
    }
    return result;
  };
}
