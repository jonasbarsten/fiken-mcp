# Fiken's help for the model: design

Date: 2026-10-05. Replaces the first version of this spec (our own guides
in `guides/`, kept in git history), after Jonas asked whether the model
could use Fiken's own help instead of guides we write and keep fresh.

## 1. Purpose

Claude and ChatGPT should book correctly in Fiken when a case is more than
a plain purchase or sale. The receipts example on the website showed the
problem: the model booked an employee's outlay as an unpaid purchase with
the employee as supplier, where Fiken books it as «Betalt av ansatt» on
2911 Gjeld til ansatte.

Fiken already publishes its help for language models:
`https://hjelp.fiken.no/llms.txt` lists every help article (278 on
2026-10-05), and every article exists as Markdown at
`https://hjelp.fiken.no/<slug>.md`, with frontmatter (`title`,
`last_updated`, `chatbot_deprioritize`, `source_url`). Fiken keeps it
current. The connector lets the model read it, and adds only what Fiken's
help cannot know: how the steps in Fiken's screens map to this connector's
operations, and where the API cannot do what the screens can.

Agreed with Jonas:

- No guides of our own, no copies of Fiken's help: articles are fetched
  live from `hjelp.fiken.no` when the model asks.
- A short list of translations from Fiken's screens to the connector's
  operations, maintained in the code.
- VAT codes on manual journal entries (section 5), which Fiken's own
  answers need («Fri postering» with VAT, outlays).
- The eval set (realistic messages → expected booking) is a separate,
  later plan.

Out of scope: our own guide pages on the website, a Claude skill, the
account help at `kontohjelp.fiken.no` (no Markdown version; a JavaScript
app), searching inside article text.

## 2. Operations (concept `help`)

Both are reads through `fiken_read`, visible on every connection
(including `/mcp/readonly`), and make no Fiken API call (no token, not
queued). They are counted in the usage statistics like other operations.

- `fiken_help_index { query? }`: parses `llms.txt` lines of the form
  `- [Title](https://hjelp.fiken.no/<slug>.md)` and returns
  `[{ slug, title }]`. With `query`, only titles containing every word of
  the query (case-insensitive, Norwegian letters as-is) are returned;
  without, all. The full index is about 27 KB, so the description tells
  the model to pass a query.
- `fiken_help_article { slug }`: fetches
  `https://hjelp.fiken.no/<slug>.md` and returns, in this order:
  - a header: title, `last_updated`, the canonical URL;
  - when `chatbot_deprioritize` is true, the line «Fiken marks this
    article as less relevant for chatbots; prefer another article if one
    fits.»;
  - the article body (frontmatter removed, Markdown image lines
    `![…](…)` removed to save tokens);
  - the connector notes (section 3).

Rules:

- `slug` must match `^[a-z0-9-]+$`; anything else is a tool error before
  any fetch.
- Only `https://hjelp.fiken.no` is fetched. A redirect that leaves that
  host is a tool error.
- Timeout 5 s, at most 500 KB read; otherwise a tool error.
- 404 is a tool error that tells the model to use `fiken_help_index`.
- Responses (the index and each article) are kept in the Lambda's memory
  for at most one hour, only to avoid refetching; nothing is written
  anywhere. A failed fetch is not cached.

The fetching lives in one small client (`api/src/help/client.ts`) with an
injectable `fetch`, added to the tool context next to the Fiken client.

## 3. Connector notes

A fixed, short list in `api/src/help/notes.ts`, appended to every article
and summarised in the instructions. Each note names only operations that
exist (a test checks it). Initial content, confirmed against the code
during implementation:

- «Fri postering» (Annet → Fri postering) is `create_journal_entry`
  (fiken_write). Amounts in øre. With a VAT code, a debit line's amount is
  net and a credit line's gross.
- «Nytt kjøp» (Kjøp → Nytt kjøp) is `create_purchase`: `cash_purchase`
  with a bank `paymentAccount`, or `supplier` with `supplierId` and
  `dueDate`. Receipts come in through `upload_receipts`/`get_upload_url`
  or the inbox, and are attached with `inboxDocumentId`.
- «Betalt av ansatt» or «betalt privat» under Betaling on a purchase is
  not available in the API. Book it as one `create_journal_entry`: each
  expense on its account with its VAT code, the gross total credited to
  the account the article names (2911 for an employee), and attach the
  receipts with `attach_inbox_document`.
- Accounts written like `2930:1000X` are an account with a person or
  contact sub-account; find the exact code with `list_accounts`.
- «Ny faktura» is `create_invoice_draft` then
  `create_invoice_from_draft`; sending is `send_invoice`. A credit note
  is `create_credit_note`. Accruals («periodisering») are
  `create_accrual`. Writing off a sale is `write_off_sale`.
- The connector cannot delete, reverse or cancel anything, run payroll
  («Lønn»), use the «Reiser og utlegg» add-on, or do year-end. When an
  article needs that, tell the user to do it in Fiken.

## 4. Instructions at connect time

`createMcpServer` passes `instructions` to `McpServer` (the SDK supports
it):

«For anything other than a plain purchase or sale, look the case up in
Fiken's own help first: fiken_help_index with a query, then
fiken_help_article (both through fiken_read). The articles describe Fiken's
screens; translate them with the connector notes at the end of each article. Go through the
proposed booking with the user before writing anything.»

Relevant operation descriptions point to the help: `create_purchase`
(outlays), `create_journal_entry` (fri postering), `create_accrual`,
`create_credit_note`, `write_off_sale`.

## 5. VAT on journal entries

The outlay case needs one journal entry with VAT from the receipts and
the debt on 2911. `create_journal_entry` refuses VAT codes today
(decision record, coverage plan: "No VAT codes: VAT is booked through
create_purchase or create_sale, where Fiken checks it"). Fiken's API
accepts `debitVatCode` and `creditVatCode` on journal entry lines; with a
VAT code, a debit line's amount is net and a credit line's amount is
gross, and Fiken books the VAT.

- Lines accept optional `debitVatCode` and `creditVatCode` (non-negative
  integers, Fiken's VAT codes).
- When any line has a VAT code, the server skips its own balance check
  (net and gross amounts do not sum) and lets Fiken validate; without
  VAT codes the check stays.
- The decision record gets a dated reversal of the old ruling.
- Verified live on the demo company after deploy.

## 6. Website and docs

- The landing page's «Hva den kan» gets one sentence: Claude and ChatGPT
  look up Fiken's own help articles when a case is more than a plain
  purchase or sale, with a link to `https://hjelp.fiken.no`.
- README: a «Fiken's help» section (the two operations, live fetch, the
  connector notes, nothing stored).
- `docs/setup.md`: a verify list after deploy.

## 7. Privacy

The Lambda fetches public pages from `hjelp.fiken.no` with no user data
in the request (no token, no query beyond the slug). The «we store
nothing» promise holds: the in-memory cache holds only Fiken's public
help text, for at most an hour.

## 8. Testing

- Help client: index parsing (well-formed lines, ignores others), query
  filtering (all words, case-insensitive), slug validation, host check on
  redirects, timeout and size limit, 404, caching (second call within the
  hour does not refetch; a failure is not cached), frontmatter and image
  stripping, the deprioritise line.
- Operations through `fiken_read`: index with and without query, article
  with notes appended, errors as tool errors, no Fiken API call, visible
  on `/mcp/readonly`.
- Notes and pointers: every operation named in `notes.ts` and in
  description pointers exists in the registry.
- Server: `initialize` returns the instructions.
- Journal entries: VAT codes pass through; without VAT the balance check
  stays; negative codes refused.
