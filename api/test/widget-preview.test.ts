import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderPreview } from "../src/widget/preview.mjs";
import { runPageScript } from "./page-script.js";

class FakeEl {
  children: FakeEl[] = [];
  textContent = "";
  disabled = false;
  className = "";
  type = "";
  listeners: Record<string, Array<() => void>> = {};
  constructor(public tag: string) {}
  append(...els: FakeEl[]) { this.children.push(...els); }
  addEventListener(ev: string, fn: () => void) { (this.listeners[ev] ??= []).push(fn); }
  click() { for (const fn of this.listeners.click ?? []) fn(); }
  all(): FakeEl[] { return [this, ...this.children.flatMap((c) => c.all())]; }
}
const doc = { createElement: (tag: string) => new FakeEl(tag) };

const preview = {
  operation: "create_journal_entry",
  title: "Create journal entry",
  summary: [{ label: "Dato", value: "2026-10-01" }, { label: "Beskrivelse", value: "<b>Utlegg</b> & \"co\"" }],
  lines: { columns: ["amount", "debitAccount"], rows: [["1 000,00 kr", "6540"], ["1 250,00 kr", ""]] },
  totals: [{ label: "Mva", value: "Fiken beregner mva" }],
  checks: "ok" as "ok" | string[],
};

const texts = (root: FakeEl) => root.all().map((e) => e.textContent);
const buttons = (root: FakeEl) => root.all().filter((e) => e.tag === "button");

describe("preview widget logic", () => {
  it("renders title, summary, table cells and totals as text", () => {
    const root = new FakeEl("div");
    renderPreview(doc as never, root as never, preview, () => {});
    const t = texts(root);
    for (const s of ["Create journal entry", "Dato", "2026-10-01", "<b>Utlegg</b> & \"co\"", "amount", "debitAccount", "1 000,00 kr", "6540", "1 250,00 kr", "Mva", "Fiken beregner mva"]) {
      expect(t).toContain(s);
    }
    expect(root.all().some((e) => e.tag === "table")).toBe(true);
    expect(root.all().filter((e) => e.tag === "tr")).toHaveLength(3);
  });

  it("sends «Før dette» once and disables both buttons", () => {
    const root = new FakeEl("div");
    const sent: string[] = [];
    renderPreview(doc as never, root as never, preview, (t: string) => sent.push(t));
    expect(buttons(root).map((b) => b.textContent)).toEqual(["Før dette", "Endre"]);
    const go = buttons(root)[0]!;
    go.click();
    go.click();
    buttons(root)[1]!.click();
    expect(sent).toEqual(["Ja, før dette."]);
    expect(buttons(root).every((b) => b.disabled)).toBe(true);
  });

  it("sends «Endre» text", () => {
    const root = new FakeEl("div");
    const sent: string[] = [];
    renderPreview(doc as never, root as never, preview, (t: string) => sent.push(t));
    buttons(root)[1]!.click();
    expect(sent).toEqual(["Jeg vil endre noe før det føres."]);
    expect(buttons(root).every((b) => b.disabled)).toBe(true);
  });

  it("with checks lists the messages and offers only «Endre»", () => {
    const root = new FakeEl("div");
    const sent: string[] = [];
    renderPreview(doc as never, root as never, { ...preview, checks: ["The entry does not balance: debit 100 øre, credit 90 øre."] }, (t: string) => sent.push(t));
    expect(buttons(root).map((b) => b.textContent)).toEqual(["Endre"]);
    const t = texts(root);
    expect(t).toContain("Kan ikke føres slik:");
    expect(t).toContain("The entry does not balance: debit 100 øre, credit 90 øre.");
  });

  it("renders a preview without lines or totals", () => {
    const root = new FakeEl("div");
    renderPreview(doc as never, root as never, { operation: "x", title: "T", summary: [], checks: "ok" }, () => {});
    expect(root.all().some((e) => e.tag === "table")).toBe(false);
  });
});

describe("built preview widget", () => {
  const html = readFileSync(new URL("../src/assets/preview.html", import.meta.url), "utf8");

  it("inlines the app bundle and the render logic as globals, and never uses innerHTML", () => {
    expect(html).toContain("globalThis.__mcpApps=");
    expect(html).toContain("globalThis.__widget=");
    expect(html).not.toContain("/*__LOGIC__*/");
    expect(html).not.toContain("innerHTML");
  });

  it("ignores a repeated tool result once the user has answered", async () => {
    const page = await runPageScript(html, { renderPreview });
    page.fire(preview);
    const go = page.root.all().filter((e) => e.tag === "button")[0]!;
    go.click();
    expect(page.sent).toEqual(["Ja, før dette."]);
    page.fire(preview);
    expect(page.root.all().filter((e) => e.tag === "button")[0]).toBe(go);
    expect(go.disabled).toBe(true);
  });
});
