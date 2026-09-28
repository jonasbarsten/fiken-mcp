import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { FikenQueue, createFikenClient } from "../../src/fiken/client.js";
import { createMcpServer } from "../../src/mcp/server.js";

async function connected(fetchImpl: typeof fetch) {
  const fiken = createFikenClient({ baseUrl: "https://api.test/v2", accessToken: "tok", fetch: fetchImpl, queue: new FikenQueue(0) });
  const server = createMcpServer({ fiken, anonId: "anon" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
  return client;
}

describe("list_companies", () => {
  it("returns name, slug and organisation number", async () => {
    const client = await connected(async () =>
      Response.json([
        { name: "byJoBa AS", slug: "byjoba-as", organizationNumber: "123456789", hasApiAccess: true },
        { name: "Test", slug: "test", organizationNumber: "987654321" },
      ]),
    );
    const tools = await client.listTools();
    const tool = tools.tools.find((t) => t.name === "list_companies");
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    const result = await client.callTool({ name: "list_companies", arguments: {} });
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    expect(JSON.parse(text)).toEqual([
      { name: "byJoBa AS", slug: "byjoba-as", organizationNumber: "123456789", hasApiAccess: true },
      { name: "Test", slug: "test", organizationNumber: "987654321" },
    ]);
  });

  it("reports Fiken errors as tool errors without leaking the token", async () => {
    const client = await connected(async () => new Response("denied tok", { status: 403 }));
    const result = await client.callTool({ name: "list_companies", arguments: {} });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(text).toMatch(/403/);
    expect(text).not.toMatch(/Bearer/);
  });

  it("tells the model to reconnect when Fiken answers 401", async () => {
    const client = await connected(async () => new Response("expired tok", { status: 401 }));
    const result = await client.callTool({ name: "list_companies", arguments: {} });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(text).toBe("Fiken rejected the login (401). Ask the user to disconnect and reconnect the Fiken connector, then retry.");
  });
});
