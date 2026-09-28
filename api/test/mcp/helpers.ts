import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { FikenQueue, createFikenClient } from "../../src/fiken/client.js";
import { createMcpServer } from "../../src/mcp/server.js";

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

export async function connected(fetchImpl: typeof fetch) {
  const fiken = createFikenClient({ baseUrl: "https://api.test/v2", accessToken: "tok", fetch: fetchImpl, queue: new FikenQueue(0) });
  const server = createMcpServer({ fiken, anonId: "anon", fikenAccessToken: "tok" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
  return client;
}

export async function callJson(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
  return { isError: result.isError === true, text, json: () => JSON.parse(text) as unknown };
}
