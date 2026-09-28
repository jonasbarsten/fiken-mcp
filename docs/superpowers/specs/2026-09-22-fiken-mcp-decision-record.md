# Decision record: auth, data flow, attachments

Date: 2026-09-22
Purpose: what we chose, what we tried, and what we ruled out, with the
evidence, so nobody re-explores a dead end. Companion to the
[design spec](2026-09-22-fiken-mcp-design.md).

## The problem in one paragraph

A Fiken customer on a phone says "her er masse kvitteringer, bokfør dem".
The receipts are bytes in the camera roll. The model needs to see them
to book, and Fiken needs the originals as documentation. The model can
see anything a chat client shows it, but nothing in MCP carries a chat
attachment to a server, and Fiken cannot be called from a browser.
Every alternative below is a way of moving those bytes and of letting
the model read them.

## Auth

**Chosen: stateless OAuth with wrapped tokens.** We are an OAuth 2.1
server toward the MCP client and an OAuth2 client toward Fiken. Client
registrations, login state and auth codes are signed blobs; the tokens
we issue are encrypted wrappers of Fiken's tokens plus an anonymous id.
No database. Details in the spec.

Ruled out:

- **Fiken personal API tokens.** Fine for one's own company, but using
  them in a third-party app violates Fiken's terms. Not applicable to a
  product for other customers.
- **Database-backed OAuth (DynamoDB + KMS).** Works, but stores customer
  refresh tokens we would rather not hold. The stateless version gives
  the same flow with nothing to protect.
- **Identity vendor as authorization server (Auth0, Stytch).** Fiken is
  plain OAuth2, not OIDC, so Cognito cannot front it, and a vendor adds
  cost, a second console and a three-hop login.
- **Cloudflare Workers OAuth provider.** Well trodden, but the project is
  on AWS by decision.
- **Fiken login on our own pages.** Not needed once nothing of ours has
  a page.

## Secrets and config

**Chosen:** Parameter Store SecureStrings, read once per cold start.

Ruled out: **GitHub secrets injected as Lambda env vars.** CDK bakes env
vars into the CloudFormation template, which lands in cdk.out, the asset
bucket and the console. Saves nothing, since the read happens once per
cold start.

## Where the model runs

**Chosen:** the user's own Claude or ChatGPT plan, through the connector.

Ruled out: **our own hosted chat app.** "Sign in with Claude" for
third-party apps is prohibited by Anthropic's terms since February 2026
(consumer OAuth is for Claude Code and Claude.ai only; tokens error
elsewhere). "Sign in with ChatGPT" only exists inside Codex. An app on
our own API key would mean we pay per token and bill users, a different
product. "Authorize Claude for X" screens are the opposite direction:
apps opening themselves to Claude, which is what our connector is.

## Getting bytes from the user to Fiken

**Chosen: MCP App widget with a native file picker, posting to our
Lambda, which forwards to the Fiken inbox in memory.** Verified on
Claude Desktop and iOS. The inbox document id is the join key: the
model books with `create_purchase(inboxDocumentId)` and Fiken attaches
the original.

Ruled out, with the reason each failed:

- **Direct browser to Fiken.** `api.fiken.no` has no CORS headers and
  its preflight returns 500. Tested. If Fiken ever adds CORS, the widget
  could post directly and our upload route disappears.
- **Base64 in tool arguments.** Legal, works everywhere, but every byte
  is an output token. A 60 kB e-receipt is about 27k tokens; a phone
  photo is impossible. Kept only as a theoretical fallback for tiny files.
- **Chunked base64 with assembly on our side.** Needs storage between
  calls (S3 or DynamoDB), which we ruled out, and does not reduce the
  token cost.
- **Signed URL plus curl from the agent.** Works in Claude Code. In
  Claude.ai the code-execution sandbox exists and holds the chat
  uploads, but on Free, Pro and Max its egress is limited to package
  registries and individuals cannot change it. Kept as the secondary
  path for shell-capable clients only.
- **Claude.ai code-execution sandbox calling MCP tools.** Programmatic
  tool calling explicitly excludes MCP tools.
- **ChatGPT file parameters (`openai/fileParams`).** The only client
  where the model can hand a chat upload to a tool. Verified caveats:
  mobile uploads arrive as placeholder strings without URLs (open issue
  since January 2026); a published app reports the file missing on
  about 10% of calls; unofficial evidence that developer-mode
  connectors never get files; app directory excluded the EEA at launch.
  Not relied on.
- **URL-mode elicitation.** An out-of-band web page, which we excluded,
  and the spec forbids pre-authenticated URLs.
- **Drop-zone web page (with Fiken login, or with a scoped capability
  link).** Works everywhere, but is a page outside the chat with double
  handling of files. Superseded by the widget, which is the same idea
  rendered inside the conversation.
- **Fiken app or inbox email as the intake.** Works and is simple, but
  a second app. Kept as something users can still do: `list_inbox` and
  `create_purchase(inboxDocumentId)` book whatever is in the inbox
  regardless of how it got there.
- **Purchase drafts as a landing spot.** Needed a placeholder line per
  draft; the inbox is the same idea without the wart.
- **Temporary S3.** Solves a 6 MB request cap we do not hit, and does
  not solve tokens or egress. Rejected on the no-storage rule.
- **Holding uploads in Lambda memory for a later tool.** Unreliable
  across instances and storage in all but name.
- **Server-side reading (Textract, PDF parsing) with read-back from
  Fiken.** Works but spends a Fiken call per receipt and breaks
  "everything on the client". Superseded by the widget pushing content
  into model context.

## Getting file content to the model

**Chosen: the widget pushes content into model context via
`ui/update-model-context`.** Photos and scans as 1024 px JPEG image
blocks; PDF pages with a text layer as extracted text. Verified: Claude
answered a page-24 question from 24 pages of extracted text (61 kB) with
no tool call.

Facts that shaped it:

- The host declares which block types it accepts. Claude Desktop
  2.2553.1 declares `text` and `image` for context updates and `text`
  for messages. **`resource` blocks (PDF bytes) are silently dropped.**
  There is no page documenting this; the declaration in the
  `ui/initialize` result is the contract, and the test confirmed it.
- **Each context update replaces the previous one** (spec text: "Each
  request overwrites the previous context sent by the View"). The widget
  therefore accumulates every block and re-sends the full set. The first
  PDF test failed for exactly this reason: a second update wiped the
  image from the first.
- The host defers the context to the next user message. `sendMessage`
  pre-fills the composer with a caution banner; the user taps send.
- Images cost about w*h/750 tokens regardless of format. Text is
  roughly a quarter of an image of the same page and gives exact numbers,
  which matters for statements and reconciliation. Context is re-sent on
  every turn, which is the argument for a default cap on image pages with
  a "render all" control, not a hard limit.
- Read-back from Fiken is not needed. The throttling concern that
  motivated avoiding it is real but small: one sequential call per
  receipt. The widget path removes it entirely.

## Widget mechanics that bit us

- **Per-build resource URIs cause "Unable to reach".** Claude caches
  the tool list per connector, so it kept asking for a URI we had stopped
  serving. Use one stable URI. The widget itself is re-read before each
  tool call, so deploys are enough.
- **Inline every bundle in its own `<script type="module">`.** Three
  minified modules in one scope collide on top-level names.
- **pdf.js without a worker.** Inline `pdf.worker.min.mjs`; it sets
  `globalThis.pdfjsWorker`, which pdf.js uses instead of spawning a
  worker. Avoids any worker CSP question.
- **`tools/list_changed` and `resources/list_changed`** can be sent on
  the tool call's stream (`ctx.mcpReq.notify`), but Claude did not act on
  them. Not a cache-invalidation mechanism.
- **iOS omits the Referer header**; allowlist on `Origin`
  (`*.claudemcpcontent.com`), not Referer.

## Concurrency

Chosen: reserved concurrency 1 plus an in-process queue. Fiken's docs do
not say whether the one-request rule is per user or per app; a third
party's README claims per user without a source. Ask Fiken at
production-status time.

## Security review (2026-09-22) and what changed

A review of the design from the standpoint of a bank's security lead
found one blocking issue and several hardening items. All were adopted
except a WAF, which is deferred until abuse appears.

- **Blocking: attacker-registered clients.** Open dynamic registration
  plus no consent of our own let an attacker phish a code out of a real
  Fiken login (confused deputy). Fixed with a redirect URI allowlist of
  known MCP clients and a consent page on `/authorize`. The redirect URI
  registered in the Fiken app does not help here; it only stops
  impersonation of our server toward Fiken.
- **Prompt injection via document content** driving write tools. Fixed
  with an untrusted-content prefix on every context block and
  confirmation-required descriptions plus `destructiveHint` on every
  consequential tool.
- **Administrator execution role in a shared account.** CDK's default
  execution role is administrator, and byjoba hosts other products.
  Fixed with a dedicated bootstrap qualifier, a scoped execution policy,
  and a permissions boundary on all roles. A dedicated account remains
  the end state.
- **24-hour access tokens.** Now one hour, with refresh reusing the
  wrapped Fiken access token while it is valid.
- **One key for signing and encryption, no rotation.** Now a key ring
  with HKDF-derived subkeys and a key id in every blob.
- **Trivial denial of service** under concurrency 1. API Gateway stage
  throttling; bearer check first.
- **Unspecified logging.** 30-day retention, structured logs, explicit
  no-token rule with tests, access logs without headers.
- **Supply chain.** Actions pinned by SHA, CODEOWNERS, secret scanning
  with push protection, Dependabot.
- **Upload validation.** Magic bytes, not extensions.
- **Smaller:** `no-store` on token responses, HSTS, widget DOM rules,
  the note that code blobs are replayable only until Fiken's single-use
  code is spent, and that disconnecting a client does not revoke the
  Fiken grant.

## Post-implementation review (2026-09-22)

A whole-branch security review of the implemented foundation. What it
changed, and what it left open:

- **Lookup role excluded from the assumable bootstrap roles.** The
  deploy role and the execution policy could assume any
  `cdk-fikenmcp-*-role`, which included the lookup role and its
  account-wide ReadOnlyAccess in a shared account. Neither stack uses
  context lookups, so both now name exactly the deploy role and the
  file-publishing role, and a test refuses `lookup-role` or a wildcard.
- **Exec-policy self-modification accepted.** `iac/lib/exec-policy.ts`
  and the deploy role's trust policy are applied by the execution role
  they govern, so a merged change can widen it. The controls are the
  `production` environment approval, CODEOWNERS over every file, and
  review. A Deny on modifying the policy itself was considered and
  rejected: the exec role runs every deploy, so such a Deny would freeze
  the boundary until an administrator re-bootstraps by hand. The policy
  does deny removing or replacing a permissions boundary.
- **Login state bound to a `__Host-` cookie.** The signed state alone
  let anyone who obtained a state blob complete `/callback` in their own
  browser (RFC 6749 section 10.12), which also bypassed our consent
  page. `GET /authorize` (2026-09-28: moved from POST) sets a nonce in a
  `__Host-fmcp_login` cookie and echoes it as a hidden field;
  `POST /authorize` requires field and cookie to match, which is the
  CSRF check a cross-site form post cannot pass (it carries neither the
  field nor, under SameSite=Lax, the cookie); the nonce goes into the
  state and `/callback` requires cookie and state to match.
- **Continue page instead of a redirect after the consent post
  (2026-09-28).** Chrome checks `form-action` against every hop of the
  redirect chain after a form post, and Fiken's login redirects are not
  ours to allowlist (two failed logins: `'self'`, then `'self'
  https://fiken.no`). The post answers with a page that navigates via
  `<meta http-equiv="refresh">`, which CSP does not govern; `form-action`
  stays `'self'`.
- **Certificate made by hand, static domain in iac (2026-09-27).** Two
  first deploys failed on `acm:RequestCertificate`: a request-tag gate
  cannot pass (CloudFormation requests first, tags afterwards) and a
  domain-name gate raced the policy update within the same deploy. The
  certificate is now requested once by hand and imported by ARN, so the
  execution policy has no certificate-write rights at all. The
  certificate, the API Gateway custom domain and the alias record live
  in the iac stack (static); the api stack only maps its API onto the
  exported domain, so api deploys never wait for validation.
- **Reserved concurrency and the account quota (2026-09-27).** The
  account's Lambda concurrency quota was the default 10, of which Lambda
  keeps 10 unreserved, so `ReservedConcurrentExecutions: 1` could not be
  applied and the first deploy failed with the unhelpful "not updatable
  with parameters provided". The setting was dropped for a few hours,
  the quota (L-B99A9384) raised to 1000, and the setting restored. A new
  account needs that quota increase before this stack deploys.
- **Refresh reuse dropped (decided 2026-09-27).** The `refresh_token`
  grant used to reuse the wrapped Fiken access token while it had more
  than an hour left, so a grant the user revoked in Fiken was not
  noticed for up to about 23 hours. Every renewal now calls Fiken's
  refresh: one upstream call per user per hour, and a revocation is
  refused within the hour, which sends the client back through login.
  The refresh wrapper carries only Fiken's refresh token and the
  anonymous id. A Fiken 401 during a tool call is still reported to the
  model as a tool error that tells the user to reconnect; mapping it to
  an HTTP 401 remains a follow-up.

## Things we decided not to do, on purpose

- No inbox as a required step for users. It remains usable.
- No HEIC conversion in version one.
- No offers, order confirmations, recurring invoices, time tracking or
  deletes in version one.
- No per-user website login. Usage is a tool; the site shows aggregates.
