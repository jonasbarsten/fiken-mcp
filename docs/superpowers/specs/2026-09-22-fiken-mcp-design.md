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

Claude clients (verified by the spike, kept in git history at commit
`c8dd493` under `spike/`, on Claude Desktop 2.2553.1 and Claude iOS
1.260911.19):

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
                                    api.fiken-mcp.byjoba.com (Route 53 zone byjoba.com)
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
iac/      CDK app, stack fiken-mcp-iac: everything static. The DynamoDB
          usage table, the GitHub OIDC provider and deploy role, the scoped
          execution policy, the ACM certificate, the API Gateway custom
          domain and its DNS record. Exports the table and the domain.
          Deployed rarely, by hand when it changes the deploy role.
api/      Lambda source (TypeScript) and CDK app, stack fiken-mcp-api:
          function, HTTP API mapped onto the exported domain, Parameter
          Store reads. Only dynamic parts. Deployed on every merge to main.
docs/     specs and decision record.
```

The throwaway widget spike was deleted before the first deploy; it is in
git history at commit `c8dd493` under `spike/`.

No deployment stages for now: one account, one environment, one domain.

### CI/CD and who can deploy

GitHub Actions with OIDC federation into the byjoba account. No AWS keys
in GitHub. The repo is public and will have outside contributors, so
deployment rights are enforced by claims, not by trust:

- The IAM deploy role's trust policy accepts a GitHub token only when
  `aud` is `sts.amazonaws.com` and `sub` is exactly
  `repo:jonasbarsten@6729295/fiken-mcp@1381698499:environment:production`.
  That is GitHub's immutable subject form (owner and repo with their
  numeric ids; the repo has `use_immutable_subject` on), so a rename or
  a re-created repo with the same name cannot assume the role. Forks
  carry their own ids and pull requests carry a `pull_request` subject,
  so neither can ever assume the role.
- The `production` GitHub Environment requires Jonas as reviewer and is
  restricted to the `main` branch. Every deploy job waits for that
  approval. Write access lets someone merge; it does not let them deploy.
- **Blast radius inside byjoba is contained.** fiken-mcp has its own CDK
  bootstrap qualifier `fikenmcp`, so its stacks use their own bootstrap
  roles and asset bucket, not the ones jotufa and vigil use. The
  CloudFormation execution role for that qualifier carries a scoped
  policy (`fiken-mcp-cfn-exec`, defined in `iac/`) instead of
  AdministratorAccess: it can only touch resources named `fiken-mcp-*`,
  the `byjoba.com` hosted zone's records, API Gateway, ACM, and the
  `/fiken_mcp/*` parameters. The same policy is the permissions boundary
  on every role the stacks create, and the execution policy only allows
  creating or changing roles that carry that boundary, so no stack change
  can mint a role more powerful than the policy. The deploy role may only
  assume the `cdk-fikenmcp-*` bootstrap roles.
- A dedicated AWS account for fiken-mcp remains the preferred end state
  and is a change of account id and bootstrap once it exists.
- Repo settings: branch protection on `main` (PR required, review from
  Jonas required, no direct pushes), `CODEOWNERS` making Jonas a
  required reviewer for `.github/`, `iac/` and `api/lib/`, Actions
  `GITHUB_TOKEN` read-only by default, workflow runs from outside
  collaborators require approval, secret scanning with push protection,
  Dependabot for npm and GitHub Actions, 2FA required.
- Workflow actions are pinned to commit SHAs, not tags.
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
normally remember travels in signed or encrypted blobs.

**Keys.** `/fiken_mcp/signing_key` holds a key ring: `kid:hex[,kid:hex]`,
first entry active. From each 32-byte master key we derive with HKDF a
signing key (info `sign`) and an encryption key (info `enc`). Every blob
carries its `kid`, so rotation is: add a new key first in the ring,
deploy, wait for old blobs to expire, remove the old key. Signed blobs
are `v1.<kid>.<base64url json>.<hmac-sha256>`; encrypted blobs are
`v1e.<kid>.<iv>.<aes-256-gcm ciphertext+tag>`. Every payload carries a
`k` discriminator (`c` client, `s` login state, `d` code, `a` access,
`r` refresh) so a blob of one kind can never be read as another.

**Allowed clients.** Dynamic registration only accepts redirect URIs
that match a known MCP client: `https://claude.ai/api/mcp/auth_callback`,
`https://chatgpt.com/connector_platform_oauth_redirect`,
`https://chatgpt.com/connector/oauth/<id>`, and loopback
`http://localhost` or `http://127.0.0.1` on any port for Claude Code.
Anything else is rejected with `invalid_redirect_uri`. Adding a client
is a code change in `api/src/auth/clients.ts` with a PR.

1. **Discovery.** `/.well-known/oauth-protected-resource` and
   `/.well-known/oauth-authorization-server` are static JSON. PKCE S256
   required, `token_endpoint_auth_methods_supported: ["none"]`.
2. **Registration.** `POST /register` validates the redirect URIs
   against the allowlist and returns a `client_id` that is a signed blob
   of `{redirect_uris, client_name}`. No storage.
3. **Consent.** `GET /authorize` validates the client id, redirect URI,
   PKCE challenge and state, then renders a minimal consent page: which
   client (registered name and redirect host) wants to connect to Fiken
   through Fiken MCP, with "Fortsett til Fiken" and "Avbryt". The MCP
   authorization spec requires this for proxies with a static upstream
   client id; it is what stops an attacker-registered client from
   phishing a code out of a real Fiken login. The page has no external
   resources and a strict CSP.
4. **Authorize.** "Fortsett" posts the same parameters back to
   `POST /authorize`. We re-validate, pack
   `{redirect_uri, code_challenge, client_state, exp: +1h}` into a signed
   state, and redirect the browser to Fiken's authorize endpoint with our
   client id and `https://api.fiken-mcp.byjoba.com/callback`. Fiken handles
   login, 2FA and its own consent. One hour so slow logins do not fail.
5. **Callback.** We verify our state, wrap
   `{fiken_code, fiken_state, code_challenge, redirect_uri, exp: +5min}`
   into a signed code blob, and redirect to the client's redirect URI
   with that blob as `code` and the client's original state. The blob is
   replayable for five minutes on our side; Fiken's code is single-use,
   which closes that.
6. **Token.** Client posts the code blob and its PKCE verifier. We check
   the verifier against the challenge in the blob, that the redirect URI
   matches the blob and the client id, exchange the Fiken code with our
   client secret, call `GET /user` once, compute the anonymous id
   `HMAC(salt, email)`, and return **encrypted wrappers**:
   - access token: `{fiken access token, anon id, exp: +1h}`. One hour,
     not Fiken's 24, so a leaked token has a short life.
   - refresh token: `{fiken refresh token, anon id}`.
   On `refresh_token` grant we unwrap, call Fiken's refresh every time
   (one upstream call per user per hour) and rewrap. If the user revoked
   the app in Fiken, that refresh fails within the hour and the client
   restarts at step 3. Token responses carry `Cache-Control: no-store`
   and `Pragma: no-cache`.
7. **Every MCP request** carries our wrapped access token. We decrypt it
   before doing any other work, forward the Fiken access token upstream,
   and use the anonymous id for usage counting. A 401 from Fiken becomes
   a 401 to the client, which triggers refresh.

**Revocation.** There is nothing to revoke on our side and Fiken has no
revocation API. Disconnecting in Claude only forgets the tokens; the
Fiken grant stays until the user revokes it in Fiken. The privacy
statement says so.

Security properties: blobs expire in minutes (an hour for the login
state, which carries no code), are bound to redirect URI and PKCE
challenge, and are useless if tampered with. A wrapped token leaked from
a client cannot be used against Fiken without our key and dies within
an hour. We hold the client secret, the key ring and the salt, and
nothing per user.

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

Two atomic `ADD` updates per tool call, run after the tool's handler
returns and awaited, so `errors` is exact; a store failure is logged as
`usage_failed` and never fails the tool.
`activeUsers` increments when the user-month update reports no previous
value. `totalUsers` increments when the `PROFILE` conditional put
succeeds at first login. Totals are sums over month rows. No streams.

Surfaces: a `my_usage` tool for the user, and `GET /stats` returning the
global rows with a cache header for the website. CloudWatch keeps
structured request logs for 30 days for debugging only; never file
content.

## 7. Fiken concurrency and abuse limits

Lambda reserved concurrency 1 plus an in-process promise queue with a
300 ms gap in `fikenFetch`; retry once on 429. Reserved concurrency
needs the account's Lambda concurrency quota above the default 10; the
byjoba account's was raised to 1000 on 2026-09-27. A second user's call
during another's in-flight call is throttled by Lambda and surfaces to
the client as a tool error the model can retry. Acceptable under the
5-user dev cap. When applying for production status, ask Fiken whether
the limit is per user; if so, raise concurrency and queue per token.

Concurrency 1 also means anyone can starve the service by hammering it.
Controls: API Gateway stage throttling (20 requests per second, burst
40) on all routes, the bearer check runs before any other work on
`/mcp`, and unauthenticated routes do no upstream calls except `/token`,
which only reaches Fiken with a validly signed code blob. CloudFront in
front with rate rules is the upgrade path if abuse ever appears; it is
not in scope now.

## 7b. Security controls that cut across the design

- **Prompt injection through documents.** Content from uploaded files
  enters the model's context by design, and the tool set can send
  invoices and register payments. Every context block the widget
  produces is prefixed with a line stating that what follows is untrusted
  document content, not instructions. Every consequential tool
  (`send_invoice`, `create_invoice`, `create_credit_note`,
  `register_payment`, `create_purchase`, `attach_inbox_document`)
  carries `destructiveHint: true`, and its description requires the
  model to restate the exact action and get explicit user confirmation
  before calling it. The client's own per-tool approval prompts stay on.
- **Logging.** Structured JSON logs with a request id, method, route,
  status and duration. Never a header, body, token, parameter value,
  Fiken response body or the `/user` response. Log groups are created
  explicitly with 30-day retention for the Lambda and for API Gateway
  access logs, whose format contains no headers. A test on each error
  path asserts that no token material appears in the message.
- **Transport headers.** `Strict-Transport-Security` on every response.
  Token responses `Cache-Control: no-store`, `Pragma: no-cache`. The
  consent page has a CSP allowing only inline styles and same-origin
  form posts.
- **Uploads.** The Lambda checks magic bytes (`%PDF`, PNG, JPEG, GIF)
  and rejects anything else before forwarding, regardless of the
  declared type or extension. Filenames are reduced to a safe basename.
- **Widget.** No token, ticket or tool result is ever rendered into the
  DOM in production; filenames are set with `textContent`. The upload
  ticket is scoped to one company and expires in 15 minutes.
- **Memory hygiene.** Request bodies are never kept in module scope, so
  nothing survives an invocation in the Lambda container.
- **Spike.** `spike/` was deleted before the first production deploy.

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
`_meta.ui.csp.connectDomains: ["https://api.fiken-mcp.byjoba.com"]`. The
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
   Bytes are never written anywhere. Limit 4 MB per file: Lambda accepts
   6 MiB per request and API Gateway base64-encodes binary bodies, which
   puts the hard ceiling at 4.5 MiB of raw bytes, so 4 MB leaves a
   margin. Multipart framing does not change this. Images above the
   limit are downscaled in the widget before upload. Any other file
   above the limit is **not uploaded**: the widget shows a clear message
   next to the file naming it and the limit, marks it as skipped in the
   summary block it sends to the model, and continues with the other
   files. Splitting large PDFs into several documents client-side is the
   planned follow-up.
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
- HEIC: Fiken rejects it, so the widget converts it to JPEG on the device
  when the browser can decode it (Safari can). A browser that cannot
  decode it gets the file named as skipped.
- Files over 4 MB that are not images. The widget tells the user
  which file was skipped and why; the model learns it from the summary
  block.

## 10. Website

Static site (separate, later) showing what the connector does, how to
add it, the privacy statement, and live counters from `GET /stats`.

## 11. Privacy statement (for README and site)

We hold Fiken app credentials and a signing key. We never store your
Fiken tokens, your files or your accounting data; files pass through our
server's memory on the way to Fiken and are not written or logged. We
keep anonymous usage counters keyed by a salted hash of your email that
we cannot reverse. Disconnecting the connector in Claude or ChatGPT only
makes that app forget its tokens; to end our access to your Fiken
account, revoke "Fiken MCP" in Fiken under Rediger konto, API. Do that
too if you suspect a device or account was compromised.

## 12. Error handling

- Fiken 401: return 401 with `WWW-Authenticate` so the client refreshes,
  set only when nothing was written in that call; after a successful
  create, a failing follow-up stays a tool error so the client's re-send
  cannot repeat the write.
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
- Widget: manual protocol from the spike's README (git history, commit
  `c8dd493`, `spike/README.md`) on Claude Desktop and iOS after each
  widget change; ChatGPT once, to record what works.
- CI: PR runs typecheck and tests; merge to main deploys with `cdk deploy`.

## 14. Open items

Done by the receipts-flow plan (2026-09-28,
`docs/superpowers/plans/2026-09-28-fiken-mcp-receipts-flow.md`): the
widget, the upload ticket and `/upload`, `get_upload_url`, and the tools
`list_projects`, `list_accounts`, `list_bank_accounts`,
`search_contacts`, `get_contact`, `create_contact`, `list_purchases`,
`get_purchase`, `create_purchase`, `attach_inbox_document`, `list_inbox`.
`attach_inbox_document` covers purchases only so far.

Done by the usage-and-cimd plan (2026-09-28,
`docs/superpowers/plans/2026-09-28-fiken-mcp-usage-and-cimd.md`): the
usage counters, `my_usage`, `GET /stats`, the Fiken 401 → HTTP 401
mapping, and Client ID Metadata Documents (Claude's "published
identity").

Still to build from section 8: invoices (`list_invoices`, `get_invoice`,
`create_invoice_draft`, `create_invoice_from_draft`, `create_invoice`,
`send_invoice`), `list_sales`, `list_products`, `account_balances`,
`bank_balances`, `get_journal_entries`, `get_inbox_document`,
`get_attachments`, `create_credit_note`, `register_payment`,
attachments to sales, invoices and journal entries. `get_upload_url`
only ever reaches the inbox: uploading straight to a sale, an invoice or
a journal entry still has to be built.

- Confirm with Fiken whether the concurrency limit is per user.
- ChatGPT: verify the widget, `connectDomains` and model-context support.
- **CIMD (done 2026-09-28).** Allowed hosts: claude.ai, anthropic.com
  and subdomains, chatgpt.com, openai.com and subdomains; the redirect
  allowlist stays the control.
- **Connector icon (done 2026-09-27).** Clients show a letter placeholder
  until the server declares `icons` on its `serverInfo` (MCP
  `Implementation` supports `icons: [{ src, mimeType, sizes }]`). The api
  serves a 512 px PNG from the unauthenticated `GET /icon.png` and
  references it by absolute URL. The icon uses no Fiken logo or colours;
  we are a third-party integration, and the connector is already named
  "Fiken MCP".
- The API lives at `api.fiken-mcp.byjoba.com` (certificate in eu-west-1,
  requested by hand). `fiken-mcp.byjoba.com` is reserved for a CloudFront
  site, which needs its own certificate in us-east-1.
