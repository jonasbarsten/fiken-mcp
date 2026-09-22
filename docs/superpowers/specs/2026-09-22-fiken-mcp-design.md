# Fiken MCP: design

Date: 2026-09-22
Status: approved in discussion, awaiting written review
Companion: [Decision record: auth, data flow, attachments](2026-09-22-fiken-mcp-decision-record.md)

## 1. What we are building

A remote MCP server that lets any Fiken customer talk to their own
accounting from Claude (web, Desktop, iOS, Claude Code) and ChatGPT, on
their own AI subscription, after logging into Fiken themselves. Full
read and write access, including sending invoices. The headline flow,
on a phone:

> "Her er masse kvitteringer, bokfør dem på prosjektet Atlanter."

The user picks the receipts in a native picker rendered inside the chat.
The files land in Fiken, the model reads them, books the purchases with
the right supplier, amounts, VAT and project, and each purchase is
documented with the original file. Nothing is stored on our side.

## 2. Non-negotiables

- **We store no user data.** No tokens, no files, no accounting data.
  Files pass through our Lambda's memory and are gone when the request
  ends. The only per-user records are anonymous usage counters.
- **Users authenticate with Fiken themselves** through Fiken's OAuth2
  authorization code flow, with Fiken's own login and 2FA.
- **Users pay for the model with their own Claude or ChatGPT plan.** We
  never call a model API.
- **Everything happens inside the chat client.** No separate website,
  no login on any page of ours.
- **Fiken's concurrency rule is respected**: one request at a time.

## 3. Verified facts the design rests on

Fiken API (from the OpenAPI spec, verified 2026-09-22):

- Base URL `https://api.fiken.no/api/v2`, bearer auth.
- OAuth2 authorization code flow only for third parties. Token endpoint
  uses HTTP Basic with client id and secret; no PKCE, no public clients.
  Access tokens last about 24 h with a refresh token. Personal API tokens
  in third-party apps violate Fiken's terms.
- Our app "Fiken MCP" exists in Jonas's Fiken account (dev status, max 5
  users listed under "Godkjente brukere"). Production status is requested
  by email to api@fiken.no after onboarding 2 to 3 real users. Client id
  and secret are in Parameter Store on the byjoba account as
  `/fiken_mcp/client_id` and `/fiken_mcp/client_secret`.
- One concurrent request allowed; more may 429 and may get the app
  banned. Slowdown above 4 req/s. The docs do not say whether the limit
  is per user or per app; treat as per app until Fiken says otherwise.
- `GET /user` returns the user's name and email.
- `GET /companies` lists companies the user can access.
- Inbox: `POST /companies/{slug}/inbox` (multipart: name, filename,
  description, file). `GET /companies/{slug}/inbox` lists documents with
  status used/unused. Inbox documents have a `documentUrl` readable with
  the bearer token.
- Purchases: `POST /companies/{slug}/purchases` with `projectId` and
  lines. `POST /companies/{slug}/purchases/{id}/attachments?inboxDocumentId=…&attachToSale=true`
  attaches an existing inbox document and marks it used. Attachment
  filenames must end in png, jpeg, jpg, gif or pdf. HEIC is not accepted.
- **No CORS.** `api.fiken.no` sends no `Access-Control-Allow-Origin`, and
  a preflight returns 500. Browsers cannot call Fiken directly.

Claude clients (verified by the spike in `spike/`, Claude Desktop
2.2553.1 and Claude iOS 1.260911.19):

- Custom connectors are remote MCP servers over Streamable HTTP with
  OAuth 2.1 and dynamic client registration. They can be added on web,
  Desktop and iOS (iOS in beta).
- MCP App widgets from a custom connector render inline on Desktop and
  iOS. `<input type=file>` opens the native picker on iOS.
- A widget can `fetch` our domain when the resource declares
  `_meta.ui.csp.connectDomains`. Requests carry
  `Origin: <hash>.claudemcpcontent.com`.
- The host accepts `text` and `image` blocks in `ui/update-model-context`
  and the model reads them without any tool call. `resource` blocks are
  dropped. Each update replaces the previous one.
- `ui/message` pre-fills the user's composer; the user taps send.
- The tool list is cached per connector and refreshed on re-add. The
  widget resource is re-read by URI before each tool call. A stable
  resource URI is required.
- Tool results: text and image content are supported; embedded binary
  resources are dropped by the hosted client (open bug).
- Claude.ai's code-execution sandbox can reach only package registries
  on Free, Pro and Max. Programmatic tool calling cannot call MCP tools.

## 4. Architecture

One CDK stack on the byjoba AWS account, region eu-west-1, repo
`jonasbarsten/fiken-mcp` (public), deployed by GitHub Actions with OIDC.

```
Claude / ChatGPT client ──HTTPS──▶ API Gateway HTTP API
                                    fiken-mcp.byjoba.com (Route 53 zone byjoba.com)
                                        │
                                        ▼
                                  Lambda (Node 24, arm64, reserved concurrency 1)
                                    /.well-known/*   OAuth discovery
                                    /register        dynamic client registration
                                    /authorize       → redirects to fiken.no/oauth/authorize
                                    /callback        ← Fiken redirect
                                    /token           code exchange + refresh (proxied to Fiken)
                                    /mcp             MCP Streamable HTTP, stateless
                                    /upload          widget file uploads (in-memory pass-through)
                                    /stats           public usage counters for the website
                                        │                    │
                                        ▼                    ▼
                                  api.fiken.no         DynamoDB (usage counters only)
```

### Repository layout

```
iac/      CDK app, stack fiken-mcp-iac: the DynamoDB usage table. Exports
          table name and ARN. Deployed rarely.
api/      Lambda source (TypeScript) and CDK app, stack fiken-mcp-api:
          function, HTTP API, custom domain, Parameter Store reads. Imports
          the table from the iac exports. Deployed on every merge to main.
docs/     specs and decision record.
spike/    throwaway widget spike; deleted once api/ has its own widget.
```

No deployment stages for now: one account, one environment, one domain.

### CI/CD and who can deploy

GitHub Actions with OIDC federation into the byjoba account. No AWS keys
in GitHub. The repo is public and will have outside contributors, so
deployment rights are enforced by claims, not by trust:

- The IAM deploy role's trust policy accepts a GitHub token only when
  `aud` is `sts.amazonaws.com` and `sub` is exactly
  `repo:jonasbarsten/fiken-mcp:environment:production`. Forks carry
  their own repo name and pull requests carry a `pull_request` subject,
  so neither can ever assume the role.
- The `production` GitHub Environment requires Jonas as reviewer and is
  restricted to the `main` branch. Every deploy job waits for that
  approval. Write access lets someone merge; it does not let them deploy.
- The deploy role may only assume the CDK bootstrap roles.
- Repo settings: branch protection on `main` (PR required, review from
  Jonas required, no direct pushes), Actions `GITHUB_TOKEN` read-only by
  default, workflow runs from outside collaborators require approval.
- PR workflow: typecheck and tests only, no AWS access.
- Deploy workflow on push to `main`: `cdk deploy` of `iac` then `api`,
  in the `production` environment.

Secrets and config: Parameter Store SecureStrings `/fiken_mcp/client_id`,
`/fiken_mcp/client_secret`, `/fiken_mcp/signing_key` (HMAC and
encryption key for our blobs), `/fiken_mcp/user_salt` (for anonymous
ids). Read once per cold start, cached in module scope. Never in the
repo, never in the CloudFormation template.

Language: TypeScript. MCP TypeScript SDK v2 (`@modelcontextprotocol/server`,
`@modelcontextprotocol/node`) and `@modelcontextprotocol/ext-apps` for the
widget. Types for Fiken generated from the swagger with
openapi-typescript. All Fiken calls go through one `fikenFetch` wrapper.

## 5. Authentication: stateless OAuth

We are an OAuth 2.1 authorization server toward the MCP client and an
OAuth2 client toward Fiken. Nothing is stored; everything a server would
normally remember travels in signed or encrypted blobs. Blobs are
base64url(JSON) plus an HMAC-SHA256 tag with the signing key; blobs that
carry Fiken tokens are AES-GCM encrypted with the same key material.

1. **Discovery.** `/.well-known/oauth-protected-resource` and
   `/.well-known/oauth-authorization-server` are static JSON. PKCE S256
   required, `token_endpoint_auth_methods_supported: ["none"]`.
2. **Registration.** `POST /register` returns a `client_id` that is a
   signed blob of the registered `redirect_uris`. No storage.
3. **Authorize.** Client sends its PKCE challenge, redirect URI and
   state. We verify the client id and redirect URI, pack
   `{redirect_uri, code_challenge, client_state, exp: +1h}` into a signed
   state, and redirect the browser to Fiken's authorize endpoint with our
   client id and `https://fiken-mcp.byjoba.com/callback`. Fiken handles
   login, 2FA and consent. One hour so slow logins do not fail.
4. **Callback.** We verify our state, wrap
   `{fiken_code, fiken_state, code_challenge, redirect_uri, exp: +5min}`
   into a signed code blob, and redirect to the client's redirect URI
   with that blob as `code` and the client's original state.
5. **Token.** Client posts the code blob and its PKCE verifier. We check
   the verifier against the challenge in the blob, exchange the Fiken
   code with our client secret, call `GET /user` once, compute the
   anonymous id `HMAC(salt, email)`, and return access and refresh
   tokens that are **encrypted wrappers** of Fiken's tokens plus the
   anonymous id. Refresh grants unwrap, forward to Fiken, and rewrap
   with the same id. If the user revoked the app in Fiken, refresh fails
   and the client restarts at step 3.
6. **Every MCP request** carries our wrapped access token. We decrypt it,
   forward the Fiken access token upstream, and use the anonymous id
   for usage counting. A 401 from Fiken becomes a 401 to the client,
   which triggers refresh.

Security properties: blobs expire in minutes (an hour for the login
state, which carries no code), are bound to redirect URI and PKCE
challenge, and are useless if tampered with. A wrapped token leaked from
a client cannot be used against Fiken without our key. We hold the
client secret, the signing key and the salt, and nothing per user.

Company selection: `list_companies` returns the user's companies; every
company-scoped tool takes `companySlug`. No stored default.

## 6. Usage tracking

One on-demand DynamoDB table, defined in this repo's `iac/` stack and
deployed from here, byjoba account. Pseudonymous, no tokens, no
accounting data.

| PK | SK | Attributes |
|---|---|---|
| `USER#<anon id>` | `MONTH#YYYY-MM` | calls, errors, one counter per tool |
| `USER#<anon id>` | `PROFILE` | firstSeen |
| `GLOBAL` | `MONTH#YYYY-MM` | calls, errors, per-tool counters, activeUsers |
| `GLOBAL` | `ALL` | totalUsers |

Two atomic `ADD` updates per tool call, in parallel with the Fiken call.
`activeUsers` increments when the user-month update reports no previous
value. `totalUsers` increments when the `PROFILE` conditional put
succeeds at first login. Totals are sums over month rows. No streams.

Surfaces: a `my_usage` tool for the user, and `GET /stats` returning the
global rows with a cache header for the website. CloudWatch keeps
structured request logs for 30 days for debugging only; never file
content.

## 7. Fiken concurrency

Lambda reserved concurrency 1 plus an in-process promise queue with a
300 ms gap in `fikenFetch`; retry once on 429. A second user's call
during another's in-flight call is throttled by Lambda and surfaces to
the client as a tool error the model can retry. Acceptable under the
5-user dev cap. When applying for production status, ask Fiken whether
the limit is per user; if so, raise concurrency and queue per token.

## 8. Tools

Conventions: `companySlug` required on company-scoped tools; list tools
take `page` and `pageSize` and return the page plus Fiken's total count;
amounts stay as Fiken returns them (integers in øre, stated in every
description); MCP annotations (`readOnlyHint`, `destructiveHint`) on
every tool; failures return `isError: true` with Fiken's own message and,
where useful, recovery hints such as the user's company slugs.

Read:
`list_companies`, `search_contacts`, `get_contact`, `list_invoices`,
`get_invoice`, `list_sales`, `list_purchases`, `get_purchase`,
`list_products`, `list_accounts`, `account_balances`, `bank_balances`,
`get_journal_entries`, `list_projects`, `list_inbox`,
`get_inbox_document` (for documents that reached the inbox outside the
widget, e.g. via the Fiken app: images returned as image content, PDFs
as text extracted in memory, page images for pages without text),
`get_attachments`, `my_usage`.

Write:
`create_contact`, `create_invoice_draft`, `create_invoice_from_draft`,
`create_invoice`, `send_invoice` (destructive), `create_credit_note`,
`create_purchase` (takes optional `inboxDocumentId`), `register_payment`,
`attach_inbox_document` (to a purchase, sale, invoice or journal entry),
`upload_receipts` (renders the widget; see section 9),
`get_upload_url` (secondary path for shell clients; see section 9).

Left out of version one, addable on the same pattern: offers, order
confirmations, recurring invoices, time tracking, deletes, EHF.

## 9. Attachments and the receipts flow

### The widget

`upload_receipts` is an MCP App tool. Its resource is one stable URI,
`ui://fiken-mcp/upload.html`, served with
`_meta.ui.csp.connectDomains: ["https://fiken-mcp.byjoba.com"]`. The
HTML inlines the ext-apps browser bundle and pdf.js (main and worker),
each in its own `<script type="module">`, with each bundle's trailing
`export{}` rewritten to a global. pdf.js runs on the main thread. The
widget is about 2 MB and renders fine.

The tool result carries, in `structuredContent`, an **upload ticket**:
an encrypted blob of `{wrapped user token, companySlug, anon id, exp: +15min}`,
plus the upload URL. The widget never sees a raw Fiken token.

The widget shows a file picker (photos, camera, files) and a "Ferdig"
button. For each picked file it does two things:

1. **Upload.** `POST /upload` with the ticket, filename and bytes. The
   Lambda validates the ticket, forwards the file as multipart to
   `POST /companies/{slug}/inbox`, and returns the inbox document id.
   Bytes are never written anywhere. Limit about 4.5 MB per file (API
   Gateway); the widget downscales images above that before upload.
2. **Context.** It builds content blocks for the model and calls
   `updateModelContext` with the **full accumulated set** every time,
   because each update replaces the previous one:
   - Images: a text block naming the file and inbox id, then the image
     downscaled to 1024 px on the long side as JPEG.
   - PDFs: per page, the text layer extracted with pdf.js and rebuilt
     into lines (a text block per page, `file, page n of m (text)`), or,
     for pages without a text layer, a 1024 px JPEG. Text pages cost
     roughly a quarter of an image page. Defaults: all text pages; image
     pages capped at 5 per file with a "render all pages" control in the
     widget, since every block is re-sent on every turn of the chat.
   - A summary block listing every uploaded file with its inbox id.

"Ferdig" calls `sendMessage` with a short user message; Claude asks
the user to confirm sending it. The model then books.

Capability-driven: the widget reads `getHostCapabilities().updateModelContext`.
On a host that declares `resource`, it would send PDF bytes instead of
text and images. Claude declares only text and image today.

Widget updates: because the resource URI is stable and Claude re-reads
it per tool call, a deploy is enough. Never change the URI per build.

### The model's side

The `upload_receipts` description tells the model that the widget
delivers file contents into its context directly and that it should
book from what it sees, calling `list_inbox` only if the user says
"ferdig" and nothing arrived. The model resolves project, supplier and
accounts with the read tools, calls `create_purchase` with
`inboxDocumentId` per receipt, and Fiken attaches the original and
clears it from the inbox.

### Secondary path for clients without widgets

Claude Code and shell-capable clients: `get_upload_url` returns a signed
15-minute URL bound to a target (purchase, sale, invoice, journal entry,
or inbox) and a curl command. The agent reads files locally and uploads
them itself. The Lambda forwards to Fiken as above.

### What is not supported

- Attaching files from a Claude.ai chat without the widget or a shell:
  no mechanism exists. See the decision record.
- HEIC: Fiken rejects it; not converted in version one.
- Files over about 4.5 MB that are not images.

## 10. Website

Static site (separate, later) showing what the connector does, how to
add it, the privacy statement, and live counters from `GET /stats`.

## 11. Privacy statement (for README and site)

We hold Fiken app credentials and a signing key. We never store your
Fiken tokens, your files or your accounting data; files pass through our
server's memory on the way to Fiken and are not written or logged. We
keep anonymous usage counters keyed by a salted hash of your email that
we cannot reverse. Revoke access at any time in Fiken under Rediger
konto, API.

## 12. Error handling

- Fiken 401: return 401 with `WWW-Authenticate` so the client refreshes.
- Fiken 429: retry once after 1 s, then surface as tool error.
- Fiken 4xx validation: pass Fiken's message through as `isError`.
- Unknown company slug: error text lists the user's slugs.
- Upload ticket invalid or expired: 401 to the widget; the widget shows
  it and the model can call `upload_receipts` again.
- Lambda throttled (concurrency): API Gateway 429; the model retries.

## 13. Testing

- Unit: blob signing and encryption, PKCE verification, token wrapping,
  the request queue, tool handlers against recorded Fiken responses,
  usage counter updates against DynamoDB Local.
- Integration: a Fiken test company under the dev app.
- Widget: manual protocol from `spike/README.md` on Claude Desktop and
  iOS after each widget change; ChatGPT once, to record what works.
- CI: PR runs typecheck and tests; merge to main deploys with `cdk deploy`.

## 14. Open items

- Confirm with Fiken whether the concurrency limit is per user.
- ChatGPT: verify the widget, `connectDomains` and model-context support.
- Custom domain and certificate for `fiken-mcp.byjoba.com`.
- Delete `spike/` once implementation has its own widget.
