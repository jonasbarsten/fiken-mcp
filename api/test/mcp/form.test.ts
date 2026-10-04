import { describe, expect, it } from "vitest";
import { connected, fakeFiken } from "./helpers.js";

type Block = { type: string; text?: string };
const fields = [
  { name: "navn", label: "Navn", type: "text", required: true },
  { name: "beloep", label: "Beløp", type: "amount", value: "1 250,50" },
  { name: "land", label: "Land", type: "select", options: [{ label: "Norge", value: "NO" }, { label: "Sverige", value: "SE" }] },
];

describe("ask_user_form", () => {
  it("is a widget tool with the stable resource, read-only", async () => {
    const c = await connected(fakeFiken([]).fetchImpl);
    const tool = (await c.listTools()).tools.find((t) => t.name === "ask_user_form")!;
    expect(tool.annotations?.readOnlyHint).toBe(true);
    expect((tool._meta as { ui: { resourceUri: string } }).ui.resourceUri).toBe("ui://fiken-mcp/form.html");
    const res = await c.readResource({ uri: "ui://fiken-mcp/form.html" });
    expect(res.contents[0]!.mimeType).toContain("text/html");
  });

  it("returns structuredContent with defaults and the exact text fallback, without calling Fiken", async () => {
    const f = fakeFiken([]);
    const c = await connected(f.fetchImpl);
    const r = await c.callTool({ name: "ask_user_form", arguments: { title: "Ny kunde", fields } });
    expect(r.structuredContent).toEqual({
      title: "Ny kunde",
      fields: fields.map((x) => ({ required: false, ...x })),
      submitLabel: "Send",
    });
    expect((r.content as Block[])[0]!.text).toBe(
      "Spurte brukeren (skjema): Ny kunde\n1. Navn (text)\n2. Beløp (amount, forslag: 1 250,50)\n3. Land (select, valg: Norge / Sverige)\nVent på svaret i chatten.",
    );
    expect(f.calls).toHaveLength(0);
  });

  it("lists suggestion and options together in the fallback", async () => {
    const c = await connected(fakeFiken([]).fetchImpl);
    const r = await c.callTool({
      name: "ask_user_form",
      arguments: { title: "T", fields: [{ ...fields[2], value: "NO" }], submitLabel: "Opprett" },
    });
    expect((r.content as Block[])[0]!.text).toContain("1. Land (select, forslag: NO, valg: Norge / Sverige)");
    expect((r.structuredContent as { submitLabel: string }).submitLabel).toBe("Opprett");
  });

  const f = (over: object) => ({ name: "a", label: "A", type: "text", ...over });
  it.each([
    ["no fields", { title: "t", fields: [] }],
    ["13 fields", { title: "t", fields: Array.from({ length: 13 }, (_, i) => f({ name: `f${i}` })) }],
    ["duplicate names", { title: "t", fields: [f({}), f({})] }],
    ["bad name", { title: "t", fields: [f({ name: "Navn" })] }],
    ["41-character name", { title: "t", fields: [f({ name: "a".repeat(41) })] }],
    ["unknown type", { title: "t", fields: [f({ type: "file" })] }],
    ["select without options", { title: "t", fields: [f({ type: "select" })] }],
    ["options on a text field", { title: "t", fields: [f({ options: [{ label: "a", value: "a" }] })] }],
    ["21 options", { title: "t", fields: [f({ type: "select", options: Array.from({ length: 21 }, (_, i) => ({ label: `l${i}`, value: `v${i}` })) })] }],
    ["duplicate option values", { title: "t", fields: [f({ type: "select", options: [{ label: "a", value: "x" }, { label: "b", value: "x" }] })] }],
    ["121-character title", { title: "t".repeat(121), fields: [f({})] }],
    ["81-character label", { title: "t", fields: [f({ label: "l".repeat(81) })] }],
    ["161-character help", { title: "t", fields: [f({ help: "h".repeat(161) })] }],
    ["a required checkbox", { title: "t", fields: [f({ type: "checkbox", required: true })] }],
    ["unknown field key", { title: "t", fields: [f({ extra: 1 })] }],
    ["unknown key", { title: "t", fields: [f({})], extra: 1 }],
  ])("refuses %s", async (_name, args) => {
    const c = await connected(fakeFiken([]).fetchImpl);
    const r = await c.callTool({ name: "ask_user_form", arguments: args });
    expect(r.isError).toBe(true);
  });
});
