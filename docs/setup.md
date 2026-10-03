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
   output.
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
- `update_contact` keeps the phone number and the contact persons.
  Currency and member number are pending a look in Fiken's UI at contact
  "fiken-mcp testkunde" (id 14462705276): expected currency EUR, member
  number M-42.
- `update_invoice_draft` replaces the lines (two lines stay two), and
  `create_invoice_from_draft` then issued invoice 10521.
- `create_product` and `update_product` keep the other fields.
- `list_offers`, `list_recurring_invoices` and `list_ehf_documents` read
  fine.
- Time tracking and projects answer 402 in the demo company (the modules
  are not activated).
- `create_journal_entry` booked correctly (transaction 14462737897,
  journal entry 52), but its read-back failed: the Location of
  `POST /generalJournalEntries` is the transaction id, not a journal entry
  id. It now reads back with `GET /transactions/{id}`.
- `create_sale` as a cash sale failed with `Missing field 'totalPaid' for
  sale marked as paid in NOK`. It now sends `totalPaid` (the sum of
  `netPrice + vat` over the lines).
- `get_counters` hit the endpoint-401 bug fixed in 310c933.
- A `%2C` in an option path reaches the server decoded, so the challenge
  and metadata show a plain comma. Write the option path with plain
  commas.

## Verify after deploying the usage-and-cimd plan

- `curl https://api.fiken-mcp.byjoba.com/stats` shows `totalUsers` and
  this month's counters after a few tool calls.
- `my_usage` in Claude matches what `/stats` reports for your own calls.
- In Claude's connector settings, "Use Claude's published identity" logs
  in and the consent page names Claude.
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

- Remove and re-add the connector in Claude (tool lists are cached) and
  check the new list: the hot-path tools, `upload_receipts`,
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

Re-add the connector first (tool lists are cached). Use the demo company
unless noted, and any email recipient at jonasbj.com.

- `get_counters`. If the credit note series is missing, run
  `initialize_counter` with kind `credit_note` and `firstNumber` 10001,
  then a full `create_credit_note` on invoice 10520 (id 14380891529).
  Confirm that this first credit note gets number 10001 (not 10002), which
  checks that the counter holds the last number used.
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
