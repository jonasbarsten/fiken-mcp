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

Read: `list_companies`, `list_projects`, `list_accounts`,
`list_bank_accounts`, `search_contacts`, `get_contact`, `list_purchases`,
`get_purchase`, `list_inbox`, `list_sales`, `list_products`,
`list_invoices`, `get_invoice`, `get_attachments` (on a purchase, sale,
invoice or journal entry),
`account_balances`, `bank_balances`, `get_journal_entries`, `my_usage` (your own pseudonymous monthly
call counts on this server).

Write (each asks the model to restate the action and get your explicit
confirmation first): `create_contact`, `create_purchase` (optionally
attaching an inbox document), `attach_inbox_document` (to a purchase,
sale, invoice or journal entry; an invoice gets a copy and the document
stays in the inbox), `create_invoice`
(issued and booked, not sent), `create_invoice_draft`,
`create_invoice_from_draft`, `send_invoice` (the customer receives it at
once), `create_credit_note` (full or partial, booked but not sent),
`register_payment` (on a sale or a purchase).

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
whether each call succeeded, against that pseudonym. Ask the `my_usage`
tool for your own counters, or see the same counts aggregated across
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
