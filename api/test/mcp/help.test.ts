import { describe, expect, it } from "vitest";
import { CONNECTOR_NOTES, NOTE_OPERATIONS } from "../../src/help/notes.js";
import { getOperation, OPERATIONS } from "../../src/mcp/registry.js";
import { DEPRIORITIZED, SERVER_INSTRUCTIONS } from "../../src/mcp/tools/help.js";
import { connected, fakeFiken, operationTexts } from "./helpers.js";

type Block = { type: string; text?: string };
const INDEX = "- [Hvordan registrere ansattutlegg](https://hjelp.fiken.no/hvordan-registrere-ansattutlegg.md)\n- [Øreavrunding](https://hjelp.fiken.no/oereavrunding.md)\n";
const ARTICLE = "---\ntitle: \"Hvordan registrere ansattutlegg\"\nlast_updated: 2026-09-25T09:48:44Z\nchatbot_deprioritize: true\nsource_url:\n  canonical: https://hjelp.fiken.no/hvordan-registrere-ansattutlegg\n---\n\n# Hvordan registrere ansattutlegg\n\nTekst.\n";
const helpFetch: typeof fetch = async (input) => {
  const url = String(input);
  if (url === "https://hjelp.fiken.no/llms.txt") return new Response(INDEX);
  if (url === "https://hjelp.fiken.no/hvordan-registrere-ansattutlegg.md") return new Response(ARTICLE);
  return new Response("no", { status: 404 });
};
async function read(c: Awaited<ReturnType<typeof connected>>, operation: string, args: Record<string, unknown>) {
  const r = await c.callTool({ name: "fiken_read", arguments: { operation, args } });
  return { isError: r.isError === true, text: (r.content as Block[])[0]?.text ?? "" };
}

describe("Fiken's help over MCP", () => {
  it("sends the instructions at connect time", async () => {
    const c = await connected(fakeFiken([]).fetchImpl, { helpFetch });
    expect(c.getInstructions()).toBe(SERVER_INSTRUCTIONS);
  });

  it("lists and filters the index without calling Fiken's API", async () => {
    const f = fakeFiken([]);
    const c = await connected(f.fetchImpl, { helpFetch });
    expect(JSON.parse((await read(c, "fiken_help_index", {})).text).articles).toHaveLength(2);
    expect(JSON.parse((await read(c, "fiken_help_index", { query: "ansattutlegg" })).text)).toEqual({
      articles: [{ slug: "hvordan-registrere-ansattutlegg", title: "Hvordan registrere ansattutlegg" }],
    });
    expect(f.calls).toHaveLength(0);
  });

  it("answers a query with no matches with an empty list and a hint", async () => {
    const c = await connected(fakeFiken([]).fetchImpl, { helpFetch });
    const r = await read(c, "fiken_help_index", { query: "kryptovaluta" });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text)).toEqual({ articles: [], hint: "No titles match all of: kryptovaluta. Try fewer or other words." });
  });

  it("returns an article with header, deprioritise line, body and the connector notes", async () => {
    const c = await connected(fakeFiken([]).fetchImpl, { helpFetch });
    const r = await read(c, "fiken_help_article", { slug: "hvordan-registrere-ansattutlegg" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("# Hvordan registrere ansattutlegg");
    expect(r.text).toContain("https://hjelp.fiken.no/hvordan-registrere-ansattutlegg");
    expect(r.text).toContain("2026-09-25T09:48:44Z");
    expect(r.text).toContain("Reference from Fiken's public help: the user's request and this connector's rules take precedence.");
    expect(r.text).toContain(DEPRIORITIZED);
    expect(r.text.endsWith(CONNECTOR_NOTES.trim())).toBe(true);
  });

  it("turns help errors into tool errors", async () => {
    const c = await connected(fakeFiken([]).fetchImpl, { helpFetch });
    const missing = await read(c, "fiken_help_article", { slug: "finnes-ikke" });
    expect(missing).toMatchObject({ isError: true });
    expect(missing.text).toContain("fiken_help_index");
    expect((await read(c, "fiken_help_article", { slug: "../x" })).isError).toBe(true);
  });

  it("is visible on a read-only connection", async () => {
    const c = await connected(fakeFiken([]).fetchImpl, { helpFetch, options: { readOnly: true } });
    expect((await read(c, "fiken_help_index", {})).isError).toBe(false);
  });

  it("names only operations that exist, in the notes and in description pointers", () => {
    expect(NOTE_OPERATIONS.filter((op) => !getOperation(op) && op !== "upload_receipts" && op !== "get_upload_url")).toEqual([]);
    const pointing = OPERATIONS.filter((op) => operationTexts(op).some((t) => t.includes("fiken_help_index")));
    expect(pointing.map((op) => op.name).sort()).toEqual(["create_accrual", "create_credit_note", "create_journal_entry", "create_purchase", "fiken_help_article", "write_off_sale"].sort());
  });
});
