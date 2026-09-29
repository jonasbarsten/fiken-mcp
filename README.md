# fiken-mcp

A remote MCP server that lets Fiken customers work with their own
accounting from Claude and ChatGPT, on their own AI subscription, after
logging into Fiken themselves. Read and write, including sending
invoices, and booking receipts picked straight from a phone.

Status: live at `https://api.fiken-mcp.byjoba.com` for a handful of
test users. The receipts flow works end to end: pick receipts in the
chat, they land in the Fiken inbox, the model reads them and books each
one as a purchase with the original attached. Invoices, credit notes and
payments are covered too.

## What it can do

The server offers a short, fixed tool list instead of one tool per Fiken
action:

- The hot-path tools, real tools the receipts flow needs without an extra
  round trip: `list_companies`, `list_projects`, `list_accounts`,
  `list_bank_accounts`, `search_contacts`, `list_inbox`, `create_purchase`.
- The upload tools: `upload_receipts` and `get_upload_url` (see below).
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
  contact is sent back as it was), `list_contact_persons`,
  `add_contact_person` (write)
- `projects`: `list_projects`, `get_project`, `create_project` (write),
  `update_project` (write; only the given fields change)
- `accounts`: `list_accounts`, `list_bank_accounts` (with the account
  number an invoice draft needs), `account_balances` (date and an account
  range such as 3000-3999), `bank_balances`
- `ledger`: `get_journal_entries`, `get_journal_entry`,
  `create_journal_entry` (write; a manual fri postering, refused unless
  debits and credits balance), `list_transactions`, `get_transaction`
- `purchases`: `list_purchases`, `get_purchase`, `create_purchase` (write;
  optionally attaching an inbox document), `create_purchase_draft` (write;
  a draft for the user to approve in Fiken, NOK only), `list_purchase_drafts`,
  `create_purchase_from_draft` (write; books it)
- `sales`: `list_sales`, `get_sale` (with lines and payment count),
  `create_sale` (write; income not invoiced through Fiken: a cash sale or an
  invoice issued elsewhere), `settle_sale` (write; settle without a
  payment), `write_off_sale` (write; books a loss)
- `invoices`: `list_invoices`, `get_invoice`, `create_invoice` (write;
  final in Fiken once created, issued and booked, not sent),
  `send_invoice` (write; final: the customer receives it at once),
  `get_counters` (the invoice and credit note number series: current and
  next number), `initialize_counter` (write; takes the first number to
  use, starts a series that was never started, never changes an existing
  one)
- `invoice_drafts`: `create_invoice_draft` (write; needs
  `bankAccountNumber` from `list_bank_accounts`, since Fiken refuses to
  issue a draft without one), `list_invoice_drafts`, `get_invoice_draft`,
  `update_invoice_draft` (write; only the given fields change, the rest of
  the draft is sent back as it was; a draft with several customers is
  refused), `create_invoice_from_draft` (write; issues it)
- `credit_notes`: `list_credit_notes`, `get_credit_note`,
  `create_credit_note` (write; full or partial, booked but not sent),
  `send_credit_note` (write; final: the customer receives it at once)
- `offers`: `list_offers`, `create_offer_draft` (write; the bank account is
  optional), `create_offer_from_draft` (write), `send_offer` (write; final:
  the customer receives it at once)
- `order_confirmations`: `list_order_confirmations`,
  `create_order_confirmation_draft` (write), `create_order_confirmation_from_draft`
  (write), `create_invoice_draft_from_order_confirmation` (write; makes an
  invoice draft that `create_invoice_from_draft` issues)
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
- `usage`: `my_usage` (your own pseudonymous monthly call counts on this
  server)

Every write asks the model to restate the action and get your explicit
confirmation first, except the draft operations (`create_invoice_draft`,
`update_invoice_draft`, `create_offer_draft`, `create_order_confirmation_draft`,
`create_invoice_draft_from_order_confirmation`), since a draft is reviewed in Fiken.

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
`payments`, `products`, `inbox`, `attachments`, `usage`. A concept filter chooses which areas the
model may change; all reads stay available, since operations take their
slugs and ids from reads in other concepts. So `/mcp/invoices` can look
up contacts and bank accounts but not create a contact, and
`/mcp/invoices,readonly` offers the same as `/mcp/readonly`. An unknown
word gets a 400 naming the valid ones, after login; an unauthenticated
request to an invalid option path gets the plain `/mcp` login challenge.
The upload tools need `purchases` chosen (or no filter) and a connection
that is not read-only.

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

Only the widget's own sandbox origins (`*.claudemcpcontent.com`) may post
to the upload endpoint, so ChatGPT's app sandbox cannot upload yet; its
read and write tools work as usual.

- Design: [docs/superpowers/specs/2026-09-22-fiken-mcp-design.md](docs/superpowers/specs/2026-09-22-fiken-mcp-design.md)
- Decision record (what we ruled out and why): [docs/superpowers/specs/2026-09-22-fiken-mcp-decision-record.md](docs/superpowers/specs/2026-09-22-fiken-mcp-decision-record.md)
- The throwaway spike that verified the widget flow lives in git history
  (`git show c8dd493:spike/README.md`).

## Privacy

We hold Fiken app credentials and a signing key. We never store your
Fiken tokens, your files or your accounting data; files pass through our
server's memory on the way to Fiken and are not written or logged. We
keep anonymous usage counters keyed by a salted hash of your email that
we cannot reverse: pseudonymous monthly call counts per tool, and
whether each call succeeded, against that pseudonym. Ask for your own
counters with the `my_usage` operation (through `fiken_read`), or see the same counts aggregated across
every user, with no per-user detail, at
`https://api.fiken-mcp.byjoba.com/stats`. Revoke access at any time in
Fiken under Rediger konto, API.

## Adding the connector

If Fiken rejects a login during a tool call (for example because you
revoked access), the server answers with an HTTP 401 so the client asks
you to log in again automatically; legacy JSON-RPC batch request bodies
are refused with a 400 instead of being processed.

Claude (web, Desktop, iOS): Settings, Connectors, Add custom connector,
URL `https://api.fiken-mcp.byjoba.com/mcp`, sign-in required. Log in with
Fiken when asked. Claude's "Use Claude's published identity" option works
too: we accept a client id metadata document from Claude (Anthropic
hosts) and ChatGPT (OpenAI hosts) in place of dynamic registration, and
check the redirect URI against the same allowlist either way.

Claude Code:

```
claude mcp add --transport http fiken https://api.fiken-mcp.byjoba.com/mcp
```

To add a narrower connection, use one of the option URLs above instead
(for example `/mcp/readonly`). Claude caches a connector's tool list, so
after an update remove and re-add the connector to see the new one.

ChatGPT: Settings, Apps, Advanced settings, Developer mode, add the same
URL. Needs Plus or higher.

## Development

```
npm install
npm test
npm run typecheck
```

`api/` is the Lambda and its CDK stack; `iac/` is the shared
infrastructure stack. The upload widget (`api/src/assets/upload.html`,
generated and gitignored) is built by `api/scripts/build-widget.mjs`,
which inlines the MCP Apps and pdf.js bundles into
`api/src/widget/upload.template.html`. `npm test` runs it first, and the
CDK bundling step runs it again before every synth or deploy, so the
Lambda bundle always carries a fresh widget. Deployments run from GitHub
Actions only; see `docs/setup.md` for the one-time setup.
