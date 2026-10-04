import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { FikenQueue, createFikenClient } from "../../src/fiken/client.js";
import { createHelpClient } from "../../src/help/client.js";
import { z } from "zod";
import type { ToolContext } from "../../src/mcp/context.js";
import type { Operation } from "../../src/mcp/operations.js";
import type { ConnectorOptions } from "../../src/mcp/options.js";
import { getOperation } from "../../src/mcp/registry.js";
import { HOT_PATH, createMcpServer } from "../../src/mcp/server.js";
import { memoryUsageStore } from "../../src/usage/memory.js";
import type { UsageStore } from "../../src/usage/store.js";

type Route = { match: RegExp; status?: number; body?: unknown; headers?: Record<string, string> };

/** A Fiken that answers by URL pattern and records every request. */
export function fakeFiken(routes: Route[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    const r = routes.find((x) => x.match.test(url));
    if (!r) return new Response(`unexpected ${url}`, { status: 500 });
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json", ...(r.headers ?? {}) },
    });
  };
  return { fetchImpl, calls };
}

/** A session that expires in an hour, so an upload ticket gets its full 15 minutes. */
export const farFutureExp = () => Math.floor(Date.now() / 1000) + 3600;

export async function connected(
  fetchImpl: typeof fetch,
  opts?: { usage?: UsageStore; session?: ToolContext["session"]; options?: ConnectorOptions; helpFetch?: typeof fetch },
) {
  const session: ToolContext["session"] = opts?.session ?? { fikenUnauthorized: false, wrote: false };
  const fiken = createFikenClient({ baseUrl: "https://api.test/v2", fileBaseUrl: "https://files.test/v2", accessToken: "tok", fetch: fetchImpl, queue: new FikenQueue(0), onWrite: () => { session.wrote = true; } });
  const server = createMcpServer({
    fiken,
    anonId: "anon",
    fikenAccessToken: "tok",
    exp: farFutureExp(),
    usage: opts?.usage ?? memoryUsageStore(),
    session,
    help: createHelpClient({ fetch: opts?.helpFetch ?? (async () => new Response("", { status: 404 })) }),
  }, undefined, undefined, opts?.options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
  return client;
}

/** An operation's description and every description in its input schema: all the text a model reads about it. */
export function operationTexts(op: Operation): string[] {
  const texts = [op.description];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        if (key === "description" && typeof value === "string") texts.push(value);
        else walk(value);
      }
    }
  };
  walk(z.toJSONSchema(op.input, { io: "input" }));
  return texts;
}

/** Every operation name in `text`, as a whole word (create_invoice does not match inside create_invoice_draft). */
export function mentionedOperations(text: string, names: readonly string[]): Array<{ name: string; index: number }> {
  return names.flatMap((name) =>
    [...text.matchAll(new RegExp(`(?<![a-z_])${name}(?![a-z_])`, "g"))].map((m) => ({ name, index: m.index })),
  );
}

const REAL_TOOLS = new Set<string>([...HOT_PATH, "fiken_explore", "fiken_read", "fiken_write", "upload_receipts", "get_upload_url"]);

/** Calls `name` directly when it is a real tool, otherwise through fiken_read or fiken_write. */
export async function callJson(client: Client, name: string, args: Record<string, unknown>) {
  const gateway = getOperation(name)?.kind === "write" ? "fiken_write" : "fiken_read";
  const result = REAL_TOOLS.has(name)
    ? await client.callTool({ name, arguments: args })
    : await client.callTool({ name: gateway, arguments: { operation: name, args } });
  const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
  return { isError: result.isError === true, text, json: () => JSON.parse(text) as unknown };
}
