import { describe, expect, it } from "vitest";
import { connected, fakeFiken } from "./helpers.js";

type Block = { type: string; text?: string };
const options = [
  { label: "Fiken-demo AS", value: "fiken-demo-as", description: "Org.nr 123" },
  { label: "Annet AS", value: "annet-as" },
];

describe("ask_user_choice", () => {
  it("is a widget tool with the stable resource, read-only", async () => {
    const c = await connected(fakeFiken([]).fetchImpl);
    const tool = (await c.listTools()).tools.find((t) => t.name === "ask_user_choice")!;
    expect(tool.annotations?.readOnlyHint).toBe(true);
    expect((tool._meta as { ui: { resourceUri: string } }).ui.resourceUri).toBe("ui://fiken-mcp/choice.html");
    const res = await c.readResource({ uri: "ui://fiken-mcp/choice.html" });
    expect(res.contents[0]!.mimeType).toContain("text/html");
  });

  it("returns structuredContent for the widget and a numbered text fallback, without calling Fiken", async () => {
    const f = fakeFiken([]);
    const c = await connected(f.fetchImpl);
    const r = await c.callTool({ name: "ask_user_choice", arguments: { question: "Hvilket foretak?", options } });
    expect(r.structuredContent).toEqual({ question: "Hvilket foretak?", options, allowOther: false });
    const text = (r.content as Block[])[0]!.text!;
    expect(text).toBe("Spurte brukeren: Hvilket foretak?\n1. Fiken-demo AS – Org.nr 123\n2. Annet AS\nVent på svaret i chatten.");
    expect(f.calls).toHaveLength(0);
  });

  it.each([
    ["one option", { question: "q", options: [options[0]] }],
    ["13 options", { question: "q", options: Array.from({ length: 13 }, (_, i) => ({ label: `L${i}`, value: `v${i}` })) }],
    ["duplicate values", { question: "q", options: [options[0], { ...options[1], value: "fiken-demo-as" }] }],
    ["long label", { question: "q", options: [{ label: "x".repeat(81), value: "a" }, options[1]] }],
    ["empty question", { question: "", options }],
    ["unknown key", { question: "q", options, extra: 1 }],
  ])("refuses %s", async (_name, args) => {
    const c = await connected(fakeFiken([]).fetchImpl);
    const r = await c.callTool({ name: "ask_user_choice", arguments: args });
    expect(r.isError).toBe(true);
  });
});
