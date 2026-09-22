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

## GitHub (jonasbarsten/fiken-mcp)

1. Settings, Environments, New environment `production`:
   required reviewers: jonasbarsten; deployment branches: `main` only.
2. Settings, Secrets and variables, Actions, Variables:
   `AWS_DEPLOY_ROLE_ARN` = the DeployRoleArn output.
3. Settings, Branches, rule for `main`: require a pull request, require 1
   approving review, require review from code owners, require status
   check `check`, block direct pushes, include administrators.
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

- Delete `spike/` in the same PR that ships the real widget, or earlier.

## First deploy

Merge the first PR to `main`, approve the `production` deployment when
GitHub asks, and watch the `deploy` workflow. Certificate validation can
take a few minutes on the first run.
