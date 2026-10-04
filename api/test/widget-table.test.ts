import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatKroner } from "../src/mcp/preview.js";
import { tableCellText } from "../src/mcp/tools/table.js";
import { formatAmountCell, renderTable, type TableData } from "../src/widget/table.mjs";
import { FakeEl } from "./fake-dom.js";
import { runPageScript } from "./page-script.js";

const doc = { createElement: (tag: string) => new FakeEl(tag) };
const data: TableData = {
  title: "Ubetalte fakturaer",
  columns: [
    { key: "nr", label: "Nr" },
    { key: "due", label: "Forfall", kind: "date" as const },
    { key: "sum", label: "Beløp", kind: "amount" as const },
  ],
  rows: [
    {
      cells: { nr: "10521", due: "2026-10-15", sum: 125000, extra: "skjules" },
      actions: [
        { label: "Registrer betaling", message: "Registrer betaling på faktura 10521" },
        { label: "Send purring", message: "Send purring på faktura 10521" },
      ],
    },
    { cells: { nr: "<b>10522</b>", sum: 5000 }, actions: [{ label: "Registrer betaling", message: "Registrer betaling på faktura 10522" }] },
    { cells: { nr: "10523", due: "2026-11-01", sum: 100 } },
  ],
  note: "Tre fakturaer",
};

const rowButtons = (root: FakeEl, rowIndex: number) => root.all().filter((e) => e.tag === "tr")[rowIndex + 1]!.all().filter((e) => e.tag === "button");
const render = (send: (t: string) => void = () => {}, d = data) => {
  const root = new FakeEl("div");
  renderTable(doc as never, root as never, d, send);
  return root;
};

describe("table widget logic", () => {
  it("renders the title, a header from the labels and one row per item, all as text", () => {
    const root = render();
    expect(root.all().some((e) => e.textContent === "Ubetalte fakturaer")).toBe(true);
    const headers = root.all().filter((e) => e.tag === "th").map((e) => e.textContent);
    expect(headers).toEqual(["Nr", "Forfall", "Beløp", ""]);
    expect(root.all().filter((e) => e.tag === "tr")).toHaveLength(4);
    expect(root.all().some((e) => e.textContent === "<b>10522</b>")).toBe(true);
    expect(root.all().some((e) => e.textContent === "Tre fakturaer")).toBe(true);
  });

  it("shows amounts as kroner, dates and text as given, missing cells empty, undeclared keys never", () => {
    const root = render();
    const rows = root.all().filter((e) => e.tag === "tr").slice(1);
    const cells = (row: FakeEl) => row.children.filter((c) => c.tag === "td").map((c) => c.textContent);
    expect(cells(rows[0]!).slice(0, 3)).toEqual(["10521", "2026-10-15", "1 250,00 kr"]);
    expect(cells(rows[1]!).slice(0, 3)).toEqual(["<b>10522</b>", "", "50,00 kr"]);
    expect(root.all().some((e) => e.textContent === "skjules")).toBe(false);
  });

  it("shows a non-numeric amount cell as given", () => {
    expect(formatAmountCell("abc")).toBe("abc");
    expect(formatAmountCell("12500")).toBe(formatAmountCell(12500));
  });

  it("renders one button per action, none for a row without actions", () => {
    const root = render();
    expect(rowButtons(root, 0).map((b) => b.textContent)).toEqual(["Registrer betaling", "Send purring"]);
    expect(rowButtons(root, 1)).toHaveLength(1);
    expect(rowButtons(root, 2)).toHaveLength(0);
  });

  it("sends an action's message once and disables only that row's buttons", () => {
    const sent: string[] = [];
    const root = render((t) => sent.push(t));
    const [pay] = rowButtons(root, 0);
    pay!.click();
    pay!.click();
    rowButtons(root, 0)[1]!.click();
    expect(sent).toEqual(["Registrer betaling på faktura 10521"]);
    expect(rowButtons(root, 0).every((b) => b.disabled)).toBe(true);
    expect(rowButtons(root, 1).every((b) => !b.disabled)).toBe(true);
    rowButtons(root, 1)[0]!.click();
    expect(sent).toEqual(["Registrer betaling på faktura 10521", "Registrer betaling på faktura 10522"]);
  });

  it("starts rows already in the acted set disabled and cannot act on them again", () => {
    const sent: string[] = [];
    const root = new FakeEl("div");
    renderTable(doc as never, root as never, data, (t: string) => sent.push(t), new Set([0]));
    expect(rowButtons(root, 0).every((b) => b.disabled)).toBe(true);
    rowButtons(root, 0)[0]!.click();
    expect(sent).toEqual([]);
    expect(rowButtons(root, 1)[0]!.disabled).toBe(false);
  });

  it("formats amounts like the server does", () => {
    for (const ore of [0, 1, 125000, -5000, 123456789]) expect(formatAmountCell(ore)).toBe(formatKroner(ore));
    for (const value of [0, 125000, "12500", " 12500 ", "", " ", "\t", "abc"]) {
      expect(formatAmountCell(value)).toBe(tableCellText("amount", value));
    }
  });
});

describe("built table widget", () => {
  const html = readFileSync(new URL("../src/assets/table.html", import.meta.url), "utf8");
  const buttons = (page: Awaited<ReturnType<typeof runPageScript>>, row: number) => rowButtons(page.root, row);

  it("inlines the app bundle and the render logic as globals, and never uses innerHTML", () => {
    expect(html).toContain("globalThis.__mcpApps=");
    expect(html).toContain("globalThis.__widget=");
    expect(html).not.toContain("/*__LOGIC__*/");
    expect(html).not.toContain("innerHTML");
  });

  it("keeps acted rows disabled when the same tool result is replayed, and leaves other rows usable", async () => {
    const page = await runPageScript(html, { renderTable });
    page.fire(data);
    buttons(page, 0)[0]!.click();
    expect(page.sent).toEqual(["Registrer betaling på faktura 10521"]);
    page.fire(data);
    expect(buttons(page, 0).every((b) => b.disabled)).toBe(true);
    buttons(page, 0)[1]!.click();
    expect(page.sent).toHaveLength(1);
    expect(buttons(page, 1)[0]!.disabled).toBe(false);
    buttons(page, 1)[0]!.click();
    expect(page.sent).toEqual(["Registrer betaling på faktura 10521", "Registrer betaling på faktura 10522"]);
  });

  it("starts fresh when a different table arrives", async () => {
    const page = await runPageScript(html, { renderTable });
    page.fire(data);
    buttons(page, 0)[0]!.click();
    page.fire({ ...data, title: "Annen tabell" });
    expect(buttons(page, 0).every((b) => !b.disabled)).toBe(true);
  });
});
