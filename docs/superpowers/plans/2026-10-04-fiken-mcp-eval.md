# Evaluation Set Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local runner that plays fixed accounting cases through the live connector with Claude, never writes to Fiken, and grades the booking the model proposes.

**Architecture:** A new `eval/` workspace. `loop.ts` drives a conversation through the Anthropic Messages API and executes tool calls itself against an MCP client (`mcp.ts`, OAuth through the browser, token in memory); write tools are never forwarded. The proposal (a blocked write or the last `preview_booking`) is converted to postings (`postings.ts`) and compared with the case's expectations (`grade.ts`); `report.ts` writes a Markdown report.

**Tech Stack:** TypeScript (NodeNext, strict), `@anthropic-ai/sdk`, `@modelcontextprotocol/client` 2.1.0, vitest 5, tsx.

**Spec:** `docs/superpowers/specs/2026-10-04-fiken-mcp-eval-design.md`

## Global Constraints

- Every file change through the Edit or Write tool; never a shell command that writes files. Bash only for reading, searching, building, testing and git.
- Nothing is ever written to Fiken: no tool without `annotations.readOnlyHint === true` is forwarded to the server.
- No secrets on disk or in the repo: `ANTHROPIC_API_KEY` from the environment only; the OAuth token in memory only.
- Model ids only in `eval/src/models.ts`: `sonnet` → `claude-sonnet-5-5`, `opus` → `claude-opus-5-5`.
- Default API: `https://api.fiken-mcp.byjoba.com`; demo company slug `fiken-demo-amerikansk-hytte-as3`; its bank account `1920:10001`.
- Amounts in øre everywhere.
- Report language Norwegian; code, comments and identifiers English, matching `api/`.
- Exact dependency versions (`--save-exact`), as the rest of the repo pins.
- Results go to `eval/results/` (gitignored).
- `eval/**` changes trigger no deploy (`iac/lib/deploy-targets.ts` already returns `[]` for unknown paths); the root `package.json` / `package-lock.json` changes in Task 1 trigger one full deploy, which is harmless.
- Never deploy, never push to main. Commit trailers:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01ELoGmasq8hztag5VGsjesY`

## Review Focus

1. The model passes `fiken_write`'s `args` as a JSON string, not an object → the proposal still carries the parsed args (test in Task 3).
2. One model turn holds a read and a write tool call → the read is forwarded, the write is blocked and the conversation ends (test in Task 3).
3. `preview_booking` reports failed checks → the simulated user asks for a correction instead of approving (test in Task 3).
4. A proposal whose operation has no converter (e.g. `create_contact`) → graded on `operations` only, with a note, not a crash (test in Task 2).
5. A journal VAT code other than 1 or 3 → the posting carries «kode N», the balance is not checked, and a note says so (tests in Tasks 1 and 2).

## Rulings made while planning

- Ruling: `expect.args` (a subset of the proposal's args that must be equal, e.g. `{ saleId: 818874095 }`) is added to the case type — why: payments and full credit notes are only right if they target the right invoice, which postings cannot show — cost if wrong: one optional field. Task 5 adds it to the spec.
- Ruling: the 503 retry lives in a `fetch` wrapper passed to the MCP transport, not in the loop — why: the transport's error type for HTTP status is not part of its API, and the wrapper is a pure function to test — cost if wrong: none.
- Ruling: the simulated user's choice and form answers reuse the widgets' own `choiceMessage` and `formMessage` (`api/src/widget/*.mjs`) — why: the answers then match what a real click sends — cost if wrong: none.
- Ruling: the model sees each tool's text content (as claude.ai does), falling back to the JSON of `structuredContent` when there is none.

---

### Task 1: Workspace, case type and postings

**Files:**
- Modify: `package.json` (root)
- Modify: `.gitignore`
- Create: `eval/package.json`, `eval/tsconfig.json`, `eval/vitest.config.ts`
- Create: `eval/cases/types.ts`
- Create: `eval/src/postings.ts`
- Test: `eval/test/postings.test.ts`

**Interfaces:**
- Produces: `Case`, `Expected`, `Replies`, `Area` (cases/types.ts); `Side`, `Posting`, `Proposal`, `Converted`, `isRate(vat)`, `toPostings(proposal): Converted | undefined`, `CONVERTERS` (src/postings.ts).

- [ ] **Step 1: Workspace files**

Root `package.json`: add `"eval"` to `workspaces`, make synth skip workspaces without it, and add an `eval` script:

```json
{
  "name": "fiken-mcp",
  "private": true,
  "workspaces": ["api", "iac", "eval"],
  "engines": { "node": ">=24" },
  "scripts": {
    "typecheck": "npm run typecheck --workspaces",
    "test": "npm test --workspaces",
    "synth": "npm run synth --workspaces --if-present",
    "eval": "npm run eval --workspace eval --"
  }
}
```

`eval/package.json`:

```json
{
  "name": "@fiken-mcp/eval",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "eval": "tsx src/cli.ts"
  }
}
```

Then install, which fills in exact versions:

```bash
npm install --save-exact --workspace eval @anthropic-ai/sdk @modelcontextprotocol/client@2.1.0
npm install --save-exact --save-dev --workspace eval @types/node@24.19.0 tsx@4.23.15 typescript@6.0.3 vitest@5.0.2
```

`eval/tsconfig.json`:

```json
{
  "extends": "../tsconfig.base.json",
  "include": ["src", "cases", "test"]
}
```

`eval/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
});
```

`.gitignore`: add the line `eval/results/`.

- [ ] **Step 2: The case type**

`eval/cases/types.ts`:

```ts
export type Area = "kjøp" | "utlegg" | "salg" | "bilag";

/** One posting a case expects. account: exact codes, or a prefix ending in * (1920* matches 1920:10001). Amounts in øre. */
export type Expected = {
  side: "debit" | "credit";
  account: string[];
  /** Net amount (before VAT). */
  net?: number;
  /** Gross amount (net plus VAT). */
  amount?: number;
  /** VAT rate: "25", "15", "12" or "0". */
  vat?: string;
};

export type Replies = {
  /** The companySlug the simulated user chooses. */
  company: string;
  /** Answers for ask_user_form, by field name. */
  form?: Record<string, string>;
  /** Answers for ask_user_choice by a fragment of the question: option value or label. */
  choices?: Record<string, string>;
  /** The answer to anything else. */
  default: string;
};

export type Case = {
  id: string;
  area: Area;
  prompt: string;
  replies: Replies;
  expect: {
    operations: string[];
    postings: Expected[];
    /** Args that must equal these values (compared as JSON). */
    args?: Record<string, unknown>;
    /** Default true: no posting beyond the expected ones. */
    exact?: boolean;
    behaviour?: { previewFirst?: boolean; askChoice?: boolean; readHelp?: boolean };
  };
  /** The hjelp.fiken.no article the expected booking follows. */
  source: string;
  /** False until an accountant has checked the case. */
  reviewed: boolean;
};
```

- [ ] **Step 3: Write the failing converter tests**

`eval/test/postings.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { toPostings, type Proposal } from "../src/postings.js";

const p = (operation: string, args: Record<string, unknown>): Proposal => ({ operation, args, via: "preview" });

describe("toPostings", () => {
  it("journal entry: a side with VAT code 1 is net at 25 %, a side without is as given", () => {
    const c = toPostings(p("create_journal_entry", { lines: [{ amount: 40000, debitAccount: "6800", debitVatCode: 1 }, { amount: 50000, creditAccount: "2911" }] }));
    expect(c!.postings).toEqual([
      { side: "debit", account: "6800", net: 40000, vat: "25", vatAmount: 10000 },
      { side: "credit", account: "2911", net: 50000, vat: undefined, vatAmount: 0 },
    ]);
    expect(c!.notes).toEqual([]);
  });

  it("journal entry: a two-sided line gives two postings", () => {
    const c = toPostings(p("create_journal_entry", { lines: [{ amount: 8900, debitAccount: "7770", creditAccount: "1920:10001" }] }));
    expect(c!.postings.map((x) => [x.side, x.account, x.net])).toEqual([["debit", "7770", 8900], ["credit", "1920:10001", 8900]]);
  });

  it("journal entry: an unknown VAT code is kept as «kode N» with a note", () => {
    const c = toPostings(p("create_journal_entry", { lines: [{ amount: 1000, debitAccount: "6800", debitVatCode: 11, creditAccount: "1920:10001" }] }));
    expect(c!.postings[0]).toEqual({ side: "debit", account: "6800", net: 1000, vat: "kode 11", vatAmount: 0 });
    expect(c!.notes).toEqual(["Mva-kode 11 er ukjent for evalueringen; balansen er ikke sjekket."]);
  });

  it("cash purchase: lines debit, the payment account credits the gross total", () => {
    const c = toPostings(p("create_purchase", {
      kind: "cash_purchase", paymentAccount: "1920:10001",
      lines: [{ description: "Rekvisita", netPrice: 50000, vat: 12500, account: "6800", vatType: "HIGH" }, { description: "Porto", netPrice: 2000, vat: 0, account: "6940", vatType: "NONE" }],
    }));
    expect(c!.postings).toEqual([
      { side: "debit", account: "6800", net: 50000, vat: "25", vatAmount: 12500 },
      { side: "debit", account: "6940", net: 2000, vat: "0", vatAmount: 0 },
      { side: "credit", account: "1920:10001", net: 64500, vat: undefined, vatAmount: 0 },
    ]);
  });

  it("supplier purchase credits 2400", () => {
    const c = toPostings(p("create_purchase", { kind: "supplier", lines: [{ description: "x", netPrice: 100000, vat: 25000, account: "6550", vatType: "HIGH" }] }));
    expect(c!.postings.at(-1)).toEqual({ side: "credit", account: "2400", net: 125000, vat: undefined, vatAmount: 0 });
  });

  it("cash sale: lines credit, the payment account debits the gross; a fee is noted", () => {
    const c = toPostings(p("create_sale", { kind: "cash_sale", paymentAccount: "1920:10001", paymentFee: 500, lines: [{ description: "Varer", netPrice: 200000, vat: 50000, vatType: "HIGH", account: "3000" }] }));
    expect(c!.postings).toEqual([
      { side: "debit", account: "1920:10001", net: 250000, vat: undefined, vatAmount: 0 },
      { side: "credit", account: "3000", net: 200000, vat: "25", vatAmount: 50000 },
    ]);
    expect(c!.notes).toEqual(["paymentFee er ikke med i posteringene."]);
  });

  it("invoice: quantity × unitPrice less discount, VAT from vatType, 1500 debits the gross", () => {
    const c = toPostings(p("create_invoice", { lines: [{ description: "Rådgivning", quantity: 10, unitPrice: 120000, vatType: "HIGH", incomeAccount: "3000", discount: 10 }] }));
    expect(c!.postings).toEqual([
      { side: "debit", account: "1500", net: 1350000, vat: undefined, vatAmount: 0 },
      { side: "credit", account: "3000", net: 1080000, vat: "25", vatAmount: 270000 },
    ]);
  });

  it("invoice line without unitPrice is noted", () => {
    const c = toPostings(p("create_invoice", { lines: [{ productId: 5, quantity: 1 }] }));
    expect(c!.notes).toEqual(["Linje 1 har ingen unitPrice (produkt); beløpet er ikke kjent."]);
  });

  it("partial credit note swaps the sides; a full one has no postings and a note", () => {
    const partial = toPostings(p("create_credit_note", { kind: "partial", lines: [{ description: "Avslag", quantity: 1, unitPrice: 45600, vatType: "HIGH", incomeAccount: "3000" }] }));
    expect(partial!.postings).toEqual([
      { side: "debit", account: "3000", net: 45600, vat: "25", vatAmount: 11400 },
      { side: "credit", account: "1500", net: 57000, vat: undefined, vatAmount: 0 },
    ]);
    const full = toPostings(p("create_credit_note", { kind: "full", invoiceId: 1 }));
    expect(full).toEqual({ postings: [], notes: ["Full kreditnota: posteringene er fakturaens, motsatt vei."] });
  });

  it("payment on a sale debits the bank and credits 1500; on a purchase debits 2400", () => {
    expect(toPostings(p("register_payment", { saleId: 1, account: "1920:10001", amount: 31250 }))!.postings).toEqual([
      { side: "debit", account: "1920:10001", net: 31250, vat: undefined, vatAmount: 0 },
      { side: "credit", account: "1500", net: 31250, vat: undefined, vatAmount: 0 },
    ]);
    expect(toPostings(p("register_payment", { purchaseId: 1, account: "1920:10001", amount: 100 }))!.postings.map((x) => x.account)).toEqual(["2400", "1920:10001"]);
  });

  it("has no converter for other operations", () => {
    expect(toPostings(p("create_contact", { name: "x" }))).toBeUndefined();
  });
});
```

- [ ] **Step 4: Run them to see them fail**

Run: `npm test --workspace eval`
Expected: FAIL, `Cannot find module '../src/postings.js'`.

- [ ] **Step 5: Implement**

`eval/src/postings.ts`:

```ts
export type Side = "debit" | "credit";

/** One side of a booking. net in øre; vat a rate ("25", "0", …), «kode N» for an unknown journal VAT code, or undefined; vatAmount the VAT added on top of net. */
export type Posting = { side: Side; account: string; net: number; vat: string | undefined; vatAmount: number };

/** What the model proposed: a write operation's name and args, from preview_booking or a blocked write call. */
export type Proposal = { operation: string; args: Record<string, unknown>; via: "preview" | "write" };

export type Converted = { postings: Posting[]; notes: string[] };

const TYPE_RATE: Record<string, string> = { HIGH: "25", MEDIUM: "15", LOW: "12", NONE: "0", EXEMPT: "0", OUTSIDE: "0", EXEMPT_IMPORT_EXPORT: "0" };
/** Journal VAT codes verified on Fiken 2026-10-05: 1 input VAT 25 %, 3 output VAT 25 %. */
const CODE_RATE: Record<number, string> = { 1: "25", 3: "25" };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "?");
const recordLines = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isRecord) : []);

/** True for a plain rate ("25", "0"), false for «kode N» or no VAT. */
export const isRate = (vat: string | undefined): boolean => vat !== undefined && /^\d+$/.test(vat);
const vatOn = (net: number, vat: string | undefined): number => (isRate(vat) ? Math.round((net * Number(vat)) / 100) : 0);
const typeRate = (t: unknown): string | undefined => (typeof t === "string" ? (TYPE_RATE[t] ?? t) : undefined);
const post = (side: Side, account: string, net: number, vat?: string, vatAmount = 0): Posting => ({ side, account, net, vat, vatAmount });
const grossOf = (ps: Posting[]): number => ps.reduce((sum, x) => sum + x.net + x.vatAmount, 0);

function journal(args: Record<string, unknown>): Converted {
  const postings: Posting[] = [];
  const notes: string[] = [];
  for (const l of recordLines(args.lines)) {
    for (const side of ["debit", "credit"] as const) {
      const account = l[`${side}Account`];
      if (typeof account !== "string") continue;
      const code = l[`${side}VatCode`];
      let vat: string | undefined;
      if (typeof code === "number") {
        vat = CODE_RATE[code] ?? `kode ${code}`;
        if (CODE_RATE[code] === undefined) notes.push(`Mva-kode ${code} er ukjent for evalueringen; balansen er ikke sjekket.`);
      }
      const net = num(l.amount);
      postings.push(post(side, account, net, vat, vatOn(net, vat)));
    }
  }
  return { postings, notes };
}

function purchase(args: Record<string, unknown>): Converted {
  const debits = recordLines(args.lines).map((l) => post("debit", str(l.account), num(l.netPrice), typeRate(l.vatType), num(l.vat)));
  const account = args.kind === "cash_purchase" ? str(args.paymentAccount) : "2400";
  return { postings: [...debits, post("credit", account, grossOf(debits))], notes: [] };
}

function sale(args: Record<string, unknown>): Converted {
  const credits = recordLines(args.lines).map((l) => post("credit", str(l.account), num(l.netPrice), typeRate(l.vatType), num(l.vat)));
  const account = args.kind === "cash_sale" ? str(args.paymentAccount) : "1500";
  const notes = args.paymentFee !== undefined ? ["paymentFee er ikke med i posteringene."] : [];
  return { postings: [post("debit", account, grossOf(credits)), ...credits], notes };
}

function documentLines(v: unknown, side: Side, notes: string[]): Posting[] {
  return recordLines(v).map((l, i) => {
    if (typeof l.unitPrice !== "number") notes.push(`Linje ${i + 1} har ingen unitPrice (produkt); beløpet er ikke kjent.`);
    const net = Math.round(num(l.quantity) * num(l.unitPrice) * (1 - num(l.discount) / 100));
    const vat = typeRate(l.vatType);
    return post(side, str(l.incomeAccount), net, vat, vatOn(net, vat));
  });
}

function invoice(args: Record<string, unknown>): Converted {
  const notes: string[] = [];
  const credits = documentLines(args.lines, "credit", notes);
  const account = args.cash === true ? str(args.paymentAccount) : "1500";
  return { postings: [post("debit", account, grossOf(credits)), ...credits], notes };
}

function creditNote(args: Record<string, unknown>): Converted {
  if (args.kind === "full") return { postings: [], notes: ["Full kreditnota: posteringene er fakturaens, motsatt vei."] };
  const notes: string[] = [];
  const debits = documentLines(args.lines, "debit", notes);
  return { postings: [...debits, post("credit", "1500", grossOf(debits))], notes };
}

function payment(args: Record<string, unknown>): Converted {
  const amount = num(args.amount);
  const bank = str(args.account);
  const notes = args.fee !== undefined ? ["fee er ikke med i posteringene."] : [];
  const postings = args.saleId !== undefined
    ? [post("debit", bank, amount), post("credit", "1500", amount)]
    : [post("debit", "2400", amount), post("credit", bank, amount)];
  return { postings, notes };
}

export const CONVERTERS: Record<string, (args: Record<string, unknown>) => Converted> = {
  create_journal_entry: journal,
  create_purchase: purchase,
  create_sale: sale,
  create_invoice: invoice,
  create_credit_note: creditNote,
  register_payment: payment,
};

/** The proposal's postings, or undefined when its operation has no converter. */
export function toPostings(p: Proposal): Converted | undefined {
  const convert = CONVERTERS[p.operation];
  return convert ? convert(p.args) : undefined;
}
```

- [ ] **Step 6: Run the tests and typecheck**

Run: `npm test --workspace eval && npm run typecheck --workspace eval`
Expected: PASS, typecheck clean.

- [ ] **Step 7: Run the whole repo's checks**

Run: `npm test && npm run typecheck && npm run synth`
Expected: all pass (synth skips `eval` via `--if-present`).

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json .gitignore eval/package.json eval/tsconfig.json eval/vitest.config.ts eval/cases/types.ts eval/src/postings.ts eval/test/postings.test.ts
git commit -m "Eval: workspace, case type, postings from write args"
```

---

### Task 2: Grading

**Files:**
- Create: `eval/src/grade.ts`
- Test: `eval/test/grade.test.ts`

**Interfaces:**
- Consumes: `Case`, `Expected` (cases/types.ts); `Posting`, `Proposal`, `isRate`, `toPostings` (src/postings.ts).
- Produces: `Call = { name; args; blocked? }`, `Trace = { calls: Call[]; proposal?: Proposal; error?: string }`, `Outcome`, `Behaviour`, `Grade`, `kr(ore)`, `accountMatches(pattern, account)`, `behaviourOf(calls)`, `grade(expect, trace): Grade`.

- [ ] **Step 1: Write the failing tests**

`eval/test/grade.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Case } from "../cases/types.js";
import { accountMatches, behaviourOf, grade, kr, type Trace } from "../src/grade.js";

const outlay: Case["expect"] = {
  operations: ["create_journal_entry", "create_purchase"],
  postings: [
    { side: "debit", account: ["6800", "6810"], net: 40000, vat: "25" },
    { side: "credit", account: ["2911"], amount: 50000 },
  ],
};
const journal = (lines: unknown[]): Trace => ({ calls: [], proposal: { operation: "create_journal_entry", args: { lines }, via: "preview" } });

describe("accountMatches", () => {
  it("matches exactly, or by prefix with a trailing *", () => {
    expect(accountMatches("1920", "1920")).toBe(true);
    expect(accountMatches("1920", "1920:10001")).toBe(false);
    expect(accountMatches("1920*", "1920:10001")).toBe(true);
    expect(accountMatches("2*", "1500")).toBe(false);
  });
});

describe("grade", () => {
  it("passes the right outlay, with an alternative account", () => {
    const g = grade(outlay, journal([{ amount: 40000, debitAccount: "6810", debitVatCode: 1 }, { amount: 50000, creditAccount: "2911" }]));
    expect(g).toMatchObject({ outcome: "pass", problems: [] });
  });

  it("passes a purchase with the same effect", () => {
    const g = grade({ ...outlay, postings: [outlay.postings[0]!, { side: "credit", account: ["1920*"], amount: 50000 }] }, {
      calls: [],
      proposal: { operation: "create_purchase", via: "write", args: { kind: "cash_purchase", paymentAccount: "1920:10001", lines: [{ description: "x", netPrice: 40000, vat: 10000, account: "6800", vatType: "HIGH" }] } },
    });
    expect(g.outcome).toBe("pass");
  });

  it("explains a wrong credit account in Norwegian", () => {
    const g = grade(outlay, journal([{ amount: 40000, debitAccount: "6800", debitVatCode: 1 }, { amount: 50000, creditAccount: "1920:10001" }]));
    expect(g.outcome).toBe("wrong");
    expect(g.problems).toEqual([`Forventet kredit 2911 ${kr(50000)}, fikk kredit 1920:10001 ${kr(50000)}.`]);
  });

  it("reports an unexpected posting when exact, not otherwise", () => {
    const lines = [{ amount: 40000, debitAccount: "6800", debitVatCode: 1 }, { amount: 50000, creditAccount: "2911" }, { amount: 100, debitAccount: "7770", creditAccount: "1920:10001" }];
    expect(grade(outlay, journal(lines)).problems).toEqual([`Uventet debet 7770 ${kr(100)}.`, `Uventet kredit 1920:10001 ${kr(100)}.`]);
    expect(grade({ ...outlay, exact: false }, journal(lines)).outcome).toBe("pass");
  });

  it("reports an unbalanced proposal", () => {
    const g = grade({ operations: ["create_journal_entry"], postings: [] , exact: false }, journal([{ amount: 100, debitAccount: "6800" }, { amount: 90, creditAccount: "1920:10001" }]));
    expect(g.problems).toEqual([`Går ikke i balanse: debet ${kr(100)}, kredit ${kr(90)}.`]);
  });

  it("does not check the balance with an unknown VAT code, and says so", () => {
    const g = grade({ operations: ["create_journal_entry"], postings: [], exact: false }, journal([{ amount: 100, debitAccount: "6800", debitVatCode: 11, creditAccount: "1920:10001" }]));
    expect(g.outcome).toBe("pass");
    expect(g.notes).toEqual(["Mva-kode 11 er ukjent for evalueringen; balansen er ikke sjekket."]);
  });

  it("refuses an operation outside the list and checks expected args", () => {
    const g = grade({ operations: ["register_payment"], postings: [], exact: false, args: { saleId: 7 } }, {
      calls: [], proposal: { operation: "create_sale", via: "write", args: { saleId: 8, kind: "cash_sale", lines: [] , paymentAccount: "1920:10001" } },
    });
    expect(g.problems).toEqual(["Operasjonen create_sale er ikke blant register_payment.", "Forventet saleId 7, fikk 8."]);
  });

  it("grades an operation without a converter on the operation only", () => {
    const g = grade({ operations: ["create_contact"], postings: [] }, { calls: [], proposal: { operation: "create_contact", via: "write", args: { name: "x" } } });
    expect(g).toMatchObject({ outcome: "pass", notes: ["create_contact har ingen omregning til posteringer; bare operasjonen er sjekket."] });
  });

  it("has outcomes for no proposal and an error", () => {
    expect(grade(outlay, { calls: [] }).outcome).toBe("none");
    expect(grade(outlay, { calls: [], error: "boom" })).toMatchObject({ outcome: "error", problems: ["boom"] });
  });
});

describe("behaviourOf", () => {
  it("sees a preview before the first write, a choice and a help article", () => {
    expect(behaviourOf([
      { name: "ask_user_choice", args: {} },
      { name: "fiken_read", args: { operation: "fiken_help_article", args: { slug: "x" } } },
      { name: "preview_booking", args: {} },
      { name: "fiken_write", args: {}, blocked: true },
    ])).toEqual({ previewFirst: true, askChoice: true, readHelp: true });
    expect(behaviourOf([{ name: "fiken_write", args: {}, blocked: true }])).toEqual({ previewFirst: false, askChoice: false, readHelp: false });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test --workspace eval -- grade`
Expected: FAIL, `Cannot find module '../src/grade.js'`.

- [ ] **Step 3: Implement**

`eval/src/grade.ts`:

```ts
import type { Case, Expected } from "../cases/types.js";
import { isRate, toPostings, type Posting, type Proposal } from "./postings.js";

export type Call = { name: string; args: Record<string, unknown>; blocked?: boolean };
export type Trace = { calls: Call[]; proposal?: Proposal; error?: string };
export type Outcome = "pass" | "wrong" | "none" | "error";
export type Behaviour = { previewFirst: boolean; askChoice: boolean; readHelp: boolean };
export type Grade = { outcome: Outcome; problems: string[]; notes: string[]; behaviour: Behaviour };

/** Øre as «1234,50 kr», without thousands separators so reports and tests stay plain. */
export const kr = (ore: number): string => `${(ore / 100).toFixed(2).replace(".", ",")} kr`;
const sideName = (side: string): string => (side === "debit" ? "debet" : "kredit");

export function accountMatches(pattern: string, account: string): boolean {
  return pattern.endsWith("*") ? account.startsWith(pattern.slice(0, -1)) : account === pattern;
}

function postingMatches(e: Expected, p: Posting): boolean {
  return (
    e.side === p.side &&
    e.account.some((a) => accountMatches(a, p.account)) &&
    (e.net === undefined || e.net === p.net) &&
    (e.amount === undefined || e.amount === p.net + p.vatAmount) &&
    (e.vat === undefined || e.vat === p.vat)
  );
}

/** Gives each expected posting a different actual one; the actual indexes in order, or undefined when impossible. */
function assign(expected: Expected[], actual: Posting[], i = 0, used = new Set<number>()): number[] | undefined {
  if (i === expected.length) return [];
  for (let j = 0; j < actual.length; j++) {
    if (used.has(j) || !postingMatches(expected[i]!, actual[j]!)) continue;
    used.add(j);
    const rest = assign(expected, actual, i + 1, used);
    used.delete(j);
    if (rest) return [j, ...rest];
  }
  return undefined;
}

function describeExpected(e: Expected): string {
  const amount = e.amount !== undefined ? ` ${kr(e.amount)}` : "";
  const net = e.net !== undefined ? ` netto ${kr(e.net)}` : "";
  const vat = e.vat !== undefined ? ` mva ${e.vat}` : "";
  return `${sideName(e.side)} ${e.account.join("/")}${amount}${net}${vat}`;
}

function describeActual(p: Posting): string {
  const vat = p.vat !== undefined ? ` (netto ${kr(p.net)}, mva ${p.vat})` : "";
  return `${sideName(p.side)} ${p.account} ${kr(p.net + p.vatAmount)}${vat}`;
}

export function behaviourOf(calls: Call[]): Behaviour {
  const firstWrite = calls.findIndex((c) => c.blocked === true);
  const firstPreview = calls.findIndex((c) => c.name === "preview_booking");
  return {
    previewFirst: firstPreview !== -1 && (firstWrite === -1 || firstPreview < firstWrite),
    askChoice: calls.some((c) => c.name === "ask_user_choice"),
    readHelp: calls.some((c) => c.name === "fiken_read" && c.args.operation === "fiken_help_article"),
  };
}

export function grade(expect: Case["expect"], trace: Trace): Grade {
  const behaviour = behaviourOf(trace.calls);
  if (trace.error !== undefined) return { outcome: "error", problems: [trace.error], notes: [], behaviour };
  const p = trace.proposal;
  if (!p) return { outcome: "none", problems: ["Ingen føring ble foreslått."], notes: [], behaviour };

  const problems: string[] = [];
  if (!expect.operations.includes(p.operation)) problems.push(`Operasjonen ${p.operation} er ikke blant ${expect.operations.join(", ")}.`);
  for (const [key, value] of Object.entries(expect.args ?? {})) {
    if (JSON.stringify(p.args[key]) !== JSON.stringify(value)) problems.push(`Forventet ${key} ${JSON.stringify(value)}, fikk ${JSON.stringify(p.args[key])}.`);
  }

  const converted = toPostings(p);
  if (!converted) {
    const notes = [`${p.operation} har ingen omregning til posteringer; bare operasjonen er sjekket.`];
    return { outcome: problems.length ? "wrong" : "pass", problems, notes, behaviour };
  }

  const actual = converted.postings;
  const match = assign(expect.postings, actual);
  if (!match) {
    const used = new Set<number>();
    for (const e of expect.postings) {
      const j = actual.findIndex((a, k) => !used.has(k) && postingMatches(e, a));
      if (j !== -1) {
        used.add(j);
        continue;
      }
      const sameSide = actual.filter((a, k) => !used.has(k) && a.side === e.side).map(describeActual);
      problems.push(`Forventet ${describeExpected(e)}, fikk ${sameSide.length ? sameSide.join("; ") : "ingen"}.`);
    }
  } else if (expect.exact !== false) {
    actual.forEach((a, k) => {
      if (!match.includes(k)) problems.push(`Uventet ${describeActual(a)}.`);
    });
  }

  if (actual.every((a) => a.vat === undefined || isRate(a.vat))) {
    const total = (side: string) => actual.filter((a) => a.side === side).reduce((s, a) => s + a.net + a.vatAmount, 0);
    const debit = total("debit");
    const credit = total("credit");
    if (debit !== credit) problems.push(`Går ikke i balanse: debet ${kr(debit)}, kredit ${kr(credit)}.`);
  }

  return { outcome: problems.length ? "wrong" : "pass", problems, notes: converted.notes, behaviour };
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npm test --workspace eval && npm run typecheck --workspace eval`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add eval/src/grade.ts eval/test/grade.test.ts
git commit -m "Eval: grade proposals against expected postings"
```

---

### Task 3: Simulated user and the conversation loop

**Files:**
- Create: `eval/src/user.ts`
- Create: `eval/src/loop.ts`
- Test: `eval/test/user.test.ts`, `eval/test/loop.test.ts`

**Interfaces:**
- Consumes: `Case`, `Replies` (cases/types.ts); `Trace`, `Call` (src/grade.ts); `Proposal` (src/postings.ts); `choiceMessage` from `api/src/widget/choice.mjs` (`choiceMessage(option: { label: string; value: string; description?: string }): string`) and `formMessage` from `api/src/widget/form.mjs` (`formMessage(data: { title; fields }, values: Record<string, string | boolean>): string`) — read their `.d.mts` files for the exact types.
- Produces: `answerChoice(args, replies): string`, `answerForm(args, replies): string` (user.ts); `SYSTEM_PROMPT`, `WRITES_OFF`, `ToolInfo`, `ToolResult`, `ToolHost`, `ModelApi`, `TranscriptEntry`, `RunResult`, `argsObject(v)`, `runConversation(opts): Promise<RunResult>` (loop.ts).

- [ ] **Step 1: Write the failing user tests**

`eval/test/user.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { answerChoice, answerForm } from "../src/user.js";

const replies = { company: "demo-as", default: "Ja, det stemmer.", choices: { "Hvilken konto": "6810" }, form: { amount: "500" } };

describe("answerChoice", () => {
  it("picks the company option and answers as the widget does", () => {
    expect(answerChoice({ question: "Hvilket foretak?", options: [{ label: "Annet AS", value: "annet-as" }, { label: "Demo AS", value: "demo-as" }] }, replies)).toBe("Demo AS (demo-as)");
  });
  it("uses choices by question fragment, then default", () => {
    const options = [{ label: "6800 Kontorrekvisita", value: "6800" }, { label: "6810 Datautstyr", value: "6810" }];
    expect(answerChoice({ question: "Hvilken konto skal brukes?", options }, replies)).toBe("6810 Datautstyr (6810)");
    expect(answerChoice({ question: "Noe annet?", options }, replies)).toBe("Ja, det stemmer.");
  });
});

describe("answerForm", () => {
  it("fills from replies.form, then suggested values, and writes the widget's message", () => {
    const text = answerForm({ title: "Utlegg", fields: [
      { name: "date", label: "Dato", type: "date", value: "2026-10-01" },
      { name: "amount", label: "Beløp", type: "amount" },
      { name: "private", label: "Betalt privat", type: "checkbox", value: "true" },
    ] }, replies);
    expect(text).toBe("Utlegg:\n- Dato: 2026-10-01\n- Beløp: 500\n- Betalt privat: Ja");
  });
});
```

(If `formMessage`'s output differs in layout from the string above, read `api/src/widget/form.mjs` and use its real layout in the expectation; the point is that the text comes from `formMessage`.)

- [ ] **Step 2: Implement user.ts**

`eval/src/user.ts`:

```ts
import { choiceMessage } from "../../api/src/widget/choice.mjs";
import { formMessage } from "../../api/src/widget/form.mjs";
import type { Replies } from "../cases/types.js";

type Option = { label: string; value: string; description?: string };
type Field = { name: string; label: string; type: string; value?: string; options?: { label: string; value: string }[] };

/** The simulated user's click on an ask_user_choice widget, as the widget would send it. */
export function answerChoice(args: Record<string, unknown>, replies: Replies): string {
  const options = Array.isArray(args.options) ? (args.options as Option[]) : [];
  const question = typeof args.question === "string" ? args.question : "";
  const company = options.find((o) => o.value === replies.company);
  if (company) return choiceMessage(company);
  for (const [fragment, wanted] of Object.entries(replies.choices ?? {})) {
    if (!question.includes(fragment)) continue;
    const option = options.find((o) => o.value === wanted || o.label === wanted);
    return option ? choiceMessage(option) : wanted;
  }
  return replies.default;
}

/** The simulated user's filled-in ask_user_form, as the widget would send it. */
export function answerForm(args: Record<string, unknown>, replies: Replies): string {
  const fields = Array.isArray(args.fields) ? (args.fields as Field[]) : [];
  const title = typeof args.title === "string" ? args.title : "";
  const values: Record<string, string | boolean> = {};
  for (const f of fields) {
    const v = replies.form?.[f.name] ?? f.value;
    if (v === undefined) continue;
    values[f.name] = f.type === "checkbox" ? v === "true" : v;
  }
  return formMessage({ title, fields } as Parameters<typeof formMessage>[0], values);
}
```

Run: `npm test --workspace eval -- user`
Expected: PASS (fix the expected layout per the note in Step 1 if needed).

- [ ] **Step 3: Write the failing loop tests**

`eval/test/loop.test.ts`:

```ts
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import type { Case } from "../cases/types.js";
import { argsObject, runConversation, WRITES_OFF, type ModelApi, type ToolHost } from "../src/loop.js";

const c: Case = {
  id: "t", area: "utlegg", prompt: "Før et utlegg.", source: "x", reviewed: false,
  replies: { company: "demo", default: "Ja." },
  expect: { operations: ["create_journal_entry"], postings: [] },
};

type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
/** A model that answers with the given turns in order and records each request. */
function fakeModel(turns: Block[][]): ModelApi & { requests: Anthropic.MessageCreateParamsNonStreaming[] } {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  let i = 0;
  return {
    requests,
    async create(params) {
      requests.push(structuredClone(params));
      const content = turns[i++] ?? [{ type: "text", text: "Ferdig." }];
      return { content, usage: { input_tokens: 10, output_tokens: 5 } } as unknown as Anthropic.Message;
    },
  };
}
function fakeHost(results: Record<string, { text: string; structured?: unknown; isError?: boolean }> = {}): ToolHost & { called: string[] } {
  const called: string[] = [];
  return {
    called,
    instructions: "Server instructions.",
    tools: [
      { name: "fiken_read", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
      { name: "preview_booking", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
      { name: "ask_user_choice", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
      { name: "fiken_write", inputSchema: { type: "object" }, annotations: { readOnlyHint: false } },
      { name: "create_purchase", inputSchema: { type: "object" } },
    ],
    async call(name) {
      called.push(name);
      return results[name] ?? { text: "ok" };
    },
  };
}
const use = (id: string, name: string, input: Record<string, unknown>): Block => ({ type: "tool_use", id, name, input });
const jeArgs = { companySlug: "demo", lines: [{ amount: 100, debitAccount: "6800", creditAccount: "1920:10001" }] };

describe("runConversation", () => {
  it("passes the server instructions after the system prompt", async () => {
    const model = fakeModel([]);
    await runConversation({ host: fakeHost(), model, modelId: "m", c });
    expect(model.requests[0]!.system).toBe("Du hjelper brukeren med regnskap i Fiken. Svar på norsk.\n\nServer instructions.");
  });

  it("never forwards a write: fiken_write is blocked, recorded as the proposal, and ends the run", async () => {
    const host = fakeHost();
    const r = await runConversation({ host, model: fakeModel([[use("1", "fiken_write", { operation: "create_journal_entry", args: jeArgs })]]), modelId: "m", c });
    expect(host.called).toEqual([]);
    expect(r.trace.proposal).toEqual({ operation: "create_journal_entry", args: jeArgs, via: "write" });
    expect(r.trace.calls).toEqual([{ name: "fiken_write", args: { operation: "create_journal_entry", args: jeArgs }, blocked: true }]);
    expect(r.transcript.at(-1)).toEqual({ who: "verktøy", text: WRITES_OFF });
  });

  it("blocks a direct write tool without annotations", async () => {
    const host = fakeHost();
    const r = await runConversation({ host, model: fakeModel([[use("1", "create_purchase", { kind: "supplier" })]]), modelId: "m", c });
    expect(host.called).toEqual([]);
    expect(r.trace.proposal).toEqual({ operation: "create_purchase", args: { kind: "supplier" }, via: "write" });
  });

  it("parses args sent as a JSON string", async () => {
    const r = await runConversation({ host: fakeHost(), model: fakeModel([[use("1", "fiken_write", { operation: "create_journal_entry", args: JSON.stringify(jeArgs) })]]), modelId: "m", c });
    expect(r.trace.proposal!.args).toEqual(jeArgs);
  });

  it("forwards a read in the same turn as a write, then blocks the write", async () => {
    const host = fakeHost();
    const r = await runConversation({ host, model: fakeModel([[use("1", "fiken_read", { operation: "list_accounts" }), use("2", "fiken_write", { operation: "create_journal_entry", args: jeArgs })]]), modelId: "m", c });
    expect(host.called).toEqual(["fiken_read"]);
    expect(r.trace.calls.map((x) => x.name)).toEqual(["fiken_read", "fiken_write"]);
  });

  it("approves an ok preview with its ref, and the next write ends the run", async () => {
    const host = fakeHost({ preview_booking: { text: "Forhåndsvisning", structured: { checks: "ok", ref: "abc123" } } });
    const model = fakeModel([[use("1", "preview_booking", { operation: "create_journal_entry", args: jeArgs })], [use("2", "fiken_write", { operation: "create_journal_entry", args: jeArgs })]]);
    const r = await runConversation({ host, model, modelId: "m", c });
    const second = model.requests[1]!.messages.at(-1)!;
    expect(second.content).toEqual([
      { type: "tool_result", tool_use_id: "1", content: "Forhåndsvisning", is_error: false },
      { type: "text", text: "Ja, før dette (ref abc123)." },
    ]);
    expect(r.trace.proposal!.via).toBe("write");
  });

  it("asks for a correction when the preview's checks fail, and keeps the preview as the proposal", async () => {
    const host = fakeHost({ preview_booking: { text: "Feil", structured: { checks: ["Går ikke i balanse"], ref: "x" } } });
    const model = fakeModel([[use("1", "preview_booking", { operation: "create_journal_entry", args: jeArgs })]]);
    const r = await runConversation({ host, model, modelId: "m", c });
    expect(model.requests[1]!.messages.at(-1)!.content).toContainEqual({ type: "text", text: "Forhåndsvisningen viser feil. Kan du rette dem?" });
    expect(r.trace.proposal).toEqual({ operation: "create_journal_entry", args: jeArgs, via: "preview" });
  });

  it("answers ask_user_choice with the company", async () => {
    const model = fakeModel([[use("1", "ask_user_choice", { question: "Hvilket foretak?", options: [{ label: "Demo", value: "demo" }, { label: "B", value: "b" }] })]]);
    await runConversation({ host: fakeHost(), model, modelId: "m", c });
    expect(model.requests[1]!.messages.at(-1)!.content).toContainEqual({ type: "text", text: "Demo (demo)" });
  });

  it("gives the default reply once, then ends after a second turn without tools", async () => {
    const model = fakeModel([[{ type: "text", text: "Hva gjelder det?" }], [{ type: "text", text: "Ok." }], [use("9", "fiken_read", {})]]);
    const r = await runConversation({ host: fakeHost(), model, modelId: "m", c });
    expect(model.requests).toHaveLength(2);
    expect(model.requests[1]!.messages.at(-1)).toEqual({ role: "user", content: "Ja." });
    expect(r.trace.proposal).toBeUndefined();
  });

  it("stops after maxTurns", async () => {
    const turns = Array.from({ length: 30 }, (_, i) => [use(String(i), "fiken_read", {})]);
    const r = await runConversation({ host: fakeHost(), model: fakeModel(turns), modelId: "m", c, maxTurns: 3 });
    expect(r.turns).toBe(3);
  });

  it("records a thrown error and adds up usage", async () => {
    const host = fakeHost();
    host.call = async () => { throw new Error("nede"); };
    const r = await runConversation({ host, model: fakeModel([[use("1", "fiken_read", {})]]), modelId: "m", c });
    expect(r.trace.error).toBe("nede");
    expect(r.usage).toEqual({ input: 10, output: 5 });
  });
});

describe("argsObject", () => {
  it("accepts an object or a JSON string, else {}", () => {
    expect(argsObject({ a: 1 })).toEqual({ a: 1 });
    expect(argsObject('{"a":1}')).toEqual({ a: 1 });
    expect(argsObject("nei")).toEqual({});
    expect(argsObject(undefined)).toEqual({});
  });
});
```

- [ ] **Step 4: Run them to see them fail**

Run: `npm test --workspace eval -- loop`
Expected: FAIL, `Cannot find module '../src/loop.js'`.

- [ ] **Step 5: Implement loop.ts**

`eval/src/loop.ts`:

```ts
import type Anthropic from "@anthropic-ai/sdk";
import type { Case } from "../cases/types.js";
import type { Trace } from "./grade.js";
import type { Proposal } from "./postings.js";
import { answerChoice, answerForm } from "./user.js";

export const SYSTEM_PROMPT = "Du hjelper brukeren med regnskap i Fiken. Svar på norsk.";
export const WRITES_OFF = "Skriving er slått av i evalueringen.";
const MAX_TEXT = 2000;

export type ToolInfo = { name: string; description?: string; inputSchema: Record<string, unknown>; annotations?: { readOnlyHint?: boolean } };
export type ToolResult = { text: string; structured?: unknown; isError?: boolean };
export interface ToolHost {
  tools: ToolInfo[];
  instructions?: string;
  call(name: string, args: Record<string, unknown>): Promise<ToolResult>;
}
export interface ModelApi {
  create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
}
export type TranscriptEntry = { who: "bruker" | "modell" | "verktøy"; text: string };
export type RunResult = { trace: Trace; turns: number; usage: { input: number; output: number }; transcript: TranscriptEntry[] };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const short = (s: string): string => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)} …` : s);

/** Write args as the gateway accepts them: an object, or an object as a JSON string. */
export function argsObject(v: unknown): Record<string, unknown> {
  if (typeof v === "string") {
    try {
      const parsed: unknown = JSON.parse(v);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return isRecord(v) ? v : {};
}

function proposalOf(name: string, args: Record<string, unknown>, via: Proposal["via"]): Proposal {
  if (name === "fiken_write" || name === "preview_booking") return { operation: String(args.operation ?? ""), args: argsObject(args.args), via };
  return { operation: name, args, via };
}

/** What the simulated user answers to a preview: approve an ok one with its ref, else ask for a correction. */
function previewReply(structured: unknown): string {
  if (isRecord(structured) && structured.checks === "ok" && typeof structured.ref === "string") return `Ja, før dette (ref ${structured.ref}).`;
  return "Forhåndsvisningen viser feil. Kan du rette dem?";
}

/**
 * Plays one case. Read-only tools (annotations.readOnlyHint true) are forwarded to the server; every other tool call is
 * blocked, recorded as the proposal and ends the run, so nothing is ever written to Fiken.
 */
export async function runConversation(o: { host: ToolHost; model: ModelApi; modelId: string; c: Case; maxTurns?: number }): Promise<RunResult> {
  const maxTurns = o.maxTurns ?? 25;
  const tools = o.host.tools.map((t) => ({ name: t.name, description: t.description ?? "", input_schema: t.inputSchema as Anthropic.Tool.InputSchema }));
  const readOnly = new Set(o.host.tools.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name));
  const system = o.host.instructions ? `${SYSTEM_PROMPT}\n\n${o.host.instructions}` : SYSTEM_PROMPT;
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: o.c.prompt }];
  const trace: Trace = { calls: [] };
  const transcript: TranscriptEntry[] = [{ who: "bruker", text: o.c.prompt }];
  const usage = { input: 0, output: 0 };
  let turns = 0;
  let quiet = 0;

  try {
    while (turns < maxTurns) {
      turns++;
      const res = await o.model.create({ model: o.modelId, max_tokens: 4096, system, tools, messages });
      usage.input += res.usage.input_tokens;
      usage.output += res.usage.output_tokens;
      messages.push({ role: "assistant", content: res.content });
      for (const b of res.content) if (b.type === "text" && b.text.trim() !== "") transcript.push({ who: "modell", text: short(b.text) });

      const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (uses.length === 0) {
        quiet++;
        if (quiet >= 2) break;
        messages.push({ role: "user", content: o.c.replies.default });
        transcript.push({ who: "bruker", text: o.c.replies.default });
        continue;
      }
      quiet = 0;

      const results: Anthropic.ToolResultBlockParam[] = [];
      let reply: string | undefined;
      for (const u of uses) {
        const args = isRecord(u.input) ? u.input : {};
        transcript.push({ who: "modell", text: short(`${u.name} ${JSON.stringify(args)}`) });
        if (!readOnly.has(u.name)) {
          trace.calls.push({ name: u.name, args, blocked: true });
          trace.proposal = proposalOf(u.name, args, "write");
          transcript.push({ who: "verktøy", text: WRITES_OFF });
          return { trace, turns, usage, transcript };
        }
        trace.calls.push({ name: u.name, args });
        const r = await o.host.call(u.name, args);
        transcript.push({ who: "verktøy", text: short(r.text) });
        results.push({ type: "tool_result", tool_use_id: u.id, content: r.text, is_error: r.isError === true });
        if (u.name === "preview_booking") {
          trace.proposal = proposalOf(u.name, args, "preview");
          reply = previewReply(r.structured);
        }
        if (u.name === "ask_user_choice") reply = answerChoice(args, o.c.replies);
        if (u.name === "ask_user_form") reply = answerForm(args, o.c.replies);
      }
      const content: Array<Anthropic.ToolResultBlockParam | Anthropic.TextBlockParam> = [...results];
      if (reply !== undefined) {
        content.push({ type: "text", text: reply });
        transcript.push({ who: "bruker", text: reply });
      }
      messages.push({ role: "user", content });
    }
  } catch (err) {
    trace.error = err instanceof Error ? err.message : String(err);
  }
  return { trace, turns, usage, transcript };
}
```

- [ ] **Step 6: Run the tests and typecheck**

Run: `npm test --workspace eval && npm run typecheck --workspace eval`
Expected: PASS. (The fake model records `structuredClone(params)`, so later pushes to `messages` don't change earlier requests.)

- [ ] **Step 7: Commit**

```bash
git add eval/src/user.ts eval/src/loop.ts eval/test/user.test.ts eval/test/loop.test.ts
git commit -m "Eval: conversation loop that never forwards writes, simulated user"
```

---

### Task 4: MCP connection, report and command line

**Files:**
- Create: `eval/src/models.ts`, `eval/src/mcp.ts`, `eval/src/report.ts`, `eval/src/cli.ts`
- Create: `eval/cases/index.ts` (empty `ALL_CASES` for now; Task 5 fills it)
- Test: `eval/test/mcp.test.ts`, `eval/test/report.test.ts`, `eval/test/select.test.ts`

**Interfaces:**
- Consumes: `ToolHost`, `ToolInfo`, `runConversation`, `RunResult`, `TranscriptEntry` (loop.ts); `grade`, `Grade` (grade.ts); `Case`, `Area` (cases/types.ts).
- Produces: `MODELS`, `ModelKey`, `selectModels(name?)` (models.ts); `retryOn503(fetchImpl, sleep?)`, `MemoryOAuthProvider`, `connectHost(apiUrl): Promise<ToolHost & { close(): Promise<void> }>` (mcp.ts); `RunRecord`, `renderReport(runs, startedAt, previous?)`, `parseSummary(md)` (report.ts); `ALL_CASES`, `selectCases(cases, filter?)` (cases/index.ts).

- [ ] **Step 1: Write the failing tests**

`eval/test/select.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { selectCases } from "../cases/index.js";
import type { Case } from "../cases/types.js";
import { MODELS, selectModels } from "../src/models.js";

const mk = (id: string, area: Case["area"]): Case => ({ id, area, prompt: "", source: "", reviewed: false, replies: { company: "x", default: "" }, expect: { operations: [], postings: [] } });

describe("selection", () => {
  it("selects cases by id or area, all without a filter, and refuses an unknown filter", () => {
    const cases = [mk("a", "kjøp"), mk("b", "salg")];
    expect(selectCases(cases).map((c) => c.id)).toEqual(["a", "b"]);
    expect(selectCases(cases, "b").map((c) => c.id)).toEqual(["b"]);
    expect(selectCases(cases, "kjøp").map((c) => c.id)).toEqual(["a"]);
    expect(() => selectCases(cases, "nope")).toThrow("Ingen sak eller område heter nope.");
  });
  it("selects models by key, both by default", () => {
    expect(MODELS).toEqual({ sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5" });
    expect(selectModels()).toEqual(["sonnet", "opus"]);
    expect(selectModels("opus")).toEqual(["opus"]);
    expect(() => selectModels("haiku")).toThrow("Ukjent modell haiku; bruk sonnet eller opus.");
  });
});
```

`eval/test/mcp.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { MemoryOAuthProvider, retryOn503 } from "../src/mcp.js";

describe("retryOn503", () => {
  it("retries once after a 503, with the same request", async () => {
    const seen: Array<[string, string | undefined]> = [];
    const statuses = [503, 200];
    const f = retryOn503(async (input, init) => {
      seen.push([String(input), init?.body as string | undefined]);
      return new Response("", { status: statuses.shift() ?? 200 });
    }, async () => {});
    const res = await f("https://x/mcp", { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    expect(seen).toEqual([["https://x/mcp", "{}"], ["https://x/mcp", "{}"]]);
  });
  it("gives up after one retry and passes other statuses through", async () => {
    let calls = 0;
    const f = retryOn503(async () => { calls++; return new Response("", { status: 503 }); }, async () => {});
    expect((await f("https://x", {})).status).toBe(503);
    expect(calls).toBe(2);
  });
});

describe("MemoryOAuthProvider", () => {
  it("keeps everything in memory and opens the browser for authorization", () => {
    const opened: string[] = [];
    const p = new MemoryOAuthProvider("http://127.0.0.1:5000/callback", (u) => opened.push(u.toString()));
    expect(p.redirectUrl).toBe("http://127.0.0.1:5000/callback");
    expect(p.clientMetadata.redirect_uris).toEqual(["http://127.0.0.1:5000/callback"]);
    p.saveCodeVerifier("v");
    expect(p.codeVerifier()).toBe("v");
    expect(p.tokens()).toBeUndefined();
    p.redirectToAuthorization(new URL("https://api.test/authorize?x=1"));
    expect(opened).toEqual(["https://api.test/authorize?x=1"]);
  });
});
```

`eval/test/report.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseSummary, renderReport, type RunRecord } from "../src/report.js";

const run = (caseId: string, model: string, outcome: "pass" | "wrong", n: number): RunRecord => ({
  caseId, area: "utlegg", reviewed: false, model, run: n, ms: 1000, usage: { input: 100, output: 10 },
  expectBehaviour: { previewFirst: true },
  grade: { outcome, problems: outcome === "pass" ? [] : ["Forventet kredit 2911 500,00 kr, fikk ingen."], notes: [], behaviour: { previewFirst: outcome === "pass", askChoice: false, readHelp: false } },
  transcript: [{ who: "bruker", text: "Før et utlegg." }],
});

describe("renderReport", () => {
  const runs = [run("a", "sonnet", "pass", 1), run("a", "sonnet", "wrong", 2), run("a", "opus", "pass", 1)];
  const md = renderReport(runs, new Date("2026-10-04T10:00:00Z"));

  it("has a summary row per case and model with the pass count and behaviour", () => {
    expect(md).toContain("| a | sonnet | 1/2 | forhåndsvisning 1/2 |");
    expect(md).toContain("| a | opus | 1/1 | forhåndsvisning 1/1 |");
  });
  it("says the cases are not reviewed by an accountant", () => {
    expect(md).toContain("ikke revidert av regnskapsfører");
  });
  it("lists failures with problems and the transcript", () => {
    expect(md).toContain("### a · sonnet · kjøring 2: wrong");
    expect(md).toContain("- Forventet kredit 2911 500,00 kr, fikk ingen.");
    expect(md).toContain("bruker: Før et utlegg.");
  });
  it("round-trips the summary and marks changes against an earlier report", () => {
    expect(parseSummary(md)).toEqual(new Map([["a|sonnet", "1/2"], ["a|opus", "1/1"]]));
    const next = renderReport([run("a", "sonnet", "pass", 1), run("a", "sonnet", "pass", 2)], new Date(), parseSummary(md));
    expect(next).toContain("| a | sonnet | 2/2 | forhåndsvisning 2/2 | 1/2 ↑ |");
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test --workspace eval`
Expected: FAIL on the three new files (modules not found).

- [ ] **Step 3: models.ts and cases/index.ts**

`eval/src/models.ts`:

```ts
export const MODELS = { sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5" } as const;
export type ModelKey = keyof typeof MODELS;

export function selectModels(name?: string): ModelKey[] {
  if (name === undefined) return ["sonnet", "opus"];
  if (name === "sonnet" || name === "opus") return [name];
  throw new Error(`Ukjent modell ${name}; bruk sonnet eller opus.`);
}
```

`eval/cases/index.ts`:

```ts
import type { Case } from "./types.js";

export const ALL_CASES: Case[] = [];

/** All cases, the one with this id, or those in this area. */
export function selectCases(cases: Case[], filter?: string): Case[] {
  if (filter === undefined) return cases;
  const picked = cases.filter((c) => c.id === filter || c.area === filter);
  if (picked.length === 0) throw new Error(`Ingen sak eller område heter ${filter}.`);
  return picked;
}
```

- [ ] **Step 4: mcp.ts**

Read `node_modules/@modelcontextprotocol/client/dist/index.d.mts` for `OAuthClientProvider`, `OAuthClientMetadata`, `StoredOAuthClientInformation`, `StoredOAuthTokens`, `StreamableHTTPClientTransport` (its `finishAuth` overloads) and `UnauthorizedError`, and adjust types below to what typecheck requires. The server accepts a `http://127.0.0.1:<port>/callback` redirect (`api/src/auth/clients.ts`).

`eval/src/mcp.ts`:

```ts
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import type { ToolHost, ToolInfo } from "./loop.js";

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The server runs one request at a time and answers 503 when busy; nothing ran, so one retry after 2 s is safe. */
export function retryOn503(fetchImpl: Fetch, sleep: (ms: number) => Promise<void> = wait): Fetch {
  return async (input, init) => {
    const res = await fetchImpl(input, init);
    if (res.status !== 503) return res;
    await sleep(2000);
    return fetchImpl(input, init);
  };
}

/** OAuth state for one run, in memory only. */
export class MemoryOAuthProvider implements OAuthClientProvider {
  private info: StoredOAuthClientInformation | undefined;
  private saved: StoredOAuthTokens | undefined;
  private verifier = "";

  constructor(
    private readonly redirect: string,
    private readonly open: (url: URL) => void,
  ) {}

  get redirectUrl(): string {
    return this.redirect;
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "fiken-mcp eval",
      redirect_uris: [this.redirect],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }
  clientInformation(): StoredOAuthClientInformation | undefined {
    return this.info;
  }
  saveClientInformation(info: StoredOAuthClientInformation): void {
    this.info = info;
  }
  tokens(): StoredOAuthTokens | undefined {
    return this.saved;
  }
  saveTokens(tokens: StoredOAuthTokens): void {
    this.saved = tokens;
  }
  redirectToAuthorization(url: URL): void {
    this.open(url);
  }
  saveCodeVerifier(verifier: string): void {
    this.verifier = verifier;
  }
  codeVerifier(): string {
    return this.verifier;
  }
}

/** A one-shot local server for the OAuth redirect. */
async function callbackServer(): Promise<{ redirectUrl: string; params: Promise<URLSearchParams>; close(): void }> {
  let resolve!: (p: URLSearchParams) => void;
  const params = new Promise<URLSearchParams>((r) => (resolve = r));
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("Innlogget. Du kan lukke denne fanen.");
    resolve(url.searchParams);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { redirectUrl: `http://127.0.0.1:${port}/callback`, params, close: () => server.close() };
}

const openBrowser = (url: URL): void => {
  spawn("open", [url.toString()], { stdio: "ignore", detached: true }).unref();
};

/** Connects to <apiUrl>/mcp, logging in through the browser; the token stays in memory. */
export async function connectHost(apiUrl: string): Promise<ToolHost & { close(): Promise<void> }> {
  const callback = await callbackServer();
  const provider = new MemoryOAuthProvider(callback.redirectUrl, openBrowser);
  const url = new URL("/mcp", apiUrl);
  const newTransport = () => new StreamableHTTPClientTransport(url, { authProvider: provider, fetch: retryOn503(fetch) });
  let client = new Client({ name: "fiken-mcp-eval", version: "0" });
  try {
    const first = newTransport();
    try {
      await client.connect(first);
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) throw err;
      console.log("Logg inn med Fiken i nettleseren som åpnet seg …");
      await first.finishAuth(await callback.params);
      client = new Client({ name: "fiken-mcp-eval", version: "0" });
      await client.connect(newTransport());
    }
  } finally {
    callback.close();
  }

  const { tools } = await client.listTools();
  return {
    tools: tools.map((t): ToolInfo => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as Record<string, unknown>, annotations: t.annotations })),
    instructions: client.getInstructions(),
    async call(name, args) {
      const r = await client.callTool({ name, arguments: args });
      const content = Array.isArray(r.content) ? (r.content as Array<{ type: string; text?: string }>) : [];
      const text = content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
      return { text: text || JSON.stringify(r.structuredContent ?? {}), structured: r.structuredContent, isError: r.isError === true };
    },
    close: () => client.close(),
  };
}
```

(If `finishAuth` takes the authorization code string rather than `URLSearchParams` in this SDK version, pass `(await callback.params).get("code") ?? ""`.)

- [ ] **Step 5: report.ts**

`eval/src/report.ts`:

```ts
import type { Case } from "../cases/types.js";
import type { Grade } from "./grade.js";
import type { TranscriptEntry } from "./loop.js";

export type RunRecord = {
  caseId: string;
  area: string;
  reviewed: boolean;
  model: string;
  run: number;
  ms: number;
  usage: { input: number; output: number };
  expectBehaviour: Case["expect"]["behaviour"];
  grade: Grade;
  transcript: TranscriptEntry[];
};

const BEHAVIOUR_LABELS = { previewFirst: "forhåndsvisning", askChoice: "valgknapper", readHelp: "hjelpeartikkel" } as const;
type BehaviourKey = keyof typeof BEHAVIOUR_LABELS;
const ROW = /^\| ([^|]+?) \| ([^|]+?) \| (\d+\/\d+) \|/;

const passes = (cell: string): number => Number(cell.split("/")[0]);

function groups(runs: RunRecord[]): Map<string, RunRecord[]> {
  const out = new Map<string, RunRecord[]>();
  for (const r of runs) {
    const key = `${r.caseId}|${r.model}`;
    out.set(key, [...(out.get(key) ?? []), r]);
  }
  return out;
}

function behaviourCell(rs: RunRecord[]): string {
  const wanted = Object.entries(rs[0]!.expectBehaviour ?? {}).filter(([, v]) => v === true).map(([k]) => k as BehaviourKey);
  return wanted.map((k) => `${BEHAVIOUR_LABELS[k]} ${rs.filter((r) => r.grade.behaviour[k]).length}/${rs.length}`).join(", ");
}

/** The report's summary as case|model → «passed/total». */
export function parseSummary(md: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of md.split("\n")) {
    const m = ROW.exec(line);
    if (m) out.set(`${m[1]}|${m[2]}`, m[3]!);
  }
  return out;
}

export function renderReport(runs: RunRecord[], startedAt: Date, previous?: Map<string, string>): string {
  const lines: string[] = [];
  const unreviewed = new Set(runs.filter((r) => !r.reviewed).map((r) => r.caseId)).size;
  lines.push(`# Evaluering ${startedAt.toISOString()}`, "");
  if (unreviewed > 0) lines.push(`${unreviewed} av sakene er ikke revidert av regnskapsfører.`, "");

  const header = previous ? "| Sak | Modell | Bestått | Atferd | Forrige |" : "| Sak | Modell | Bestått | Atferd |";
  lines.push(header, previous ? "|---|---|---|---|---|" : "|---|---|---|---|");
  for (const [key, rs] of groups(runs)) {
    const passed = rs.filter((r) => r.grade.outcome === "pass").length;
    const cell = `${passed}/${rs.length}`;
    let row = `| ${rs[0]!.caseId} | ${rs[0]!.model} | ${cell} | ${behaviourCell(rs)} |`;
    if (previous) {
      const before = previous.get(key);
      const mark = before === undefined ? "ny" : passes(cell) > passes(before) ? `${before} ↑` : passes(cell) < passes(before) ? `${before} ↓` : before;
      row += ` ${mark} |`;
    }
    lines.push(row);
  }

  const input = runs.reduce((s, r) => s + r.usage.input, 0);
  const output = runs.reduce((s, r) => s + r.usage.output, 0);
  const seconds = Math.round(runs.reduce((s, r) => s + r.ms, 0) / 1000);
  lines.push("", `Tokens: ${input} inn, ${output} ut. Tid: ${seconds} s.`, "");

  const failures = runs.filter((r) => r.grade.outcome !== "pass");
  if (failures.length > 0) lines.push("## Feil", "");
  for (const r of failures) {
    lines.push(`### ${r.caseId} · ${r.model} · kjøring ${r.run}: ${r.grade.outcome}`, "");
    for (const p of r.grade.problems) lines.push(`- ${p}`);
    for (const n of r.grade.notes) lines.push(`- Merknad: ${n}`);
    lines.push("", "```text", ...r.transcript.map((t) => `${t.who}: ${t.text}`), "```", "");
  }
  return lines.join("\n");
}
```

- [ ] **Step 6: cli.ts**

`eval/src/cli.ts`:

```ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { ALL_CASES, selectCases } from "../cases/index.js";
import { grade } from "./grade.js";
import { runConversation } from "./loop.js";
import { connectHost } from "./mcp.js";
import { MODELS, selectModels } from "./models.js";
import { parseSummary, renderReport, type RunRecord } from "./report.js";

const { values } = parseArgs({
  options: {
    case: { type: "string" },
    model: { type: "string" },
    runs: { type: "string", default: "3" },
    api: { type: "string", default: "https://api.fiken-mcp.byjoba.com" },
    compare: { type: "string" },
  },
});

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Sett ANTHROPIC_API_KEY i miljøet.");
  process.exit(1);
}

const cases = selectCases(ALL_CASES, values.case);
const models = selectModels(values.model);
const runs = Number(values.runs);
const previous = values.compare ? parseSummary(readFileSync(values.compare, "utf8")) : undefined;
const startedAt = new Date();

const host = await connectHost(values.api);
const anthropic = new Anthropic();
const model = { create: (p: Anthropic.MessageCreateParamsNonStreaming) => anthropic.messages.create(p) };
const records: RunRecord[] = [];

try {
  for (const c of cases) {
    for (const m of models) {
      for (let run = 1; run <= runs; run++) {
        const start = Date.now();
        const result = await runConversation({ host, model, modelId: MODELS[m], c });
        const g = grade(c.expect, result.trace);
        records.push({ caseId: c.id, area: c.area, reviewed: c.reviewed, model: m, run, ms: Date.now() - start, usage: result.usage, expectBehaviour: c.expect.behaviour, grade: g, transcript: result.transcript });
        console.log(`${c.id} ${m} ${run}: ${g.outcome}${g.problems[0] ? ` – ${g.problems[0]}` : ""}`);
      }
    }
  }
} finally {
  await host.close();
  const dir = new URL("../results/", import.meta.url);
  mkdirSync(dir, { recursive: true });
  const stamp = startedAt.toISOString().slice(0, 16).replace("T", "-").replace(":", "");
  const file = new URL(`${stamp}.md`, dir);
  writeFileSync(file, renderReport(records, startedAt, previous));
  console.log(`Rapport: ${file.pathname}`);
}
```

- [ ] **Step 7: Run the tests and typecheck**

Run: `npm test --workspace eval && npm run typecheck --workspace eval`
Expected: PASS, typecheck clean (adjust `mcp.ts` types to the SDK's declarations if needed; do not change behaviour).

- [ ] **Step 8: Commit**

```bash
git add eval/src/models.ts eval/src/mcp.ts eval/src/report.ts eval/src/cli.ts eval/cases/index.ts eval/test/select.test.ts eval/test/mcp.test.ts eval/test/report.test.ts
git commit -m "Eval: MCP login and connection, report, command line"
```

---

### Task 5: The cases, their checks and the docs

**Files:**
- Create: `eval/cases/purchases.ts`, `eval/cases/outlays.ts`, `eval/cases/sales.ts`, `eval/cases/journal.ts`
- Modify: `eval/cases/index.ts`
- Test: `eval/test/cases.test.ts`
- Modify: `README.md`, `CLAUDE.md`, `docs/superpowers/specs/2026-10-04-fiken-mcp-eval-design.md`

**Interfaces:**
- Consumes: `Case` (cases/types.ts); `OPERATIONS` from `api/src/mcp/registry.ts` (each has `name` and `kind: "read" | "write"`); `toPostings`, `isRate` (src/postings.ts).
- Produces: `ALL_CASES` with the 25 cases below.

Demo company facts the cases rely on (checked 2026-10-04): slug `fiken-demo-amerikansk-hytte-as3`; bank account `1920:10001`; supplier «Domeneshop AS» (contactId 5128544942); customer «Demokunde» (contactId 818696461); invoice 10001 (Demokunde, gross 312,50 kr, saleId 818874095, unpaid); invoice 10003 (Jonas Barsten AS, net 2 280 kr, VAT 570 kr, invoiceId 5191494176); invoice 10004 (Jonas Barsten AS, invoiceId 5191494236); invoice 10005 (Jonas Barsten AS, gross 2 017,50 kr, saleId 5191506351, unpaid).

- [ ] **Step 1: Write the failing case checks**

`eval/test/cases.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { OPERATIONS } from "../../api/src/mcp/registry.js";
import { ALL_CASES } from "../cases/index.js";

const writes = new Set(OPERATIONS.filter((o) => o.kind === "write").map((o) => o.name));

describe("the cases", () => {
  it("are 25, with unique kebab-case ids, in all four areas", () => {
    expect(ALL_CASES).toHaveLength(25);
    const ids = ALL_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(new Set(ALL_CASES.map((c) => c.area))).toEqual(new Set(["kjøp", "utlegg", "salg", "bilag"]));
  });

  it("name only real write operations", () => {
    for (const c of ALL_CASES) for (const op of c.expect.operations) expect(writes.has(op), `${c.id}: ${op}`).toBe(true);
  });

  it("expect postings that balance where amounts are given", () => {
    for (const c of ALL_CASES) {
      const gross = (side: string) => c.expect.postings.filter((p) => p.side === side).reduce((s, p) => s + (p.amount ?? (p.net !== undefined ? p.net + Math.round((p.net * Number(p.vat ?? 0)) / 100) : 0)), 0);
      if (c.expect.postings.length > 0 && c.expect.exact !== false) expect(gross("debit"), c.id).toBe(gross("credit"));
    }
  });

  it("all point to a source and are unreviewed until an accountant has checked them", () => {
    for (const c of ALL_CASES) {
      expect(c.source.length, c.id).toBeGreaterThan(0);
      expect(c.reviewed, c.id).toBe(false);
    }
  });
});
```

Run: `npm test --workspace eval -- cases`
Expected: FAIL (`ALL_CASES` is empty).

- [ ] **Step 2: Look up the sources**

Run: `curl -s https://hjelp.fiken.no/llms.txt | grep -i -E "kjøp|utlegg|faktura|kreditnota|betaling|fri postering|avskriv|periodiser|bankgebyr|renter|kontant"`

For each case below, set `source` to the URL of the article whose subject matches the case (the line's link); where none fits, set `source: "ingen artikkel"`. These are the only values left open in this task, and only because the help site's slugs must be read from it.

- [ ] **Step 3: The cases**

Shared values at the top of each file:

```ts
import type { Case } from "./types.js";

const company = "fiken-demo-amerikansk-hytte-as3";
const replies = { company, default: "Ja, det stemmer. Bruk bankkontoen 1920:10001 og dagens dato." };
```

`eval/cases/purchases.ts` (`export const PURCHASES: Case[]`):

| id | prompt | operations | postings | behaviour |
|---|---|---|---|---|
| `kjop-kontorrekvisita` | «Kjøpte kontorrekvisita for 625 kr inkl. 25 % mva, betalt med firmakortet fra bankkontoen i dag. Før det i demoforetaket.» | `create_purchase`, `create_journal_entry` | debit `["6800","6810"]` net 50000 vat "25"; credit `["1920:10001"]` amount 62500 | previewFirst |
| `kjop-togbillett` | «Togbillett til kundebesøk, 448 kr inkl. 12 % mva, betalt med firmakortet. Før det i demoforetaket.» | `create_purchase`, `create_journal_entry` | debit `["7140","7130"]` net 40000 vat "12"; credit `["1920:10001"]` amount 44800 | previewFirst |
| `kjop-porto` | «Kjøpte frimerker for 220 kr med firmakortet. Porto har ikke mva. Før det i demoforetaket.» | `create_purchase`, `create_journal_entry` | debit `["6940"]` net 22000; credit `["1920:10001"]` amount 22000 | previewFirst |
| `kjop-leverandorfaktura` | «Fikk faktura fra Domeneshop AS på 1 250 kr inkl. 25 % mva for domene og webhotell, forfall om 14 dager. Før den i demoforetaket.» | `create_purchase` | debit `["6420","6550","6551","6553"]` net 100000 vat "25"; credit `["2400*"]` amount 125000 | previewFirst |
| `kjop-blandet-mva` | «Kvittering fra Rema betalt med firmakortet: matvarer til personalmøte 230 kr inkl. 15 % mva og tørkepapir 125 kr inkl. 25 % mva. Før den i demoforetaket.» | `create_purchase`, `create_journal_entry` | debit `["5*","6*","7*"]` net 20000 vat "15"; debit `["5*","6*","7*"]` net 10000 vat "25"; credit `["1920:10001"]` amount 35500 | previewFirst, readHelp |
| `kjop-forsikring` | «Betalte årspremie for bedriftsforsikring, 4 800 kr, fra bankkontoen. Forsikring har ikke mva. Før det i demoforetaket.» | `create_purchase`, `create_journal_entry` | debit `["7500"]` net 480000; credit `["1920:10001"]` amount 480000 | previewFirst |
| `kjop-mobilregning` | «Mobilregningen på 499 kr inkl. 25 % mva ble trukket fra bankkontoen. Før den i demoforetaket.» | `create_purchase`, `create_journal_entry` | debit `["6900"]` net 39920 vat "25"; credit `["1920:10001"]` amount 49900 | previewFirst |

`eval/cases/outlays.ts` (`export const OUTLAYS: Case[]`):

| id | prompt | operations | postings | behaviour |
|---|---|---|---|---|
| `utlegg-kontorrekvisita` | «En ansatt kjøpte kontorrekvisita for 500 kr inkl. 25 % mva med privat kort. Før utlegget i demoforetaket; vi betaler henne tilbake senere.» | `create_journal_entry`, `create_purchase` | debit `["6800","6810"]` net 40000 vat "25"; credit `["2910","2911"]` amount 50000 | previewFirst, readHelp |
| `utlegg-taxi` | «En ansatt tok taxi til et kundemøte for 336 kr inkl. 12 % mva og betalte privat. Før utlegget i demoforetaket.» | `create_journal_entry`, `create_purchase` | debit `["7140","7130"]` net 30000 vat "12"; credit `["2910","2911"]` amount 33600 | previewFirst, readHelp |
| `utlegg-porto` | «En ansatt betalte 150 kr i porto privat. Porto har ikke mva. Før utlegget i demoforetaket.» | `create_journal_entry`, `create_purchase` | debit `["6940"]` net 15000; credit `["2910","2911"]` amount 15000 | previewFirst, readHelp |
| `utlegg-hotell` | «En ansatt betalte én hotellnatt på jobbreise privat, 1 120 kr inkl. 12 % mva. Før utlegget i demoforetaket.» | `create_journal_entry`, `create_purchase` | debit `["7140","7130"]` net 100000 vat "12"; credit `["2910","2911"]` amount 112000 | previewFirst, readHelp |
| `utlegg-tilbakebetaling` | «Vi har betalt tilbake 500 kr til en ansatt for et utlegg, fra bankkontoen i dag. Før tilbakebetalingen i demoforetaket.» | `create_journal_entry` | debit `["2910","2911"]` amount 50000; credit `["1920:10001"]` amount 50000 | previewFirst, readHelp |

`eval/cases/sales.ts` (`export const SALES: Case[]`):

| id | prompt | operations | args | postings | behaviour |
|---|---|---|---|---|---|
| `salg-faktura-radgivning` | «Lag en faktura i demoforetaket til Demokunde for 10 timer rådgivning à 1 200 kr eks. mva, 25 % mva, forfall om 14 dager. Ikke send den.» | `create_invoice` | `{ customerId: 818696461 }` | credit `["3*"]` net 1200000 vat "25"; debit `["1500*"]` amount 1500000 | previewFirst |
| `salg-faktura-uten-mva` | «Lag en faktura i demoforetaket til Demokunde for et kurs som er unntatt mva, 3 000 kr. Forfall om 14 dager. Ikke send den.» | `create_invoice` | `{ customerId: 818696461 }` | credit `["3*"]` net 300000 vat "0"; debit `["1500*"]` amount 300000 | previewFirst |
| `salg-kontant-vipps` | «Vi solgte varer for 2 500 kr inkl. 25 % mva betalt med Vipps; pengene kom inn på bankkontoen i dag. Før salget i demoforetaket.» | `create_sale` | — | credit `["3*"]` net 200000 vat "25"; debit `["1920:10001"]` amount 250000 | previewFirst |
| `salg-kreditnota-full` | «Kunden har reklamert på faktura 10004 i demoforetaket. Krediter hele fakturaen.» | `create_credit_note` | `{ kind: "full", invoiceId: 5191494236 }` | none (`postings: []`) | previewFirst |
| `salg-kreditnota-delvis` | «Gi Jonas Barsten AS 20 % avslag på faktura 10003 i demoforetaket (2 280 kr eks. mva, 25 % mva) som en kreditnota.» | `create_credit_note` | `{ kind: "partial", invoiceId: 5191494176 }` | debit `["3*"]` net 45600 vat "25"; credit `["1500*"]` amount 57000 | previewFirst |
| `salg-betaling-full` | «Demokunde har betalt faktura 10001 i demoforetaket i sin helhet til bankkontoen i dag. Registrer betalingen.» | `register_payment` | `{ saleId: 818874095 }` | debit `["1920:10001"]` amount 31250; credit `["1500*"]` amount 31250 | previewFirst |
| `salg-delbetaling` | «Jonas Barsten AS har betalt 1 000 kr av faktura 10005 i demoforetaket til bankkontoen i dag. Registrer delbetalingen.» | `register_payment` | `{ saleId: 5191506351 }` | debit `["1920:10001"]` amount 100000; credit `["1500*"]` amount 100000 | previewFirst |

`eval/cases/journal.ts` (`export const JOURNAL: Case[]`):

| id | prompt | operations | postings | behaviour |
|---|---|---|---|---|
| `bilag-lan-fra-eier` | «Eieren har satt inn 50 000 kr på bankkontoen som et lån til selskapet. Før det i demoforetaket.» | `create_journal_entry` | debit `["1920:10001"]` amount 5000000; credit `["22*","29*"]` amount 5000000 | previewFirst, readHelp |
| `bilag-bankgebyr` | «Banken trakk 89 kr i gebyr fra bankkontoen. Før det i demoforetaket.» | `create_journal_entry`, `create_purchase` | debit `["7770"]` amount 8900; credit `["1920:10001"]` amount 8900 | previewFirst |
| `bilag-renteinntekt` | «Vi fikk 312 kr i renter på bankkontoen. Før det i demoforetaket.» | `create_journal_entry` | debit `["1920:10001"]` amount 31200; credit `["8040","8050"]` amount 31200 | previewFirst |
| `bilag-omklassifisering` | «Vi førte 1 500 kr på konto 6800 som skulle vært på 6550. Rett det med en postering i demoforetaket.» | `create_journal_entry` | debit `["6550"]` amount 150000; credit `["6800"]` amount 150000 | previewFirst, readHelp |
| `bilag-periodisering` | «Vi betalte 12 000 kr for et årsabonnement på programvare i januar og førte det som forskuddsbetalt kostnad. Før oktobers del, 1 000 kr, som kostnad i demoforetaket.» | `create_journal_entry` | debit `["6420","6550","6551","6553"]` amount 100000; credit `["17*"]` amount 100000 | previewFirst, readHelp |
| `bilag-avskrivning` | «Før årets avskrivning på inventar, 6 000 kr, mot konto 1250 i demoforetaket.» | `create_journal_entry` | debit `["6000","6010","6015"]` amount 600000; credit `["1250"]` amount 600000 | previewFirst, readHelp |

Write each row as a `Case`:

```ts
{
  id: "kjop-kontorrekvisita",
  area: "kjøp",
  prompt: "Kjøpte kontorrekvisita for 625 kr inkl. 25 % mva, betalt med firmakortet fra bankkontoen i dag. Før det i demoforetaket.",
  replies,
  expect: {
    operations: ["create_purchase", "create_journal_entry"],
    postings: [
      { side: "debit", account: ["6800", "6810"], net: 50000, vat: "25" },
      { side: "credit", account: ["1920:10001"], amount: 62500 },
    ],
    behaviour: { previewFirst: true },
  },
  source: "<from Step 2>",
  reviewed: false,
},
```

`area` per file: purchases.ts `"kjøp"`, outlays.ts `"utlegg"`, sales.ts `"salg"`, journal.ts `"bilag"`. A row with args adds `args` to `expect`. A posting without a VAT column has no `vat` field.

`eval/cases/index.ts` — replace `export const ALL_CASES: Case[] = [];` with:

```ts
import { JOURNAL } from "./journal.js";
import { OUTLAYS } from "./outlays.js";
import { PURCHASES } from "./purchases.js";
import { SALES } from "./sales.js";

export const ALL_CASES: Case[] = [...PURCHASES, ...OUTLAYS, ...SALES, ...JOURNAL];
```

(Keep the existing `import type { Case }` and `selectCases`.)

- [ ] **Step 4: Run the case checks**

Run: `npm test --workspace eval && npm run typecheck --workspace eval`
Expected: PASS. A failing balance check means a typo in a row; fix the row, not the test.

- [ ] **Step 5: Docs**

`README.md`: add a section after the development section:

```markdown
## Evaluering

`eval/` spiller faste regnskapssaker gjennom den ekte koblingen med Claude
og sjekker føringen modellen foreslår mot det en regnskapsfører ville ført.
Ingenting skrives til Fiken: kjøreren videresender bare verktøy som er
merket som lesing, og stopper ved første skriveforsøk eller etter
forhåndsvisningen.

    export ANTHROPIC_API_KEY=…
    npm run eval -- [--case <id|område>] [--model sonnet|opus] [--runs 3] [--compare eval/results/<tidligere>.md]

Første kjøring åpner nettleseren for innlogging med Fiken; tokenet ligger
bare i minnet. Sakene (`eval/cases/`) har 25 tilfeller innen kjøp, utlegg,
salg og bilag i demoforetaket, og er ikke revidert av regnskapsfører ennå.
Rapporten havner i `eval/results/` (ikke i git) med bestått per sak og
modell, atferd (forhåndsvisning, valgknapper, hjelpeartikler), tokens og
avskrift av hver feil. En full kjøring er 150 samtaler, én om gangen;
tokenbruken står i rapporten.
```

(Match the README's language and heading style: if the README is in English, write the section in English with the same content.)

`CLAUDE.md`, in the Process paragraph, replace the line beginning «Next: the eval set,» with:

```
Eval plan executed 2026-10-04 (`eval/` runner and 25 cases; see `docs/superpowers/plans/2026-10-04-fiken-mcp-eval.md`).
Next: deletes decision, ChatGPT verification.
```

`docs/superpowers/specs/2026-10-04-fiken-mcp-eval-design.md`: in section 6's `Case` type, add `args?: Record<string, unknown>;` to `expect` with the comment `// args that must equal these values (payments, credit notes)`, and in section 7's «A run passes when» list add «every key in `args` equals the proposal's arg (compared as JSON);».

- [ ] **Step 6: Full checks**

Run: `npm test && npm run typecheck && npm run synth`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add eval/cases eval/test/cases.test.ts README.md CLAUDE.md docs/superpowers/specs/2026-10-04-fiken-mcp-eval-design.md
git commit -m "Eval: 25 cases across purchases, outlays, sales and journal entries; docs"
```

---

## After the plan

A first real run is Jonas's: `ANTHROPIC_API_KEY=… npm run eval -- --case kjop-kontorrekvisita --model sonnet --runs 1` to check login and one conversation end to end, then the full run.
