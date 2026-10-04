# One-time setup

Everything here is done once by Jonas. Nothing in it needs repeating for
normal development.

## AWS (byjoba, eu-west-1)

1. Parameter Store SecureStrings. `/fiken_mcp/client_id` and
   `/fiken_mcp/client_secret` already exist. Create:
   - `/fiken_mcp/signing_key`: the value `k1:<64 hex>` where the hex comes
     from `openssl rand -hex 32`. To rotate later, prepend `k2:<hex>,`.
   - `/fiken_mcp/user_salt`: 64 hex characters from `openssl rand -hex 32`.
   Use the console or `aws ssm put-parameter --type SecureString`. Never
   paste the values anywhere else.
2. Certificate for `api.fiken-mcp.byjoba.com`, requested once by hand so
   that CloudFormation never needs certificate-request rights. It must be
   in eu-west-1, the API's region; `fiken-mcp.byjoba.com` itself stays
   free for a future CloudFront site, whose certificate would have to be
   in us-east-1 and cannot be shared with the API anyway.
   ```
   aws acm request-certificate --domain-name api.fiken-mcp.byjoba.com \
     --validation-method DNS --tags Key=Project,Value=fiken-mcp \
     --region eu-west-1 --profile byjoba
   ```
   In the ACM console open the certificate and use "Create records in
   Route 53" to add the validation CNAME to the byjoba.com zone (or add
   the CNAME from `aws acm describe-certificate` by hand). Wait for
   status ISSUED, then put the ARN in `CERTIFICATE_ARN` in
   `iac/lib/iac-stack.ts`. The certificate renews itself as long as the
   CNAME stays in the zone.
3. Bootstrap and first deploy, from `iac/`, in this order:
   ```
   npx cdk bootstrap aws://209479295726/eu-west-1 --qualifier fikenmcp --profile byjoba
   npx cdk deploy fiken-mcp-iac --profile byjoba
   npx cdk bootstrap aws://209479295726/eu-west-1 --qualifier fikenmcp \
     --cloudformation-execution-policies arn:aws:iam::209479295726:policy/fiken-mcp-cfn-exec \
     --profile byjoba
   ```
   The second bootstrap swaps the execution role's AdministratorAccess for
   the scoped policy the first deploy created. Note the `DeployRoleArn`
   output. On a new account the first `fiken-mcp-iac` deploy needs the
   site records and the invalidation import commented out, and the web
   stack must deploy before iac is deployed again with them restored; see
   "Fresh setup order" below.
4. Every future `cdk bootstrap` for qualifier `fikenmcp` (CDK upgrades,
   re-bootstraps) must repeat
   `--cloudformation-execution-policies arn:aws:iam::209479295726:policy/fiken-mcp-cfn-exec`.
   Without the flag the bootstrap template's default puts
   AdministratorAccess back on the execution role, silently.
5. If the deploy workflow fails at "Assuming role with OIDC" with "Not
   authorized to perform sts:AssumeRoleWithWebIdentity", the token's
   subject does not match the trust policy. Compare
   `gh api repos/jonasbarsten/fiken-mcp/actions/oidc/customization/sub`
   with `GITHUB_SUBJECT_PREFIX` in `iac/lib/iac-stack.ts`; GitHub's
   immutable subject carries the owner and repo ids. After changing the
   trust policy, deploy the iac stack once by hand
   (`cd iac && npx cdk deploy fiken-mcp-iac --profile byjoba`), because
   the workflow cannot assume the role until the trust policy matches.

### First deploy: things that may bite

- The upload widget is generated (`api/src/assets/upload.html`,
  gitignored). The deploy workflow calls `cdk deploy` directly, which
  skips npm's `pre*` hooks, so the CDK bundling step builds the widget
  itself (`beforeBundling` in `api/lib/api-stack.ts`); a stack test
  checks the bundled asset contains it. The first deploy of the receipts
  flow (2026-09-29) shipped without it and every request answered 500.
- The execution role reads `/cdk-bootstrap/fikenmcp/version` in SSM
  when CloudFormation checks the bootstrap version. The `Parameters`
  statement in `iac/lib/exec-policy.ts` covers
  `parameter/cdk-bootstrap/fikenmcp/*`; a test pins it.
- The execution policy grants no certificate-request rights at all; the
  certificate is made by hand (step 2) and imported by ARN. Two first
  deploys on 2026-09-27 failed on `acm:RequestCertificate`: a
  request-tag gate cannot pass because CloudFormation requests first and
  tags afterwards, and a policy change and a certificate request in the
  same iac deploy race each other. If the custom domain fails to create,
  check that `CERTIFICATE_ARN` names an ISSUED certificate in eu-west-1.
- Changes to `iac/lib/exec-policy.ts` or to the deploy role's trust
  policy are applied by the same CloudFormation execution role they
  govern. Review such pull requests with extra care: the `production`
  approval and CODEOWNERS are the controls.
- API Gateway access logging uses CloudWatch Logs "log delivery", which
  has no resource scoping: `logs:CreateLogDelivery`, `PutResourcePolicy`
  and friends must be granted on `*`. The `LogDelivery` statement holds
  the documented set. Two first deploys failed here, first with "Unable
  to retrieve Arn attribute for AWS::Logs::LogGroup" (needs
  `DescribeLogGroups` on `*`), then with "Insufficient permissions to
  enable logging ... logs:CreateLogDelivery".
- Lambda reserved concurrency needs an account quota above the default
  10 (Lambda keeps 10 unreserved, so nothing can be reserved). The first
  deploy failed on this with the unhelpful message "Resource of type
  'AWS::Lambda::Function' ... is not updatable with parameters
  provided". The byjoba quota was raised to 1000 on 2026-09-27; a new
  account needs the same request once, before the first deploy:
  ```
  aws service-quotas request-service-quota-increase --service-code lambda \
    --quota-code L-B99A9384 --desired-value 1000 --region eu-west-1 --profile byjoba
  ```
  `aws lambda get-account-settings --query AccountLimit` shows when it
  is in.

## GitHub (jonasbarsten/fiken-mcp)

1. Settings, Environments, New environment `production`:
   required reviewers: jonasbarsten; deployment branches: `main` only.
   Leave "Prevent self-review" off, so you can approve your own
   deployments. This approval is the gate that decides what reaches AWS.
2. Settings, Secrets and variables, Actions, Variables:
   `AWS_DEPLOY_ROLE_ARN` = the DeployRoleArn output.
3. Settings, Branches, rule for `main`: require a pull request, require
   status check `check`, block direct pushes, include administrators.
   While you are the only maintainer, set required approvals to 0:
   GitHub does not let an author approve their own pull request, so 1
   would lock you out of merging. When a second contributor joins, set
   required approvals to 1 and enable "require review from code owners";
   the CODEOWNERS file covers every file in the repository (`*`), so it
   then routes every change to you.
4. Settings, Actions, General: workflow permissions read-only; "Require
   approval for all outside collaborators".
5. Settings, Code security: enable secret scanning and push protection,
   Dependabot alerts and security updates.
6. Settings, Account: two-factor authentication required.

## Fiken

In the "Fiken MCP" app under Rediger konto, API: add redirect URI
`https://api.fiken-mcp.byjoba.com/callback`. Add each tester's Fiken login
under "Godkjente brukere" while the app is in development status.

## Website certificate

CloudFront needs its certificate in us-east-1. Requested by hand on
2026-10-03 for `fiken-mcp.byjoba.com`, DNS-validated in the byjoba.com
zone: `arn:aws:acm:us-east-1:209479295726:certificate/6814f406-e879-4458-9a45-739a1639ee30`
(`SITE_CERTIFICATE_ARN` in `iac/lib/web-stack.ts`). It auto-renews while
the validation CNAME exists. Before the first deploy, confirm in the ACM
console (us-east-1) that it is Issued.

## Fresh setup order

The iac stack owns the site's A and AAAA records and imports the web stack's
exports (`fiken-mcp-web-distribution-id` and
`fiken-mcp-web-distribution-domain-name`). On a new account iac therefore
cannot deploy until the web stack exists, and the web stack needs iac's
execution policy. The full order on a new account:

1. `cdk bootstrap` (default execution policy).
2. `cdk deploy fiken-mcp-iac` with the site alias records and the deploy
   role's invalidation import temporarily commented out in
   `iac/lib/iac-stack.ts`.
3. `cdk bootstrap` again with `--cloudformation-execution-policies` set to
   `fiken-mcp-cfn-exec` (step 3 above).
4. `cdk deploy fiken-mcp-web`.
5. Restore the commented-out code and `cdk deploy fiken-mcp-iac` again.
6. `cdk deploy fiken-mcp-api`, then the content deploy (merge anything to
   main, or run the content step's commands by hand).

The web stack cannot remove or rename those exports while iac imports them,
and a replacement of the distribution (for example renaming its construct)
would be blocked for the same reason.

## Before the first production deploy

- `spike/` was deleted in the foundation pull request. Its code and
  manual test protocol remain in git history at commit `c8dd493`.

## First deploy

Merge the first PR to `main`, approve the `production` deployment when
GitHub asks, and watch the `deploy` workflow. The certificate lives in
the iac stack, so its DNS validation (a few minutes) happens during the
hand-run `cdk deploy fiken-mcp-iac`, not in the workflow.

## Verified 2026-09-29 (after hotfix #24, from Claude Code)

- Login from Claude Code with dynamic registration: consent page, Fiken
  login, continue page, callback. Tools appeared without a manual step.
- Against the demo company: `list_companies`, `list_accounts`,
  `list_bank_accounts`, `search_contacts`, `list_purchases`,
  `list_inbox`, `get_upload_url`, a PNG uploaded through the ticketed
  `POST /upload` (201 with `documentId`), `create_purchase` as a cash
  purchase with `inboxDocumentId` (booked, one attachment, inbox document
  marked used), `my_usage`, and `GET /stats` (counts match, cache header
  present).
- `list_projects` answers Fiken's 402 "Project/time-tracking module not
  activated" on the demo company; activate the module in Fiken to test
  booking on a project.
- Six tool calls fired in parallel: one was refused with API Gateway's
  503 "Service Unavailable" (reserved concurrency 1). The call never
  reached the Lambda, so it is not counted. The client showed the error
  rather than retrying. Not yet verified: the widget on Desktop and iOS,
  HEIC, a supplier-kind purchase, CIMD login, revoke-then-reauth.

Verified 2026-09-29 (after deploying #26, from Claude Code, against the
demo company):

- Worked: `list_sales`, `list_invoices` (with `saleId`), `get_invoice`,
  `list_products`, `account_balances`, `bank_balances` (empty in the
  demo), `get_attachments`, `get_inbox_document` (PDF text per page and
  the scan note, an image as an image; the real `documentUrl` passed the
  host allowlist and pdf.js works in the Lambda), `create_invoice`
  (including a line without a product) and `register_payment`.
- Not verifiable in the demo company: `send_invoice` (Fiken refuses: the
  demo company has hit its 101-document sending cap) and credit notes
  (Fiken answers 409: the credit note counter is not initialized;
  creating one credit note in Fiken's UI, or the counter operation
  planned next, fixes it).
- Attaching to an invoice needed the connector removed and re-added in
  Claude Code; re-authenticating kept the old tool schema cached.
- The first request after a deploy took about 1.7 s (cold start with the
  5.1 MB bundle).

Verified 2026-10-03 (from Claude Code, against the demo company):

- `get_counters` in the demo company produced a 401 on the counter
  endpoint with a valid login (the next call, `list_bank_accounts`,
  worked with the same token). Before the fix this made `/mcp` answer
  HTTP 401 and Claude Code asked to re-authenticate; now `GET /user`
  confirms the login and the call is a tool error with Fiken's message.
- `create_purchase_draft` and `create_purchase_from_draft` worked
  (purchase 14463007170, the lineId was returned).
- `create_accrual` on that line with account 1700 over 3 periods worked
  (numeric id returned).
- `settle_sale` with `settledDate` worked (sale 14381053880).
- `update_contact` keeps the phone number, the contact persons, the
  currency and the member number: after an email-only update, Fiken's UI
  still showed currency EUR, member number M-42, the phone number and the
  contact person on "fiken-mcp testkunde" (id 14462705276).
- `update_invoice_draft` replaces the lines (two lines stay two), and
  `create_invoice_from_draft` then issued invoice 10521.
- `create_product` and `update_product` keep the other fields.
- `list_offers`, `list_recurring_invoices` and `list_ehf_documents` read
  fine.
- Time tracking and projects answered 402 in the demo company until Jonas
  activated both modules the same day. Then `create_project` (MCP-1,
  "fiken-mcp testprosjekt", id 14444164210) and `update_project`
  (description only) worked, and `create_purchase` with that `projectId`
  booked purchase 14463888319 on the project. `list_time_users` and
  `list_time_entries` read fine; `list_activities` was empty, which
  showed the connector could not create an activity (fixed by
  `create_activity`).
- After #34: `create_activity` ("fiken-mcp konsulenttimer", 1 200 kr per
  hour, billable, on the test project), `create_time_entry` (2 hours,
  entry 14451860850) and `create_invoice_draft_from_time_entries` worked:
  draft 14464113093 has one line of 2 hours at 1 200 kr (2 400 kr net,
  3 000 kr gross) on the project.
- `create_journal_entry` booked correctly (transaction 14462737897,
  journal entry 52), but its read-back failed: the Location of
  `POST /generalJournalEntries` is the transaction id, not a journal entry
  id. It now reads back with `GET /transactions/{id}`.
- `create_sale` as a cash sale failed with `Missing field 'totalPaid' for
  sale marked as paid in NOK`. It now sends `totalPaid` (the sum of
  `netPrice + vat` over the lines).
- `get_counters` hit the endpoint-401 bug fixed in 310c933.
- After #31 deployed: the counter 401 came back as a tool error with
  Fiken's message, no re-login. That message showed Fiken answers 401
  (not 404 or 409) with "Company credit note counter not initialized" for
  a series that was never started; `get_counters` and
  `initialize_counter` now read that as "not started".
- After #31: a cash sale worked (sale 14463888105, settled, totalPaid
  12500), also with `paymentFee` 1500 (sale 14463888114; Fiken accepted
  the gross as totalPaid and booked the fee as a second payment), and
  `create_journal_entry` read back through the transaction (journal
  entry 58, transaction 14463730530).
- After #32: `get_counters` showed the invoice series (current 10523,
  next 10524) and the credit note series as not started;
  `initialize_counter` credit_note with firstNumber 10001 started it, and
  a full `create_credit_note` on invoice 10521 got credit note number
  10001, confirming the counter semantics. A second `initialize_counter`
  was refused ("already exists (current value 10001, next number
  10002)").
- A `%2C` in an option path reaches the server decoded, so the challenge
  and metadata show a plain comma. Write the option path with plain
  commas.
- User-facing paths checked in a browser. In Fiken, the user menu's
  Rediger konto opens Brukerinnstillinger: the API tab lists the "Fiken
  MCP" app (status Utvikling, at most 5 users), and the Sikkerhet tab's
  "Apper du har gitt tilgang til" is where a user revokes it (it was
  wrongly documented under API). Add-on modules, including the API
  module, are ordered under Foretak, Tilleggstjenester. In Claude,
  Settings, Connectors now points to Customize, Connectors; Add, Add
  custom connector asks only for a name and a URL. A connector's menu
  has "Refresh tools list", which loaded the new tool list without
  re-adding. The ChatGPT path was not checked: the browser extension
  has no access to chatgpt.com.

## Verify after deploying the usage-and-cimd plan

- `curl https://api.fiken-mcp.byjoba.com/stats` shows `totalUsers` and
  this month's counters after a few tool calls.
- `my_usage` in Claude matches what `/stats` reports for your own calls.
- A CIMD login from Claude shows a consent page naming Claude. Claude's
  Add custom connector dialog (checked 2026-10-03) has only a name and a
  URL, with no identity option, so this is up to Claude's client.
- Revoking "Fiken MCP" in Fiken and then calling a tool makes Claude
  re-authenticate instead of showing an error.

## Verify after deploying the remaining-tools plan

Do all of this against the demo company.

- Reads: `list_sales`, `list_products`, `account_balances` (date plus a
  range such as 3000-3999), `bank_balances`, `get_journal_entries`.
- `create_invoice_draft`, then `create_invoice_from_draft`, to a test
  customer. Check whether an invoice line without `productId` is
  accepted with `description` alone or Fiken also wants `productName`.
  Check that `create_invoice_from_draft` (and `create_invoice`) get a
  Location header back from Fiken; without one the tool reports the
  invoice as most likely created and does not read it back.
- `send_invoice` with `method: ["email"]` and `recipientEmail` set to your
  own address (`auto` may choose EHF for a customer with an organisation
  number).
- A full `create_credit_note` on that invoice.
- `register_payment` on the sale (get its id from `saleId` on
  `get_invoice`). Payments are NOK-only; a sale or purchase in another
  currency is registered in Fiken itself.
- `attach_inbox_document` to the invoice (it gets a copy; the document
  stays in the inbox), then `get_attachments` on the invoice.
- `get_inbox_document` on a PDF and a photo mailed to the company's inbox
  address. Confirm what `documentUrl` looks like for a real inbox
  document (host `fiken.no` or `api.fiken.no`). A refusal saying
  "refusing to fetch a URL outside the Fiken API" means Fiken uses a
  third host and `fikenFileBaseUrl` needs changing.
- Check a cold start's Init Duration in CloudWatch for the Lambda. The
  bundle grew from 1.5 MB to 5.1 MB with pdf.js (about 135 ms to load
  locally).
- Expect a few unstructured pdf.js warnings about `@napi-rs/canvas` or
  `DOMMatrix` on the first PDF per container. They are harmless and
  carry no document content.

## Verify after deploying the operations plan

- Refresh the tool list in Claude (Customize, Connectors, the connector,
  "Refresh tools list"; tool lists are cached) and check the new list: the hot-path tools, `upload_receipts`,
  `get_upload_url`, `fiken_explore`, `fiken_read`, `fiken_write`.
- Ask Claude to "send invoice 10042" and confirm it explores first, then
  uses `fiken_write` with a confirmation. For any email test, use an
  address at jonasbj.com (Jonas's catch-all) as recipient, in a real
  company.
- Add a second connector with `/mcp/readonly` in Claude, confirm login
  works and no write tool appears (no `fiken_write`, no upload tools).
- Run the receipts flow on a phone and confirm it still needs no
  `fiken_explore`.
- `curl -i https://api.fiken-mcp.byjoba.com/mcp/invoices%2Csales` without
  a token: expect 401, and check that `resource_metadata` in the
  `WWW-Authenticate` header still shows `%2C`. That confirms API Gateway
  passes the raw path through.

## Verify after deploying the coverage plan

Refresh the connector's tool list first (tool lists are cached). Use the demo company
unless noted, and any email recipient at jonasbj.com.

- `get_counters`. If the credit note series is missing, run
  `initialize_counter` with kind `credit_note` and `firstNumber` 10001,
  then a full `create_credit_note` on invoice 10520 (id 14380891529).
  Confirm that this first credit note gets number 10001 (not 10002), which
  checks that the counter holds the last number used.
- `create_activity`, then `create_time_entry` and
  `create_invoice_draft_from_time_entries`: time tracking has to work in a
  company that has no activities yet.
- A cash sale (`create_sale`); a manual journal entry
  (`create_journal_entry`): confirm the read-back via the transaction
  works (verified 2026-10-03); a purchase draft approved in Fiken's UI,
  then `create_purchase_from_draft` on another one.
- A cash sale with a `paymentFee`: confirm Fiken accepts `totalPaid` as
  the gross without the fee.
- Two `create_purchase_draft` drafts with `paid: true`: approve one in
  Fiken's UI and the other with `create_purchase_from_draft`. For each,
  note whether Fiken records the payment or refuses the draft.
- `create_accrual` on a purchase line with `account` 1700: confirm Fiken
  books it on that account (the swagger's text calls `account` required
  although its schema does not list it, so the operation requires it), and
  whether the Location's last segment is numeric so `accrualId` comes back.
- `settle_sale` with a `settledDate` on an unsettled external_invoice sale,
  then `get_sale` shows it settled. `write_off_sale` only on a sale that
  meets one of the reasons (for example past due at least 6 months with 3
  reminders sent), in the demo company only; expect Fiken to refuse
  otherwise.
- `update_contact` on a test contact that has a phone number, a currency,
  a member number, a contact person and a group set in Fiken: change only
  the email, then check in Fiken that all five are unchanged. This decides
  whether the contact person must be sent back and whether the
  phone-number caveat in the description holds.
- `update_invoice_draft`: change only `invoiceText` on a draft with lines
  and a project; confirm in Fiken that lines, customer and project are
  unchanged. This confirms PUT replaces lines rather than appending.
- `create_project`, `update_project`, `create_product` and
  `update_product` (stock unchanged).
- Offers, order confirmations and sending: only in a real company; send to
  a jonasbj.com address with `method: ["email"]`.

## Verify after deploying the website plan

- `https://fiken-mcp.byjoba.com` loads over HTTPS; `http://` redirects.
- The counters fill in and match `curl https://fiken-mcp.byjoba.com/stats`
  (same JSON as `https://api.fiken-mcp.byjoba.com/stats`).
- «Vis e-postadressen» shows the address as a mail link with the subject
  «Tilgang til Fiken MCP».
- «Kopier» copies the connector URL.
- `curl -sI https://fiken-mcp.byjoba.com/` shows the CSP,
  `strict-transport-security`, `x-content-type-options`,
  `referrer-policy` and `x-frame-options` headers.
- `https://fiken-mcp.byjoba.com/nope` shows the Norwegian 404 page with
  status 404.
- The browser console shows no CSP violations.
- A later merge touching only `web/` runs only the content step (sync and
  invalidation, no stack), and a docs-only merge asks for no approval.
- If the first `fiken-mcp-web` create fails with AccessDenied on a
  CloudFront action such as `cloudfront:CreateConnectionGroup` or
  `cloudfront:GetVpcOrigin` (listed among CreateDistribution's related
  actions in AWS's service authorization reference), add it to the
  `CloudFrontCreate` statement in `iac/lib/exec-policy.ts`. The bucket is
  not retained on a failed create, so the retry is clean.

## Verify after deploying the Fiken help plan

Do all of this against the demo company.

- `fiken_help_index { query: "utlegg" }` returns titles and slugs of help
  articles; the result should include "Hvordan registrere ansattutlegg".
- `fiken_help_article { slug: "hvordan-registrere-ansattutlegg" }` returns
  the article as Markdown with the connector notes appended.
- Claude shows the instructions behaviour: when you describe something that
  looks like an employee outlay, Claude asks to look it up in Fiken's help
  first.
- First read an existing purchase's journal entry with 25 % VAT on the demo
  company (`get_journal_entries`) and note the vatCode Fiken used on the
  expense line.
- Then `create_journal_entry` with lines
  `[{ amount: 100000, debitAccount: "6540", debitVatCode: <that code> }, { amount: 125000, creditAccount: "2911" }]`
  and check the read-back: expense 6540 1 000,00, input VAT 250,00 on
  Fiken's input-VAT account, 2911 1 250,00. Record the code and Fiken's
  postings here.
- Then the same with credit amount 120000 and confirm Fiken refuses it
  (unbalanced).
- Then a two-sided line
  `{ amount: 125000, debitAccount: "6540", debitVatCode: <code>, creditAccount: "1920:<bank sub-account>" }`,
  and the same with a `creditVatCode` too. Record which amount Fiken took
  as net or gross and the postings it made.
- Record the outcome in this file; if Fiken's postings differ from the
  expectation, the connector note and the field descriptions must be
  corrected before anyone books outlays.

Verified 2026-10-05 (after deploying #44, from Claude Code, demo company):

- The connect-time instructions reached Claude Code. `fiken_help_index
  { query: "utlegg" }` returned four articles; `fiken_help_article
  hvordan-registrere-ansattutlegg` returned the article with source, last
  updated, the reference line and the connector notes. (Cosmetic: the
  title appears twice, from our header and the article's own heading.)
- Existing bookings show VAT code 1 on 25 % purchases (VAT on 2711) and
  code 3 on 25 % sales (VAT on 2701).
- One-sided lines, debit 6540 100 000 øre with `debitVatCode` 1 and credit
  2911 125 000 øre: 6540 1 000,00, 2711 250,00, 2911 −1 250,00 (journal
  entry 61). 2911 needs no sub-account.
- The same with credit 120 000 øre: Fiken refused it with «Summen av
  posteringslinjene er ikke null: 50,00».
- Two-sided line, 125 000 øre, debit 6540 with code 1, credit 1920:10001:
  6540 1 250,00, 2711 312,50, bank −1 562,50 (journal entry 62). The amount
  is net on the side with the code.
- Two-sided line, 100 000 øre, debit 6540 code 1, credit 3020 code 3: 6540
  1 000,00 + 2711 250,00, 3020 −1 000,00 + 2701 −250,00 (journal entry 63).
  Net on both sides, each with its own VAT.
- Rule now in the field descriptions, the connector note and README: on a
  side with a VAT code the amount is net and Fiken adds the VAT; a side
  without a code takes the amount as given. The three test entries remain
  in the demo company (the connector cannot delete).

Verified 2026-10-04 (after deploying #38):

- The first deploy ran all three stacks, iac first (`deploy.yml` changed,
  so the changes job set every flag). `fiken-mcp-web` was created on the
  first try; no CloudFront AccessDenied.
- `https://fiken-mcp.byjoba.com` answers 200 with the CSP, HSTS (one
  year, include subdomains), `nosniff`, `no-referrer` and `DENY` headers;
  `http://` answers 301 to HTTPS.
- `/site.js`, `/style.css`, `/icon.png` (from `api/src/assets`) and
  `/404.html` are served with the right content types; `/upload.html` is
  404, so only the icon ships from the API's assets folder.
- `/nope` answers 404 with the Norwegian page.
- `/stats` on the site matches the API's byte for byte and is a
  CloudFront cache hit with `max-age=300`.
- In Chrome: the counters filled (1 user, 1 active, 45 calls in
  oktober), «Vis e-postadressen» revealed the mail link with the subject
  «Tilgang til Fiken MCP», «Kopier» is shown, and the console had no CSP
  violations.
- Then observed: the docs-only merge of #39 skipped the deploy job (no
  approval asked), and #40 (web/ and README) set only the web flag, which
  at the time meant the `fiken-mcp-web` stack. Since the site-sync change
  a web-only merge runs only the content step.

## Verify after deploying the widgets plan

Do all of this against the demo company, in Claude (web and iOS) and then
in Claude Code.

- Ask «Hvilket foretak?» (with more than one company): Claude shows
  buttons (`ask_user_choice`), and a click fills the chat with the answer.
- Ask Claude to book a journal entry: it shows the preview
  (`preview_booking`) with «Før dette» and «Endre»; «Før dette» makes the
  write, «Endre» goes back to the conversation. Nothing is written before.
- Ask for a short form («Jeg trenger dato, beløp og beskrivelse»): the form
  (`ask_user_form`) fills in the suggested values, and «Send» puts the
  answers in the chat as one message.
- Ask for the latest invoices or the inbox: a table (`show_table`) with the
  row buttons; a click sends its message and disables only that row.
- Ask to see an inbox document (and an attachment from `get_attachments`):
  the image or the PDF with «Forrige» / «Neste» (`show_document`). A file
  over 4 MiB is refused with a short message.
- In Claude Code: each widget tool answers with a numbered list or a
  Markdown table instead, and the model waits for the answer in the chat.
- Check the instructions behaviour: Claude uses the widget tools instead
  of asking the same question in text.

## Site content deploy (2026-10-04)

The site's files no longer go through CloudFormation. The `BucketDeployment`
in `fiken-mcp-web` (a custom resource Lambda plus an AWS CLI layer) is gone;
the deploy workflow's `content` step runs `aws s3 sync web/ --delete
--exclude icon.png`, copies `api/src/assets/icon.png` and invalidates
CloudFront. The web stack holds only the bucket, the distribution and the
response headers, and exports `fiken-mcp-web-distribution-id` and
`fiken-mcp-web-distribution-domain-name`. The deploy role
(`fiken-mcp-github-deploy`) got the rights for this: list, put and delete on
the site bucket, `CreateInvalidation`/`GetInvalidation`, and
`cloudformation:DescribeStacks` on the web stack (to read `DistributionId`).
The execution policy has a matching `StackOutputsRead` statement because it
bounds the deploy role.

It ships in two PRs, because the workflow deploys iac before web and a Route
53 record cannot be created while another stack still owns it:

1. PR A removes the BucketDeployment and the apex A/AAAA records from the web
   stack and adds the content step and the deploy role rights. The live
   objects stay in the bucket (the custom resource's delete retains them).
   `SiteLayer` stayed in the execution policy so CloudFormation could delete
   the layer.
2. PR B moves the alias records to the iac stack (importing the exports),
   narrows the invalidation right to the imported distribution and drops
   `SiteLayer` (the layer is gone).

The site is unreachable from PR A's deploy until PR B's deploy (no DNS
records in between). Jonas accepted that. The first content step also
populates the bucket again from git.

Merge PR B only after PR A's deploy run is green. If it failed or was
rejected, its changes are still undeployed, PR B's run would deploy iac
before the web stack has the exports, and the iac step would fail. Before
merging PR B, check with `--profile byjoba`:

- `aws cloudformation list-exports` lists both `fiken-mcp-web-*` exports.
- `aws route53 list-resource-record-sets --hosted-zone-id Z04810525CNVQNP7ALNV`
  has no A or AAAA record for `fiken-mcp.byjoba.com.`.
- `aws lambda list-layer-versions --layer-name fiken-mcp-web-awscli
  --region eu-west-1` is empty (a delete that failed in the cleanup phase
  leaves the stack green; once PR B drops `SiteLayer` an orphaned layer can
  only be removed by hand).

Verify after PR B's deploy:

- `dig +short A fiken-mcp.byjoba.com` and `dig +short AAAA
  fiken-mcp.byjoba.com` return CloudFront addresses.
- `curl -sI https://fiken-mcp.byjoba.com/` answers 200 with the security
  headers, and `/stats` matches the API's.
- The deploy role's policy (`DeployRoleDefaultPolicy` in `fiken-mcp-iac`)
  names the concrete distribution ARN for the invalidation statement.
- A later merge touching only `web/` runs only the content step.
