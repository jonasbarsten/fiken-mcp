import { describe, expect, it } from "vitest";
import { connected, fakeFiken } from "./helpers.js";

type Block = { type: string; text?: string };
const columns = [
  { key: "nr", label: "Nr" },
  { key: "due", label: "Forfall", kind: "date" },
  { key: "sum", label: "Beløp", kind: "amount" },
];
const pay = { label: "Registrer betaling", message: "Registrer betaling på faktura 10521" };
const rows = [
  { cells: { nr: "10521", due: "2026-10-15", sum: 125000 }, actions: [pay, { label: "Send purring", message: "Send purring på faktura 10521" }] },
  { cells: { nr: "10522", sum: 5000 } },
  { cells: { nr: "10523", sum: 100 }, actions: [{ label: "Kreditér", message: "Kreditér faktura 10523" }] },
];

describe("show_table", () => {
  it("is a widget tool with the stable resource, read-only", async () => {
    const c = await connected(fakeFiken([]).fetchImpl);
    const tool = (await c.listTools()).tools.find((t) => t.name === "show_table")!;
    expect(tool.annotations?.readOnlyHint).toBe(true);
    expect((tool._meta as { ui: { resourceUri: string } }).ui.resourceUri).toBe("ui://fiken-mcp/table.html");
    const res = await c.readResource({ uri: "ui://fiken-mcp/table.html" });
    expect(res.contents[0]!.mimeType).toContain("text/html");
  });

  it("returns structuredContent and a Markdown fallback with formatted amounts and action lines, without calling Fiken", async () => {
    const f = fakeFiken([]);
    const c = await connected(f.fetchImpl);
    const r = await c.callTool({ name: "show_table", arguments: { title: "Ubetalte fakturaer", columns, rows, note: "Tre fakturaer" } });
    expect(r.structuredContent).toEqual({ title: "Ubetalte fakturaer", columns, rows, note: "Tre fakturaer" });
    const text = (r.content as Block[])[0]!.text!;
    expect(text).toBe(
      [
        "Ubetalte fakturaer",
        "",
        "| Nr | Forfall | Beløp |",
        "| --- | --- | --- |",
        "| 10521 | 2026-10-15 | 1 250,00 kr |",
        "| 10522 |  | 50,00 kr |",
        "| 10523 |  | 1,00 kr |",
        "",
        "Tre fakturaer",
        "",
        "Handlinger rad 1: Registrer betaling / Send purring",
        "Handlinger rad 3: Kreditér",
      ].join("\n"),
    );
    expect(f.calls).toHaveLength(0);
  });

  it("escapes pipes and line breaks in the Markdown table", async () => {
    const c = await connected(fakeFiken([]).fetchImpl);
    const r = await c.callTool({
      name: "show_table",
      arguments: { title: "t", columns: [{ key: "a", label: "A|B" }], rows: [{ cells: { a: "x|y\nz" } }] },
    });
    expect((r.content as Block[])[0]!.text).toContain("| A\\|B |\n| --- |\n| x\\|y z |");
  });

  const ok = { title: "t", columns, rows };
  const manyColumns = Array.from({ length: 9 }, (_, i) => ({ key: `k${i}`, label: `L${i}` }));
  const action = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `A${i}`, message: `m${i}` }));
  it.each([
    ["no columns", { ...ok, columns: [] }],
    ["9 columns", { ...ok, columns: manyColumns }],
    ["duplicate keys", { ...ok, columns: [columns[0], columns[0]] }],
    ["unknown column kind", { ...ok, columns: [{ key: "a", label: "A", kind: "bool" }] }],
    ["no rows", { ...ok, rows: [] }],
    ["51 rows", { ...ok, rows: Array.from({ length: 51 }, () => ({ cells: { nr: "1" } })) }],
    ["4 actions", { ...ok, rows: [{ cells: { nr: "1" }, actions: action(4) }] }],
    ["zero actions", { ...ok, rows: [{ cells: { nr: "1" }, actions: [] }] }],
    ["empty action label", { ...ok, rows: [{ cells: { nr: "1" }, actions: [{ label: "", message: "m" }] }] }],
    ["41-character action label", { ...ok, rows: [{ cells: { nr: "1" }, actions: [{ label: "l".repeat(41), message: "m" }] }] }],
    ["empty action message", { ...ok, rows: [{ cells: { nr: "1" }, actions: [{ label: "l", message: "" }] }] }],
    ["201-character action message", { ...ok, rows: [{ cells: { nr: "1" }, actions: [{ label: "l", message: "m".repeat(201) }] }] }],
    ["201-character note", { ...ok, note: "n".repeat(201) }],
    ["cell for an undeclared key", { ...ok, rows: [{ cells: { nr: "1", other: "x" } }] }],
    ["201-character text cell", { ...ok, rows: [{ cells: { nr: "x".repeat(201) } }] }],
    ["object cell", { ...ok, rows: [{ cells: { nr: { a: 1 } } }] }],
    ["empty title", { ...ok, title: "" }],
    ["unknown key", { ...ok, extra: 1 }],
    ["unknown row key", { ...ok, rows: [{ cells: { nr: "1" }, extra: 1 }] }],
  ])("refuses %s", async (_name, args) => {
    const c = await connected(fakeFiken([]).fetchImpl);
    const r = await c.callTool({ name: "show_table", arguments: args });
    expect(r.isError).toBe(true);
  });

  it("accepts the limits", async () => {
    const c = await connected(fakeFiken([]).fetchImpl);
    const cols = Array.from({ length: 8 }, (_, i) => ({ key: `k${i}`, label: `L${i}` }));
    const r = await c.callTool({
      name: "show_table",
      arguments: { title: "t", columns: cols, rows: Array.from({ length: 50 }, () => ({ cells: { k0: "x".repeat(200) }, actions: action(3) })) },
    });
    expect(r.isError).toBeFalsy();
  });
});
