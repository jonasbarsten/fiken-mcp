# fiken-mcp

A remote MCP server that lets Fiken customers work with their own
accounting from Claude and ChatGPT, on their own AI subscription, after
logging into Fiken themselves. Read and write, including sending
invoices, and booking receipts picked straight from a phone.

Status: live at `https://api.fiken-mcp.byjoba.com` for a handful of
test users. The receipts flow works end to end: pick receipts in the
chat, they land in the Fiken inbox, the model reads them and books each
one as a purchase with the original attached. Invoices, sales, credit
notes and payments are next.

## What it can do

Read: `list_companies`, `list_projects`, `list_accounts`,
`list_bank_accounts`, `search_contacts`, `get_contact`, `list_purchases`,
`get_purchase`, `list_inbox`.

Write (each asks the model to restate the action and get your explicit
confirmation first): `create_contact`, `create_purchase` (optionally
attaching an inbox document), `attach_inbox_document`.

Receipts: `upload_receipts` opens a picker inside the chat (photos,
camera, PDFs). Each file goes to the company's Fiken inbox and its
content (images, or the text of each PDF page) goes straight into the
model's context, so nothing is read back from Fiken. Press "Ferdig" and
the model books. `get_upload_url` gives shell-capable clients such as
Claude Code a `curl` command instead.

Limits: 4.5 MB per file (larger photos are downscaled in the widget;
larger PDFs are skipped and named), and no HEIC (Fiken does not accept
it; export as JPEG first). Amounts everywhere are integers in øre.

- Design: [docs/superpowers/specs/2026-09-22-fiken-mcp-design.md](docs/superpowers/specs/2026-09-22-fiken-mcp-design.md)
- Decision record (what we ruled out and why): [docs/superpowers/specs/2026-09-22-fiken-mcp-decision-record.md](docs/superpowers/specs/2026-09-22-fiken-mcp-decision-record.md)
- The throwaway spike that verified the widget flow lives in git history
  (`git show c8dd493:spike/README.md`).

## Privacy

We hold Fiken app credentials and a signing key. We never store your
Fiken tokens, your files or your accounting data; files pass through our
server's memory on the way to Fiken and are not written or logged. We
keep anonymous usage counters keyed by a salted hash of your email that
we cannot reverse. Revoke access at any time in Fiken under Rediger
konto, API.

## Adding the connector

Claude (web, Desktop, iOS): Settings, Connectors, Add custom connector,
URL `https://api.fiken-mcp.byjoba.com/mcp`, sign-in required. Log in with
Fiken when asked.

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
infrastructure stack. `npm test` first builds the upload widget
(`api/src/assets/upload.html`, generated and gitignored) by inlining the
MCP Apps and pdf.js bundles into `api/src/widget/upload.template.html`.
Deployments run from GitHub Actions only; see `docs/setup.md` for the
one-time setup.
