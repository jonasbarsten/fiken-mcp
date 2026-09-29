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
