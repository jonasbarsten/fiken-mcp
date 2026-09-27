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
2. Bootstrap and first deploy, from `iac/`, in this order:
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
3. Every future `cdk bootstrap` for qualifier `fikenmcp` (CDK upgrades,
   re-bootstraps) must repeat
   `--cloudformation-execution-policies arn:aws:iam::209479295726:policy/fiken-mcp-cfn-exec`.
   Without the flag the bootstrap template's default puts
   AdministratorAccess back on the execution role, silently.

### First deploy: things that may bite

- The execution role reads `/cdk-bootstrap/fikenmcp/version` in SSM
  when CloudFormation checks the bootstrap version. The `Parameters`
  statement in `iac/lib/exec-policy.ts` covers
  `parameter/cdk-bootstrap/fikenmcp/*`; a test pins it.
- The execution policy can only request an ACM certificate that carries
  the `Project=fiken-mcp` tag. The api app tags everything it creates,
  so the certificate should be tagged; if certificate creation fails
  with AccessDenied, check that tag first.
- Changes to `iac/lib/exec-policy.ts` or to the deploy role's trust
  policy are applied by the same CloudFormation execution role they
  govern. Review such pull requests with extra care: the `production`
  approval and CODEOWNERS are the controls.

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
`https://fiken-mcp.byjoba.com/callback`. Add each tester's Fiken login
under "Godkjente brukere" while the app is in development status.

## Before the first production deploy

- `spike/` was deleted in the foundation pull request. Its code and
  manual test protocol remain in git history at commit `c8dd493`.

## First deploy

Merge the first PR to `main`, approve the `production` deployment when
GitHub asks, and watch the `deploy` workflow. Certificate validation can
take a few minutes on the first run.
