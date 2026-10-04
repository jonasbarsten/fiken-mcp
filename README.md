<p align="center">
  <img src="api/src/assets/icon.png" alt="" width="112" height="112">
</p>

<h1 align="center">Fiken MCP</h1>

<p align="center">
  <strong>Your Fiken accounting, from Claude and ChatGPT.</strong><br>
  Book receipts from a photo, send invoices, and ask about your numbers in plain language.
</p>

<p align="center">
  <a href="https://github.com/jonasbarsten/fiken-mcp/actions/workflows/ci.yml"><img src="https://github.com/jonasbarsten/fiken-mcp/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT licence"></a>
  <a href="https://fiken-mcp.byjoba.com"><img src="https://img.shields.io/badge/site-fiken--mcp.byjoba.com-0b6e4f.svg" alt="Website"></a>
</p>

---

A remote [MCP](https://modelcontextprotocol.io) server for the
[Fiken](https://fiken.no) accounting API. I built it to use Fiken from
Claude and ChatGPT in my own companies, and figured I might as well make
it available to others. You log in with Fiken yourself and use it on your
own AI subscription. Nothing is stored on the server. The Norwegian
landing page is [fiken-mcp.byjoba.com](https://fiken-mcp.byjoba.com).

## Trying it

The app is still in development status with Fiken, so there is room for
five users, and I add each one by hand. If you want to try it, send me
the email address you use in Fiken; the address is behind the «Vis
e-postadressen» button on [the landing page](https://fiken-mcp.byjoba.com).

## Getting started

You need:

- Fiken's add-on «API» – 99 kr/month (Fiken MCP itself is free):
  **Foretak › Tilleggstjenester › API**
- access to the app (see above)
- Claude or ChatGPT

**Claude** (mobile, web and desktop):

1. Go to **Customize › Connectors**.
2. Press **Add** and choose **Add custom connector**.
3. Give it a name, for example Fiken, and paste
   `https://api.fiken-mcp.byjoba.com/mcp`.
4. Log in with Fiken when asked.

**Claude Code:**

```
claude mcp add --transport http fiken https://api.fiken-mcp.byjoba.com/mcp
```

**ChatGPT:** not tested yet.

More options (read-only and narrower connections): [Adding the connector](#adding-the-connector).

## What it can do

Nearly everything in Fiken. Nothing can be deleted, reversed or
cancelled; you do that yourself in Fiken, so a mistake by Claude or
ChatGPT can always be corrected in Fiken. If Claude or ChatGPT should
only read, use this address instead:
`https://api.fiken-mcp.byjoba.com/mcp/readonly`.

## Examples

The same conversations as on the landing page (names and numbers made up):

| You write | Claude or ChatGPT answers |
|---|---|
| "An employee paid for some equipment for the company. Here are the receipts, can you sort it out?" | Reads the three receipts (4 138 kr incl. VAT) and offers to book one journal entry with the expenses and VAT, the total as a debt to the employee on 2911 Gjeld til ansatte, with the receipts attached |
| "Invoice Hansen AS for ten hours of consulting in September. I want to see it before it's sent." | Shows the draft (10 × 1 200 kr + VAT = 15 000 kr, due in 14 days), saved as a draft in Fiken, and waits before issuing and sending |
| "Which customers have overdue invoices? Name, email, phone, how much they owe and for how long." | Lists each customer with contact details, amount and days overdue |
| "How much is on the operating account now?" | The balance on 1920 today |
| "Log three hours on project MCP-1 today." | Logs 3 hours on MCP-1, activity Utvikling |
| "Credit invoice 10521, the customer got the wrong price." | Issues a full credit note and offers a new invoice with the right price |

## Privacy and responsibility

Nothing you send is stored: files and accounting data pass through the
server's memory on their way to Fiken. Only anonymous usage counters are
kept ([details](#privacy)).

This is something I made in my spare time, not affiliated with Fiken AS,
provided as is under the [MIT licence](LICENSE). Claude and ChatGPT can
make mistakes; you are responsible for what is booked, invoiced or sent
from your company. Check the result in Fiken.

## How it works

```
Claude / ChatGPT ──MCP over HTTPS──▶ API Gateway ──▶ Lambda (Hono) ──▶ Fiken API
        ▲                                               │
        └──── OAuth: you log in with Fiken ◀────────────┘
```

One stateless Lambda serves MCP (`/mcp`), OAuth, receipt uploads
(`POST /upload`) and the document viewer's downloads (`GET /document`),
plus `/stats` and the connector icon. Fiken allows one
concurrent request, so every call goes through one queue.

Status: live at `https://api.fiken-mcp.byjoba.com` for a handful of
test users. The receipts flow works end to end, and invoices, credit
notes and payments are covered too.

## Tools

A short, fixed tool list instead of one tool per Fiken action:

- The hot-path tools, real tools the receipts flow needs without an extra
  round trip: `list_companies`, `list_projects`, `list_accounts`,
  `list_bank_accounts`, `search_contacts`, `list_inbox`, `create_purchase`.
- The upload tools: `upload_receipts` and `get_upload_url` (see below).
- `ask_user_choice`: shows the user a question with 2-12 options as
  buttons in clients that render widgets (others get a numbered list);
  the answer comes back as the user's next chat message. Read-only, on
  every connection.
- `ask_user_form`: shows the user a short form (1-12 fields: text,
  number, amount, date, select, checkbox) with suggested values in
  clients that render widgets (others get a numbered list); the answers
  come back as one chat message (number and amount answers as typed,
  possibly with a decimal comma; an amount is kroner as typed, not øre).
  A suggested value is at most 200
  characters, the button label 1-40. Read-only, on every connection.
- `show_table`: shows rows you fetched (invoices, inbox documents,
  balances, ...) as a table in clients that render widgets (others get a
  Markdown table), 1-8 columns and 1-50 rows, with up to 3 action buttons
  per row; a text cell is at most 200 characters. A click sends the
  action's message as the user's next chat message and disables that
  row's buttons; other rows stay usable.
  `amount` columns take øre and are shown as kroner; amounts in another
  currency go in a text column. Read-only, on every connection.
- `show_document`: shows the user an inbox document (`inboxDocumentId`)
  or an attachment (`attachmentUuid` from `get_attachments`, with exactly
  one of `purchaseId`, `saleId`, `invoiceId`, `journalEntryId`) as an
  image or a PDF with «Forrige» / «Neste» page buttons, in clients that
  render widgets (others get a line naming the file). The tool looks the
  file up in Fiken and returns a view ticket: encrypted, bound to that
  one Fiken file URL, valid 5 minutes and never longer than the session. The widget fetches the file from `GET /document`
  with the ticket in an `x-ticket` header; the model does not see the
  content (it reads an inbox document with `get_inbox_document`).
  Read-only, on every connection.
- `preview_booking`: takes a write operation's name and args, checks the
  args against the write's schema (journal entries also get their balance
  and VAT-code checks) and shows a summary, the lines in kroner and any
  problems, with «Før dette» and «Endre» buttons in widget clients
  (others get Markdown ending «Ingenting er ført ennå.»). Each preview
  has a reference: the first 6 hex characters of SHA-256 over the
  operation and its parsed args. «Før dette» sends
  «Ja, før dette (ref <ref>).», and the model writes only when that ref
  matches its latest preview of exactly those args, otherwise it
  previews again. The write may still be refused. Never calls Fiken.
  Only on connections that may write, and only for operations visible
  there.
- The gateway: `fiken_explore`, `fiken_read` and `fiken_write`. Every
  operation below, the hot-path ones included, is reachable through it.
  `fiken_explore` lists the concepts, then a concept's operations with
  their inputs (compact JSON; each input is a JSON Schema that marks
  defaulted fields optional and refuses extra keys). `fiken_read` runs a
  read operation and `fiken_write` a write operation, each taking the
  operation's name and its `args`. They are separate tools because the
  host's confirmation prompt follows the tool's annotations. A write
  operation sent to `fiken_read`, unknown names, a key beside `operation`
  and `args` (the reply says to put the inputs under `args`), and args
  that do not match the operation's input are refused before any call to
  Fiken; `args` sent as a JSON string is parsed. Unknown keys in args,
  and in an invoice or purchase line, are refused rather than dropped, so
  a misspelled price cannot issue an invoice at list price. The hot-path
  tools refuse unknown keys the same way. Only the tools listed above can
  be called by name; descriptions and replies that name any other
  operation say which of `fiken_read` or `fiken_write` runs it.
  `fiken_write` is absent when the connection has no visible write
  operation.

Operations by concept (`read` unless marked write):

- `companies`: `list_companies`
- `contacts`: `search_contacts`, `get_contact`, `create_contact` (write),
  `update_contact` (write; only the given fields change, the rest of the
  contact is sent back as it was, groups included; currency, member
  number, phone number and contact persons are kept, verified live
  2026-10-03),
  `list_contact_persons`, `add_contact_person` (write)
- `projects`: `list_projects`, `get_project`, `create_project` (write),
  `update_project` (write; only the given fields change)
- `accounts`: `list_accounts`, `list_bank_accounts` (with the account
  number an invoice draft needs), `account_balances` (date and an account
  range such as 3000-3999), `bank_balances`
- `ledger`: `get_journal_entries`, `get_journal_entry`,
  `create_journal_entry` (write; a manual fri postering, refused unless
  debits and credits balance; accepts `debitVatCode` and `creditVatCode`:
  the amount on a side with a code is net and Fiken adds the VAT, also on a
  line with both accounts (verified 2026-10-05), and the side without a
  code must carry the gross amount. The codes are the Tax Administration's
  standard ones: input VAT 1 (25 %), 11 (15 %), 13 (12 %); output VAT 3
  (25 %), 31 (15 %), 33 (12 %); 1 and 3 are verified on Fiken. With these
  codes the balance is checked including VAT before writing (1 øre of
  rounding per coded side); with any other code Fiken checks it. A VAT
  code needs its account on the same line; the
  description is at most 166 characters, since Fiken's 200-character limit
  includes its 34-character prefix), `list_transactions`, `get_transaction`
  (journal entries carry the `transactionId` it takes),
  `create_accrual` (write; spreads a sale or purchase line over months,
  the line id comes from `get_sale` or `get_purchase`; the balance account
  to accrue to is required: 1397, 1700, 1710, 1742, 1743, 1744, 1749 or
  2961 for purchases, 1530 or 2965 for sales)
- `ehf`: `list_ehf_documents`, `get_ehf_document` (incoming EHF
  e-invoices; `attach_inbox_document` takes an `ehfDocumentId` for
  purchases, sales and journal entries, not invoices)
- `purchases`: `list_purchases`, `get_purchase`, `create_purchase` (write;
  optionally attaching an inbox document), `create_purchase_draft` (write;
  a draft for the user to approve in Fiken, NOK only), `list_purchase_drafts`,
  `create_purchase_from_draft` (write; books it)
- `sales`: `list_sales`, `get_sale` (with lines and payment count),
  `create_sale` (write; income not invoiced through Fiken: a cash sale or an
  invoice issued elsewhere; NOK only), `settle_sale` (write; settle without a
  payment on a given `settledDate`), `write_off_sale` (write; books a loss
  for one of Fiken's four reasons, on a sale that is not a cash sale, not
  settled or written off, and still has an outstanding balance)
- `invoices`: `list_invoices`, `get_invoice`, `create_invoice` (write;
  final in Fiken once created, issued and booked, not sent),
  `send_invoice` (write; final: the customer receives it at once),
  `get_counters` (the invoice and credit note number series: current and
  next number, or null when the series is missing or the company slug is
  wrong), `initialize_counter` (write; takes `firstNumber`, starts a
  series that was never started, never changes an existing one)
- `invoice_drafts`: `create_invoice_draft` (write; needs
  `bankAccountNumber` from `list_bank_accounts`, since Fiken refuses to
  issue a draft without one), `list_invoice_drafts`, `get_invoice_draft`,
  `update_invoice_draft` (write; only the given fields change, the rest of
  the draft is sent back as it was; a draft with several customers is
  refused), `create_invoice_from_draft` (write; issues it)
- `credit_notes`: `list_credit_notes`, `get_credit_note`,
  `create_credit_note` (write; full or partial, booked but not sent),
  `send_credit_note` (write; final: the customer receives it at once)
- `offers`: `list_offers`, `list_offer_drafts`, `create_offer_draft` (write;
  the bank account is optional), `create_offer_from_draft` (write),
  `send_offer` (write; final: the customer receives it at once)
- `order_confirmations`: `list_order_confirmations`,
  `list_order_confirmation_drafts`, `create_order_confirmation_draft`
  (write), `create_order_confirmation_from_draft`
  (write), `create_invoice_draft_from_order_confirmation` (write; makes an
  invoice draft that `create_invoice_from_draft` issues)
- `recurring_invoices`: `list_recurring_invoices` (jobs, schedule, status),
  `create_recurring_invoice_from_draft` (write; the draft is a
  `create_invoice_draft` of type `repeating_invoice` with `startDate` and
  `frequency`; invoices are then issued on the schedule),
  `set_recurring_invoice_job` (write; pause, resume or stop, and stop is
  final)
- `time_tracking`: `list_time_users`, `list_activities`, `create_activity` (write),
  `list_time_entries`, `create_time_entry` (write), `create_invoice_draft_from_time_entries`
  (write; NOK only, sends only what you give; a draft that
  `create_invoice_from_draft` issues)
- `payments`: `register_payment` (write; on a sale or a purchase, positive
  amounts only, NOK only), `list_payments` (on one sale or one purchase)
- `products`: `list_products`, `get_product`, `create_product` (write),
  `update_product` (write; only the given fields change)
- `inbox`: `list_inbox`, `get_inbox_document` (an inbox document that did
  not come through the upload widget: images as images, PDFs as text per
  page, read in memory; scanned PDFs are named, and the widget handles
  them)
- `attachments`: `get_attachments` (on a purchase, sale, invoice or journal
  entry), `attach_inbox_document` (write; an invoice gets a copy and the
  document stays in the inbox)
- `help`: `fiken_help_index` (titles and slugs from https://hjelp.fiken.no,
  filtered by title words, always returned as `{ articles, hint? }`) and `fiken_help_article` (one article as Markdown,
  followed by notes on how its steps map to this connector). Articles are
  fetched live from hjelp.fiken.no (its llms.txt index and the `.md` page of
  each article) and cached in memory for at most an hour; nothing is stored
  per user. The server also sends connect-time instructions telling the model
  to look unusual cases up there first
- `usage`: `my_usage` (your own pseudonymous monthly call counts on this
  server)

The `update_*` operations (contact, product, invoice draft) read the
current record, overlay the fields you give and write it back, since
Fiken's updates replace the whole record. Fiken has no ETag, so an edit
made in Fiken between the read and the write is overwritten.

Not covered on purpose: deletes, reversals and cancelling (pending a
decision). Not covered yet: activity writes, contact group management,
contact attachments, the product sales report and creating bank accounts.

Every write asks the model to restate the action and get your explicit
confirmation first, except the draft operations (`create_invoice_draft`,
`update_invoice_draft`, `create_purchase_draft`, `create_offer_draft`,
`create_order_confirmation_draft`,
`create_invoice_draft_from_order_confirmation`,
`create_invoice_draft_from_time_entries`), since a draft is reviewed in
Fiken. These, `create_contact` and `add_contact_person` are the writes the
host is told are not destructive (easy to undo in Fiken); the two contact
writes still ask for confirmation.

### Connector URL options

The connector URL can narrow what a connection offers the model. The
options are read from the path on every request, so nothing is stored.

| URL | What the connection offers |
| --- | --- |
| `https://api.fiken-mcp.byjoba.com/mcp` | Everything |
| `https://api.fiken-mcp.byjoba.com/mcp/readonly` | Reads only; no write operation, no `fiken_write`, no upload tools |
| `https://api.fiken-mcp.byjoba.com/mcp/invoices,sales` | Every read; writes only in those concepts |

Concept names: `companies`, `contacts`, `projects`, `accounts`, `ledger`,
`purchases`, `sales`, `invoices`, `invoice_drafts`, `credit_notes`,
`offers`, `order_confirmations`, `recurring_invoices`, `time_tracking`, `payments`, `products`, `inbox`, `ehf`, `attachments`, `help`, `usage`. A concept filter chooses which areas the
model may change; all reads stay available, since operations take their
slugs and ids from reads in other concepts. So `/mcp/invoices` can look
up contacts and bank accounts but not create a contact, and
`/mcp/invoices,readonly` offers the same as `/mcp/readonly`. An unknown
word gets a 400 naming the valid ones, after login; an unauthenticated
request to an invalid option path gets the plain `/mcp` login challenge.
The upload tools need `purchases` chosen (or no filter) and a connection
that is not read-only.

Some tasks write in two areas, so choose both:

| Task | Filter |
| --- | --- |
| Set up a recurring invoice (its draft is an invoice draft) | `recurring_invoices,invoice_drafts` |
| Invoice tracked hours and issue the invoice | `time_tracking,invoice_drafts` |
| Invoice an order confirmation and issue the invoice | `order_confirmations,invoice_drafts` |
| Attach an incoming EHF document (`ehf` has only reads) | `ehf,attachments` |

These options limit what a connection offers the model. They are not a
security boundary against whoever holds the token: the same login token
works on `/mcp`. To stop a token, revoke access in Fiken.

Receipts: `upload_receipts` opens a picker inside the chat (photos,
camera, PDFs). Each file goes to the company's Fiken inbox and its
content (images, or the text of each PDF page) goes straight into the
model's context, so nothing is read back from Fiken. Press "Ferdig" and
the model books. `get_upload_url` gives shell-capable clients such as
Claude Code a `curl` command instead.

Limits: 4 MB per file (larger photos are downscaled in the widget; larger
PDFs are skipped and named). Fiken takes PDF, PNG, JPEG and GIF; a HEIC
photo is converted to JPEG on your phone when the browser can decode it,
and named as skipped when it cannot. Amounts everywhere are integers in
øre.

Only the widget's own sandbox origins (`*.claudemcpcontent.com`) may call
the upload and document endpoints cross-origin, so ChatGPT's app sandbox
cannot upload or show documents yet; its read and write tools work as
usual. `GET /document` fetches only the file URL sealed in its ticket
(never one from the request), only from Fiken's hosts, answers only PDF,
PNG, JPEG and GIF (by magic bytes, at most 4 MB) with
`Cache-Control: no-store`, and refuses a missing, expired or upload
ticket with a bare 401.

- Design: [docs/superpowers/specs/2026-09-22-fiken-mcp-design.md](docs/superpowers/specs/2026-09-22-fiken-mcp-design.md)
- Decision record (what we ruled out and why): [docs/superpowers/specs/2026-09-22-fiken-mcp-decision-record.md](docs/superpowers/specs/2026-09-22-fiken-mcp-decision-record.md)
- The throwaway spike that verified the widget flow lives in git history
  (`git show c8dd493:spike/README.md`).

## Privacy

We hold Fiken app credentials and a signing key. We never store your
Fiken tokens, your files or your accounting data; files pass through our
server's memory on the way to Fiken (and from Fiken to the document
viewer) and are not written or logged. We
keep anonymous usage counters keyed by a salted hash of your email that
we cannot reverse: pseudonymous monthly call counts per tool, and
whether each call succeeded, against that pseudonym. Ask for your own
counters with the `my_usage` operation (through `fiken_read`), or see the same counts aggregated across
every user, with no per-user detail, at
`https://api.fiken-mcp.byjoba.com/stats`. Revoke access at any time in
Fiken under Rediger konto, Sikkerhet, "Apper du har gitt tilgang til".

## Adding the connector

Each Fiken company you want to use needs Fiken's API add-on. An owner
orders it in Fiken under Foretak → Tilleggstjenester → API (99 kr a
month; always on for test companies). `list_companies` shows
`hasApiAccess` per company. Projects and time tracking are separate
add-ons on the same page; without them Fiken answers 402 and the tool
error says where to order them.

If Fiken rejects a login during a tool call (for example because you
revoked access), the server answers with an HTTP 401 so the client asks
you to log in again automatically. The server first asks Fiken whether
the login itself is dead, and only then answers HTTP 401. When the login
still works and Fiken refused only that one endpoint, the call returns
an ordinary tool error saying so. When that check itself fails (or a
401 comes after something was already written), the call returns a
tool error suggesting a retry, never an HTTP 401. Legacy JSON-RPC batch
request bodies are refused with a 400 instead of being processed.

Claude (web, Desktop, iOS): Customize, Connectors, Add, Add custom
connector. Any name, MCP server URL `https://api.fiken-mcp.byjoba.com/mcp`.
Log in with Fiken when asked. A client that logs in with its published
identity works too: we accept a client id metadata document from Claude
(Anthropic hosts) and ChatGPT (OpenAI hosts) in place of dynamic
registration, and check the redirect URI against the same allowlist
either way.

Claude Code:

```
claude mcp add --transport http fiken https://api.fiken-mcp.byjoba.com/mcp
```

To add a narrower connection, use one of the option URLs above instead
(for example `/mcp/readonly`). Claude caches a connector's tool list.
After an update, open the connector under Customize, Connectors and
choose "Refresh tools list" in its menu. In Claude Code, remove and
re-add it (`claude mcp remove fiken`, then the add command above).

ChatGPT: Settings, Apps, Advanced settings, Developer mode, add the same
URL. Needs Plus or higher.

## Website

`https://fiken-mcp.byjoba.com` is a static Norwegian page in `web/`
(`index.html`, `404.html`, `style.css`, `site.js`; no build step). The
icon is the API's own `api/src/assets/icon.png`, copied to the bucket as
`/icon.png`. The `fiken-mcp-web` stack in `iac/lib/web-stack.ts` holds
only the infrastructure: a private S3 bucket behind CloudFront (Origin
Access Control), `/stats` forwarded to the API so the page reads the
counters from its own domain, and strict security headers (all CSS and JS
in files, never inline). No access logs. The content never goes through
CloudFormation: the deploy workflow runs `aws s3 sync web/ --delete`, copies
the icon and invalidates CloudFront. The A/AAAA alias records on the apex
live in the iac stack (`iac/lib/iac-stack.ts`), which imports the
distribution's id and domain name from the web stack's exports. The
early-access email address exists only as char codes in `site.js` and is
assembled on click; a test fails if it appears in plain text.

The deploy workflow deploys only what changed since the last successful
deploy (`iac/lib/deploy-targets.ts`) and has four flags: `iac`, `web`,
`content` and `api`. `web/**` sets only `content` (sync and invalidation,
no stack), `iac/lib/web-stack.ts` only `web`, `api/**` only `api`, and
docs and tests nothing at all.

## Development

```
npm install
npm test
npm run typecheck
```

`api/` is the Lambda and its CDK stack; `iac/` is the shared
infrastructure stack. The widgets (`api/src/assets/<name>.html`,
generated and gitignored) are built by `api/scripts/build-widget.mjs`,
which inlines the MCP Apps bundle (and pdf.js for the upload and document
widgets, the render logic in `api/src/widget/<name>.mjs` for the choice,
preview, form, table and document widgets) into
`api/src/widget/<name>.template.html`. `npm test` runs it first, and the
CDK bundling step runs it again before every synth or deploy, so the
Lambda bundle always carries a fresh widget. Deployments run from GitHub
Actions only; see `docs/setup.md` for the one-time setup.

---

<p align="center">MIT licence · byJoBa (Jonas Barsten)</p>
