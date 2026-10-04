import { describe, expect, it } from "vitest";
import { connected } from "./helpers.js";

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

  it("tells the model where to share a missing company with the app", async () => {
    const client = await connected(async () => Response.json([]));
    const tool = (await client.listTools()).tools.find((t) => t.name === "list_companies");
    expect(tool?.description).toContain(
      "Fiken shares only the companies the user has chosen with this app: a company that is missing (not even with hasApiAccess false) is added in Fiken under " +
        "Brukerinnstillinger → Sikkerhet → Apper du har gitt tilgang til → Endre next to Fiken MCP. Ordering the API add-on does not share it.",
    );
  });

  it("reports Fiken errors as tool errors without leaking the token", async () => {
    const client = await connected(async () => new Response("denied tok", { status: 403 }));
    const result = await client.callTool({ name: "list_companies", arguments: {} });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(text).toMatch(/403/);
    expect(text).not.toMatch(/Bearer/);
  });

  it("tells the model to reconnect when Fiken answers 401 everywhere, /user included", async () => {
    const client = await connected(async () => new Response("expired tok", { status: 401 }));
    const result = await client.callTool({ name: "list_companies", arguments: {} });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(text).toBe("Fiken rejected the login (401). Ask the user to disconnect and reconnect the Fiken connector, then retry.");
  });
});
