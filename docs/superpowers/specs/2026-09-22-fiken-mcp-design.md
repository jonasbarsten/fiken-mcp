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
- The tool list is cached per connector and refreshed on re-add or with
  the connector's "Refresh tools list" menu item. The
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
`usage_failed` and never fails the tool. Calls the SDK rejects before a
handler runs (invalid arguments, unknown tool) are not counted.
`activeUsers` increments when the user-month update reports no previous
value. `totalUsers` increments when the `PROFILE` conditional put
succeeds at first login. Totals are sums over month rows. No streams.
If the global update fails after the user update succeeded, that user's
`activeUsers` contribution for the month is lost; this is accepted for
anonymous statistics rather than giving up the single `ALL_OLD` round
trip on the user update.

Surfaces: a `my_usage` operation for the user (run through
`fiken_read`), and `GET /stats` returning the
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
A single user hits this too: clients fire independent tool calls in
parallel (Claude Code sent six at once on 2026-09-29 and five
succeeded), and the throttled one surfaces as a 503 the model has to
retry. If that proves annoying in practice, the fix is a small
reserved concurrency (say 3) with a cross-container lock on Fiken calls
(a DynamoDB conditional write on an expiry timestamp checked in the
condition itself; DynamoDB's TTL deletes items up to about 48 hours late
and cannot expire a lock), not a bigger queue in one container.

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

### The gateway, the hot path and the registry

Every Fiken action is an `Operation` in one registry
(`api/src/mcp/registry.ts`): name, concept, `read` or `write`,
destructive flag, zod input and `run`. The tool list stays fixed and
short: the hot-path tools, the upload tools, and three gateway tools.

- `fiken_explore` returns the concepts, then one concept's operations
  with compact JSON Schema inputs (defaulted fields optional, extra keys
  refused). Disclosure happens in tool results, not in a changing tool
  list (decision record).
- `fiken_read` and `fiken_write` take an operation name and `args`,
  validate `args` against the operation's zod schema and run it through
  the same `counted()` wrapper, read-backs and write guard as before. A
  write operation sent to `fiken_read` is refused before any Fiken call;
  unknown names, a key beside `operation` and `args` (answered with a
  hint to put the inputs under `args`) and invalid args are refused and
  counted under the gateway's name as errors. `args` sent as a JSON
  string is parsed; one that does not parse gets the same hint. Unknown
  keys in args, and in an invoice or purchase line, are refused instead
  of dropped. The hot-path tools parse their input strictly at the top
  level too, so a mistyped key is refused the same way there.
- Only real tools can be called by name. Every description and result
  text that names an operation that is not a hot-path tool says how to
  run it ("use get_invoice (via fiken_read)"; recovery texts give the
  exact `fiken_read`/`fiken_write` call with its args). A registry test
  pins this for every operation.
- The hot path (`HOT_PATH` in `api/src/mcp/server.ts`) is `list_companies`,
  `list_projects`, `list_accounts`, `list_bank_accounts`,
  `search_contacts`, `list_inbox`, `create_purchase`. They stay real
  tools because the receipts flow calls them on a phone and should not
  spend a round trip on `fiken_explore`. Every operation, these too, is
  also reachable through the gateway.
- Concepts (`CONCEPTS` in `operations.ts`): companies, contacts,
  projects, accounts, ledger, purchases, sales, invoices, invoice_drafts,
  credit_notes, offers, order_confirmations, recurring_invoices,
  time_tracking, payments, products, inbox, ehf, attachments, usage.
- Connector options live in the URL path: `/mcp/readonly`,
  `/mcp/<concept>,<concept>`, combinable with `readonly`. A concept
  filter chooses which areas the model may change; all reads stay
  available (ruling, 2026-09-29): every read operation is visible on
  every connection, and writes only for the chosen concepts (none when
  `readonly`). They are read on every request and nothing is stored.
  `fiken_write` is absent when the connection sees no write; the upload
  tools need `purchases` chosen (or no filter) and a non-readonly
  connection. Unknown
  words get a 400 after login; an unauthenticated request to an invalid
  option path gets the plain `/mcp` challenge. The protected-resource
  metadata mirrors the path
  (`/.well-known/oauth-protected-resource/mcp/<options>`). The options
  narrow what a connection offers the model; they are not a security
  boundary against the token holder, since the same token works on
  `/mcp`.

The operations, by kind:

Read:
`list_companies`, `search_contacts`, `get_contact`, `list_invoices`,
`get_invoice`, `list_sales`, `list_purchases`, `get_purchase`,
`list_products`, `list_accounts`, `account_balances`, `bank_balances`,
`get_journal_entries`, `list_projects`, `list_inbox`,
`get_inbox_document` (for documents that reached the inbox outside the
widget, e.g. via the Fiken app: images returned as image content, PDFs
as text extracted in memory per page; pages without text are named and
the model is pointed to `upload_receipts` when that tool is available and
otherwise to opening the document in Fiken, since rendering them needs a
native canvas the Lambda does not have), `get_attachments` (on a
purchase, sale, invoice or journal entry, exactly one id), `my_usage`.
`list_invoices` filters by issue date range, customer, settled status
or invoice number; `get_invoice` returns one invoice with its lines.

Added by the coverage plan (2026-09-29), reads:
`get_sale`, `list_payments`, `get_journal_entry`, `list_transactions`,
`get_transaction`, `list_purchase_drafts`, `get_project`, `get_product`,
`list_contact_persons`, `list_invoice_drafts`, `get_invoice_draft`,
`get_counters` (`{ current, next }` per series, or null; null can also
mean a wrong company slug), `list_credit_notes`, `get_credit_note`,
`list_offers`, `list_offer_drafts`, `list_order_confirmations`,
`list_order_confirmation_drafts`, `list_recurring_invoices`,
`list_time_users`, `list_activities`, `list_time_entries`,
`list_ehf_documents`, `get_ehf_document`.

Writes added by the coverage plan: `create_sale` (NOK only),
`settle_sale` (sends Fiken's required `settledDate` query parameter),
`write_off_sale` (booked as a loss, not a delete),
`create_journal_entry` (balanced before any call, no VAT codes, description
at most 166 characters, since Fiken's 200-character limit includes its
34-character prefix), `create_accrual` (takes a `lineId` from
`get_sale` or `get_purchase`, and the required `account`), `create_purchase_draft` (NOK only, not
destructive), `create_purchase_from_draft`, `create_project`,
`update_project`, `create_product`, `update_product`, `update_contact`,
`add_contact_person`, `update_invoice_draft` (not destructive),
`initialize_counter` (takes `firstNumber`; Fiken stores the last number
used, so the POST sends `firstNumber - 1`; an existing series is never
changed), `send_credit_note`, `create_offer_draft`,
`create_offer_from_draft`, `send_offer`, `create_order_confirmation_draft`,
`create_order_confirmation_from_draft`,
`create_invoice_draft_from_order_confirmation`,
`create_recurring_invoice_from_draft`, `set_recurring_invoice_job`,
`create_time_entry`, `create_invoice_draft_from_time_entries` (NOK only,
not destructive). `attach_inbox_document` also takes an `ehfDocumentId`
(not for invoices). `update_contact`, `update_product` and
`update_invoice_draft` are read-modify-write; see the decision record.

Write:
`create_contact`, `create_invoice_draft` (not destructive: a draft is
reviewed in Fiken), `create_invoice_from_draft` (destructive),
`create_invoice` (destructive), `send_invoice` (destructive),
`create_credit_note` (destructive; `kind` full or partial; booked, not sent),
`create_purchase` (destructive; takes optional `inboxDocumentId`),
`register_payment` (destructive; on a sale or a purchase, positive
amounts only, NOK only),
`attach_inbox_document` (destructive; to a purchase, sale, invoice or
journal entry; Fiken takes only a file for an invoice, so an invoice gets
a copy and the document stays in the inbox),
`upload_receipts` (renders the widget; see section 9),
`get_upload_url` (secondary path for shell clients; see section 9).

Left out on purpose: deletes, reversals and cancelling (pending Jonas's
decision). Not covered: activity writes, contact group management,
contact attachments, the product sales report and creating bank accounts.

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
15-minute URL bound to the company's inbox and a curl command. The agent
reads files locally and uploads them itself. The Lambda forwards to the
inbox as above, and `attach_inbox_document` then places the document on
a purchase, sale, invoice or journal entry. There are no direct targets:
one ticket shape and one upload route cover the same ground.

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
account, revoke "Fiken MCP" in Fiken under Rediger konto, Sikkerhet,
"Apper du har gitt tilgang til". Do that
too if you suspect a device or account was compromised.

## 12. Error handling

- Fiken 401: return 401 with `WWW-Authenticate` so the client refreshes,
  set only when nothing was written in that request: after any
  successful non-GET Fiken call (the write guard, `session.wrote`), a
  Fiken 401 stays a tool error so the client's re-send cannot repeat the
  write. Legacy JSON-RPC batch bodies are refused with
  400 so one body can never mix a write with the 401 mapping. Before
  mapping, the login is checked once per request with `GET /user`, with
  three outcomes. Confirmed dead (a 401 there): HTTP 401. Confirmed
  valid: a tool error saying Fiken refused this request although the
  login is valid. Check failed another way (network, 5xx), or not made
  (any 401 in a read-back or follow-up after a write): a tool error
  with Fiken's message saying to retry and reconnect if it keeps
  happening, never an HTTP 401.
- Fiken 429: retry once after 1 s, then surface as tool error.
- Fiken 4xx validation: pass Fiken's message through as `isError`.
- Unknown company slug: error text lists the user's slugs.
- Upload ticket invalid or expired: 401 to the widget; the widget shows
  it and the model can call `upload_receipts` again.
- Lambda throttled (concurrency): API Gateway answers 503 "Service
  Unavailable" (observed 2026-09-29 when Claude Code fired six tool calls
  at once), not 429. The call never reaches the Lambda and is not
  counted. Clients show the error instead of retrying, so a client that
  parallelises tool calls loses all but one of them; see section 7 for
  the trade-off.

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
(`attach_inbox_document` covered purchases only then; see the next
plan.)

Done by the usage-and-cimd plan (2026-09-28,
`docs/superpowers/plans/2026-09-28-fiken-mcp-usage-and-cimd.md`): the
usage counters, `my_usage`, `GET /stats`, the Fiken 401 → HTTP 401
mapping, and Client ID Metadata Documents (Claude's "published
identity").

Done by the remaining-tools plan (2026-09-29,
`docs/superpowers/plans/2026-09-29-fiken-mcp-remaining-tools.md`): the
write guard; the tools `list_sales`, `list_products`, `account_balances`,
`bank_balances`, `get_journal_entries`, `list_invoices`, `get_invoice`,
`create_invoice`, `create_invoice_draft`, `create_invoice_from_draft`,
`send_invoice`, `create_credit_note`, `register_payment`,
`attach_inbox_document` to sales, invoices and journal entries as well,
`get_attachments` and `get_inbox_document`. `get_upload_url` stays
inbox-only by decision (see the decision record).

Done by the operations plan (2026-09-29,
`docs/superpowers/plans/2026-09-29-fiken-mcp-operations.md`): the
registry, `fiken_explore`, `fiken_read` and `fiken_write` with the hot
path kept as real tools, strict invoice and purchase lines, and connector
URL options (`/mcp/readonly`, `/mcp/<concepts>`). Live fixes after
production testing: `get_journal_entries` lines carry `account` and
`vatCode` again, and `create_invoice_draft` requires `bankAccountNumber`
(from `list_bank_accounts`).

Done by the coverage plan (2026-09-29): the Fiken areas that were not
covered, added as operations: sales without an invoice, manual journal
entries (`createGeneralJournalEntry`), purchase drafts, projects and
products create and update, contact updates and contact persons, sending
credit notes, invoice and credit note counters, marking sales settled or
written off, invoice draft list and update, single sale lookup, payments
lookup, transactions (read), offers and order confirmations, recurring
invoices, time tracking, the EHF inbox and accruals. New concepts:
`invoice_drafts`, `offers`, `order_confirmations`, `recurring_invoices`,
`time_tracking`, `ehf`. Deletes, reversals and cancelling stay out until
Jonas decides; activity writes, contact groups, contact attachments, the
product sales report and creating bank accounts are not covered.

Still to build after that: ChatGPT verification.

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
  requested by hand).
- **Website at `https://fiken-mcp.byjoba.com` (built 2026-10-03; see `2026-10-03-fiken-mcp-website-design.md`).**
  Static site on CloudFront: what the connector does, how to add it in
  Claude and ChatGPT, the privacy statement (section 11), and the live
  counters from `GET /stats`. The certificate was requested by hand in
  us-east-1, like the API's. The bucket, distribution, apex records and
  content upload live in the separate `fiken-mcp-web` stack
  (`iac/lib/web-stack.ts`); the page is in `web/`.
