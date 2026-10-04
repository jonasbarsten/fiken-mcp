import { FakeEl } from "./fake-dom.js";

/**
 * Runs a built widget's page script (the last inline module) against a fake App and a fake document, with the
 * widget's render function passed in as `__widget`. Returns what the page did, so tests can fire tool results.
 */
export async function runPageScript(html: string, widget: Record<string, unknown>) {
  const scripts = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
  const page = scripts.at(-1)!;
  const sent: string[] = [];
  const root = new FakeEl("div");
  const replaced: number[] = [];
  root.replaceChildren = () => {
    replaced.push(root.children.length);
    root.children = [];
  };
  let onResult: ((p: { structuredContent: unknown }) => void) | undefined;
  class App {
    set ontoolresult(fn: (p: { structuredContent: unknown }) => void) { onResult = fn; }
    async connect() {}
    async sendSizeChanged() {}
    async sendMessage(m: { content: Array<{ text: string }> }) { sent.push(m.content[0]!.text); }
  }
  const doc = {
    createElement: (tag: string) => new FakeEl(tag),
    getElementById: () => root,
    body: { scrollHeight: 100 },
  };
  const fakeGlobal = { __mcpApps: { App }, __widget: widget };
  const run = new (Object.getPrototypeOf(async () => {}).constructor)("globalThis", "document", page) as (g: unknown, d: unknown) => Promise<void>;
  await run(fakeGlobal, doc);
  return { root, sent, fire: (structuredContent: unknown) => onResult!({ structuredContent }) };
}
