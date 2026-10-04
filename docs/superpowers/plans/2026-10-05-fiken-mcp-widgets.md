# Choice and booking preview widgets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two MCP App widgets with text fallbacks: `ask_user_choice` (buttons for any choice; a click puts the answer into the chat) and `preview_booking` (validates a proposed write without writing and shows it, with «Før dette» / «Endre»), plus instructions that tell the model to use them.

**Architecture:** Widget logic lives in small ESM modules (`api/src/widget/choice.mjs`, `preview.mjs`) that take a minimal DOM and a `send(text)` callback, so vitest can test them with a fake DOM. The build script inlines each module next to the MCP Apps bundle into its HTML template, as it already does for the upload widget. Server-side, `preview_booking` reuses the operation's strict schema and a journal-entry check function extracted from `create_journal_entry`.

**Tech Stack:** TypeScript 6, zod 4, MCP server SDK 2.1, `@modelcontextprotocol/ext-apps` (`registerAppTool`, `registerAppResource`, `RESOURCE_MIME_TYPE`, client `App`), vitest 5.

**Spec:** `docs/superpowers/specs/2026-10-05-fiken-mcp-widgets-design.md`

## Global Constraints

- Every file change goes through the Edit or Write tool, never a shell command. Bash only for reading, searching, building, testing and git.
- Never deploy, never push. Work on branch `widgets` (stacked on `vat-verified`, PR #45; rebase onto `main` when #45 merges).
- Stable resource URIs: `ui://fiken-mcp/choice.html`, `ui://fiken-mcp/preview.html` (hard rule: never versioned per build).
- Widgets: no network (`connectDomains` empty or absent), no `innerHTML`, DOM built with `textContent`; buttons disabled after a click; Norwegian UI text.
- Click messages, exactly: choice → `<label>` or `<label> (<value>)` when value differs from label; preview → `Ja, før dette.` / `Jeg vil endre noe før det føres.`
- Fallback frame words, exactly: `Spurte brukeren: `, `Vent på svaret i chatten.`, `Ingenting er ført ennå.`, `Kan ikke føres slik:`
- `ask_user_choice` input: question 1–200 chars; 2–12 options; label 1–80; value 1–200; description ≤ 160; values unique; `allowOther` optional boolean.
- Neither tool calls Fiken. Both are read-only (`readOnlyHint: true`) and counted with `counted()`.
- The early-access email address never appears anywhere.
- Commit trailers on every commit:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01ELoGmasq8hztag5VGsjesY`

## Review Focus

1. Option labels, descriptions or preview values containing `<script>`, `&` or quotes must render as text in the widget, never as markup. Pinned in Tasks 1 and 2 (fake DOM records textContent only; a test asserts no `innerHTML` use).
2. A double click on a choice or «Før dette» must send exactly one message. Pinned in Tasks 1 and 2.
3. `preview_booking` for a read operation, an unknown operation or args that fail the schema must not crash the widget: a tool error or a «Kan ikke føres slik» preview. Pinned in Task 2.
4. A client without widget support gets a complete text result it can act on (numbered options; a Markdown table ending «Ingenting er ført ennå.»). Pinned in Tasks 1 and 2.
5. `preview_booking` must never write: no Fiken call in any path. Pinned in Task 2.

---

### Task 1: Generic build, the choice widget and `ask_user_choice`

**Files:**
- Modify: `api/scripts/build-widget.mjs` (build every widget)
- Create: `api/src/widget/choice.mjs`, `api/src/widget/choice.template.html`, `api/src/mcp/tools/choice.ts`, `api/test/widget-choice.test.ts`, `api/test/mcp/choice.test.ts`
- Modify: `api/src/assets.ts` (`CHOICE_HTML`), `api/test/assets.test.ts`, `api/test/widget.test.ts` (still passes), `.gitignore` (`api/src/assets/choice.html`, `api/src/assets/preview.html`), `api/src/mcp/server.ts` (register), `api/test/mcp/gateway.test.ts` (tool list)

**Interfaces:**
- Produces: `api/src/widget/choice.mjs` exporting `renderChoice(doc, root, data, send)` and `choiceMessage(option)`; `CHOICE_RESOURCE_URI = "ui://fiken-mcp/choice.html"`, `registerChoiceTool(server, ctx)` and `choiceFallback(input)` in `api/src/mcp/tools/choice.ts`; the build script's `WIDGETS` list that Task 2 extends.

- [ ] **Step 1: Generalize the build.** In `api/scripts/build-widget.mjs`, replace the single template/out pair with a list:

```js
const WIDGETS = [
  {
    name: "upload",
    bundles: [
      ["/*__BUNDLE__*/", "@modelcontextprotocol/ext-apps/app-with-deps", "__mcpApps"],
      ["/*__PDFJS__*/", "pdfjs-dist/build/pdf.min.mjs", "__pdfjs"],
      ["/*__PDFJS_WORKER__*/", "pdfjs-dist/build/pdf.worker.min.mjs", "__pdfjsWorker"],
    ],
  },
  {
    name: "choice",
    bundles: [
      ["/*__BUNDLE__*/", "@modelcontextprotocol/ext-apps/app-with-deps", "__mcpApps"],
      ["/*__LOGIC__*/", new URL("../src/widget/choice.mjs", import.meta.url), "__widget"],
    ],
  },
];
```

`inlineEsm` must accept either a package specifier (resolved with `require.resolve`) or a `URL` (read with `readFile`). Each widget reads `src/widget/<name>.template.html` and writes `src/assets/<name>.html`, with its own version stamp. `main()` loops over `WIDGETS`. The log line prints each widget. Keep the existing upload output byte-for-byte equivalent (same bundles, same order) so `api/test/widget.test.ts` keeps passing unchanged.

- [ ] **Step 2: Failing logic test** `api/test/widget-choice.test.ts` with a tiny fake DOM:

```ts
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
});
```

Run `npm test --workspace api -- widget-choice` → fails (no module).

- [ ] **Step 3: Implement** `api/src/widget/choice.mjs` (no imports; plain DOM via the passed `doc`; ends with a single trailing `export { renderChoice, choiceMessage };` so the build's `inlineEsm` can rewrite it):

```js
// Renders a multiple-choice question for the choice widget. Takes the
// document and a send(text) callback so tests can run it with a fake DOM.
// Text only: every string goes into textContent, never into HTML.

function choiceMessage(option) {
  return option.value === option.label ? option.label : `${option.label} (${option.value})`;
}

function renderChoice(doc, root, data, send) {
  let done = false;
  const buttons = [];
  const finish = (text, chosen) => {
    if (done) return;
    done = true;
    for (const b of buttons) b.disabled = true;
    if (chosen) chosen.className = `${chosen.className} chosen`.trim();
    send(text);
  };

  const q = doc.createElement("p");
  q.className = "question";
  q.textContent = data.question;
  root.append(q);

  for (const option of data.options) {
    const b = doc.createElement("button");
    b.type = "button";
    b.className = "option";
    const label = doc.createElement("span");
    label.className = "label";
    label.textContent = option.label;
    b.append(label);
    if (option.description) {
      const d = doc.createElement("span");
      d.className = "description";
      d.textContent = option.description;
      b.append(d);
    }
    b.addEventListener("click", () => finish(choiceMessage(option), b));
    buttons.push(b);
    root.append(b);
  }

  if (data.allowOther) {
    const row = doc.createElement("div");
    row.className = "other";
    const input = doc.createElement("input");
    input.type = "text";
    input.placeholder = "Annet …";
    const b = doc.createElement("button");
    b.type = "button";
    b.textContent = "Send";
    b.addEventListener("click", () => {
      const text = String(input.value ?? "").trim();
      if (text !== "") finish(text, b);
    });
    buttons.push(b);
    row.append(input, b);
    root.append(row);
  }
}

export { renderChoice, choiceMessage };
```

Add a `choice.mjs.d.ts`-style declaration if TypeScript needs one to import it in tests (`api/src/widget/choice.d.mts` declaring both functions with loose types).

`api/src/widget/choice.template.html`: same head pattern as `upload.template.html` (charset, viewport, `<title>Velg</title>`, a `<style>` with `.option` as full-width buttons, `.description` smaller and muted, `.chosen` marked, `.other` row, dark-mode colours like the upload widget), a `<div id="root"></div>`, then:

```html
  <script type="module">/*__BUNDLE__*/</script>
  <script type="module">/*__LOGIC__*/</script>
  <script type="module">
    const { App } = globalThis.__mcpApps;
    const { renderChoice } = globalThis.__widget;
    const app = new App({ name: "Fiken choice", version: "1.0.0" });
    const root = document.getElementById("root");
    const syncSize = () => app.sendSizeChanged({ height: document.body.scrollHeight }).catch(() => {});
    app.ontoolresult = (params) => {
      const sc = params.structuredContent;
      if (!sc?.question || !Array.isArray(sc.options)) return;
      root.replaceChildren();
      renderChoice(document, root, sc, (text) => {
        app.sendMessage({ role: "user", content: [{ type: "text", text }] }).catch((e) => console.error("sendMessage failed", e));
      });
      syncSize();
    };
    await app.connect();
  </script>
```

- [ ] **Step 4: Tool tests** `api/test/mcp/choice.test.ts`:

```ts
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
    expect(JSON.stringify(tool._meta)).toContain("ui://fiken-mcp/choice.html");
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
```

(Adjust `_meta` / resource assertions to how `registerAppTool`/`registerAppResource` expose them, as `upload.test.ts` does for the upload widget; duplicate-value refusal comes from a zod `.refine` or `superRefine` on the options array.)

Run → fails.

- [ ] **Step 5: Implement** `api/src/mcp/tools/choice.ts`:
  - `CHOICE_RESOURCE_URI = "ui://fiken-mcp/choice.html"`.
  - zod input per the Global Constraints, `.strict()`, unique values via `superRefine`.
  - `choiceFallback({ question, options })` builds the exact text from the test.
  - `registerChoiceTool(server, ctx)`: `registerAppTool(server, "ask_user_choice", { title: "Ask the user to choose", description, inputSchema, annotations: { readOnlyHint: true }, _meta: { ui: { resourceUri: CHOICE_RESOURCE_URI } } }, counted(ctx, "ask_user_choice", async (args) => ({ content: [{ type: "text", text: choiceFallback(args) }], structuredContent: { question, options, allowOther: args.allowOther ?? false } })))` and `registerAppResource` for the URI with `RESOURCE_MIME_TYPE` and `CHOICE_HTML` (no `csp.connectDomains`).
  - Description: «Show the user a question with 2–12 options as buttons (in clients that render widgets; others get a numbered list). The answer comes back as the user's next chat message. Use it whenever the user must choose: which company, which customer or supplier, which account, or between alternatives you propose. Fill options from the read operations (e.g. list_companies, search_contacts, list_accounts).»
  - `api/src/assets.ts`: `export const CHOICE_HTML = readFileSync(new URL("./assets/choice.html", import.meta.url), "utf8");`
  - `api/src/mcp/server.ts`: register on every connection (also read-only and concept-filtered: it writes nothing).
  - `api/test/mcp/gateway.test.ts`: add `ask_user_choice` to the expected tool list.

- [ ] **Step 6: Run** `npm test --workspace api` (pretest builds the widgets), `npm run typecheck --workspace api`, `npm run synth --workspace api`. Check `api/src/assets/choice.html` contains `globalThis.__widget=` and no `innerHTML`; add those two assertions to `api/test/widget-choice.test.ts` reading the built file.

- [ ] **Step 7: Commit** `git add api .gitignore && git commit -m "Choice widget: ask_user_choice with buttons and a text fallback"`.

---

### Task 2: Booking preview: `preview_booking`

**Files:**
- Modify: `api/src/mcp/tools/ledger.ts` (extract `checkJournalLines`)
- Create: `api/src/mcp/preview.ts`, `api/src/widget/preview.mjs` (+ `.d.mts`), `api/src/widget/preview.template.html`, `api/src/mcp/tools/preview.ts`, `api/test/mcp/preview.test.ts`, `api/test/widget-preview.test.ts`
- Modify: `api/scripts/build-widget.mjs` (add `preview` to `WIDGETS`), `api/src/assets.ts` (`PREVIEW_HTML`), `api/src/mcp/server.ts`, `api/test/mcp/gateway.test.ts`

**Interfaces:**
- Consumes: `WIDGETS` (Task 1), `getOperation` (registry), the operation's `input` schema.
- Produces: `checkJournalLines(lines): string | undefined` exported from `ledger.ts`; `buildPreview(op, args): Preview` in `api/src/mcp/preview.ts` where

```ts
export interface Preview {
  operation: string;
  title: string;
  companySlug?: string;
  summary: Array<{ label: string; value: string }>;
  lines?: { columns: string[]; rows: string[][] };
  totals?: Array<{ label: string; value: string }>;
  checks: "ok" | string[];
}
```

`formatKroner(ore: number): string` (e.g. `1 234,56 kr` with a no-break space before `kr`, using `Intl.NumberFormat("nb-NO", { minimumFractionDigits: 2, maximumFractionDigits: 2 })`).

- [ ] **Step 1: Extract the journal checks.** Move the loop's checks in `create_journal_entry.run` into

```ts
/** The checks create_journal_entry makes before calling Fiken; undefined when the lines may be sent. */
export function checkJournalLines(lines: z.output<typeof journalEntryLine>[]): string | undefined
```

returning the same messages (every line needs an account; VAT code needs its account; the balance check only without VAT codes). `run` calls it and returns `toolText(message)` when set. Existing tests must pass unchanged.

- [ ] **Step 2: Failing tests** `api/test/mcp/preview.test.ts` (through the MCP client, like `choice.test.ts`):
  - unknown operation → `isError` with `Unknown operation`; a read operation (`list_sales`) → `isError` saying it only previews writes.
  - `create_journal_entry` with the outlay lines from `docs/setup.md` (debit 6540 100 000 code 1, credit 2911 125 000): `structuredContent.checks === "ok"`, `lines.columns` includes `debitAccount`, `amount` cells formatted `1 000,00 kr` and `1 250,00 kr`, totals include «Fiken beregner mva» since a VAT code is present; text ends `Ingenting er ført ennå.`; `f.calls` is empty.
  - The same without VAT codes and unbalanced (100 / 90): `checks` is `["The entry does not balance: debit 100 øre, credit 90 øre."]`, text contains `Kan ikke føres slik:`.
  - Args failing the schema (`create_journal_entry` with `lines: []`): `checks` holds the prettified zod error (not a crash), `isError` false (the widget shows it).
  - `create_purchase` (cash, one line): summary contains `Dato` and `Type`, money in kroner, checks ok.
  - Read-only tool annotation and the `ui://fiken-mcp/preview.html` resource, as in Task 1.

  And `api/test/widget-preview.test.ts` with the Task 1 fake DOM (copy the `FakeEl` helper): renders title, summary rows, the lines table (all cells via textContent), totals; «Før dette» sends `Ja, før dette.` once and disables both buttons; «Endre» sends `Jeg vil endre noe før det føres.`; with `checks` a list, only «Endre» is shown and the messages are listed under «Kan ikke føres slik:».

- [ ] **Step 3: Implement.**
  - `api/src/mcp/preview.ts`: `buildPreview(op, args)`:
    - parse with `op.input.strict().safeParse(args)`; on failure `checks = [z.prettifyError(error)]` and summary from the raw args.
    - `summary`: top-level scalar args except `lines`, with labels from a map (`companySlug` Foretak, `date` Dato, `description` Beskrivelse, `kind` Type, `supplierId` Leverandør (id), `customerId` Kunde (id), `contactId` Kontakt (id), `dueDate` Forfall, `paymentAccount` Betalingskonto, `paymentDate` Betalingsdato, `inboxDocumentId` Vedlegg (innboks-id), `projectId` Prosjekt (id), `currency` Valuta); unknown keys keep their name.
    - `lines`: when `args.lines` is an array of objects, `columns` = union of keys in first-seen order, `rows` = cells as strings; keys in `MONEY = ["amount", "net", "vat", "gross", "netPrice", "unitPrice"]` formatted with `formatKroner` (check in `api/src/mcp/tools/*.ts` that each of these is øre where used; drop any that is not and say so in the report).
    - `totals` for `create_journal_entry`: sum of amounts on debit-only lines and credit-only lines as kroner, plus `{ label: "Mva", value: "Fiken beregner mva" }` when any line has a VAT code.
    - `checks`: for `create_journal_entry` after a successful parse, `checkJournalLines(lines)`; `"ok"` otherwise.
    - `title`: the operation's `title`.
  - `api/src/mcp/tools/preview.ts`: `registerPreviewTool(server, ctx, visible)`: input `{ operation: string, args: record }` strict; unknown op → `toolText("Unknown operation \"…\". Call fiken_explore to see what exists.")`; read op → `toolText("preview_booking only previews writes; … is a read.")`; otherwise `buildPreview` and return `{ content: [{ type: "text", text: markdown(preview) }], structuredContent: preview }`, where `markdown` renders title, summary as `- label: value`, the lines as a Markdown table, totals, then either nothing or `Kan ikke føres slik:` with the messages, and always the last line `Ingenting er ført ennå.` Register with `registerAppTool` (`readOnlyHint: true`, `_meta.ui.resourceUri: "ui://fiken-mcp/preview.html"`) and the resource with `PREVIEW_HTML`. Only operations visible on the connection may be previewed (pass the visible list, as the gateway does); register the tool only when the connection may write.
  - `api/src/widget/preview.mjs`: `renderPreview(doc, root, preview, send)` building title, summary list, a `table` (thead from `columns`, rows), totals, the checks list, and the buttons per the Global Constraints, one send per render, all text via `textContent`; trailing `export { renderPreview };`. Template like the choice template, with table styles.
  - Build: add `{ name: "preview", bundles: [BUNDLE, ["/*__LOGIC__*/", new URL("../src/widget/preview.mjs", import.meta.url), "__widget"]] }`.
  - `assets.ts`: `PREVIEW_HTML`. `server.ts`: register (when writes are allowed). `gateway.test.ts`: tool list.

- [ ] **Step 4: Run** `npm test --workspace api`, `npm run typecheck --workspace api`, `npm run synth --workspace api`.

- [ ] **Step 5: Commit** `git add api && git commit -m "Booking preview widget: preview_booking validates and shows a write without writing"`.

---

### Task 3: Instructions, pointers, docs

**Files:** Modify `api/src/mcp/tools/help.ts` (`SERVER_INSTRUCTIONS`), the descriptions of `list_companies`, `search_contacts`, `list_accounts` (pointer to ask_user_choice) and the `fiken_write` gateway description (pointer to preview_booking) in `api/src/mcp/gateway.ts`, tests that pin those texts, `README.md`, `docs/setup.md`, `CLAUDE.md`, `docs/superpowers/specs/2026-09-22-fiken-mcp-design.md` (section 14).

- [ ] **Step 1: Instructions.** Append to `SERVER_INSTRUCTIONS`: ` When the user must choose between options (company, customer, account, alternatives), call ask_user_choice instead of asking in text. Before any write, call preview_booking with the operation and args and wait for the user's answer.` Update the help spec's section 4 quote and the widgets spec section 5 if wording differs.
- [ ] **Step 2: Pointers.** `list_companies`, `search_contacts`, `list_accounts`: append ` When there are several to choose from, let the user pick with ask_user_choice.` `fiken_write`: append ` Show the write with preview_booking first and wait for the user's answer.` Add a test asserting each pointer exists (`operationTexts` / tool descriptions).
- [ ] **Step 3: Docs.** README: the two widget tools (what they show, the text fallback, that they never write), in the Tools section next to `upload_receipts`. `docs/setup.md`: «Verify after deploying the widgets plan» — in Claude (web and iOS): ask «Hvilket foretak?» → buttons, a click fills the chat; a journal entry preview with «Før dette»; in Claude Code: numbered list and Markdown table fallback. `CLAUDE.md` process line; design spec section 14 bullet.
- [ ] **Step 4: Run** `npm test`; commit `git add api README.md docs CLAUDE.md && git commit -m "Instructions and docs: use the choice and preview widgets"`.

## After the plan

Push `widgets`, open a PR (base `main` once #45 merged). After deploy: the setup.md verify list on Claude web and iOS and in Claude Code.
