# Fiken's help for the model: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the model read Fiken's own help articles live (`fiken_help_index`, `fiken_help_article` through `fiken_read`), translate Fiken's screens into this connector's operations with a short list of connector notes, announce it in connect-time instructions, and accept VAT codes on manual journal entries.

**Architecture:** A small help client (`api/src/help/client.ts`) fetches `https://hjelp.fiken.no/llms.txt` and `<slug>.md` with an injectable `fetch`, a host check, a timeout, a size cap and a one-hour in-memory cache; it joins the tool context next to the Fiken client. A new `help` concept serves two read operations; `api/src/help/notes.ts` holds the connector notes appended to every article.

**Tech Stack:** TypeScript 6 (ESM, NodeNext), zod 4, MCP server SDK 2.1 (`McpServer` options `instructions`), vitest 5.

**Spec:** `docs/superpowers/specs/2026-10-05-fiken-mcp-accounting-guides-design.md`

## Global Constraints

- Every file change goes through the Edit or Write tool, never a shell command (no `cat >`, heredocs, `sed -i`, `tee`, redirects into files). Bash only for reading, searching, building, testing and git.
- Never run `cdk deploy` or any deploy command. Never push. Work on branch `guides`.
- Only `https://hjelp.fiken.no` is fetched; slug regex `^[a-z0-9-]+$`; timeout 5000 ms; at most 500 000 bytes; cache TTL 3 600 000 ms; failures are not cached.
- Deprioritise line, exactly: `Fiken marks this article as less relevant for chatbots; prefer another article if one fits.`
- Server instructions, exactly: `For anything other than a plain purchase or sale, look the case up in Fiken's own help first: fiken_help_index with a query, then fiken_help_article. The articles describe Fiken's screens; translate them with the connector notes at the end of each article. Go through the proposed booking with the user before writing anything.`
- No Fiken API call from the help operations (no token, not queued). No user data in help requests.
- The early-access email address never appears in plain text anywhere.
- Commit trailers on every commit:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01ELoGmasq8hztag5VGsjesY`
- Task 4 changes `web/index.html`: PR #43 must be merged first; rebase `guides` onto `main` before Task 4.

## Review Focus

1. `hjelp.fiken.no` down, slow or answering HTML (e.g. a maintenance page) instead of Markdown: a clear tool error or an empty index, never a crash or a half-parsed article. Pinned in Task 2 (non-Markdown index → no entries; article without frontmatter still returned as body).
2. A slug the model invents (`../x`, `ansattutlegg.md`, capitals, empty): refused before any fetch. Pinned in Task 2.
3. A redirect from `hjelp.fiken.no` to another host: refused. Pinned in Task 2.
4. A journal entry with VAT codes whose net/gross amounts do not balance locally still reaches Fiken; one without VAT keeps the local check. Pinned in Task 1.
5. A query with no matches: an empty list plus a hint to try fewer or other words, not an error. Pinned in Task 3.

---

### Task 1: VAT codes on manual journal entries

**Files:**
- Modify: `api/src/mcp/tools/ledger.ts` (`journalEntryLine`, `create_journal_entry` description and balance check)
- Modify: `api/test/mcp/ledger-more.test.ts`
- Modify: `docs/superpowers/specs/2026-09-22-fiken-mcp-decision-record.md`

**Interfaces:**
- Produces: `create_journal_entry` lines accept `debitVatCode?: number`, `creditVatCode?: number` (non-negative integers), passed through unchanged.

- [ ] **Step 1: Change the tests first** in `api/test/mcp/ledger-more.test.ts`:
  - Rename "refuses VAT codes, line projects and a too long description, before any call" to "refuses line projects and a too long description, before any call" and delete its two `vat` lines.
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

- [ ] **Step 2: Run, expect failure:** `npm test --workspace api -- ledger-more`.

- [ ] **Step 3: Implement** in `api/src/mcp/tools/ledger.ts`:

```ts
const vatCode = z.number().int().nonnegative();

const journalEntryLine = z
  .object({
    amount: z.number().int().positive().describe(`Amount moved. ${ORE} With a VAT code, a debit line's amount is net (excluding VAT) and a credit line's amount is gross (including VAT); Fiken books the VAT.`),
    debitAccount: z.string().min(1).optional().describe("Account code to debit, from list_accounts (via fiken_read); bank accounts look like 1920:10001"),
    creditAccount: z.string().min(1).optional().describe("Account code to credit, from list_accounts (via fiken_read)"),
    debitVatCode: vatCode.optional().describe("Fiken VAT code for the debit side, e.g. an expense with deductible input VAT"),
    creditVatCode: vatCode.optional().describe("Fiken VAT code for the credit side"),
  })
  .strict();
```

In `create_journal_entry`'s description, replace `No VAT: book VAT through create_purchase or create_sale (via fiken_write).` with `This is «Fri postering» in Fiken's help. Lines may carry debitVatCode/creditVatCode; then debit amounts are net and credit amounts gross, and Fiken checks the balance.` In `run`, compute `const hasVat = lines.some((l) => l.debitVatCode !== undefined || l.creditVatCode !== undefined);` and compare `debit !== credit` only when `!hasVat` (the "every line needs an account" check stays).

- [ ] **Step 4: Decision record.** Under "Rulings in the coverage plan (2026-09-29)", after "Manual journal entries are balanced before the call.", add:

```markdown
- **Reversed 2026-10-05: VAT codes on manual journal entries.** Fiken's
  help answers outlays and private use with «Fri postering», and an
  employee's outlay needs one journal entry with the receipt's VAT and the
  debt on 2911 (the API cannot mark a purchase "Betalt av ansatt"). Lines
  now accept `debitVatCode`/`creditVatCode`. With a VAT code Fiken treats
  debit amounts as net and credit amounts as gross, so the server skips its
  own balance check and lets Fiken validate; without VAT codes the check
  stays. Jonas decided this in the Fiken help spec.
```

- [ ] **Step 5: Run** `npm test --workspace api` and `npm run typecheck --workspace api`.

- [ ] **Step 6: Commit** `git add api/src/mcp/tools/ledger.ts api/test/mcp/ledger-more.test.ts docs/superpowers/specs/2026-09-22-fiken-mcp-decision-record.md && git commit -m "Journal entries: accept VAT codes, let Fiken balance them"`.

---

### Task 2: The help client

**Files:**
- Create: `api/src/help/client.ts`, `api/test/help/client.test.ts`

**Interfaces:**
- Produces:

```ts
export interface HelpIndexEntry { slug: string; title: string }
export interface HelpArticle { slug: string; title: string; lastUpdated?: string; url: string; deprioritized: boolean; body: string }
export interface HelpClient {
  index(): Promise<HelpIndexEntry[]>;
  article(slug: string): Promise<HelpArticle>;
}
export class HelpError extends Error {}
export const HELP_BASE = "https://hjelp.fiken.no";
export function createHelpClient(opts?: { fetch?: typeof fetch; now?: () => number; ttlMs?: number; timeoutMs?: number; maxBytes?: number }): HelpClient;
export function filterIndex(entries: HelpIndexEntry[], query: string | undefined): HelpIndexEntry[];
```

- [ ] **Step 1: Failing tests** `api/test/help/client.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { HelpError, createHelpClient, filterIndex } from "../../src/help/client.js";

const INDEX = `# Hjelp og kundeservice for Fiken

Hver artikkel finnes også som Markdown ved å legge til \`.md\` på URL-en.
---

- [Hvordan registrere ansattutlegg](https://hjelp.fiken.no/hvordan-registrere-ansattutlegg.md)
- [Arbeidsforhold og lønn ](https://hjelp.fiken.no/arbeidsforhold-og-loenn.md)
- [Øreavrunding](https://hjelp.fiken.no/oereavrunding.md)
- [Elsewhere](https://example.com/x.md)
`;

const ARTICLE = `---
title: "Hvordan registrere ansattutlegg"
last_updated: 2026-09-25T09:48:44Z
chatbot_deprioritize: false
source_url:
  canonical: https://hjelp.fiken.no/hvordan-registrere-ansattutlegg
  markdown: https://hjelp.fiken.no/hvordan-registrere-ansattutlegg.md
---

# Hvordan registrere ansattutlegg

Kjøpet registreres på vanlig måte.

![Skjermbilde](https://cdn.example/a.png)

Sammen med kjøpet skal det lastes opp en utleggsoppstilling.
`;

function fakeFetch(routes: Record<string, { status?: number; body?: string; url?: string; headers?: Record<string, string> }>) {
  const calls: string[] = [];
  const impl: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    const r = routes[url];
    if (!r) return new Response("not found", { status: 404 });
    const res = new Response(r.body ?? "", { status: r.status ?? 200, headers: r.headers });
    Object.defineProperty(res, "url", { value: r.url ?? url });
    return res;
  };
  return { impl, calls };
}

describe("help client", () => {
  it("parses the index: only hjelp.fiken.no Markdown links, titles trimmed", async () => {
    const f = fakeFetch({ "https://hjelp.fiken.no/llms.txt": { body: INDEX } });
    const help = createHelpClient({ fetch: f.impl });
    expect(await help.index()).toEqual([
      { slug: "hvordan-registrere-ansattutlegg", title: "Hvordan registrere ansattutlegg" },
      { slug: "arbeidsforhold-og-loenn", title: "Arbeidsforhold og lønn" },
      { slug: "oereavrunding", title: "Øreavrunding" },
    ]);
  });

  it("returns no entries when the index is not the expected Markdown", async () => {
    const f = fakeFetch({ "https://hjelp.fiken.no/llms.txt": { body: "<!doctype html><title>Vedlikehold</title>" } });
    expect(await createHelpClient({ fetch: f.impl }).index()).toEqual([]);
  });

  it("filters by every word of the query, case-insensitively", () => {
    const all = [
      { slug: "a", title: "Hvordan registrere ansattutlegg" },
      { slug: "b", title: "Ansattutlegg med Reiser og utlegg" },
      { slug: "c", title: "Øreavrunding" },
    ];
    expect(filterIndex(all, "ANSATTUTLEGG registrere").map((e) => e.slug)).toEqual(["a"]);
    expect(filterIndex(all, "øre").map((e) => e.slug)).toEqual(["c"]);
    expect(filterIndex(all, undefined)).toEqual(all);
    expect(filterIndex(all, "   ")).toEqual(all);
  });

  it("parses an article: frontmatter, canonical URL, body without image lines", async () => {
    const f = fakeFetch({ "https://hjelp.fiken.no/hvordan-registrere-ansattutlegg.md": { body: ARTICLE } });
    const a = await createHelpClient({ fetch: f.impl }).article("hvordan-registrere-ansattutlegg");
    expect(a).toMatchObject({
      slug: "hvordan-registrere-ansattutlegg",
      title: "Hvordan registrere ansattutlegg",
      lastUpdated: "2026-09-25T09:48:44Z",
      url: "https://hjelp.fiken.no/hvordan-registrere-ansattutlegg",
      deprioritized: false,
    });
    expect(a.body).toContain("Sammen med kjøpet");
    expect(a.body).not.toContain("![Skjermbilde]");
    expect(a.body).not.toContain("last_updated");
  });

  it("reads chatbot_deprioritize and keeps an article without frontmatter as body", async () => {
    const f = fakeFetch({
      "https://hjelp.fiken.no/a.md": { body: ARTICLE.replace("chatbot_deprioritize: false", "chatbot_deprioritize: true") },
      "https://hjelp.fiken.no/b.md": { body: "# Bare tekst\n\nInnhold." },
    });
    const help = createHelpClient({ fetch: f.impl });
    expect((await help.article("a")).deprioritized).toBe(true);
    expect(await help.article("b")).toMatchObject({ title: "b", url: "https://hjelp.fiken.no/b", body: "# Bare tekst\n\nInnhold." });
  });

  it.each(["../x", "ansattutlegg.md", "Ansattutlegg", "", "a b"])("refuses the slug %j before any fetch", async (slug) => {
    const f = fakeFetch({});
    await expect(createHelpClient({ fetch: f.impl }).article(slug)).rejects.toBeInstanceOf(HelpError);
    expect(f.calls).toEqual([]);
  });

  it("refuses a redirect to another host, a 404, and an oversized body", async () => {
    const f = fakeFetch({
      "https://hjelp.fiken.no/away.md": { body: ARTICLE, url: "https://example.com/away.md" },
      "https://hjelp.fiken.no/big.md": { body: "x".repeat(20) },
    });
    const help = createHelpClient({ fetch: f.impl, maxBytes: 10 });
    await expect(help.article("away")).rejects.toThrow(/outside hjelp.fiken.no/);
    await expect(help.article("missing")).rejects.toThrow(/fiken_help_index/);
    await expect(help.article("big")).rejects.toThrow(/too large/);
  });

  it("times out", async () => {
    const slow: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("timeout", "TimeoutError")));
    });
    await expect(createHelpClient({ fetch: slow, timeoutMs: 10 }).index()).rejects.toThrow(/did not answer/);
  });

  it("caches answers for the TTL, and does not cache failures", async () => {
    let now = 0;
    let fail = true;
    const calls: string[] = [];
    const impl: typeof fetch = async (input) => {
      calls.push(String(input));
      if (fail) return new Response("err", { status: 503 });
      return new Response(INDEX);
    };
    const help = createHelpClient({ fetch: impl, now: () => now, ttlMs: 1000 });
    await expect(help.index()).rejects.toBeInstanceOf(HelpError);
    fail = false;
    await help.index();
    await help.index();
    expect(calls).toHaveLength(2);
    now = 1001;
    await help.index();
    expect(calls).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run, expect failure:** `npm test --workspace api -- help/client`.

- [ ] **Step 3: Implement** `api/src/help/client.ts`:

```ts
/**
 * Reads Fiken's public help for the model: the llms.txt index and each
 * article as Markdown. Only hjelp.fiken.no, with a timeout, a size cap and a
 * short in-memory cache so a busy conversation does not refetch the index.
 * No token and no user data is ever sent: these are public pages.
 */

export interface HelpIndexEntry { slug: string; title: string }
export interface HelpArticle { slug: string; title: string; lastUpdated?: string; url: string; deprioritized: boolean; body: string }
export interface HelpClient {
  index(): Promise<HelpIndexEntry[]>;
  article(slug: string): Promise<HelpArticle>;
}

export class HelpError extends Error {}

export const HELP_BASE = "https://hjelp.fiken.no";
const HOST = "hjelp.fiken.no";
const SLUG = /^[a-z0-9-]+$/;
const INDEX_LINE = /^- \[(.+)\]\(https:\/\/hjelp\.fiken\.no\/([a-z0-9-]+)\.md\)\s*$/;
const IMAGE_LINE = /^\s*!\[[^\]]*\]\([^)]*\)\s*$/;

export function filterIndex(entries: HelpIndexEntry[], query: string | undefined): HelpIndexEntry[] {
  const words = (query ?? "").toLowerCase().split(/\s+/).filter((w) => w !== "");
  if (words.length === 0) return entries;
  return entries.filter((e) => {
    const title = e.title.toLowerCase();
    return words.every((w) => title.includes(w));
  });
}

function parseIndex(text: string): HelpIndexEntry[] {
  const out: HelpIndexEntry[] = [];
  for (const line of text.split("\n")) {
    const m = INDEX_LINE.exec(line.trim());
    if (m) out.push({ slug: m[2]!, title: m[1]!.trim() });
  }
  return out;
}

function parseArticle(slug: string, text: string): HelpArticle {
  const normal = text.replace(/\r\n/g, "\n");
  const fm = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normal);
  const front = fm?.[1] ?? "";
  const rest = fm ? fm[2]! : normal;
  const field = (key: string) => new RegExp(`^\\s*${key}:\\s*(.+)$`, "m").exec(front)?.[1]?.trim().replace(/^"(.*)"$/, "$1");
  const body = rest
    .split("\n")
    .filter((l) => !IMAGE_LINE.test(l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return {
    slug,
    title: field("title") ?? slug,
    lastUpdated: field("last_updated"),
    url: field("canonical") ?? `${HELP_BASE}/${slug}`,
    deprioritized: field("chatbot_deprioritize") === "true",
    body,
  };
}

export function createHelpClient(opts: { fetch?: typeof fetch; now?: () => number; ttlMs?: number; timeoutMs?: number; maxBytes?: number } = {}): HelpClient {
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? 3_600_000;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const maxBytes = opts.maxBytes ?? 500_000;
  const cache = new Map<string, { at: number; text: string }>();

  async function get(path: string): Promise<string> {
    const hit = cache.get(path);
    if (hit && now() - hit.at < ttlMs) return hit.text;
    const url = `${HELP_BASE}/${path}`;
    let res: Response;
    try {
      res = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "text/markdown, text/plain" } });
    } catch {
      throw new HelpError(`Fiken's help (${url}) did not answer.`);
    }
    if (res.url && new URL(res.url).hostname !== HOST) throw new HelpError(`Refusing a redirect outside hjelp.fiken.no (${res.url}).`);
    if (res.status === 404) throw new HelpError(`No help article at ${url}. Find the right slug with fiken_help_index.`);
    if (!res.ok) throw new HelpError(`Fiken's help answered ${res.status} for ${url}.`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new HelpError(`The help page ${url} is too large (${bytes.byteLength} bytes).`);
    const text = new TextDecoder().decode(bytes);
    cache.set(path, { at: now(), text });
    return text;
  }

  return {
    async index() {
      return parseIndex(await get("llms.txt"));
    },
    async article(slug) {
      if (!SLUG.test(slug)) throw new HelpError(`"${slug}" is not a help article slug (a-z, 0-9, -). Find it with fiken_help_index.`);
      return parseArticle(slug, await get(`${slug}.md`));
    },
  };
}
```

- [ ] **Step 4: Run** `npm test --workspace api -- help/client` and `npm run typecheck --workspace api`.

- [ ] **Step 5: Commit** `git add api/src/help/client.ts api/test/help/client.test.ts && git commit -m "Help client: Fiken's llms.txt and articles, host-checked, cached"`.

---

### Task 3: Operations, connector notes, instructions

**Files:**
- Create: `api/src/help/notes.ts`, `api/src/mcp/tools/help.ts`, `api/test/mcp/help.test.ts`
- Modify: `api/src/mcp/context.ts` (`ToolContext.help`), `api/src/mcp/routes.ts` (create the help client), every other place a `ToolContext` is built (find them with `npm run typecheck --workspace api` after adding the field; at least `api/test/mcp/helpers.ts`), `api/src/mcp/operations.ts` (CONCEPTS), `api/src/mcp/registry.ts`, `api/src/mcp/server.ts` (instructions), and the descriptions of `create_purchase`, `create_accrual`, `create_credit_note`, `write_off_sale` (pointers).

**Interfaces:**
- Consumes: `HelpClient`, `createHelpClient`, `filterIndex`, `HelpError` (Task 2).
- Produces: `ToolContext.help: HelpClient`; `CONNECTOR_NOTES: string` and `NOTE_OPERATIONS: readonly string[]` in `notes.ts`; `SERVER_INSTRUCTIONS`, `DEPRIORITIZED` in `tools/help.ts`; operations `fiken_help_index { query? }` and `fiken_help_article { slug }` in concept `help`.

- [ ] **Step 1: Notes** `api/src/help/notes.ts`. Write the notes from spec section 3 as one Markdown block under the heading `## Connector notes (fiken-mcp)`, and export the list of operation names it mentions:

```ts
/** Operations the notes name; a test checks each exists, so the notes cannot drift from the registry. */
export const NOTE_OPERATIONS = [
  "create_journal_entry", "create_purchase", "upload_receipts", "get_upload_url", "attach_inbox_document",
  "list_accounts", "create_invoice_draft", "create_invoice_from_draft", "send_invoice", "create_credit_note",
  "create_accrual", "write_off_sale",
] as const;

export const CONNECTOR_NOTES = `## Connector notes (fiken-mcp)

Fiken's help describes Fiken's screens. With this connector:

- «Fri postering» (Annet → Fri postering) is create_journal_entry via fiken_write. Amounts are in øre. With a VAT code (debitVatCode/creditVatCode), a debit line's amount is net and a credit line's amount is gross.
- «Nytt kjøp» (Kjøp → Nytt kjøp) is create_purchase: kind cash_purchase with a bank paymentAccount, or kind supplier with supplierId and dueDate. Receipts come in through upload_receipts or get_upload_url, or from the inbox, and are linked with inboxDocumentId.
- «Betalt av ansatt» or «betalt privat» under Betaling on a purchase is not available in the API. Book it as one create_journal_entry: each expense on its account with its VAT code, the gross total credited to the account the article names (2911 for an employee), and attach the receipts with attach_inbox_document.
- Accounts written like 2930:1000X are an account with a person or contact sub-account; find the exact code with list_accounts.
- «Ny faktura» is create_invoice_draft, then create_invoice_from_draft; sending is send_invoice. A credit note is create_credit_note. Accruals («periodisering») are create_accrual. Writing off a sale is write_off_sale.
- This connector cannot delete, reverse or cancel anything, run payroll («Lønn»), use the «Reiser og utlegg» add-on, or do year-end. When an article needs that, tell the user to do it in Fiken.
`;
```

Before committing, check each statement against the operations' actual inputs in `api/src/mcp/tools/*.ts` (e.g. that `create_purchase` takes `inboxDocumentId`, that `upload_receipts`/`get_upload_url` exist as tools, the `kind` values) and correct the text to match the code; list any change in the report.

- [ ] **Step 2: Failing tests** `api/test/mcp/help.test.ts`. Extend `connected()` in `api/test/mcp/helpers.ts` with an optional `helpFetch?: typeof fetch` that builds `createHelpClient({ fetch: helpFetch ?? (async () => new Response("", { status: 404 })) })` into the context. Then:

```ts
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
    expect(JSON.parse((await read(c, "fiken_help_index", {})).text)).toHaveLength(2);
    expect(JSON.parse((await read(c, "fiken_help_index", { query: "ansattutlegg" })).text)).toEqual([
      { slug: "hvordan-registrere-ansattutlegg", title: "Hvordan registrere ansattutlegg" },
    ]);
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
```

(`upload_receipts` and `get_upload_url` are real tools outside the registry; keep the exception, or check them against the server's tool list instead if simpler. Adjust the `pointing` list if the pointer wording lands on a different set, as long as the five spec pointers are in it.)

Run `npm test --workspace api -- mcp/help` → fails.

- [ ] **Step 3: Implement.**
  - `api/src/mcp/context.ts`: add `help: HelpClient;` to `ToolContext` (import type from `../help/client.js`).
  - `api/src/mcp/routes.ts`: build one help client per Lambda container (module scope: `const help = createHelpClient({ fetch: cfg.fetch })` if `cfg.fetch` is available where routes are created; otherwise create it once next to the config) and pass `help` in the context. Fix every other context construction the typecheck reports.
  - `api/src/mcp/operations.ts` CONCEPTS: add `help: "Fiken's own help articles, and how they map to this connector",`.
  - `api/src/mcp/tools/help.ts`:

```ts
import { z } from "zod";
import { CONNECTOR_NOTES } from "../../help/notes.js";
import { HelpError, filterIndex } from "../../help/client.js";
import { toolJson } from "../context.js";
import { defineOperation, type Operation } from "../operations.js";
import { toolText } from "./common.js";

export const SERVER_INSTRUCTIONS =
  "For anything other than a plain purchase or sale, look the case up in Fiken's own help first: fiken_help_index with a query, then fiken_help_article. The articles describe Fiken's screens; translate them with the connector notes at the end of each article. Go through the proposed booking with the user before writing anything.";
export const DEPRIORITIZED = "Fiken marks this article as less relevant for chatbots; prefer another article if one fits.";

export const helpOperations: Operation[] = [
  defineOperation({
    name: "fiken_help_index",
    concept: "help",
    kind: "read",
    destructive: false,
    title: "Search Fiken's help",
    description: "Titles and slugs of Fiken's own help articles (hjelp.fiken.no), for cases beyond a plain purchase or sale: outlays, private use, VAT special cases, accruals, assets, credit notes, losses. Pass a query (words that must all appear in the title, e.g. \"utlegg\"); the full list is long. Then read one with fiken_help_article.",
    input: z.object({ query: z.string().optional().describe("Words that must all appear in the title, e.g. utlegg or representasjon") }),
    async run(ctx, { query }) {
      try {
        const hits = filterIndex(await ctx.help.index(), query);
        if (hits.length === 0 && query?.trim()) return toolJson({ articles: [], hint: `No titles match all of: ${query.trim()}. Try fewer or other words.` });
        return toolJson(hits);
      } catch (err) {
        if (err instanceof HelpError) return toolText(err.message);
        throw err;
      }
    },
  }),
  defineOperation({
    name: "fiken_help_article",
    concept: "help",
    kind: "read",
    destructive: false,
    title: "Read a Fiken help article",
    description: "One of Fiken's help articles as Markdown, by slug from fiken_help_index, followed by notes on how its steps map to this connector's operations.",
    input: z.object({ slug: z.string().describe("Slug from fiken_help_index, e.g. hvordan-registrere-ansattutlegg") }),
    async run(ctx, { slug }) {
      try {
        const a = await ctx.help.article(slug);
        const head = [`# ${a.title}`, "", `Source: ${a.url}`, ...(a.lastUpdated ? [`Last updated: ${a.lastUpdated}`] : []), ...(a.deprioritized ? ["", DEPRIORITIZED] : []), ""];
        return { content: [{ type: "text" as const, text: `${head.join("\n")}\n${a.body}\n\n${CONNECTOR_NOTES.trim()}` }] };
      } catch (err) {
        if (err instanceof HelpError) return toolText(err.message);
        throw err;
      }
    },
  }),
];
```

  (Check how `toolText` and the other helpers are imported in `ledger.ts` and that `toolText` sets `isError`; use the same imports.)
  - `api/src/mcp/registry.ts`: append `...helpOperations`.
  - `api/src/mcp/server.ts`: `new McpServer({ … }, { instructions: SERVER_INSTRUCTIONS })`.
  - Pointers: append to the descriptions of `create_purchase`, `create_accrual`, `create_credit_note`, `write_off_sale` (and the existing `create_journal_entry` text from Task 1 gets the same) a sentence containing `fiken_help_index`, e.g. ` For outlays or anything unusual, look it up first with fiken_help_index (via fiken_read).`

- [ ] **Step 4: Run** `npm test --workspace api`, `npm run typecheck --workspace api`, `npm run synth --workspace api`.

- [ ] **Step 5: Check the live formats (read-only).** Run `curl -sL https://hjelp.fiken.no/llms.txt | head -12` and `curl -sL https://hjelp.fiken.no/hvordan-registrere-ansattutlegg.md | head -12` and confirm they still match the parsers (index lines `- [Title](https://hjelp.fiken.no/<slug>.md)`, frontmatter keys `title`, `last_updated`, `chatbot_deprioritize`, `canonical`). Note the result in the report.

- [ ] **Step 6: Commit** `git add api && git commit -m "Fiken's help through fiken_read, with connector notes and connect-time instructions"`.

---

### Task 4: Website, README, docs

Rebase `guides` onto `main` first (PR #43 must be merged).

**Files:** Modify `web/index.html`, `README.md`, `docs/setup.md`, `CLAUDE.md`, `docs/superpowers/specs/2026-09-22-fiken-mcp-design.md` (section 14).

- [ ] **Step 1: Landing page.** In «Hva den kan», after the read-only address, add: `<p>Når noe er mer enn et vanlig kjøp eller salg, slår Claude og ChatGPT opp i <a href="https://hjelp.fiken.no">Fikens egne hjelpeartikler</a> før de foreslår en føring.</p>` Run `npm test --workspace iac -- web-content`.
- [ ] **Step 2: README.** A «Fiken's help» section after «Tools»: the two operations, that articles are fetched live from `hjelp.fiken.no` (its `llms.txt` and `.md` pages) and cached in memory for at most an hour, the connector notes appended to each article, the connect-time instructions, and that nothing is stored. Mention that `create_journal_entry` accepts VAT codes. Add the two operations to the README's operation list if it has one.
- [ ] **Step 3: docs/setup.md.** «Verify after deploying the Fiken help plan»: `fiken_help_index { query: "utlegg" }` returns articles; `fiken_help_article { slug: "hvordan-registrere-ansattutlegg" }` returns the article with the connector notes; Claude shows the instructions behaviour (asks to look things up); a live outlay on the demo company: `create_journal_entry` with `debitVatCode` against 2911 (record the VAT code used and Fiken's response, and that the entry shows the VAT line).
- [ ] **Step 4: CLAUDE.md** Process paragraph: «Fiken help plan executed 2026-10-05 (`fiken_help_index`, `fiken_help_article`, VAT codes on journal entries; see `docs/superpowers/plans/2026-10-05-fiken-mcp-accounting-guides.md`). Next: the eval set, deletes decision, ChatGPT verification.» Design spec section 14: a bullet for the Fiken help access.
- [ ] **Step 5: Run** `npm test`; commit `git add web/index.html README.md docs/setup.md CLAUDE.md docs/superpowers/specs/2026-09-22-fiken-mcp-design.md && git commit -m "Docs and site: Fiken's help for the model"`.

## After the plan

Push `guides`, open a PR to `main`. After it deploys: the setup.md verify list, including the live journal entry with VAT on the demo company.
