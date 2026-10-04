import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formMessage, renderForm } from "../src/widget/form.mjs";
import { FakeEl } from "./fake-dom.js";
import { runPageScript } from "./page-script.js";

const doc = { createElement: (tag: string) => new FakeEl(tag) };
const opts = [
  { label: "Norge", value: "NO" },
  { label: "SE", value: "SE" },
];
const data = {
  title: "Ny kunde",
  fields: [
    { name: "navn", label: "Navn", type: "text" as const, required: true, help: "Slik det står i Brreg" },
    { name: "beloep", label: "Beløp", type: "amount" as const, value: "1 250,50" },
    { name: "timer", label: "Timer", type: "number" as const, value: "7,5" },
    { name: "dato", label: "Dato", type: "date" as const, value: "2026-10-05" },
    { name: "land", label: "Land", type: "select" as const, options: opts, value: "NO" },
    { name: "faktura", label: "Send faktura", type: "checkbox" as const, value: "true" },
  ],
};

const render = (d: typeof data & { submitLabel?: string } = data) => {
  const root = new FakeEl("div");
  const sent: string[] = [];
  renderForm(doc as never, root as never, d, (t: string) => sent.push(t));
  const all = root.all();
  const input = (i: number) => all.filter((e) => e.tag === "input" || e.tag === "select")[i]!;
  const submit = all.find((e) => e.tag === "button")!;
  return { root, all, sent, input, submit };
};

describe("form widget logic", () => {
  it("renders one control per field with the right type, suggested values and help, as text", () => {
    const { all, input } = render();
    expect(all.filter((e) => e.tag === "input" || e.tag === "select")).toHaveLength(6);
    expect(input(0).type).toBe("text");
    expect(input(1).type).toBe("text");
    expect(input(1).value).toBe("1 250,50");
    expect(input(2).type).toBe("text");
    expect(input(2).inputMode).toBe("decimal");
    expect(input(1).inputMode).toBe("decimal");
    expect(input(2).value).toBe("7,5");
    expect(input(3).type).toBe("date");
    expect(input(3).value).toBe("2026-10-05");
    expect(input(4).tag).toBe("select");
    expect(input(4).value).toBe("NO");
    expect(input(4).all().filter((e) => e.tag === "option").map((o) => [o.textContent, o.value])).toEqual([
      ["Velg …", ""],
      ["Norge", "NO"],
      ["SE", "SE"],
    ]);
    expect(input(5).type).toBe("checkbox");
    expect(input(5).checked).toBe(true);
    expect(all.some((e) => e.textContent === "Ny kunde")).toBe(true);
    expect(all.some((e) => e.textContent === "Slik det står i Brreg")).toBe(true);
    expect(all.some((e) => e.textContent === "Beløp")).toBe(true);
  });

  it("keeps hostile text as text", () => {
    const root = new FakeEl("div");
    renderForm(doc as never, root as never, { title: "<b>x</b>", fields: [{ name: "a", label: "<i>y</i>", type: "text" }] }, () => {});
    expect(root.all().some((e) => e.textContent === "<b>x</b>")).toBe(true);
    expect(root.all().some((e) => e.textContent === "<i>y</i>")).toBe(true);
  });

  it("disables Send while a required field is empty and enables it when filled", () => {
    const { input, submit } = render();
    expect(submit.textContent).toBe("Send");
    expect(submit.disabled).toBe(true);
    input(0).value = "   ";
    input(0).fire("input");
    expect(submit.disabled).toBe(true);
    input(0).value = "Acme AS";
    input(0).fire("input");
    expect(submit.disabled).toBe(false);
    input(0).value = "";
    input(0).fire("input");
    expect(submit.disabled).toBe(true);
  });

  it("never treats a checkbox as empty, and requires a chosen select option", () => {
    const d = {
      title: "t",
      fields: [
        { name: "ok", label: "Ok", type: "checkbox" as const, required: true },
        { name: "land", label: "Land", type: "select" as const, options: opts, required: true },
      ],
    };
    const { input, submit } = render(d as never);
    expect(submit.disabled).toBe(true);
    input(1).value = "SE";
    input(1).fire("change");
    expect(submit.disabled).toBe(false);
  });

  it("uses submitLabel", () => {
    expect(render({ ...data, submitLabel: "Opprett" }).submit.textContent).toBe("Opprett");
  });

  it("sends exactly formMessage once, then disables the form", () => {
    const { all, sent, input, submit } = render();
    input(0).value = "Acme AS";
    input(0).fire("input");
    submit.click();
    submit.click();
    expect(sent).toEqual([
      "Ny kunde:\n- Navn: Acme AS\n- Beløp: 1 250,50\n- Timer: 7,5\n- Dato: 2026-10-05\n- Land: Norge (NO)\n- Send faktura: Ja",
    ]);
    expect(all.filter((e) => ["input", "select", "button"].includes(e.tag)).every((e) => e.disabled)).toBe(true);
  });

  it("does not submit on Enter until all required fields are filled, then submits once", () => {
    const { sent, input } = render();
    input(0).key("Enter");
    expect(sent).toEqual([]);
    input(0).value = "Acme AS";
    input(0).fire("input");
    input(0).key("a");
    expect(sent).toEqual([]);
    input(0).key("Enter");
    input(0).key("Enter");
    expect(sent).toHaveLength(1);
  });

  it("does not submit on Enter during IME composition", () => {
    const { sent, input } = render();
    input(0).value = "Acme AS";
    input(0).fire("input");
    input(0).key("Enter", true);
    expect(sent).toEqual([]);
    input(0).key("Enter");
    expect(sent).toHaveLength(1);
  });

  it("accepts a decimal comma in a required number field and sends it as typed", () => {
    const d = { title: "Timer", fields: [{ name: "timer", label: "Timer", type: "number" as const, required: true }] };
    const { sent, input, submit } = render(d as never);
    expect(submit.disabled).toBe(true);
    input(0).value = "7,5";
    input(0).fire("input");
    expect(submit.disabled).toBe(false);
    submit.click();
    expect(sent).toEqual(["Timer:\n- Timer: 7,5"]);
  });

  it("ignores events on a form that is already sent", () => {
    const { sent, input, submit } = render();
    input(0).value = "A";
    input(0).fire("input");
    submit.click();
    input(0).value = "";
    input(0).fire("input");
    expect(submit.disabled).toBe(true);
    input(0).key("Enter");
    expect(sent).toHaveLength(1);
  });
});

describe("formMessage", () => {
  const fields = data.fields;
  it("lists filled fields, leaves empty optional ones out, and sends amounts as typed", () => {
    expect(formMessage({ title: "T", fields }, { navn: "A", beloep: " 1 250,50 ", timer: "", dato: "", land: "", faktura: false })).toBe(
      "T:\n- Navn: A\n- Beløp: 1 250,50\n- Send faktura: Nei",
    );
  });

  it("writes a select as label (value) when they differ and as the label alone when equal", () => {
    expect(formMessage({ title: "T", fields }, { land: "NO", faktura: true })).toBe("T:\n- Land: Norge (NO)\n- Send faktura: Ja");
    expect(formMessage({ title: "T", fields: [{ name: "l", label: "L", type: "select", options: [{ label: "SE", value: "SE" }] }] }, { l: "SE" })).toBe("T:\n- L: SE");
  });
});

describe("built form widget", () => {
  const html = readFileSync(new URL("../src/assets/form.html", import.meta.url), "utf8");

  it("inlines the app bundle and the render logic as globals, and never uses innerHTML", () => {
    expect(html).toContain("globalThis.__mcpApps=");
    expect(html).toContain("globalThis.__widget=");
    expect(html).not.toContain("/*__LOGIC__*/");
    expect(html).not.toContain("innerHTML");
  });

  it("lets the date input shrink to the widget's width on iOS", () => {
    expect(html).toMatch(/input\[type="date"\] \{[^}]*appearance: none;[^}]*min-width: 0;/);
  });

  it("ignores a repeated tool result once the user has answered", async () => {
    const page = await runPageScript(html, { renderForm });
    page.fire(data);
    const inputs = page.root.all().filter((e) => e.tag === "input");
    inputs[0]!.value = "Acme AS";
    inputs[0]!.fire("input");
    page.root.all().find((e) => e.tag === "button")!.click();
    expect(page.sent).toHaveLength(1);
    page.fire(data);
    expect(page.root.all().filter((e) => e.tag === "input")[0]).toBe(inputs[0]);
    expect(inputs[0]!.disabled).toBe(true);
  });
});
