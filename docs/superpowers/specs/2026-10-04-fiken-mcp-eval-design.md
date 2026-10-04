# Evaluation set: design

Date: 2026-10-04.

## 1. Purpose

Find out whether Claude books correctly through this connector and notice
when a change makes it worse. Each case is an accounting situation with the
booking a competent accountant would make. A runner plays the case through
the real connector, takes the booking the model proposes, and grades it.

Agreed with Jonas:

- A script on his machine, not CI and not a manual checklist.
- Declarative checks, not an LLM judge.
- All four areas: purchases and receipts, employee outlays, sales and
  invoices, journal entries.
- Sonnet and Opus, 3 runs per case.
- The runner runs the tool loop itself (approach A). The Anthropic API's
  MCP connector cannot block writes, and Claude Code headless tests a
  different system prompt and harness.

Nothing is ever written to Fiken: the demo company fills up (101-document
cap on sending), and every test booking would stay there.

Out of scope: CI, an LLM judge, reproducing claude.ai's system prompt,
ChatGPT.

## 2. Layout

A new workspace `eval/` (added to the root `workspaces`), TypeScript like
`api/`:

```
eval/
  src/
    cli.ts          arguments, the run loop over cases × models × runs
    auth.ts         OAuth (register, PKCE, localhost callback), token in memory
    mcp.ts          MCP SDK client to <api>/mcp
    loop.ts         one conversation: model ↔ tools, write blocking, simulated user
    user.ts         the simulated user's answers
    postings.ts     write args → postings, per supported operation
    grade.ts        postings and behaviour against a case's expectations
    report.ts       Markdown report, compare with an earlier report
    models.ts       model ids in one place
  cases/
    types.ts        the Case type
    purchases.ts  outlays.ts  sales.ts  journal.ts
  test/
  results/          gitignored
```

New dependency: `@anthropic-ai/sdk` (in `eval/` only). The MCP SDK client
comes from the package `api/` already uses.

## 3. Logging in

The server already accepts a localhost redirect (`api/src/auth/clients.ts`),
as Claude Code uses. The runner registers a client at `/register`, opens the
browser at `/authorize` with PKCE and a `http://127.0.0.1:<port>/callback`
redirect, exchanges the code at `/token`, and keeps the access token in
memory for the run. Nothing is written to disk. A 401 during the run (expired
token) refreshes once with the refresh token, else stops with a message.

`ANTHROPIC_API_KEY` comes from the environment and is never written.

## 4. The conversation loop

For each run:

1. Connect to `<api>/mcp` (default `https://api.fiken-mcp.byjoba.com`,
   overridable with `--api`), list the tools and read the server's
   instructions.
2. System prompt: a short neutral prompt («Du hjelper brukeren med
   regnskap i Fiken. Svar på norsk.») followed by the server's instructions,
   as a client would pass them. The tools are passed as Anthropic tools with
   their input schemas.
3. The user message is the case's `prompt`. The model runs; tool calls are
   handled by the runner:
   - **Writes are never forwarded.** `fiken_write` and every tool the server
     marks as not read-only (`annotations.readOnlyHint` false or missing:
     `create_purchase` and the like) are answered with a fixed tool result
     («Skriving er slått av i evalueringen.») and recorded as a proposal.
   - **`preview_booking`** is forwarded (it never writes). Its args are
     recorded as the proposal. The simulated user then answers «Ja, før
     dette (ref <ref>).», and the next write the model attempts ends the
     conversation (the write itself is blocked as above).
   - **`ask_user_choice`, `ask_user_form`** are forwarded (for the tool
     result), and the simulated user answers as the next user message
     (section 5).
   - Every other tool (reads, help, `show_table`, `show_document`) is
     forwarded and its result returned.
4. The conversation ends at a blocked write, after the model ends its turn
   without a tool call twice in a row (the simulated user has given its
   `default` reply once), or after 25 model turns. Tool calls go one at a
   time; a 503 from the server waits 2 s and retries once.

The proposal graded is the last blocked write, else the last
`preview_booking`. No proposal is its own outcome.

## 5. The simulated user

A case's `replies`:

- `company`: the `companySlug` to choose. An `ask_user_choice` gets the
  option whose value matches (sent as the widget would: `<label> (<value>)`),
  else the case's `choices` by question text (substring), else `default`.
- `form`: field name → value. An `ask_user_form` answer is built like the
  widget's message (`<title>:` then `- <label>: <value>`), from these
  values or the fields' suggested values.
- `default`: the answer to a text question («Ja, det stemmer.»).

## 6. Cases

```ts
type Case = {
  id: string;                       // unique, kebab-case
  area: "kjøp" | "utlegg" | "salg" | "bilag";
  prompt: string;                   // Norwegian, as a user would write
  replies: { company: string; form?: Record<string, string>; choices?: Record<string, string>; default: string };
  expect: {
    operations: string[];           // allowed write operations
    postings: Expected[];           // see section 7
    args?: Record<string, unknown>; // args that must equal these values (payments, credit notes)
    exact?: boolean;                // default true: no unexpected postings
    behaviour?: { previewFirst?: boolean; askChoice?: boolean; readHelp?: boolean };
  };
  source: string;                   // the Fiken help article the answer rests on
  reviewed: boolean;                // false until an accountant has checked it
};
type Expected = { side: "debit" | "credit"; account: string[]; net?: number; amount?: number; vat?: "25" | "15" | "12" | "0" };
```

About 25 cases to start, across the four areas, each with `source` pointing
to the help article on hjelp.fiken.no it follows, and `reviewed: false`
(«ikke revidert av regnskapsfører» in the report). Cases needing existing
data (an invoice to credit, a supplier, a receipt in the inbox) name objects
that exist in the demo company (`fiken-demo-amerikansk-hytte-as3`); a test
checks only the case file, so a case whose data has gone shows up as «no
proposal» in the report.

Amounts are in øre. An account in `account` is matched exactly or, with a
trailing `*`, by prefix (`1920*` matches `1920:10001`).

## 7. Grading

**Postings.** Each supported write operation has a converter from its args
to postings `{ side, account, net, vat? }`:

| Operation | Postings |
|---|---|
| `create_journal_entry` | each line's debit and credit side; a side with a VAT code is net with that code's rate (codes 1 and 3: 25), a side without is the amount as given |
| `create_purchase` | each line: debit `account`, net `netPrice`, rate from `vatType`; credit the payment account (cash) or `2400*` (supplier) for the gross total |
| `create_sale` | each line: credit income account with net and rate; debit the payment account or `1500*` for the gross total |
| `create_invoice` | each line: credit `incomeAccount`, net from quantity × `unitPrice` less discount, rate from `vatType`; debit `1500*` for the gross total |
| `create_credit_note` | as an invoice, sides swapped |
| `register_payment` | debit the payment account, credit `1500*` (invoice) or `2400*` (purchase) |

The exact arg shapes are taken from the operations' schemas in
`api/src/mcp/tools`; a converter is a pure function with its own tests.
Operations without a converter are graded on `operations` only.

**Comparison.** A run passes when:

- the proposal's operation is in `operations`;
- every key in `args` equals the proposal's arg (compared as JSON);
- every expected posting is matched by a different actual posting (same
  side, account in the list, `net` or `amount` exact when given, `vat` equal
  when given);
- with `exact`, no actual posting is left unmatched;
- the postings balance (debit total = credit total, counting VAT where a
  rate is set).

A failure lists the differences in Norwegian, e.g. «forventet kredit 2911
500,00 kr, fikk kredit 1920:10001 500,00 kr».

**Behaviour**, reported apart from the booking:

- `previewFirst`: a `preview_booking` came before the first write attempt.
- `askChoice`: an `ask_user_choice` was called.
- `readHelp`: a `fiken_help_article` was read (through `fiken_read`).

Each run ends as one of: pass, wrong booking, no proposal, error (with the
message).

## 8. Running and the report

```
npm run eval -- [--case <id|area>] [--model sonnet|opus] [--runs 3] [--api <url>] [--compare <report>]
```

Defaults: all cases, both models, 3 runs. Model ids in `models.ts`
(`claude-sonnet-5-5`, `claude-opus-5-5`). Runs go one at a time; a line per
run is printed as it ends.

The report, `eval/results/<YYYY-MM-DD-HHmm>.md` (gitignored):

- a table: case × model, pass count of runs (e.g. 2/3), and the behaviour
  checks;
- input and output tokens and duration per case and in total;
- per failure: the differences and the full transcript (tool calls and
  results shortened to 2 000 characters each).

`--compare` adds a column with the earlier report's result and marks cases
that got better or worse.

## 9. Testing the runner

vitest, no network:

- each converter, with real arg shapes from the operations' schemas;
- the comparison: alternatives, prefix accounts, exact vs not, the
  Norwegian difference text, balance;
- the simulated user's choice and form answers;
- the loop with a fake MCP client and a fake model: a write tool call is
  never forwarded, `preview_booking` is, the conversation ends where
  section 4 says, a 503 is retried once;
- the case files: ids unique, every `operations` entry is a real write
  operation in the registry, every case's expected postings balance.

The README gets an «Evaluering» section (how to run, what it costs to know,
that nothing is written).
