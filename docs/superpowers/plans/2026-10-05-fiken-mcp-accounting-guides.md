# Accounting guides Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Norwegian bookkeeping guides in `guides/`, served to the model through `fiken_read` (`accounting_guides`, `accounting_guide`), announced in the server's connect-time instructions, published as static pages under `/guider/` on the website, plus VAT codes on manual journal entries so the outlay guides can be followed.

**Architecture:** One parser (`guides/parse.mjs`, plain ESM with a `.d.mts`) validates the Markdown guides. The API's bundling hook turns them into `api/src/assets/guides.json`, read once by `src/assets.ts`; a new `guides` concept serves them. A root build script renders the same guides to HTML with `marked` in the deploy's content step. Change detection maps `guides/**` to api + content.

**Tech Stack:** TypeScript 6 (ESM, NodeNext), zod 4, MCP server SDK 2.1, vitest 5, AWS CDK 2.271 NodejsFunction bundling hooks, `marked` 18.0.14 (build time only), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-05-fiken-mcp-accounting-guides-design.md`

## Global Constraints

- Every file change goes through the Edit or Write tool, never a shell command (no `cat >`, heredocs, `sed -i`, `tee`, redirects into files, `cp`). Bash only for reading, searching, building, testing and git.
- Never run `cdk deploy` or any deploy command. Never push. Work on branch `guides`.
- Guides are Norwegian (bokmål). Frontmatter keys exactly: `id`, `tittel`, `når`, `operasjoner`, `kilder`, `gjennomgått`, `oppdatert`.
- Section headings exactly, in order: `## Situasjon`, `## Spør brukeren først`, `## Slik føres det`, `## Dokumentasjon`, `## Vanlige feil`.
- `kilder` hosts: `fiken.no`, `skatteetaten.no`, `lovdata.no` (and their subdomains). A URL is listed only after it was opened and read (WebFetch). Every claim about accounts, VAT codes or rules is backed by a listed source. If a source cannot be found for a claim, the claim is left out.
- `gjennomgått: false` on every guide in this plan.
- Unreviewed line, exactly: `Ikke gjennomgått av regnskapsfører. Be brukeren kontrollere føringen i Fiken.`
- Server instructions, exactly: `Før du fører noe annet enn et vanlig kjøp eller salg: hent accounting_guides med fiken_read og les guiden som passer. Gå gjennom forslaget med brukeren før du skriver noe.`
- Guide bodies contain no raw HTML (the site's CSP forbids inline script/style; contributions arrive as PRs).
- Site pages: `/guider/index.html`, `/guider/<id>.html`; edit link `https://github.com/jonasbarsten/fiken-mcp/edit/main/guides/<id>.md`.
- `marked` pinned exactly at `18.0.14` (checked on npm 2026-10-05), root `devDependencies` only.
- The early-access email address never appears in plain text anywhere.
- Commit trailers on every commit:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01ELoGmasq8hztag5VGsjesY`
- **Checkpoint:** after Task 3 the controller stops and asks Jonas to read the first three guides. Tasks 6 and 7 start only after his go-ahead and carry his corrections.
- **Before Task 5:** PR #43 (which changes `deploy.yml`, `web/index.html`, the web tests) must be merged; rebase `guides` onto `main` first.

## Review Focus

1. A contributed guide with a typo in a heading, an unknown operation, a non-allowed source host or raw HTML must fail CI with the file name and the broken rule, not reach the model or the site. Pinned in Tasks 2 and 3.
2. `accounting_guide` with an unknown, empty or differently-cased id: a tool error that lists the valid ids, never a crash. Pinned in Task 4.
3. A journal entry with VAT codes whose net/gross amounts do not "balance" locally must still reach Fiken (Fiken validates); one without VAT codes keeps the local balance check. Pinned in Task 1.
4. The Lambda cold start must not fail when `guides.json` is missing or stale: the bundling hook always regenerates it, and the API tests read `guides/` directly. Pinned in Task 4.
5. A guide whose frontmatter contains `<`, `&` or quotes must render escaped on the site (no broken HTML, no injected markup). Pinned in Task 5.

---

### Task 1: VAT codes on manual journal entries

**Files:**
- Modify: `api/src/mcp/tools/ledger.ts` (`journalEntryLine`, `create_journal_entry` description and balance check)
- Modify: `api/test/mcp/ledger-more.test.ts`
- Modify: `docs/superpowers/specs/2026-09-22-fiken-mcp-decision-record.md` (dated reversal)

**Interfaces:**
- Produces: `create_journal_entry` lines accept `debitVatCode?: number` and `creditVatCode?: number` (integers ≥ 0), passed through unchanged in the POST body.

- [ ] **Step 1: Change the tests first.** In `api/test/mcp/ledger-more.test.ts`:
  - Rename the test "refuses VAT codes, line projects and a too long description, before any call" to "refuses line projects and a too long description, before any call" and delete its two `vat` lines (`const vat = …` and `expect(vat.isError)…`).
  - Add:

```ts
  it("passes VAT codes through and leaves the balance to Fiken when a line has one", async () => {
    const f = fakeFiken([
      { match: /\/generalJournalEntries$/, status: 201, headers: { location: "https://api.test/v2/companies/demo/transactions/77" } },
      { match: /\/transactions\/77$/, body: transaction },
    ]);
    const c = await connected(f.fetchImpl);
    // Debit is net (100 000 øre plus 25 % VAT), credit is gross: they do not sum to equal, Fiken books the VAT.
    const lines = [{ amount: 100000, debitAccount: "6540", debitVatCode: 1 }, { amount: 125000, creditAccount: "2911" }];
    const r = await callJson(c, "create_journal_entry", { companySlug: "demo", description: "Utlegg Ola", date: "2026-10-05", lines });
    expect(r.isError).toBe(false);
    const body = JSON.parse(String(f.calls[0]!.init!.body)) as { journalEntries: Array<{ lines: unknown[] }> };
    expect(body.journalEntries[0]!.lines).toEqual(lines);
  });

  it("still refuses an unbalanced entry without VAT codes, and a negative VAT code", async () => {
    const f = fakeFiken([]);
    const c = await connected(f.fetchImpl);
    const r = await callJson(c, "create_journal_entry", { companySlug: "demo", description: "x", date: "2026-10-05",
      lines: [{ amount: 100, debitAccount: "6000" }, { amount: 90, creditAccount: "1200" }] });
    expect(r).toMatchObject({ isError: true, text: "The entry does not balance: debit 100 øre, credit 90 øre." });
    const neg = await callJson(c, "create_journal_entry", { companySlug: "demo", description: "x", date: "2026-10-05",
      lines: [{ amount: 100, debitAccount: "6000", debitVatCode: -1 }, { amount: 100, creditAccount: "1200" }] });
    expect(neg.isError).toBe(true);
    expect(f.calls).toHaveLength(0);
  });
```

- [ ] **Step 2: Run, expect failures.** `npm test --workspace api -- ledger-more` → the new pass-through test fails (strict schema refuses `debitVatCode`).

- [ ] **Step 3: Implement.** In `api/src/mcp/tools/ledger.ts`:

```ts
const vatCode = z.number().int().nonnegative();

const journalEntryLine = z
  .object({
    amount: z.number().int().positive().describe(`Amount moved. ${ORE} With a VAT code, a debit line's amount is net (excluding VAT) and a credit line's amount is gross (including VAT); Fiken books the VAT.`),
    debitAccount: z.string().min(1).optional().describe("Account code to debit, from list_accounts (via fiken_read); bank accounts look like 1920:10001"),
    creditAccount: z.string().min(1).optional().describe("Account code to credit, from list_accounts (via fiken_read)"),
    debitVatCode: vatCode.optional().describe("Fiken VAT code for the debit side, e.g. for an expense with deductible input VAT"),
    creditVatCode: vatCode.optional().describe("Fiken VAT code for the credit side"),
  })
  .strict();
```

In `create_journal_entry`: replace the description's sentence `No VAT: book VAT through create_purchase or create_sale (via fiken_write).` with `Lines may carry debitVatCode/creditVatCode; then debit amounts are net and credit amounts gross, and Fiken checks the balance. For outlays and other special cases read the accounting guides first (accounting_guides via fiken_read).` In `run`, before the balance loop:

```ts
      const hasVat = lines.some((l) => l.debitVatCode !== undefined || l.creditVatCode !== undefined);
```

and only compare `debit !== credit` when `!hasVat` (the "every line needs an account" check stays for all lines).

- [ ] **Step 4: Decision record.** Under "Rulings in the coverage plan (2026-09-29)", after the bullet "Manual journal entries are balanced before the call.", add:

```markdown
- **Reversed 2026-10-05: VAT codes on manual journal entries.** The
  accounting guides need an outlay booked as one journal entry with the
  receipt's VAT and the debt on 2911 (Fiken's API cannot mark a purchase
  "Betalt av ansatt"). Lines now accept `debitVatCode`/`creditVatCode`.
  With a VAT code Fiken treats debit amounts as net and credit amounts as
  gross, so the server skips its own balance check and lets Fiken validate;
  without VAT codes the check stays. Jonas decided this in the guides spec.
```

- [ ] **Step 5: Run.** `npm test --workspace api -- ledger-more` passes; then `npm test --workspace api` and `npm run typecheck --workspace api` pass.

- [ ] **Step 6: Commit.**

```bash
git add api/src/mcp/tools/ledger.ts api/test/mcp/ledger-more.test.ts docs/superpowers/specs/2026-09-22-fiken-mcp-decision-record.md
git commit -m "Journal entries: accept VAT codes, let Fiken balance them"
```

---

### Task 2: The guide parser

**Files:**
- Create: `guides/parse.mjs`, `guides/parse.d.mts`
- Test: `api/test/guides-parse.test.ts`

**Interfaces:**
- Produces (`guides/parse.mjs`, typed by `guides/parse.d.mts`):
  - `interface Guide { id: string; tittel: string; når: string; operasjoner: string[]; kilder: string[]; gjennomgått: boolean; oppdatert: string; body: string }`
  - `const HEADINGS: readonly string[]` (the five headings without `## `)
  - `const ALLOWED_SOURCE_HOSTS: readonly string[]` (`["fiken.no", "skatteetaten.no", "lovdata.no"]`)
  - `const GUIDES_DIR: string` (absolute path of `guides/`)
  - `function parseGuide(fileName: string, text: string): Guide` — throws `Error("<fileName>: <rule>")`
  - `function loadGuides(dir?: string): Guide[]` — every `*.md` in `dir` (default `GUIDES_DIR`), parsed, sorted by `id`; throws on duplicate ids.

- [ ] **Step 1: Write the failing test** `api/test/guides-parse.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ALLOWED_SOURCE_HOSTS, HEADINGS, parseGuide } from "../../guides/parse.mjs";

const body = HEADINGS.map((h) => `## ${h}\n\nTekst.\n`).join("\n");
function guide(front: Record<string, string>, text = body): string {
  const base: Record<string, string> = {
    id: "eksempel",
    tittel: "Eksempel",
    "når": "Når noe skjer.",
    operasjoner: "[create_purchase, create_journal_entry]",
    kilder: "\n  - https://hjelp.fiken.no/noe\n  - https://www.skatteetaten.no/x",
    "gjennomgått": "false",
    oppdatert: "2026-10-05",
    ...front,
  };
  const lines = Object.entries(base).map(([k, v]) => (v.startsWith("\n") ? `${k}:${v}` : `${k}: ${v}`));
  return `---\n${lines.join("\n")}\n---\n\n${text}`;
}

describe("parseGuide", () => {
  it("parses frontmatter scalars, inline lists, block lists, booleans and the body", () => {
    const g = parseGuide("eksempel.md", guide({}));
    expect(g).toEqual({
      id: "eksempel",
      tittel: "Eksempel",
      "når": "Når noe skjer.",
      operasjoner: ["create_purchase", "create_journal_entry"],
      kilder: ["https://hjelp.fiken.no/noe", "https://www.skatteetaten.no/x"],
      "gjennomgått": false,
      oppdatert: "2026-10-05",
      body: body.trim(),
    });
    expect(ALLOWED_SOURCE_HOSTS).toEqual(["fiken.no", "skatteetaten.no", "lovdata.no"]);
  });

  it.each([
    ["id differs from the file name", guide({ id: "annet" }), "id must equal the file name"],
    ["id with capitals", guide({ id: "Eksempel" }), "id must equal the file name"],
    ["missing når", guide({ "når": "" }), "når is required"],
    ["missing frontmatter", body, "missing frontmatter"],
    ["no sources", guide({ kilder: "[]" }), "kilder needs at least one https URL"],
    ["http source", guide({ kilder: "[http://hjelp.fiken.no/x]" }), "kilder: http://hjelp.fiken.no/x is not https"],
    ["foreign host", guide({ kilder: "[https://example.com/x]" }), "kilder: example.com is not an allowed host"],
    ["lookalike host", guide({ kilder: "[https://fiken.no.example.com/x]" }), "kilder: fiken.no.example.com is not an allowed host"],
    ["non-boolean gjennomgått", guide({ "gjennomgått": "kanskje" }), "gjennomgått must be true or false"],
    ["bad date", guide({ oppdatert: "5. oktober" }), "oppdatert must be YYYY-MM-DD"],
    ["unknown key", guide({ forfatter: "Jonas" }), "unknown key forfatter"],
    ["heading typo", guide({}, body.replace("## Dokumentasjon", "## Dokumentasjoner")), "headings must be"],
    ["heading order", guide({}, HEADINGS.slice().reverse().map((h) => `## ${h}\n\nx\n`).join("\n")), "headings must be"],
    ["raw HTML", guide({}, `${body}\n<script>alert(1)</script>\n`), "no raw HTML in the body"],
  ])("refuses %s", (_name, text, message) => {
    expect(() => parseGuide("eksempel.md", text)).toThrow(`eksempel.md: ${message}`);
  });

  it("allows ### subsections and an angle bracket in prose that is not a tag", () => {
    const text = body.replace("## Slik føres det\n\nTekst.", "## Slik føres det\n\n### Eksempel\n\nBeløp < 5000 kr.");
    expect(parseGuide("eksempel.md", guide({}, text)).body).toContain("### Eksempel");
  });
});
```

- [ ] **Step 2: Run, expect failure.** `npm test --workspace api -- guides-parse` → cannot find `../../guides/parse.mjs`.

- [ ] **Step 3: Implement** `guides/parse.mjs`:

```js
// Reads and validates the accounting guides in guides/*.md. Used by the API's
// bundling hook (api/scripts/build-guides.mjs), the website build
// (scripts/build-guides.mjs) and the tests, so the model and the site always
// show the same, validated text. Plain ESM with no dependencies, so every
// caller can run it with plain `node`.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const HEADINGS = ["Situasjon", "Spør brukeren først", "Slik føres det", "Dokumentasjon", "Vanlige feil"];
export const ALLOWED_SOURCE_HOSTS = ["fiken.no", "skatteetaten.no", "lovdata.no"];
export const GUIDES_DIR = fileURLToPath(new URL(".", import.meta.url));

const KEYS = ["id", "tittel", "når", "operasjoner", "kilder", "gjennomgått", "oppdatert"];

/** The small YAML subset the guides use: `key: value`, `key: [a, b]`, and `key:` followed by `  - item` lines. */
function parseFrontmatter(fail, lines) {
  const out = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const m = /^([^\s:][^:]*):\s*(.*)$/.exec(line);
    if (!m) fail(`cannot read frontmatter line "${line}"`);
    const [, key, raw] = m;
    if (!KEYS.includes(key)) fail(`unknown key ${key}`);
    if (raw === "") {
      const items = [];
      while (i + 1 < lines.length && /^\s+-\s+/.test(lines[i + 1])) items.push(lines[++i].replace(/^\s+-\s+/, "").trim());
      out[key] = items;
    } else if (raw.startsWith("[") && raw.endsWith("]")) {
      out[key] = raw.slice(1, -1).split(",").map((s) => s.trim()).filter((s) => s !== "");
    } else {
      out[key] = raw.trim().replace(/^"(.*)"$/, "$1");
    }
  }
  return out;
}

export function parseGuide(fileName, text) {
  const fail = (rule) => { throw new Error(`${fileName}: ${rule}`); };
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n"));
  if (!match) fail("missing frontmatter");
  const front = parseFrontmatter(fail, match[1].split("\n"));
  const body = match[2].trim();

  const id = front.id ?? "";
  if (!/^[a-z0-9-]+$/.test(id) || `${id}.md` !== fileName) fail("id must equal the file name (a-z, 0-9, -)");
  for (const key of ["tittel", "når"]) if (typeof front[key] !== "string" || front[key] === "") fail(`${key} is required`);
  const operasjoner = Array.isArray(front.operasjoner) ? front.operasjoner : [];
  if (operasjoner.length === 0) fail("operasjoner needs at least one operation");
  const kilder = Array.isArray(front.kilder) ? front.kilder : [];
  if (kilder.length === 0) fail("kilder needs at least one https URL");
  for (const url of kilder) {
    let parsed;
    try { parsed = new URL(url); } catch { fail(`kilder: ${url} is not a URL`); }
    if (parsed.protocol !== "https:") fail(`kilder: ${url} is not https`);
    const host = parsed.hostname;
    if (!ALLOWED_SOURCE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) fail(`kilder: ${host} is not an allowed host`);
  }
  if (front["gjennomgått"] !== "true" && front["gjennomgått"] !== "false") fail("gjennomgått must be true or false");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(front.oppdatert ?? "")) fail("oppdatert must be YYYY-MM-DD");

  const headings = body.split("\n").filter((l) => /^##\s/.test(l)).map((l) => l.replace(/^##\s+/, "").trim());
  if (JSON.stringify(headings) !== JSON.stringify(HEADINGS)) fail(`headings must be: ${HEADINGS.join(", ")}`);
  if (/<\/?[a-zA-Z][^>]*>/.test(body)) fail("no raw HTML in the body");

  return { id, tittel: front.tittel, "når": front["når"], operasjoner, kilder, "gjennomgått": front["gjennomgått"] === "true", oppdatert: front.oppdatert, body };
}

export function loadGuides(dir = GUIDES_DIR) {
  const guides = readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => parseGuide(f, readFileSync(`${dir.replace(/\/$/, "")}/${f}`, "utf8")))
    .sort((a, b) => a.id.localeCompare(b.id));
  const seen = new Set();
  for (const g of guides) {
    if (seen.has(g.id)) throw new Error(`${g.id}.md: duplicate id`);
    seen.add(g.id);
  }
  return guides;
}
```

Note: `README.md` or `CONTRIBUTING.md` must never be placed in `guides/` (every `.md` there is a guide).

`guides/parse.d.mts`:

```ts
export interface Guide {
  id: string;
  tittel: string;
  "når": string;
  operasjoner: string[];
  kilder: string[];
  "gjennomgått": boolean;
  oppdatert: string;
  body: string;
}
export declare const HEADINGS: readonly string[];
export declare const ALLOWED_SOURCE_HOSTS: readonly string[];
export declare const GUIDES_DIR: string;
export declare function parseGuide(fileName: string, text: string): Guide;
export declare function loadGuides(dir?: string): Guide[];
```

- [ ] **Step 4: Run.** `npm test --workspace api -- guides-parse` passes; `npm run typecheck --workspace api` passes.

- [ ] **Step 5: Commit.**

```bash
git add guides/parse.mjs guides/parse.d.mts api/test/guides-parse.test.ts
git commit -m "Guide parser: frontmatter, sources, headings, no raw HTML"
```

---

### Task 3: The first three guides (then STOP for Jonas)

**Files:**
- Create: `guides/ansattutlegg.md`, `guides/eierutlegg.md`, `guides/privat-kjop.md`
- Test: `api/test/guides.test.ts`

**Interfaces:**
- Consumes: `loadGuides`, `Guide` (Task 2); `getOperation` from `api/src/mcp/registry.ts`.

- [ ] **Step 1: Write the test** `api/test/guides.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadGuides } from "../../guides/parse.mjs";
import { getOperation } from "../src/mcp/registry.js";

describe("the guides in guides/", () => {
  const guides = loadGuides();

  it("all parse and validate", () => {
    expect(guides.length).toBeGreaterThan(0);
  });

  it("name only operations that exist", () => {
    const missing = guides.flatMap((g) => g.operasjoner.filter((op) => !getOperation(op)).map((op) => `${g.id}: ${op}`));
    expect(missing).toEqual([]);
  });

  it("are all unreviewed in this round", () => {
    expect(guides.filter((g) => g["gjennomgått"]).map((g) => g.id)).toEqual([]);
  });
});
```

- [ ] **Step 2: Research and write the three guides.** For each guide, open the sources with WebFetch, read them, and write only what they support. Use the format and headings from the Global Constraints, `gjennomgått: false`, `oppdatert: 2026-10-05`. Plain bokmål, short sentences, concrete account numbers and the server's operations with example inputs (`fiken_write` with `operation` and `args`, amounts in øre).

  - `ansattutlegg` — tittel «Ansatt har lagt ut for firmaet»; når «En ansatt har betalt en utgift for firmaet privat og skal ha pengene tilbake.» Starting sources: https://hjelp.fiken.no/hvordan-registrere-ansattutlegg and https://kontohjelp.fiken.no/enk/medMoms/2911. The guide must settle: Fiken's own way («Betalt av ansatt» on a purchase, debt on 2911); that the API cannot mark a purchase that way, so through this connector it is one `create_journal_entry` with each expense on its account with `debitVatCode` from the receipt and the gross total credited to 2911 (Task 1), plus `attach_inbox_document` for the receipts; the signed utleggsoppstilling Fiken describes; how the repayment is booked (2911 against the bank account) — only as far as the sources say.
  - `eierutlegg` — tittel «Eieren har betalt for firmaet privat»; når «Eieren har betalt en utgift for firmaet med egne penger.» Must distinguish ENK and AS and find, on fiken.no help/kontohjelp, which account Fiken uses for each (do not assume; cite the source). Same API note as ansattutlegg.
  - `privat-kjop` — tittel «Firmaet har betalt noe privat»; når «Firmaet har betalt for noe som er privat, eller delvis privat.» Must cover ENK (privat uttak) and AS (find what Fiken/Skatteetaten say: e.g. receivable on the owner or taxable benefit — only with a source), and that no input VAT is deducted on the private part.

- [ ] **Step 3: Run.** `npm test --workspace api -- guides` passes (all three parse, operations exist).

- [ ] **Step 4: Commit.**

```bash
git add guides/ansattutlegg.md guides/eierutlegg.md guides/privat-kjop.md api/test/guides.test.ts
git commit -m "Guides: employee outlay, owner outlay, private purchase"
```

- [ ] **Step 5: STOP.** The controller shows Jonas the three guides (paths and a short summary of what each says and which sources back it) and waits. Jonas's corrections are applied in a fix round of this task before Task 4 starts, and any general wording or format lessons are carried into Tasks 6 and 7's dispatches.

---

### Task 4: Serve the guides through the MCP server

**Files:**
- Create: `api/scripts/build-guides.mjs`, `api/src/mcp/tools/guides.ts`, `api/test/mcp/guides.test.ts`
- Modify: `api/src/assets.ts`, `api/test/assets.test.ts`, `api/src/mcp/operations.ts` (CONCEPTS), `api/src/mcp/registry.ts`, `api/src/mcp/server.ts`, `api/lib/api-stack.ts` (beforeBundling), `api/package.json` (scripts), `.gitignore`, `api/src/mcp/tools/purchases.ts` (pointer in `create_purchase`)

**Interfaces:**
- Consumes: `loadGuides`, `Guide` (Task 2).
- Produces: `GUIDES_JSON: string` in `api/src/assets.ts`; operations `accounting_guides` and `accounting_guide` (concept `guides`); exported `SERVER_INSTRUCTIONS` and `UNREVIEWED` constants from `api/src/mcp/tools/guides.ts`.

- [ ] **Step 1: Build script** `api/scripts/build-guides.mjs`:

```js
// Writes src/assets/guides.json from guides/*.md for the Lambda. Runs in the
// CDK bundling hook (like build-widget.mjs) and before the tests, so the
// generated file is never stale. Validation lives in guides/parse.mjs.
import { mkdir, writeFile } from "node:fs/promises";
import { loadGuides } from "../../guides/parse.mjs";

const OUT = new URL("../src/assets/guides.json", import.meta.url);
await mkdir(new URL(".", OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(loadGuides()));
```

`api/package.json` scripts: add `"build:guides": "node scripts/build-guides.mjs"` and change `"pretest"` to `"npm run build:widget && npm run build:guides"`.

`.gitignore`: add under the widget lines:

```
# Built by api/scripts/build-guides.mjs from guides/*.md
api/src/assets/guides.json
```

`api/lib/api-stack.ts`: `beforeBundling: (inputDir) => [\`node ${inputDir}/api/scripts/build-widget.mjs\`, \`node ${inputDir}/api/scripts/build-guides.mjs\`],` and extend the comment above it: the guides JSON is generated there for the same reason.

- [ ] **Step 2: Assets.** In `api/src/assets.ts` add:

```ts
/** The accounting guides, as JSON. Produced by scripts/build-guides.mjs from guides/*.md; gitignored. */
export const GUIDES_JSON = readFileSync(new URL("./assets/guides.json", import.meta.url), "utf8");
```

In `api/test/assets.test.ts`, extend "load the built widget and the icon" (rename to "load the built widget, the guides and the icon") with:

```ts
    expect(Array.isArray(JSON.parse(GUIDES_JSON))).toBe(true);
```

and import `GUIDES_JSON`.

- [ ] **Step 3: Failing tests** `api/test/mcp/guides.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadGuides } from "../../../guides/parse.mjs";
import { getOperation } from "../../src/mcp/registry.js";
import { SERVER_INSTRUCTIONS, UNREVIEWED } from "../../src/mcp/tools/guides.js";
import { connected, fakeFiken, operationTexts } from "./helpers.js";
import { OPERATIONS } from "../../src/mcp/registry.js";

type Block = { type: string; text?: string };
async function read(c: Awaited<ReturnType<typeof connected>>, operation: string, args: Record<string, unknown>) {
  const r = await c.callTool({ name: "fiken_read", arguments: { operation, args } });
  return { isError: r.isError === true, text: (r.content as Block[])[0]?.text ?? "" };
}

describe("accounting guides over MCP", () => {
  const guides = loadGuides();

  it("sends the instructions at connect time", async () => {
    const c = await connected(fakeFiken([]).fetchImpl);
    expect(c.getInstructions()).toBe(SERVER_INSTRUCTIONS);
  });

  it("lists every guide with id, tittel, når and gjennomgått, without calling Fiken", async () => {
    const f = fakeFiken([]);
    const c = await connected(f.fetchImpl);
    const r = await read(c, "accounting_guides", {});
    expect(JSON.parse(r.text)).toEqual(guides.map((g) => ({ id: g.id, tittel: g.tittel, "når": g["når"], "gjennomgått": g["gjennomgått"] })));
    expect(f.calls).toHaveLength(0);
  });

  it("returns a guide with its header, sources and the unreviewed line first", async () => {
    const c = await connected(fakeFiken([]).fetchImpl);
    const g = guides[0]!;
    const r = await read(c, "accounting_guide", { id: g.id });
    expect(r.isError).toBe(false);
    expect(r.text.split("\n")[0]).toBe(UNREVIEWED);
    expect(r.text).toContain(`# ${g.tittel}`);
    for (const url of g.kilder) expect(r.text).toContain(url);
    expect(r.text).toContain(g.body);
  });

  it.each(["finnes-ikke", "", "ANSATTUTLEGG"])("answers an unknown id (%j) with the valid ids", async (id) => {
    const c = await connected(fakeFiken([]).fetchImpl);
    const r = await read(c, "accounting_guide", { id });
    expect(r.isError).toBe(true);
    for (const g of guides) expect(r.text).toContain(g.id);
  });

  it("is visible on a read-only connection", async () => {
    const c = await connected(fakeFiken([]).fetchImpl, { options: { readOnly: true } });
    expect((await read(c, "accounting_guides", {})).isError).toBe(false);
  });

  it("only points to guides that exist", () => {
    const ids = new Set(guides.map((g) => g.id));
    const pointers = OPERATIONS.flatMap((op) => operationTexts(op)).flatMap((t) => [...t.matchAll(/accounting guide ([a-z0-9-]+)/g)].map((m) => m[1]!));
    expect(pointers.length).toBeGreaterThan(0);
    expect(pointers.filter((id) => !ids.has(id))).toEqual([]);
    expect(getOperation("accounting_guide")?.kind).toBe("read");
  });
});
```

Run `npm test --workspace api -- mcp/guides` → fails (no module `tools/guides.js`).

- [ ] **Step 4: Implement** `api/src/mcp/tools/guides.ts`:

```ts
import { z } from "zod";
import { GUIDES_JSON } from "../../assets.js";
import type { Guide } from "../../../../guides/parse.mjs";
import { toolJson } from "../context.js";
import { defineOperation, type Operation } from "../operations.js";
import { toolText } from "./common.js";

export const SERVER_INSTRUCTIONS =
  "Før du fører noe annet enn et vanlig kjøp eller salg: hent accounting_guides med fiken_read og les guiden som passer. Gå gjennom forslaget med brukeren før du skriver noe.";
export const UNREVIEWED = "Ikke gjennomgått av regnskapsfører. Be brukeren kontrollere føringen i Fiken.";

const GUIDES: readonly Guide[] = JSON.parse(GUIDES_JSON) as Guide[];
const BY_ID = new Map(GUIDES.map((g) => [g.id, g]));

function render(g: Guide): string {
  const head = [
    ...(g["gjennomgått"] ? [] : [UNREVIEWED, ""]),
    `# ${g.tittel}`,
    "",
    `Når: ${g["når"]}`,
    `Operasjoner: ${g.operasjoner.join(", ")}`,
    "Kilder:",
    ...g.kilder.map((k) => `- ${k}`),
    `Oppdatert: ${g.oppdatert}`,
    "",
  ];
  return `${head.join("\n")}\n${g.body}`;
}

export const guidesOperations: Operation[] = [
  defineOperation({
    name: "accounting_guides",
    concept: "guides",
    kind: "read",
    destructive: false,
    title: "List accounting guides",
    description: "Norwegian bookkeeping guides for cases beyond a plain purchase or sale (outlays, private use, VAT special cases, accruals, assets, credit notes, bad debts). Returns id, tittel, når (when it applies) and gjennomgått for each; read the one that fits with accounting_guide.",
    input: z.object({}),
    async run() {
      return toolJson(GUIDES.map((g) => ({ id: g.id, tittel: g.tittel, "når": g["når"], "gjennomgått": g["gjennomgått"] })));
    },
  }),
  defineOperation({
    name: "accounting_guide",
    concept: "guides",
    kind: "read",
    destructive: false,
    title: "Read an accounting guide",
    description: "One accounting guide by id (from accounting_guides): how to book the case in Fiken with this connector's operations, what to ask the user first, and the sources.",
    input: z.object({ id: z.string().describe("Guide id from accounting_guides, e.g. ansattutlegg") }),
    async run(_ctx, { id }) {
      const g = BY_ID.get(id);
      if (!g) return toolText(`Unknown guide "${id}". Guides: ${GUIDES.map((x) => x.id).join(", ")}.`);
      return { content: [{ type: "text", text: render(g) }] };
    },
  }),
];
```

(If `toolText` lives elsewhere or does not set `isError`, use whatever `ledger.ts` uses for its refusals; check its import before writing.)

`api/src/mcp/operations.ts` CONCEPTS: add `guides: "Accounting guides: how to book special cases in Fiken",` after `usage`.

`api/src/mcp/registry.ts`: import `guidesOperations` and append `...guidesOperations` after `...usageOperations`.

`api/src/mcp/server.ts`: `new McpServer({ name: …, version: …, icons… }, { instructions: SERVER_INSTRUCTIONS })` with the import from `./tools/guides.js`.

`api/src/mcp/tools/purchases.ts` `create_purchase` description: append ` If an employee or the owner paid privately, read accounting guide ansattutlegg or accounting guide eierutlegg first (accounting_guide via fiken_read).`

- [ ] **Step 5: Run.** `npm test --workspace api` (the pretest builds the JSON), `npm run typecheck --workspace api`, `npm run synth --workspace api` all pass. Check `api/cdk.out` (or the synth output dir) contains `assets/guides.json` in the Lambda asset.

- [ ] **Step 6: Commit.**

```bash
git add api/scripts/build-guides.mjs api/src/mcp/tools/guides.ts api/test/mcp/guides.test.ts api/src/assets.ts api/test/assets.test.ts api/src/mcp/operations.ts api/src/mcp/registry.ts api/src/mcp/server.ts api/lib/api-stack.ts api/package.json .gitignore api/src/mcp/tools/purchases.ts
git commit -m "Serve accounting guides through fiken_read, with connect-time instructions"
```

---

### Task 5: The guides on the website

Rebase `guides` onto `main` first (PR #43 must be merged).

**Files:**
- Create: `scripts/build-guides.mjs`, `scripts/build-guides.d.mts`, `iac/test/guides-site.test.ts`
- Modify: root `package.json` (devDependency `marked` 18.0.14, script `build:guides`), `package-lock.json` (via `npm install`, which is allowed: it is a package-manager operation, not a hand edit), `.gitignore`, `web/index.html` (link), `web/style.css` (guide page styles), `iac/test/web-content.test.ts` (generated path), `.github/workflows/deploy.yml` (build before sync), `iac/test/deploy-workflow.test.ts`, `iac/lib/deploy-targets.ts`, `iac/test/deploy-targets.test.ts`

**Interfaces:**
- Consumes: `loadGuides`, `Guide` (Task 2).
- Produces: `renderSite(guides: Guide[]): Map<string, string>` (keys `guider/index.html`, `guider/<id>.html`) and `writeSite(outDir: string, guides?: Guide[]): Promise<void>` in `scripts/build-guides.mjs`; running the file writes into `web/`.

- [ ] **Step 1: Dependency.** `npm install --save-dev --save-exact marked@18.0.14` at the root (workspace root). Add root script `"build:guides": "node scripts/build-guides.mjs"`. `.gitignore`: `web/guider/`.

- [ ] **Step 2: Failing test** `iac/test/guides-site.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadGuides, type Guide } from "../../guides/parse.mjs";
import { renderSite } from "../../scripts/build-guides.mjs";

const guides = loadGuides();
const site = renderSite(guides);

describe("guide pages", () => {
  it("has an index and one page per guide", () => {
    expect([...site.keys()].sort()).toEqual(["guider/index.html", ...guides.map((g) => `guider/${g.id}.html`)].sort());
  });

  it("links every guide from the index, with the unreviewed tag and the contribution note", () => {
    const index = site.get("guider/index.html")!;
    for (const g of guides) expect(index).toContain(`href="/guider/${g.id}.html"`);
    expect(index).toContain("Ikke gjennomgått av regnskapsfører");
    expect(index).toContain("https://github.com/jonasbarsten/fiken-mcp/tree/main/guides");
  });

  it("shows sources, the edit link and the disclaimer on each guide page", () => {
    for (const g of guides) {
      const page = site.get(`guider/${g.id}.html`)!;
      for (const url of g.kilder) expect(page).toContain(`href="${url}"`);
      expect(page).toContain(`https://github.com/jonasbarsten/fiken-mcp/edit/main/guides/${g.id}.md`);
      expect(page).toContain("ikke regnskapsrådgivning");
    }
  });

  it("uses the site's stylesheet and no inline script or style", () => {
    for (const [name, html] of site) {
      expect(html, name).toContain('<html lang="nb">');
      expect(html, name).toContain('href="/style.css"');
      expect(html, name).not.toMatch(/<script/);
      expect(html, name).not.toMatch(/<style|\sstyle=/);
    }
  });

  it("escapes frontmatter text", () => {
    const tricky: Guide = { ...guides[0]!, id: "x", tittel: 'A <b>"&"</b>', "når": "<script>alert(1)</script>" };
    const page = renderSite([tricky]).get("guider/x.html")!;
    expect(page).toContain("A &lt;b&gt;&quot;&amp;&quot;&lt;/b&gt;");
    expect(page).not.toContain("<script>alert(1)</script>");
  });
});
```

Run `npm test --workspace iac -- guides-site` → fails (no module).

- [ ] **Step 3: Implement** `scripts/build-guides.mjs` (with `scripts/build-guides.d.mts` declaring `renderSite(guides: Guide[]): Map<string, string>` and `writeSite(outDir: string, guides?: Guide[]): Promise<void>`, importing `Guide` from `../guides/parse.mjs`):

```js
// Renders guides/*.md to static pages under web/guider/ for the website.
// Runs in the deploy's content step before the sync, and locally with
// `npm run build:guides`. No JavaScript on the pages: the site's CSP allows none inline.
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { marked } from "marked";
import { loadGuides } from "../guides/parse.mjs";

const REPO = "https://github.com/jonasbarsten/fiken-mcp";
const UNREVIEWED = "Ikke gjennomgått av regnskapsfører";

const escape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function page(title, main) {
  return `<!doctype html>
<html lang="nb">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escape(title)} · Fiken MCP</title>
  <link rel="icon" href="/icon.png" type="image/png">
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <main class="guide">
    <p class="crumbs"><a href="/">Fiken MCP</a> › <a href="/guider/index.html">Guider</a></p>
${main}
    <section class="contribute">
      <p>Ser du en feil, eller vil du bidra? Guidene ligger på GitHub. Lag en pull request, eller <a href="${REPO}/issues/new">åpne en sak</a> om du ikke vil skrive selv. <a href="${REPO}/tree/main/guides">Guidene på GitHub</a></p>
      <p class="muted">Guidene er ikke regnskapsrådgivning. Kontroller føringen med regnskapsføreren din.</p>
    </section>
  </main>
</body>
</html>
`;
}

export function renderSite(guides) {
  const files = new Map();
  const items = guides
    .map((g) => `      <li><a href="/guider/${g.id}.html">${escape(g.tittel)}</a>${g["gjennomgått"] ? "" : ` <span class="tag">${UNREVIEWED}</span>`}<br><span class="muted">${escape(g["når"])}</span></li>`)
    .join("\n");
  files.set("guider/index.html", page("Guider", `    <h1>Guider</h1>
    <p>Dette er guidene Claude og ChatGPT får når de fører noe annet enn et vanlig kjøp eller salg i Fiken.</p>
    <ul class="guides">
${items}
    </ul>`));
  for (const g of guides) {
    const sources = g.kilder.map((k) => `<li><a href="${escape(k)}">${escape(k)}</a></li>`).join("");
    files.set(`guider/${g.id}.html`, page(g.tittel, `    <h1>${escape(g.tittel)}</h1>
    ${g["gjennomgått"] ? "" : `<p class="tag">${UNREVIEWED}</p>`}
    <p class="lead">${escape(g["når"])}</p>
${marked.parse(g.body, { async: false })}
    <h2>Kilder</h2>
    <ul>${sources}</ul>
    <p class="muted">Sist oppdatert ${escape(g.oppdatert)} · <a href="${REPO}/edit/main/guides/${g.id}.md">Rediger på GitHub</a></p>`));
  }
  return files;
}

export async function writeSite(outDir, guides = loadGuides()) {
  for (const [name, html] of renderSite(guides)) {
    const path = `${outDir}/${name}`;
    await mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    await writeFile(path, html);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await writeSite(fileURLToPath(new URL("../web", import.meta.url)));
}
```

`web/style.css`: add small styles for `.guide` (same width as `main`), `.crumbs`, `.tag` (like `.ui` but muted, inline), `.guides li` spacing, `.contribute`. No new colours beyond the existing variables.

`web/index.html`, in the «Hva den kan» section after the read-only address: `<p><a href="/guider/index.html">Se guidene Claude og ChatGPT får om føring i Fiken</a></p>`.

`iac/test/web-content.test.ts`: in "references only files the site serves", treat `guider/index.html` as served (generated by `scripts/build-guides.mjs`, checked in `guides-site.test.ts`), next to the existing `icon.png` mapping.

- [ ] **Step 4: Deploy wiring.**
  - `iac/lib/deploy-targets.ts`: `guides/**` → `["content", "api"]`; `scripts/**` → `["content"]`. Add both rows to `iac/test/deploy-targets.test.ts` (`["guides/ansattutlegg.md", ["content", "api"]]`, `["guides/parse.mjs", ["content", "api"]]`, `["scripts/build-guides.mjs", ["content"]]`) and update any spec table row in the website spec section 2.3 with a dated note.
  - `.github/workflows/deploy.yml` content step: before `aws s3 sync`, add `node scripts/build-guides.mjs` (the deploy job already ran `npm ci`). Keep action pins. In `iac/test/deploy-workflow.test.ts` assert the content step contains `node scripts/build-guides.mjs` before the sync line (index of one < index of the other).

- [ ] **Step 5: Run.** `npm test` at the root, `npm run typecheck`, `npm run synth`. Then `npm run build:guides` and serve `web/` locally (`python3 -m http.server 4176 --bind 127.0.0.1 --directory web`) and open `/guider/index.html` and one guide in a browser if available; stop the server after.

- [ ] **Step 6: Commit.**

```bash
git add scripts package.json package-lock.json .gitignore web/index.html web/style.css iac/test/guides-site.test.ts iac/test/web-content.test.ts .github/workflows/deploy.yml iac/test/deploy-workflow.test.ts iac/lib/deploy-targets.ts iac/test/deploy-targets.test.ts docs/superpowers/specs/2026-10-03-fiken-mcp-website-design.md
git commit -m "Guides on the website: generated pages under /guider, built in the content step"
```

---

### Task 6: VAT and period guides (7)

Starts after Jonas's go-ahead at the Task 3 checkpoint; carry his corrections.

**Files:** Create `guides/representasjon.md`, `guides/gaver.md`, `guides/snudd-avregning.md`, `guides/delvis-fradrag.md`, `guides/forskuddsbetalt.md`, `guides/periodisering.md`, `guides/driftsmidler.md`. Modify `api/src/mcp/tools/ledger.ts` (`create_accrual` description pointer) only if a guide fits it.

- [ ] **Step 1: Research and write.** Same rules as Task 3 Step 2 (WebFetch every source before listing it; only sourced claims; the server's operations with example inputs). What each guide must settle, from its sources:
  - `representasjon` («Representasjon»; når «Firmaet har betalt mat, drikke eller underholdning for kunder eller forretningsforbindelser.»): that input VAT is not deductible on entertainment, which accounts Fiken uses, the documentation (who attended, purpose), and how it is booked with `create_purchase` (no VAT deduction).
  - `gaver` («Gaver til kunder og ansatte»): the limits and rules for deduction and VAT that Skatteetaten states, the accounts Fiken uses, the difference between customer gifts and employee gifts.
  - `snudd-avregning` («Tjenester kjøpt fra utlandet»): reverse charge for services bought from abroad: the VAT codes Fiken uses and how a purchase is booked through this connector; if `create_purchase` cannot carry the needed VAT code, say so and give the journal-entry alternative (Task 1).
  - `delvis-fradrag` («Utgifter som brukes både i og utenfor mva-pliktig virksomhet»): proportional deduction as Skatteetaten describes it, and how to book the split.
  - `forskuddsbetalt` («Forskuddsbetalte kostnader»): prepaid costs over several periods and how `create_accrual` covers it (accounts 1700-range per the operation's description).
  - `periodisering` («Periodisering av kostnader og inntekter»): when to accrue, `create_accrual` for sales and purchases, its limits (as the operation's description lists).
  - `driftsmidler` («Kjøp som skal aktiveres og avskrives»): the thresholds Skatteetaten sets (value and lifetime), the 12xx accounts, depreciation booked with `create_journal_entry`.

- [ ] **Step 2: Run** `npm test --workspace api -- guides` and `npm test --workspace iac -- guides-site`.

- [ ] **Step 3: Commit** `git add guides api/src/mcp/tools/ledger.ts && git commit -m "Guides: VAT special cases, periods and assets"`.

---

### Task 7: Sales correction guides (3)

Starts after Jonas's go-ahead at the Task 3 checkpoint; carry his corrections.

**Files:** Create `guides/kreditere-og-fakturere-pa-nytt.md`, `guides/delvis-kreditering.md`, `guides/tap-pa-fordringer.md`. Modify `api/src/mcp/tools/credit-notes.ts` (`create_credit_note` description) and `api/src/mcp/tools/sales.ts` (`write_off_sale` description) with an `accounting guide <id>` pointer each.

- [ ] **Step 1: Research and write.** Same rules as Task 3 Step 2. Must settle:
  - `kreditere-og-fakturere-pa-nytt`: full credit note on an issued invoice (`create_credit_note`), then a new invoice (`create_invoice_draft` → `create_invoice_from_draft`), and that issued invoices are never deleted.
  - `delvis-kreditering`: partial credit (what `create_credit_note` supports for partial; check its input), when to use it instead of a full credit.
  - `tap-pa-fordringer`: when a receivable may be written off as a loss (Skatteetaten's conditions), `write_off_sale`, the VAT correction on realised losses as far as the sources say, and payments with fees or cash (`settle_sale`, `register_payment`, `paymentFee`) in «Vanlige feil» or «Slik føres det» where relevant.

- [ ] **Step 2: Run** `npm test --workspace api` (pointer test) and `npm test --workspace iac -- guides-site`.

- [ ] **Step 3: Commit** `git add guides api/src/mcp/tools/credit-notes.ts api/src/mcp/tools/sales.ts && git commit -m "Guides: credit notes and bad debts"`.

---

### Task 8: Docs

**Files:** Create `CONTRIBUTING.md`. Modify `README.md`, `docs/setup.md`, `CLAUDE.md`, `docs/superpowers/specs/2026-09-22-fiken-mcp-design.md` (section 14).

- [ ] **Step 1: CONTRIBUTING.md** (English, short): how to correct or add a guide (edit on GitHub or a PR), the frontmatter keys and the five headings, the allowed source hosts and the rule that every claim needs a source, `gjennomgått` stays `false` unless an accountant reviewed it, no raw HTML, `npm test` runs the checks, and how to preview the pages (`npm run build:guides`, then serve `web/`).
- [ ] **Step 2: README.** A «Guides» section: what they are, how the model gets them (connect-time instructions, `accounting_guides`/`accounting_guide` via `fiken_read`), that they are published at `https://fiken-mcp.byjoba.com/guider/index.html`, that they are unreviewed, and a link to `CONTRIBUTING.md`. Mention that `create_journal_entry` accepts VAT codes (Task 1).
- [ ] **Step 3: docs/setup.md.** A «Verify after deploying the guides plan» list: `/guider/index.html` and a guide page load; `fiken_read accounting_guides` lists all 13; `accounting_guide ansattutlegg` starts with the unreviewed line; a live outlay on the demo company: `create_journal_entry` with `debitVatCode` against 2911, read back with its VAT line (record the VAT code used and Fiken's response).
- [ ] **Step 4: CLAUDE.md** Process paragraph: «Guides plan executed 2026-10-05 (`guides/`, `accounting_guides`, `/guider/`; see `docs/superpowers/plans/2026-10-05-fiken-mcp-accounting-guides.md`).» Design spec section 14: a bullet that accounting guides exist and the eval set is next.
- [ ] **Step 5: Run** `npm test`; commit `git add CONTRIBUTING.md README.md docs/setup.md CLAUDE.md docs/superpowers/specs/2026-09-22-fiken-mcp-design.md && git commit -m "Docs: accounting guides, contributing"`.

## After the plan

Push `guides`, open a PR to `main`. After it deploys: run the setup.md verify list, including the live journal entry with VAT on the demo company.
