import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { choiceMessage, renderChoice } from "../src/widget/choice.mjs";

class FakeEl {
  children: FakeEl[] = [];
  textContent = "";
  disabled = false;
  className = "";
  type = "";
  value = "";
  placeholder = "";
  listeners: Record<string, Array<() => void>> = {};
  constructor(public tag: string) {}
  append(...els: FakeEl[]) { this.children.push(...els); }
  addEventListener(ev: string, fn: () => void) { (this.listeners[ev] ??= []).push(fn); }
  click() { for (const fn of this.listeners.click ?? []) fn(); }
  key(key: string) { for (const fn of this.listeners.keydown ?? []) (fn as (e: { key: string }) => void)({ key }); }
  all(): FakeEl[] { return [this, ...this.children.flatMap((c) => c.all())]; }
}
const doc = { createElement: (tag: string) => new FakeEl(tag) };
const data = {
  question: "Hvilket foretak?",
  options: [
    { label: "Fiken-demo AS", value: "fiken-demo-as", description: "Org.nr 123" },
    { label: "<script>x</script>", value: "<script>x</script>" },
  ],
  allowOther: false,
};

describe("choice widget logic", () => {
  it("renders the question and one button per option, as text", () => {
    const root = new FakeEl("div");
    renderChoice(doc as never, root as never, data, () => {});
    const buttons = root.all().filter((e) => e.tag === "button");
    expect(buttons).toHaveLength(2);
    expect(root.all().some((e) => e.textContent === "Hvilket foretak?")).toBe(true);
    expect(root.all().some((e) => e.textContent === "<script>x</script>")).toBe(true);
    expect(root.all().some((e) => e.textContent === "Org.nr 123")).toBe(true);
  });

  it("sends label and value once, then disables every button", () => {
    const root = new FakeEl("div");
    const sent: string[] = [];
    renderChoice(doc as never, root as never, data, (t: string) => sent.push(t));
    const [first] = root.all().filter((e) => e.tag === "button");
    first!.click();
    first!.click();
    expect(sent).toEqual(["Fiken-demo AS (fiken-demo-as)"]);
    expect(root.all().filter((e) => e.tag === "button").every((b) => b.disabled)).toBe(true);
  });

  it("sends the label alone when value equals label", () => {
    expect(choiceMessage({ label: "Ja", value: "Ja" })).toBe("Ja");
  });

  it("offers a free-text field with allowOther", () => {
    const root = new FakeEl("div");
    const sent: string[] = [];
    renderChoice(doc as never, root as never, { ...data, allowOther: true }, (t: string) => sent.push(t));
    const input = root.all().find((e) => e.tag === "input")!;
    const send = root.all().find((e) => e.tag === "button" && e.textContent === "Send")!;
    input.value = "  Et annet foretak  ";
    send.click();
    expect(sent).toEqual(["Et annet foretak"]);
  });

  it("submits the free-text field on Enter, once, and ignores empty text and other keys", () => {
    const root = new FakeEl("div");
    const sent: string[] = [];
    renderChoice(doc as never, root as never, { ...data, allowOther: true }, (t: string) => sent.push(t));
    const input = root.all().find((e) => e.tag === "input")!;
    input.value = "   ";
    input.key("Enter");
    input.value = "Noe";
    input.key("a");
    expect(sent).toEqual([]);
    input.key("Enter");
    input.key("Enter");
    expect(sent).toEqual(["Noe"]);
  });
});

describe("built choice widget", () => {
  const html = readFileSync(new URL("../src/assets/choice.html", import.meta.url), "utf8");

  it("inlines the app bundle and the render logic as globals, and never uses innerHTML", () => {
    expect(html).toContain("globalThis.__mcpApps=");
    expect(html).toContain("globalThis.__widget=");
    expect(html).not.toContain("/*__LOGIC__*/");
    expect(html).not.toContain("innerHTML");
  });
});
