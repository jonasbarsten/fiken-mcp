import { describe, expect, it } from "vitest";
import { renderChoice } from "../src/widget/choice.mjs";
import { renderForm } from "../src/widget/form.mjs";
import { renderPreview } from "../src/widget/preview.mjs";
import { renderTable } from "../src/widget/table.mjs";
import { FakeEl } from "./fake-dom.js";

// ChatGPT sends a widget's message at once; Claude puts it in the composer for the user to send. True in both:
const HINT = "Svaret er sendt til chatten. Står det i meldingsfeltet, trykk send.";
const doc = { createElement: (tag: string) => new FakeEl(tag) };
const hints = (root: FakeEl) => root.all().filter((e) => e.className === "hint");
const noop = () => {};

describe("after an answer, every widget says where the message went", () => {
  it("choice: an option, and «Bruk» on the Annet field", () => {
    const root = new FakeEl("div");
    renderChoice(doc as never, root as never, { question: "Hvilket foretak?", options: [{ label: "A", value: "a" }, { label: "B", value: "b" }], allowOther: true }, noop);
    expect(hints(root)).toEqual([]);
    expect(root.all().find((e) => e.tag === "button" && e.textContent === "Bruk")).toBeDefined();
    root.all().find((e) => e.className === "option")!.click();
    expect(hints(root).map((e) => e.textContent)).toEqual([HINT]);
  });

  it("form: the button says «Bruk» by default", () => {
    const root = new FakeEl("div");
    renderForm(doc as never, root as never, { title: "Utlegg", fields: [{ name: "x", label: "X", type: "text" }] }, noop);
    const submit = root.all().find((e) => e.tag === "button")!;
    expect(submit.textContent).toBe("Bruk");
    submit.click();
    expect(hints(root).map((e) => e.textContent)).toEqual([HINT]);
  });

  it("preview: «Før dette»", () => {
    const root = new FakeEl("div");
    renderPreview(doc as never, root as never, { operation: "create_journal_entry", title: "Bilag", summary: [], checks: "ok", ref: "abc123" }, noop);
    root.all().find((e) => e.tag === "button" && e.textContent === "Før dette")!.click();
    expect(hints(root).map((e) => e.textContent)).toEqual([HINT]);
  });

  it("table: one hint, however many rows are acted on", () => {
    const root = new FakeEl("div");
    const rows = [1, 2].map((n) => ({ cells: { nr: String(n) }, actions: [{ label: "Vis", message: `Vis ${n}` }] }));
    renderTable(doc as never, root as never, { title: "T", columns: [{ key: "nr", label: "Nr" }], rows }, noop);
    for (const b of root.all().filter((e) => e.tag === "button" && e.textContent === "Vis")) b.click();
    expect(hints(root).map((e) => e.textContent)).toEqual([HINT]);
  });
});
