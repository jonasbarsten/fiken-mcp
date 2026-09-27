# Fiken MCP Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deployed MCP server at `https://fiken-mcp.byjoba.com/mcp` that Claude can add as a custom connector, log into with Fiken through a consent step, and call `list_companies` on.

**Architecture:** One Lambda behind an HTTP API serves OAuth discovery, allowlisted dynamic client registration, a consent page, a stateless authorize/callback/token flow that wraps Fiken's tokens in encrypted one-hour blobs, and a stateless MCP Streamable HTTP endpoint. A separate `iac` stack holds the DynamoDB usage table, the GitHub OIDC deploy role, and the scoped CloudFormation execution policy that also serves as the permissions boundary. Both stacks use their own CDK bootstrap qualifier. Nothing is stored per user.

**Tech Stack:** TypeScript, Node 24, Hono 4 (`hono/aws-lambda`, `hono/secure-headers`), `@modelcontextprotocol/server` 2, zod 4, AWS CDK 2 (`aws-cdk-lib` 2.270), vitest 5, esbuild via `NodejsFunction`, `@aws-sdk/client-ssm` 3.

**Spec:** `docs/superpowers/specs/2026-09-22-fiken-mcp-design.md` (sections 4, 5, 7, 7b and the CI/CD part of 4 are implemented here; sections 6, 8 and 9 are later plans). Read the security review section of the decision record too.

## Global Constraints

- Store no user data. No tokens, files or accounting data written anywhere. Only the usage table (created here, written to in plan 2).
- Secrets only in Parameter Store SecureStrings `/fiken_mcp/client_id`, `/fiken_mcp/client_secret`, `/fiken_mcp/signing_key`, `/fiken_mcp/user_salt`. Never in code, env vars, or the CloudFormation template. Load the `aws-secrets-manager` skill before touching secret handling; never fetch secret values into context.
- Never log a header, body, token, parameter value, Fiken response body or the `/user` response. Structured JSON logs only.
- All Fiken calls go through `fikenFetch` (one in-process queue, 300 ms gap, one retry on 429). Lambda reserved concurrency 1.
- Region `eu-west-1`, account `209479295726`, profile `byjoba`, domain `fiken-mcp.byjoba.com`, hosted zone `byjoba.com` id `Z04810525CNVQNP7ALNV`. CDK bootstrap qualifier `fikenmcp` for both stacks.
- Public repo `jonasbarsten/fiken-mcp`. Feature branches and PRs; never push to `main`. Never run `cdk deploy` or `cdk bootstrap` from a developer machine except the documented one-off steps in `docs/setup.md`, which Jonas runs himself.
- Never modify files through shell commands (no heredocs, `sed -i`, redirects). Use the editor tools.
- Every file change that touches `package.json` or a workflow must use the exact versions and commit SHAs listed in Task 1 and Task 14; they were verified against the registries on 2026-09-22.
- Amounts from Fiken are integers in øre; pass them through unchanged.
- Commit after every task with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## File structure

```
package.json                     npm workspaces: api, iac; root scripts
tsconfig.base.json               shared compiler options
.github/workflows/ci.yml         typecheck + test + synth on PRs and pushes
.github/workflows/deploy.yml     cdk deploy from the production environment
.github/dependabot.yml           npm and actions updates
CODEOWNERS                       Jonas reviews infra and workflows
iac/
  package.json  cdk.json  tsconfig.json
  bin/iac.ts                     CDK app entry (qualifier fikenmcp)
  lib/iac-stack.ts               table, GitHub OIDC provider, deploy role, scoped exec policy / boundary
  test/iac-stack.test.ts         CDK assertions
api/
  package.json  cdk.json  tsconfig.json  vitest.config.ts
  bin/api.ts                     CDK app entry (qualifier fikenmcp)
  lib/api-stack.ts               Lambda, HTTP API + stage throttling + access logs, domain, SSM grants
  src/lambda.ts                  Lambda entry: handle(app)
  src/app.ts                     builds the Hono app from a Config; security headers
  src/config.ts                  Config type, env + Parameter Store loader, key ring parsing
  src/log.ts                     structured logger that refuses secrets
  src/crypto/blob.ts             signed and encrypted blobs with kid and expiry
  src/crypto/pkce.ts             S256 verification
  src/auth/anon.ts               anonymous user id
  src/auth/clients.ts            redirect URI allowlist
  src/auth/tokens.ts             wrap/unwrap our access and refresh tokens; refresh reuse
  src/auth/consent.ts            consent page HTML
  src/auth/routes.ts             discovery, register, consent, authorize, callback, token
  src/fiken/client.ts            fikenFetch: queue, retry, errors
  src/fiken/oauth.ts             code exchange, refresh, current user
  src/fiken/types.d.ts           generated from the Fiken swagger
  src/mcp/server.ts              McpServer factory bound to a user token
  src/mcp/tools/companies.ts     list_companies
  src/mcp/routes.ts              /mcp route: bearer check, transport
  test/                          one test file per src module
```

Interfaces that cross tasks are spelled out in each task's **Interfaces** block. Names are final; later tasks depend on them.

---

### Task 1: Repository scaffolding and toolchain

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `api/package.json`, `api/tsconfig.json`, `api/vitest.config.ts`, `api/cdk.json`, `iac/package.json`, `iac/tsconfig.json`, `iac/cdk.json`
- Modify: `.gitignore`
- Test: `api/test/smoke.test.ts`

**Interfaces:**
- Produces: root scripts `npm run typecheck`, `npm test`, `npm run synth`; workspace layout every later task assumes.

- [ ] **Step 1: Root package.json**

```json
{
  "name": "fiken-mcp",
  "private": true,
  "workspaces": ["api", "iac"],
  "engines": { "node": ">=24" },
  "scripts": {
    "typecheck": "npm run typecheck --workspaces",
    "test": "npm test --workspaces",
    "synth": "npm run synth --workspaces"
  }
}
```

- [ ] **Step 2: tsconfig.base.json**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "noUncheckedIndexedAccess": true,
    "types": ["node"]
  }
}
```

- [ ] **Step 3: api/package.json**

```json
{
  "name": "@fiken-mcp/api",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "synth": "cdk synth --quiet",
    "gen:fiken-types": "openapi-typescript https://api.fiken.no/api/v2/docs/swagger.yaml -o src/fiken/types.d.ts"
  },
  "dependencies": {
    "@aws-sdk/client-ssm": "3.1137.0",
    "@modelcontextprotocol/server": "2.0.0",
    "hono": "4.13.8",
    "zod": "4.6.5"
  },
  "devDependencies": {
    "@modelcontextprotocol/client": "2.0.0",
    "@types/aws-lambda": "8.10.163",
    "@types/node": "24.13.6",
    "aws-cdk": "2.1142.0",
    "aws-cdk-lib": "2.270.0",
    "constructs": "10.8.1",
    "esbuild": "0.28.2",
    "openapi-typescript": "7.13.0",
    "tsx": "4.23.15",
    "typescript": "7.0.2",
    "vitest": "5.0.1"
  }
}
```

If `tsc --noEmit` from TypeScript 7 rejects the project for a reason unrelated to our code, pin `typescript` to `5.9.3` in both workspaces and say so in the commit message.

- [ ] **Step 4: api/tsconfig.json, api/vitest.config.ts, api/cdk.json**

`api/tsconfig.json`:
```json
{
  "extends": "../tsconfig.base.json",
  "include": ["src", "lib", "bin", "test"]
}
```

`api/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
});
```

`api/cdk.json`:
```json
{
  "app": "npx tsx bin/api.ts"
}
```

- [ ] **Step 5: iac/package.json, iac/tsconfig.json, iac/cdk.json**

`iac/package.json`:
```json
{
  "name": "@fiken-mcp/iac",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "synth": "cdk synth --quiet"
  },
  "devDependencies": {
    "@types/node": "24.13.6",
    "aws-cdk": "2.1142.0",
    "aws-cdk-lib": "2.270.0",
    "constructs": "10.8.1",
    "tsx": "4.23.15",
    "typescript": "7.0.2",
    "vitest": "5.0.1"
  }
}
```

`iac/tsconfig.json`:
```json
{
  "extends": "../tsconfig.base.json",
  "include": ["lib", "bin", "test"]
}
```

`iac/cdk.json`:
```json
{
  "app": "npx tsx bin/iac.ts"
}
```

- [ ] **Step 6: .gitignore**

Replace the file's content with:
```
node_modules/
cdk.out/
dist/
.env
*.log
.DS_Store
```

- [ ] **Step 7: Smoke test**

`api/test/smoke.test.ts`:
```ts
import { describe, expect, it } from "vitest";

describe("toolchain", () => {
  it("runs tests", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 8: Install and run**

Run: `npm install` then `npm test`
Expected: the smoke test passes in the api workspace; iac reports no test files (fine until Task 2).

Run: `npm run typecheck`
Expected: passes.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "Scaffold npm workspaces for api and iac

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: iac stack: usage table, GitHub OIDC, deploy role, scoped execution policy

**Files:**
- Create: `iac/bin/iac.ts`, `iac/lib/iac-stack.ts`, `iac/lib/exec-policy.ts`
- Test: `iac/test/iac-stack.test.ts`

**Interfaces:**
- Produces: CloudFormation exports `fiken-mcp-usage-table-name` and `fiken-mcp-usage-table-arn` (plan 2), outputs `DeployRoleArn` and `ExecPolicyArn` (Task 14 and `docs/setup.md`). Managed policy name `fiken-mcp-cfn-exec` is referenced by the bootstrap command and by the api stack's permissions boundary.
- Both CDK apps use `new DefaultStackSynthesizer({ qualifier: "fikenmcp" })`.

- [ ] **Step 1: Write the failing test**

`iac/test/iac-stack.test.ts`:
```ts
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { IacStack } from "../lib/iac-stack.js";
import { synthesizer } from "../lib/synthesizer.js";

function synth() {
  const app = new App();
  const stack = new IacStack(app, "fiken-mcp-iac", {
    env: { account: "209479295726", region: "eu-west-1" },
    synthesizer: synthesizer(),
  });
  return Template.fromStack(stack);
}

describe("IacStack", () => {
  it("creates the usage table with PK/SK, on-demand billing and retain", () => {
    const t = synth();
    t.hasResourceProperties("AWS::DynamoDB::GlobalTable", {
      TableName: "fiken-mcp-usage",
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [
        { AttributeName: "PK", KeyType: "HASH" },
        { AttributeName: "SK", KeyType: "RANGE" },
      ],
    });
    t.hasResource("AWS::DynamoDB::GlobalTable", { DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain" });
  });

  it("creates the GitHub OIDC provider", () => {
    synth().hasResourceProperties("Custom::AWSCDKOpenIdConnectProvider", {
      Url: "https://token.actions.githubusercontent.com",
      ClientIDList: ["sts.amazonaws.com"],
    });
  });

  it("pins the deploy role to the repo's production environment and the fikenmcp bootstrap roles", () => {
    const t = synth();
    t.hasResourceProperties("AWS::IAM::Role", {
      RoleName: "fiken-mcp-github-deploy",
      AssumeRolePolicyDocument: {
        Statement: [
          {
            Action: "sts:AssumeRoleWithWebIdentity",
            Effect: "Allow",
            Condition: {
              StringEquals: {
                "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
                "token.actions.githubusercontent.com:sub": "repo:jonasbarsten/fiken-mcp:environment:production",
              },
            },
          },
        ],
      },
    });
    t.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: [
          {
            Action: "sts:AssumeRole",
            Effect: "Allow",
            Resource: "arn:aws:iam::209479295726:role/cdk-fikenmcp-*-role-209479295726-eu-west-1",
          },
        ],
      },
    });
  });

  it("creates the scoped execution policy and uses it as the boundary on every role", () => {
    const t = synth();
    t.hasResourceProperties("AWS::IAM::ManagedPolicy", {
      ManagedPolicyName: "fiken-mcp-cfn-exec",
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(["iam:CreateRole", "iam:PutRolePolicy"]),
            Condition: {
              StringEquals: {
                "iam:PermissionsBoundary": "arn:aws:iam::209479295726:policy/fiken-mcp-cfn-exec",
              },
            },
          }),
        ]),
      },
    });
    const roles = t.findResources("AWS::IAM::Role");
    expect(Object.keys(roles).length).toBeGreaterThan(0);
    for (const role of Object.values(roles)) {
      expect(role.Properties.PermissionsBoundary).toBeDefined();
    }
  });

  it("exports the table and outputs the arns", () => {
    const t = synth();
    t.hasOutput("UsageTableName", { Export: { Name: "fiken-mcp-usage-table-name" } });
    t.hasOutput("UsageTableArn", { Export: { Name: "fiken-mcp-usage-table-arn" } });
    t.hasOutput("DeployRoleArn", {});
    t.hasOutput("ExecPolicyArn", {});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd iac && npx vitest run`
Expected: FAIL, cannot find `../lib/iac-stack.js`.

- [ ] **Step 3: Implement the synthesizer helper and the policy**

`iac/lib/synthesizer.ts`:
```ts
import { DefaultStackSynthesizer } from "aws-cdk-lib";

export const QUALIFIER = "fikenmcp";

export function synthesizer(): DefaultStackSynthesizer {
  return new DefaultStackSynthesizer({ qualifier: QUALIFIER });
}
```

`iac/lib/exec-policy.ts`:
```ts
import * as iam from "aws-cdk-lib/aws-iam";

export const EXEC_POLICY_NAME = "fiken-mcp-cfn-exec";
export const ZONE_ID = "Z04810525CNVQNP7ALNV";

/**
 * What CloudFormation may do when deploying fiken-mcp stacks, and the
 * permissions boundary on every role those stacks create. Everything is
 * pinned to the fiken-mcp-* name prefix, the byjoba.com zone, the
 * fikenmcp asset bucket and the /fiken_mcp/* parameters.
 */
export function execPolicyStatements(account: string, region: string): iam.PolicyStatement[] {
  const boundaryArn = `arn:aws:iam::${account}:policy/${EXEC_POLICY_NAME}`;
  return [
    new iam.PolicyStatement({
      sid: "Assets",
      actions: ["s3:GetObject", "s3:GetBucketLocation", "s3:ListBucket"],
      resources: [
        `arn:aws:s3:::cdk-fikenmcp-assets-${account}-${region}`,
        `arn:aws:s3:::cdk-fikenmcp-assets-${account}-${region}/*`,
      ],
    }),
    new iam.PolicyStatement({
      sid: "Lambda",
      actions: ["lambda:*"],
      resources: [`arn:aws:lambda:${region}:${account}:function:fiken-mcp-*`],
    }),
    new iam.PolicyStatement({
      sid: "Logs",
      actions: ["logs:*"],
      resources: [
        `arn:aws:logs:${region}:${account}:log-group:/aws/lambda/fiken-mcp-*`,
        `arn:aws:logs:${region}:${account}:log-group:/aws/apigateway/fiken-mcp-*`,
        `arn:aws:logs:${region}:${account}:log-group:/fiken-mcp/*`,
      ],
    }),
    new iam.PolicyStatement({
      sid: "RolesWithBoundary",
      actions: ["iam:CreateRole", "iam:PutRolePolicy", "iam:AttachRolePolicy", "iam:UpdateRole"],
      resources: [`arn:aws:iam::${account}:role/fiken-mcp-*`],
      conditions: { StringEquals: { "iam:PermissionsBoundary": boundaryArn } },
    }),
    new iam.PolicyStatement({
      sid: "RolesRead",
      actions: [
        "iam:GetRole",
        "iam:DeleteRole",
        "iam:DeleteRolePolicy",
        "iam:DetachRolePolicy",
        "iam:GetRolePolicy",
        "iam:ListRolePolicies",
        "iam:ListAttachedRolePolicies",
        "iam:ListRoleTags",
        "iam:TagRole",
        "iam:UntagRole",
        "iam:UpdateAssumeRolePolicy",
        "iam:PassRole",
      ],
      resources: [`arn:aws:iam::${account}:role/fiken-mcp-*`],
    }),
    new iam.PolicyStatement({
      sid: "Policies",
      actions: [
        "iam:CreatePolicy",
        "iam:DeletePolicy",
        "iam:GetPolicy",
        "iam:CreatePolicyVersion",
        "iam:DeletePolicyVersion",
        "iam:GetPolicyVersion",
        "iam:ListPolicyVersions",
        "iam:SetDefaultPolicyVersion",
        "iam:TagPolicy",
        "iam:UntagPolicy",
      ],
      resources: [`arn:aws:iam::${account}:policy/fiken-mcp-*`],
    }),
    new iam.PolicyStatement({
      sid: "GitHubOidcProvider",
      actions: [
        "iam:CreateOpenIDConnectProvider",
        "iam:DeleteOpenIDConnectProvider",
        "iam:GetOpenIDConnectProvider",
        "iam:UpdateOpenIDConnectProviderThumbprint",
        "iam:AddClientIDToOpenIDConnectProvider",
        "iam:RemoveClientIDFromOpenIDConnectProvider",
        "iam:TagOpenIDConnectProvider",
        "iam:UntagOpenIDConnectProvider",
      ],
      resources: [`arn:aws:iam::${account}:oidc-provider/token.actions.githubusercontent.com`],
    }),
    new iam.PolicyStatement({
      sid: "ApiGateway",
      actions: ["apigateway:*"],
      resources: [`arn:aws:apigateway:${region}::/*`],
    }),
    new iam.PolicyStatement({
      sid: "Certificates",
      actions: [
        "acm:RequestCertificate",
        "acm:DeleteCertificate",
        "acm:DescribeCertificate",
        "acm:AddTagsToCertificate",
        "acm:RemoveTagsFromCertificate",
        "acm:ListTagsForCertificate",
      ],
      resources: ["*"],
    }),
    new iam.PolicyStatement({
      sid: "DnsZone",
      actions: ["route53:ChangeResourceRecordSets", "route53:ListResourceRecordSets", "route53:GetHostedZone"],
      resources: [`arn:aws:route53:::hostedzone/${ZONE_ID}`],
    }),
    new iam.PolicyStatement({
      sid: "DnsRead",
      actions: ["route53:GetChange", "route53:ListHostedZones", "route53:ListHostedZonesByName"],
      resources: ["*"],
    }),
    new iam.PolicyStatement({
      sid: "Dynamo",
      actions: ["dynamodb:*"],
      resources: [
        `arn:aws:dynamodb:${region}:${account}:table/fiken-mcp-*`,
        `arn:aws:dynamodb::${account}:global-table/fiken-mcp-*`,
      ],
    }),
    new iam.PolicyStatement({
      sid: "DynamoRead",
      actions: ["dynamodb:ListTables", "dynamodb:DescribeLimits"],
      resources: ["*"],
    }),
    new iam.PolicyStatement({
      sid: "Parameters",
      actions: ["ssm:GetParameter", "ssm:GetParameters", "ssm:DescribeParameters", "ssm:GetParameterHistory"],
      resources: [`arn:aws:ssm:${region}:${account}:parameter/fiken_mcp/*`],
    }),
    new iam.PolicyStatement({
      sid: "ParameterDecrypt",
      actions: ["kms:Decrypt"],
      resources: ["*"],
      conditions: { StringEquals: { "kms:ViaService": `ssm.${region}.amazonaws.com` } },
    }),
    new iam.PolicyStatement({
      sid: "AssumeBootstrapRoles",
      actions: ["sts:AssumeRole"],
      resources: [`arn:aws:iam::${account}:role/cdk-fikenmcp-*-role-${account}-${region}`],
    }),
  ];
}
```

- [ ] **Step 4: Implement the stack**

`iac/lib/iac-stack.ts`:
```ts
import { CfnOutput, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";
import { EXEC_POLICY_NAME, execPolicyStatements } from "./exec-policy.js";

const GITHUB_REPO = "jonasbarsten/fiken-mcp";
const GITHUB_ENVIRONMENT = "production";

export class IacStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    // Scoped CloudFormation execution policy, also the permissions boundary
    // on every role fiken-mcp stacks create (this stack included).
    const execPolicy = new iam.ManagedPolicy(this, "ExecPolicy", {
      managedPolicyName: EXEC_POLICY_NAME,
      description: "What CloudFormation may do for fiken-mcp stacks; boundary for their roles",
      statements: execPolicyStatements(this.account, this.region),
    });
    iam.PermissionsBoundary.of(this).apply(execPolicy);

    const table = new dynamodb.TableV2(this, "UsageTable", {
      tableName: "fiken-mcp-usage",
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const githubProvider = new iam.OpenIdConnectProvider(this, "GitHubOidc", {
      url: "https://token.actions.githubusercontent.com",
      clientIds: ["sts.amazonaws.com"],
    });

    const deployRole = new iam.Role(this, "DeployRole", {
      roleName: "fiken-mcp-github-deploy",
      description: `Assumed by GitHub Actions in the ${GITHUB_ENVIRONMENT} environment of ${GITHUB_REPO}`,
      assumedBy: new iam.OpenIdConnectPrincipal(githubProvider, {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": `repo:${GITHUB_REPO}:environment:${GITHUB_ENVIRONMENT}`,
        },
      }),
    });
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["sts:AssumeRole"],
        resources: [`arn:aws:iam::${this.account}:role/cdk-fikenmcp-*-role-${this.account}-${this.region}`],
      }),
    );

    new CfnOutput(this, "UsageTableName", { value: table.tableName, exportName: "fiken-mcp-usage-table-name" });
    new CfnOutput(this, "UsageTableArn", { value: table.tableArn, exportName: "fiken-mcp-usage-table-arn" });
    new CfnOutput(this, "DeployRoleArn", { value: deployRole.roleArn });
    new CfnOutput(this, "ExecPolicyArn", { value: execPolicy.managedPolicyArn });
  }
}
```

`iac/bin/iac.ts`:
```ts
import { App } from "aws-cdk-lib";
import { IacStack } from "../lib/iac-stack.js";
import { synthesizer } from "../lib/synthesizer.js";

const app = new App();
new IacStack(app, "fiken-mcp-iac", {
  env: { account: "209479295726", region: "eu-west-1" },
  synthesizer: synthesizer(),
});
```

- [ ] **Step 5: Run tests and synth**

Run: `cd iac && npx vitest run && npx cdk synth --quiet`
Expected: 5 tests pass; synth succeeds without AWS credentials.

- [ ] **Step 6: Commit**

```bash
git add iac
git commit -m "iac stack: usage table, GitHub OIDC, deploy role, scoped exec policy and boundary

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 7: One-off bootstrap and deploy (Jonas, by hand)**

The only commands ever run against AWS from a machine, in this order, from `iac/`:

```bash
# 1. Bootstrap the fikenmcp qualifier (default admin exec policy, once)
npx cdk bootstrap aws://209479295726/eu-west-1 --qualifier fikenmcp --profile byjoba
# 2. Deploy the iac stack: creates the scoped policy, table, OIDC provider, deploy role
npx cdk deploy fiken-mcp-iac --profile byjoba
# 3. Re-bootstrap so CloudFormation runs fiken-mcp stacks under the scoped policy
npx cdk bootstrap aws://209479295726/eu-west-1 --qualifier fikenmcp \
  --cloudformation-execution-policies arn:aws:iam::209479295726:policy/fiken-mcp-cfn-exec \
  --profile byjoba
```

Record the `DeployRoleArn` output; Task 14 needs it. From now on every deploy goes through GitHub.

---

### Task 3: Signed and encrypted blobs with a key ring

**Files:**
- Create: `api/src/crypto/blob.ts`
- Test: `api/test/crypto/blob.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface KeyRing { active: string; keys: Map<string, { sign: Buffer; enc: Buffer }> }
  export function keyRingFromParameter(value: string): KeyRing   // "kid:hex,kid:hex", first active, hex = 64 chars
  export function signBlob(payload: object, ring: KeyRing): string
  export function verifyBlob<T>(blob: string, ring: KeyRing, now?: number): T   // throws BlobError
  export function encryptBlob(payload: object, ring: KeyRing): string
  export function decryptBlob<T>(blob: string, ring: KeyRing, now?: number): T  // throws BlobError
  export class BlobError extends Error { code: "invalid" | "expired" }
  ```
- Blob formats: signed `v1.<kid>.<payload>.<tag>`, encrypted `v1e.<kid>.<iv>.<ciphertext+tag>`. Sub-keys are HKDF-SHA256 of the master with info `sign` and `enc`.

- [ ] **Step 1: Write the failing tests**

`api/test/crypto/blob.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { BlobError, decryptBlob, encryptBlob, keyRingFromParameter, signBlob, verifyBlob } from "../../src/crypto/blob.js";

const ring = keyRingFromParameter(`k1:${"a".repeat(64)}`);
const rotated = keyRingFromParameter(`k2:${"b".repeat(64)},k1:${"a".repeat(64)}`);
const other = keyRingFromParameter(`k1:${"c".repeat(64)}`);

describe("keyRingFromParameter", () => {
  it("parses kids and makes the first one active", () => {
    expect(rotated.active).toBe("k2");
    expect([...rotated.keys.keys()]).toEqual(["k2", "k1"]);
    expect(rotated.keys.get("k1")?.sign.length).toBe(32);
    expect(rotated.keys.get("k1")?.enc.length).toBe(32);
    expect(rotated.keys.get("k1")?.sign.equals(rotated.keys.get("k1")!.enc)).toBe(false);
  });

  it("rejects bad input", () => {
    expect(() => keyRingFromParameter("")).toThrow();
    expect(() => keyRingFromParameter("k1:abcd")).toThrow();
    expect(() => keyRingFromParameter(`k 1:${"a".repeat(64)}`)).toThrow();
  });
});

describe("signed blobs", () => {
  it("round-trips a payload and names the active kid", () => {
    const blob = signBlob({ a: 1, b: "x" }, ring);
    expect(blob.split(".")[1]).toBe("k1");
    expect(verifyBlob(blob, ring)).toEqual({ a: 1, b: "x" });
  });

  it("is url-safe", () => {
    expect(signBlob({ s: "æøå/+=" }, ring)).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it("verifies blobs signed by an older key still in the ring, and not by unknown kids", () => {
    const old = signBlob({ a: 1 }, ring);
    expect(verifyBlob(old, rotated)).toEqual({ a: 1 });
    expect(() => verifyBlob(signBlob({ a: 1 }, rotated), ring)).toThrow(BlobError);
  });

  it("rejects tampering, wrong keys and garbage", () => {
    const blob = signBlob({ a: 1 }, ring);
    const [v, kid, , tag] = blob.split(".");
    const forged = `${v}.${kid}.${Buffer.from(JSON.stringify({ a: 2 })).toString("base64url")}.${tag}`;
    expect(() => verifyBlob(forged, ring)).toThrow(BlobError);
    expect(() => verifyBlob(signBlob({ a: 1 }, other), ring)).toThrow(BlobError);
    expect(() => verifyBlob("nope", ring)).toThrow(BlobError);
    expect(() => verifyBlob("v1.k1.x.y", ring)).toThrow(BlobError);
  });

  it("enforces exp", () => {
    const blob = signBlob({ exp: 1000 }, ring);
    expect(() => verifyBlob(blob, ring, 1001)).toThrow(expect.objectContaining({ code: "expired" }));
    expect(verifyBlob(blob, ring, 999)).toEqual({ exp: 1000 });
  });
});

describe("encrypted blobs", () => {
  it("round-trips, hides the payload, and differs per call", () => {
    const blob = encryptBlob({ token: "secret" }, ring);
    expect(blob).not.toContain("secret");
    expect(blob.split(".")[1]).toBe("k1");
    expect(decryptBlob(blob, ring)).toEqual({ token: "secret" });
    expect(encryptBlob({ a: 1 }, ring)).not.toBe(encryptBlob({ a: 1 }, ring));
  });

  it("decrypts with an older key in the ring", () => {
    expect(decryptBlob(encryptBlob({ a: 1 }, ring), rotated)).toEqual({ a: 1 });
  });

  it("rejects the wrong key, tampering and exp", () => {
    const blob = encryptBlob({ a: 1, exp: 10 }, ring);
    expect(() => decryptBlob(blob, other)).toThrow(BlobError);
    expect(() => decryptBlob(blob.slice(0, -2) + "AA", ring)).toThrow(BlobError);
    expect(() => decryptBlob(blob, ring, 11)).toThrow(expect.objectContaining({ code: "expired" }));
  });

  it("does not accept a signed blob as encrypted or vice versa", () => {
    expect(() => decryptBlob(signBlob({ a: 1 }, ring), ring)).toThrow(BlobError);
    expect(() => verifyBlob(encryptBlob({ a: 1 }, ring), ring)).toThrow(BlobError);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd api && npx vitest run test/crypto/blob.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`api/src/crypto/blob.ts`:
```ts
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

export class BlobError extends Error {
  constructor(public readonly code: "invalid" | "expired") {
    super(`blob ${code}`);
  }
}

export interface KeyRing {
  active: string;
  keys: Map<string, { sign: Buffer; enc: Buffer }>;
}

const KID = /^[A-Za-z0-9_-]{1,16}$/;

export function keyRingFromParameter(value: string): KeyRing {
  const keys = new Map<string, { sign: Buffer; enc: Buffer }>();
  for (const entry of value.split(",")) {
    const [kid, hex] = entry.trim().split(":");
    if (!kid || !KID.test(kid) || !hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new Error("signing_key must be kid:hex64[,kid:hex64] with alphanumeric kids");
    }
    const master = Buffer.from(hex, "hex");
    keys.set(kid, {
      sign: Buffer.from(hkdfSync("sha256", master, "", "sign", 32)),
      enc: Buffer.from(hkdfSync("sha256", master, "", "enc", 32)),
    });
  }
  const active = keys.keys().next().value;
  if (!active) throw new Error("signing_key is empty");
  return { active, keys };
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

function parse<T>(json: Buffer, now: number): T {
  let payload: unknown;
  try {
    payload = JSON.parse(json.toString("utf8"));
  } catch {
    throw new BlobError("invalid");
  }
  if (payload && typeof payload === "object" && "exp" in payload) {
    const exp = (payload as { exp: unknown }).exp;
    if (typeof exp === "number" && exp < now) throw new BlobError("expired");
  }
  return payload as T;
}

function keyFor(ring: KeyRing, kid: string | undefined) {
  const key = kid ? ring.keys.get(kid) : undefined;
  if (!key) throw new BlobError("invalid");
  return key;
}

export function signBlob(payload: object, ring: KeyRing): string {
  const key = ring.keys.get(ring.active)!;
  const body = Buffer.from(JSON.stringify(payload));
  const tag = createHmac("sha256", key.sign).update(body).digest();
  return `v1.${ring.active}.${body.toString("base64url")}.${tag.toString("base64url")}`;
}

export function verifyBlob<T>(blob: string, ring: KeyRing, now = nowSeconds()): T {
  const parts = blob.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") throw new BlobError("invalid");
  const key = keyFor(ring, parts[1]);
  const body = Buffer.from(parts[2]!, "base64url");
  const tag = Buffer.from(parts[3]!, "base64url");
  const expected = createHmac("sha256", key.sign).update(body).digest();
  if (tag.length !== expected.length || !timingSafeEqual(tag, expected)) throw new BlobError("invalid");
  return parse<T>(body, now);
}

export function encryptBlob(payload: object, ring: KeyRing): string {
  const key = ring.keys.get(ring.active)!;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key.enc, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const data = Buffer.concat([ciphertext, cipher.getAuthTag()]);
  return `v1e.${ring.active}.${iv.toString("base64url")}.${data.toString("base64url")}`;
}

export function decryptBlob<T>(blob: string, ring: KeyRing, now = nowSeconds()): T {
  const parts = blob.split(".");
  if (parts.length !== 4 || parts[0] !== "v1e") throw new BlobError("invalid");
  const key = keyFor(ring, parts[1]);
  const iv = Buffer.from(parts[2]!, "base64url");
  const data = Buffer.from(parts[3]!, "base64url");
  if (iv.length !== 12 || data.length < 16) throw new BlobError("invalid");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key.enc, iv);
    decipher.setAuthTag(data.subarray(data.length - 16));
    const plain = Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
    return parse<T>(plain, now);
  } catch (err) {
    if (err instanceof BlobError) throw err;
    throw new BlobError("invalid");
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd api && npx vitest run test/crypto/blob.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add api/src/crypto/blob.ts api/test/crypto/blob.test.ts
git commit -m "Signed and encrypted blobs with key ring, kid and expiry

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: PKCE, anonymous ids, and the safe logger

**Files:**
- Create: `api/src/crypto/pkce.ts`, `api/src/auth/anon.ts`, `api/src/log.ts`
- Test: `api/test/crypto/pkce.test.ts`, `api/test/auth/anon.test.ts`, `api/test/log.test.ts`

**Interfaces:**
- `pkceChallenge(verifier: string): string`, `verifyPkce(verifier: string, challenge: string): boolean`
- `anonymousId(email: string, salt: Buffer): string` (32 hex chars; email trimmed and lowercased)
- `log(event: string, fields?: Record<string, string | number | boolean | undefined>): void` writes one JSON line to stdout with `event`, `ts`, and the fields. It throws if any field value looks like a bearer token, a blob (`v1.`/`v1e.` prefix) or an email address, so a mistake fails loudly in tests rather than leaking in production. `withRequestId(id)` returns a bound logger with the same signature.

- [ ] **Step 1: Failing tests**

`api/test/crypto/pkce.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { pkceChallenge, verifyPkce } from "../../src/crypto/pkce.js";

describe("pkce", () => {
  // RFC 7636 appendix B test vector
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

  it("computes the RFC 7636 challenge", () => {
    expect(pkceChallenge(verifier)).toBe(challenge);
  });

  it("verifies matching and rejects mismatching pairs", () => {
    expect(verifyPkce(verifier, challenge)).toBe(true);
    expect(verifyPkce(verifier + "x", challenge)).toBe(false);
    expect(verifyPkce(verifier, "")).toBe(false);
  });
});
```

`api/test/auth/anon.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { anonymousId } from "../../src/auth/anon.js";

const salt = Buffer.from("c".repeat(64), "hex");

describe("anonymousId", () => {
  it("is stable, salted and normalised", () => {
    const a = anonymousId("Jonas@Example.com ", salt);
    expect(a).toBe(anonymousId("jonas@example.com", salt));
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(anonymousId("jonas@example.com", Buffer.from("d".repeat(64), "hex")));
    expect(a).not.toContain("jonas");
  });
});
```

`api/test/log.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { log, withRequestId } from "../src/log.js";

describe("log", () => {
  afterEach(() => vi.restoreAllMocks());

  it("writes one json line with event and fields", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    log("request", { method: "POST", route: "/mcp", status: 200, ms: 12 });
    const line = JSON.parse(String(out.mock.calls[0]?.[0]));
    expect(line).toMatchObject({ event: "request", method: "POST", route: "/mcp", status: 200, ms: 12 });
    expect(typeof line.ts).toBe("string");
  });

  it("binds a request id", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    withRequestId("req-1")("x", { a: 1 });
    expect(JSON.parse(String(out.mock.calls[0]?.[0])).requestId).toBe("req-1");
  });

  it("refuses to log token-like values, blobs and emails", () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(() => log("x", { h: "Bearer abc.def" })).toThrow(/refusing/);
    expect(() => log("x", { b: "v1e.k1.aaaa.bbbb" })).toThrow(/refusing/);
    expect(() => log("x", { b: "v1.k1.aaaa.bbbb" })).toThrow(/refusing/);
    expect(() => log("x", { e: "jonas@example.com" })).toThrow(/refusing/);
    expect(() => log("x", { ok: "fiken 401" })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd api && npx vitest run test/crypto/pkce.test.ts test/auth/anon.test.ts test/log.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`api/src/crypto/pkce.ts`:
```ts
import { createHash, timingSafeEqual } from "node:crypto";

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export function verifyPkce(verifier: string, challenge: string): boolean {
  const a = Buffer.from(pkceChallenge(verifier));
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}
```

`api/src/auth/anon.ts`:
```ts
import { createHmac } from "node:crypto";

export function anonymousId(email: string, salt: Buffer): string {
  return createHmac("sha256", salt).update(email.trim().toLowerCase()).digest("hex").slice(0, 32);
}
```

`api/src/log.ts`:
```ts
export type LogFields = Record<string, string | number | boolean | undefined>;

const FORBIDDEN = [/^bearer\s/i, /^basic\s/i, /^v1e?\.[A-Za-z0-9_-]+\./, /[^\s@]+@[^\s@]+\.[^\s@]+/];

function assertSafe(fields: LogFields): void {
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value !== "string") continue;
    if (FORBIDDEN.some((re) => re.test(value))) {
      throw new Error(`refusing to log field ${key}: looks like a secret or personal data`);
    }
  }
}

export function log(event: string, fields: LogFields = {}): void {
  assertSafe(fields);
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }) + "\n");
}

export function withRequestId(requestId: string) {
  return (event: string, fields: LogFields = {}) => log(event, { requestId, ...fields });
}
```

- [ ] **Step 4: Run tests**

Run: `cd api && npx vitest run test/crypto/pkce.test.ts test/auth/anon.test.ts test/log.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add api/src/crypto/pkce.ts api/src/auth/anon.ts api/src/log.ts api/test/crypto/pkce.test.ts api/test/auth/anon.test.ts api/test/log.test.ts
git commit -m "PKCE verification, anonymous ids, logger that refuses secrets

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Config from env and Parameter Store

**Files:**
- Create: `api/src/config.ts`
- Test: `api/test/config.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface Config {
    publicUrl: string;            // no trailing slash
    fikenClientId: string;
    fikenClientSecret: string;
    keys: KeyRing;
    userSalt: Buffer;             // 32 bytes
    fikenBaseUrl: string;         // "https://api.fiken.no/api/v2"
    fikenOAuthBaseUrl: string;    // "https://fiken.no/oauth"
    fetch: typeof fetch;
  }
  export interface SsmLike { getParameters(names: string[]): Promise<Record<string, string>> }
  export function loadConfig(deps?: { env?: NodeJS.ProcessEnv; ssm?: SsmLike; fetch?: typeof fetch }): Promise<Config>
  export function testConfig(overrides?: Partial<Config>): Config
  ```
- Env: `PUBLIC_URL` (required), `PARAM_PREFIX` (default `/fiken_mcp`).

- [ ] **Step 1: Failing test**

`api/test/config.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { loadConfig, testConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("reads env and Parameter Store", async () => {
    const asked: string[][] = [];
    const ssm = {
      async getParameters(names: string[]) {
        asked.push(names);
        return {
          "/fiken_mcp/client_id": "cid",
          "/fiken_mcp/client_secret": "csec",
          "/fiken_mcp/signing_key": `k1:${"a".repeat(64)}`,
          "/fiken_mcp/user_salt": "b".repeat(64),
        };
      },
    };
    const cfg = await loadConfig({ env: { PUBLIC_URL: "https://x.test/" }, ssm });
    expect(cfg.publicUrl).toBe("https://x.test");
    expect(cfg.fikenClientId).toBe("cid");
    expect(cfg.fikenClientSecret).toBe("csec");
    expect(cfg.keys.active).toBe("k1");
    expect(cfg.userSalt.length).toBe(32);
    expect(cfg.fikenBaseUrl).toBe("https://api.fiken.no/api/v2");
    expect(asked[0]).toEqual(["/fiken_mcp/client_id", "/fiken_mcp/client_secret", "/fiken_mcp/signing_key", "/fiken_mcp/user_salt"]);
  });

  it("fails on missing PUBLIC_URL or missing parameters", async () => {
    const ssm = { async getParameters() { return {}; } };
    await expect(loadConfig({ env: {}, ssm })).rejects.toThrow(/PUBLIC_URL/);
    await expect(loadConfig({ env: { PUBLIC_URL: "https://x.test" }, ssm })).rejects.toThrow(/client_id/);
  });

  it("testConfig gives usable keys", () => {
    const cfg = testConfig();
    expect(cfg.keys.keys.size).toBe(1);
    expect(cfg.publicUrl).toBe("https://fiken-mcp.test");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd api && npx vitest run test/config.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`api/src/config.ts`:
```ts
import { GetParametersCommand, SSMClient } from "@aws-sdk/client-ssm";
import { keyRingFromParameter, type KeyRing } from "./crypto/blob.js";

export interface Config {
  publicUrl: string;
  fikenClientId: string;
  fikenClientSecret: string;
  keys: KeyRing;
  userSalt: Buffer;
  fikenBaseUrl: string;
  fikenOAuthBaseUrl: string;
  fetch: typeof fetch;
}

export interface SsmLike {
  getParameters(names: string[]): Promise<Record<string, string>>;
}

const PARAM_NAMES = ["client_id", "client_secret", "signing_key", "user_salt"] as const;

export function ssmFromSdk(client = new SSMClient({})): SsmLike {
  return {
    async getParameters(names) {
      const out = await client.send(new GetParametersCommand({ Names: names, WithDecryption: true }));
      const result: Record<string, string> = {};
      for (const p of out.Parameters ?? []) {
        if (p.Name && p.Value !== undefined) result[p.Name] = p.Value;
      }
      return result;
    },
  };
}

function saltFromHex(hex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("user_salt must be 64 hex characters");
  return Buffer.from(hex, "hex");
}

export async function loadConfig(deps: { env?: NodeJS.ProcessEnv; ssm?: SsmLike; fetch?: typeof fetch } = {}): Promise<Config> {
  const env = deps.env ?? process.env;
  const publicUrl = env.PUBLIC_URL?.replace(/\/+$/, "");
  if (!publicUrl) throw new Error("PUBLIC_URL is required");
  const prefix = env.PARAM_PREFIX ?? "/fiken_mcp";
  const names = PARAM_NAMES.map((n) => `${prefix}/${n}`);
  const params = await (deps.ssm ?? ssmFromSdk()).getParameters(names);
  const get = (n: (typeof PARAM_NAMES)[number]) => {
    const v = params[`${prefix}/${n}`];
    if (!v) throw new Error(`missing parameter ${prefix}/${n}`);
    return v;
  };
  return {
    publicUrl,
    fikenClientId: get("client_id"),
    fikenClientSecret: get("client_secret"),
    keys: keyRingFromParameter(get("signing_key")),
    userSalt: saltFromHex(get("user_salt")),
    fikenBaseUrl: "https://api.fiken.no/api/v2",
    fikenOAuthBaseUrl: "https://fiken.no/oauth",
    fetch: deps.fetch ?? globalThis.fetch,
  };
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    publicUrl: "https://fiken-mcp.test",
    fikenClientId: "test-client-id",
    fikenClientSecret: "test-client-secret",
    keys: keyRingFromParameter(`t1:${"1".repeat(64)}`),
    userSalt: saltFromHex("2".repeat(64)),
    fikenBaseUrl: "https://api.fiken.test/api/v2",
    fikenOAuthBaseUrl: "https://fiken.test/oauth",
    fetch: async () => new Response("unexpected fetch", { status: 500 }),
    ...overrides,
  };
}
```

- [ ] **Step 4: Run tests**

Run: `cd api && npx vitest run test/config.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add api/src/config.ts api/test/config.test.ts
git commit -m "Config loader: env plus Parameter Store with key ring

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: fikenFetch with queue and retry

**Files:**
- Create: `api/src/fiken/client.ts`
- Test: `api/test/fiken/client.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export class FikenError extends Error { status: number; body: string }   // body truncated to 500 chars
  export interface FikenClient {
    fetch(path: string, init?: RequestInit): Promise<Response>;
    json<T>(path: string, init?: RequestInit): Promise<T>;
  }
  export function createFikenClient(opts: { baseUrl: string; accessToken: string; fetch: typeof fetch; queue?: FikenQueue }): FikenClient
  export class FikenQueue { constructor(gapMs?: number); run<T>(fn: () => Promise<T>): Promise<T> }
  export const globalQueue: FikenQueue
  ```

- [ ] **Step 1: Failing tests**

`api/test/fiken/client.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FikenError, FikenQueue, createFikenClient } from "../../src/fiken/client.js";

function fakeFetch(responses: Array<() => Response>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    return next();
  };
  return { fetchImpl, calls };
}

describe("createFikenClient", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("prefixes the base url and sends the bearer token", async () => {
    const { fetchImpl, calls } = fakeFetch([() => Response.json([{ slug: "a" }])]);
    const client = createFikenClient({ baseUrl: "https://api.test/v2", accessToken: "tok", fetch: fetchImpl, queue: new FikenQueue(0) });
    const p = client.json<unknown[]>("/companies");
    await vi.runAllTimersAsync();
    expect(await p).toEqual([{ slug: "a" }]);
    expect(calls[0]?.url).toBe("https://api.test/v2/companies");
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer tok");
  });

  it("throws FikenError with status and body on non-2xx", async () => {
    const { fetchImpl } = fakeFetch([() => new Response("nope", { status: 404 })]);
    const client = createFikenClient({ baseUrl: "https://api.test/v2", accessToken: "tok", fetch: fetchImpl, queue: new FikenQueue(0) });
    const p = client.json("/companies/x");
    await vi.runAllTimersAsync();
    await expect(p).rejects.toMatchObject({ status: 404, body: "nope" });
    await expect(p).rejects.toBeInstanceOf(FikenError);
  });

  it("retries once on 429 after one second", async () => {
    const { fetchImpl, calls } = fakeFetch([
      () => new Response("slow down", { status: 429 }),
      () => Response.json({ ok: true }),
    ]);
    const client = createFikenClient({ baseUrl: "https://api.test/v2", accessToken: "tok", fetch: fetchImpl, queue: new FikenQueue(0) });
    const p = client.json("/companies");
    await vi.advanceTimersByTimeAsync(999);
    expect(calls.length).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.runAllTimersAsync();
    expect(await p).toEqual({ ok: true });
    expect(calls.length).toBe(2);
  });

  it("serialises calls through the queue with a gap", async () => {
    const order: string[] = [];
    const queue = new FikenQueue(300);
    const a = queue.run(async () => { order.push("a-start"); await new Promise((r) => setTimeout(r, 50)); order.push("a-end"); });
    const b = queue.run(async () => { order.push("b-start"); });
    await vi.advanceTimersByTimeAsync(50);
    expect(order).toEqual(["a-start", "a-end"]);
    await vi.advanceTimersByTimeAsync(299);
    expect(order).toEqual(["a-start", "a-end"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(order).toEqual(["a-start", "a-end", "b-start"]);
    await Promise.all([a, b]);
  });

  it("keeps the queue alive after a failure", async () => {
    const queue = new FikenQueue(0);
    await expect(queue.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    const p = queue.run(async () => 42);
    await vi.runAllTimersAsync();
    expect(await p).toBe(42);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd api && npx vitest run test/fiken/client.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`api/src/fiken/client.ts`:
```ts
export class FikenError extends Error {
  constructor(public readonly status: number, public readonly body: string) {
    super(`Fiken ${status}`);
    this.body = body.slice(0, 500);
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Serialises calls: the next one starts `gapMs` after the previous one settled. */
export class FikenQueue {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly gapMs = 300) {}

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.then(
      () => sleep(this.gapMs),
      () => sleep(this.gapMs),
    );
    return result;
  }
}

export const globalQueue = new FikenQueue(300);

export interface FikenClient {
  fetch(path: string, init?: RequestInit): Promise<Response>;
  json<T>(path: string, init?: RequestInit): Promise<T>;
}

export function createFikenClient(opts: { baseUrl: string; accessToken: string; fetch: typeof fetch; queue?: FikenQueue }): FikenClient {
  const queue = opts.queue ?? globalQueue;

  async function once(path: string, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${opts.accessToken}`);
    if (!headers.has("accept")) headers.set("accept", "application/json");
    return opts.fetch(`${opts.baseUrl}${path}`, { ...init, headers });
  }

  const doFetch = (path: string, init?: RequestInit) =>
    queue.run(async () => {
      const first = await once(path, init);
      if (first.status !== 429) return first;
      await sleep(1000);
      return once(path, init);
    });

  return {
    fetch: doFetch,
    async json<T>(path: string, init?: RequestInit): Promise<T> {
      const res = await doFetch(path, init);
      if (!res.ok) throw new FikenError(res.status, await res.text());
      return (await res.json()) as T;
    },
  };
}
```

- [ ] **Step 4: Run tests**

Run: `cd api && npx vitest run test/fiken/client.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add api/src/fiken/client.ts api/test/fiken/client.test.ts
git commit -m "fikenFetch: serial queue, 429 retry, typed errors

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Fiken OAuth client

**Files:**
- Create: `api/src/fiken/oauth.ts`
- Test: `api/test/fiken/oauth.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface FikenTokens { access_token: string; refresh_token: string; expires_in: number }
  export class FikenOAuthError extends Error { error: string; description?: string }
  export function fikenRedirectUri(cfg: Config): string
  export function fikenAuthorizeUrl(cfg: Config, state: string): string
  export function exchangeFikenCode(cfg: Config, code: string, state: string): Promise<FikenTokens>
  export function refreshFikenToken(cfg: Config, refreshToken: string): Promise<FikenTokens>
  export function fetchFikenUser(cfg: Config, accessToken: string): Promise<{ name: string; email: string }>
  ```

- [ ] **Step 1: Failing tests**

`api/test/fiken/oauth.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { testConfig } from "../../src/config.js";
import { FikenOAuthError, exchangeFikenCode, fetchFikenUser, fikenAuthorizeUrl, refreshFikenToken } from "../../src/fiken/oauth.js";

function capture(response: Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const cfg = testConfig({
    fetch: async (input, init) => {
      calls.push({ url: String(input), init });
      return response;
    },
  });
  return { cfg, calls };
}

describe("fikenAuthorizeUrl", () => {
  it("builds the authorize url", () => {
    const url = new URL(fikenAuthorizeUrl(testConfig(), "st"));
    expect(url.origin + url.pathname).toBe("https://fiken.test/oauth/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("test-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe("https://fiken-mcp.test/callback");
    expect(url.searchParams.get("state")).toBe("st");
  });
});

describe("exchangeFikenCode", () => {
  it("posts form data with basic auth", async () => {
    const { cfg, calls } = capture(Response.json({ access_token: "a", refresh_token: "r", token_type: "bearer", expires_in: 86157 }));
    const tokens = await exchangeFikenCode(cfg, "CODE", "ST");
    expect(tokens).toEqual({ access_token: "a", refresh_token: "r", expires_in: 86157 });
    expect(calls[0]?.url).toBe("https://fiken.test/oauth/token");
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("authorization")).toBe("Basic " + Buffer.from("test-client-id:test-client-secret").toString("base64"));
    expect(headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    const body = new URLSearchParams(String(calls[0]?.init?.body));
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("CODE");
    expect(body.get("state")).toBe("ST");
    expect(body.get("redirect_uri")).toBe("https://fiken-mcp.test/callback");
  });

  it("surfaces Fiken's oauth error", async () => {
    const { cfg } = capture(Response.json({ error: "invalid_grant", error_description: "expired" }, { status: 400 }));
    await expect(exchangeFikenCode(cfg, "x", "y")).rejects.toMatchObject({ error: "invalid_grant", description: "expired" });
    await expect(exchangeFikenCode(cfg, "x", "y")).rejects.toBeInstanceOf(FikenOAuthError);
  });
});

describe("refreshFikenToken", () => {
  it("posts grant_type=refresh_token", async () => {
    const { cfg, calls } = capture(Response.json({ access_token: "a2", refresh_token: "r2", expires_in: 100 }));
    expect(await refreshFikenToken(cfg, "r1")).toEqual({ access_token: "a2", refresh_token: "r2", expires_in: 100 });
    const body = new URLSearchParams(String(calls[0]?.init?.body));
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("r1");
  });
});

describe("fetchFikenUser", () => {
  it("gets /user with the bearer token", async () => {
    const { cfg, calls } = capture(Response.json({ name: "Test", email: "t@x.no" }));
    expect(await fetchFikenUser(cfg, "tok")).toEqual({ name: "Test", email: "t@x.no" });
    expect(calls[0]?.url).toBe("https://api.fiken.test/api/v2/user");
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer tok");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd api && npx vitest run test/fiken/oauth.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`api/src/fiken/oauth.ts`:
```ts
import type { Config } from "../config.js";
import { createFikenClient, globalQueue } from "./client.js";

export interface FikenTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export class FikenOAuthError extends Error {
  constructor(public readonly error: string, public readonly description?: string) {
    super(`Fiken OAuth error ${error}`);
  }
}

export function fikenRedirectUri(cfg: Config): string {
  return `${cfg.publicUrl}/callback`;
}

export function fikenAuthorizeUrl(cfg: Config, state: string): string {
  const url = new URL(`${cfg.fikenOAuthBaseUrl}/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", cfg.fikenClientId);
  url.searchParams.set("redirect_uri", fikenRedirectUri(cfg));
  url.searchParams.set("state", state);
  return url.toString();
}

async function tokenRequest(cfg: Config, form: Record<string, string>): Promise<FikenTokens> {
  const basic = Buffer.from(`${cfg.fikenClientId}:${cfg.fikenClientSecret}`).toString("base64");
  const res = await globalQueue.run(() =>
    cfg.fetch(`${cfg.fikenOAuthBaseUrl}/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${basic}`,
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams(form).toString(),
    }),
  );
  const body = (await res.json().catch(() => ({}))) as Partial<FikenTokens> & { error?: string; error_description?: string };
  if (!res.ok || body.error || !body.access_token || !body.refresh_token) {
    throw new FikenOAuthError(body.error ?? `http_${res.status}`, body.error_description);
  }
  return { access_token: body.access_token, refresh_token: body.refresh_token, expires_in: body.expires_in ?? 3600 };
}

export function exchangeFikenCode(cfg: Config, code: string, state: string): Promise<FikenTokens> {
  return tokenRequest(cfg, { grant_type: "authorization_code", code, redirect_uri: fikenRedirectUri(cfg), state });
}

export function refreshFikenToken(cfg: Config, refreshToken: string): Promise<FikenTokens> {
  return tokenRequest(cfg, { grant_type: "refresh_token", refresh_token: refreshToken });
}

export function fetchFikenUser(cfg: Config, accessToken: string): Promise<{ name: string; email: string }> {
  const client = createFikenClient({ baseUrl: cfg.fikenBaseUrl, accessToken, fetch: cfg.fetch });
  return client.json<{ name: string; email: string }>("/user");
}
```

- [ ] **Step 4: Run tests**

Run: `cd api && npx vitest run test/fiken/oauth.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add api/src/fiken/oauth.ts api/test/fiken/oauth.test.ts
git commit -m "Fiken OAuth client: authorize url, code exchange, refresh, user

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Our tokens: one-hour wrappers and refresh reuse

**Files:**
- Create: `api/src/auth/tokens.ts`
- Test: `api/test/auth/tokens.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const ACCESS_TOKEN_SECONDS = 3600;
  export interface AccessClaims { fikenAccessToken: string; anonId: string; exp: number }
  export interface RefreshClaims { fikenRefreshToken: string; fikenAccessToken: string; fikenAccessExp: number; anonId: string }
  export interface IssuedTokens { access_token: string; refresh_token: string; token_type: "bearer"; expires_in: number }
  export function issueTokens(cfg: Config, fiken: FikenTokens, anonId: string, now?: number): IssuedTokens
  export function readAccessToken(cfg: Config, token: string, now?: number): AccessClaims
  export function readRefreshToken(cfg: Config, token: string): RefreshClaims
  export function renewTokens(cfg: Config, refreshToken: string, now?: number): Promise<IssuedTokens>
  ```
- Wire: access `{ k:"a", t, u, exp }`; refresh `{ k:"r", r, t, te, u }`. `renewTokens` reuses the wrapped Fiken access token when `te - now > ACCESS_TOKEN_SECONDS + 60`, otherwise calls `refreshFikenToken`. Throws `BlobError` for bad tokens and `FikenOAuthError` when Fiken refuses.

- [ ] **Step 1: Failing test**

`api/test/auth/tokens.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { ACCESS_TOKEN_SECONDS, issueTokens, readAccessToken, readRefreshToken, renewTokens } from "../../src/auth/tokens.js";
import { testConfig } from "../../src/config.js";
import { BlobError } from "../../src/crypto/blob.js";

const cfg = testConfig();
const fiken = { access_token: "FA", refresh_token: "FR", expires_in: 86157 };

describe("issueTokens", () => {
  it("issues one-hour encrypted wrappers", () => {
    const issued = issueTokens(cfg, fiken, "anon1", 1000);
    expect(issued.token_type).toBe("bearer");
    expect(issued.expires_in).toBe(ACCESS_TOKEN_SECONDS);
    expect(issued.access_token).not.toContain("FA");
    expect(readAccessToken(cfg, issued.access_token, 1050)).toEqual({ fikenAccessToken: "FA", anonId: "anon1", exp: 1000 + ACCESS_TOKEN_SECONDS });
    expect(readRefreshToken(cfg, issued.refresh_token)).toEqual({ fikenRefreshToken: "FR", fikenAccessToken: "FA", fikenAccessExp: 1000 + 86157, anonId: "anon1" });
  });

  it("never issues longer than Fiken's own expiry", () => {
    const issued = issueTokens(cfg, { ...fiken, expires_in: 120 }, "anon1", 1000);
    expect(issued.expires_in).toBe(120);
  });

  it("access tokens expire; refresh tokens do not; kinds are not interchangeable", () => {
    const issued = issueTokens(cfg, fiken, "anon1", 1000);
    expect(() => readAccessToken(cfg, issued.access_token, 1000 + ACCESS_TOKEN_SECONDS + 1)).toThrow(BlobError);
    expect(readRefreshToken(cfg, issued.refresh_token).fikenRefreshToken).toBe("FR");
    expect(() => readRefreshToken(cfg, issued.access_token)).toThrow(BlobError);
    expect(() => readAccessToken(cfg, issued.refresh_token, 1000)).toThrow(BlobError);
  });
});

describe("renewTokens", () => {
  it("reuses the wrapped Fiken access token while it has more than an hour left", async () => {
    let fikenCalls = 0;
    const c = testConfig({ fetch: async () => { fikenCalls++; return Response.json({}); } });
    const issued = issueTokens(c, fiken, "anon1", 1000);
    const renewed = await renewTokens(c, issued.refresh_token, 5000);
    expect(fikenCalls).toBe(0);
    expect(readAccessToken(c, renewed.access_token, 5000)).toEqual({ fikenAccessToken: "FA", anonId: "anon1", exp: 5000 + ACCESS_TOKEN_SECONDS });
    expect(readRefreshToken(c, renewed.refresh_token).fikenRefreshToken).toBe("FR");
  });

  it("calls Fiken when the wrapped access token is about to expire", async () => {
    const c = testConfig({ fetch: async () => Response.json({ access_token: "FA2", refresh_token: "FR2", expires_in: 86157 }) });
    const issued = issueTokens(c, { ...fiken, expires_in: 4000 }, "anon1", 1000);
    const renewed = await renewTokens(c, issued.refresh_token, 2000);
    expect(readAccessToken(c, renewed.access_token, 2000).fikenAccessToken).toBe("FA2");
    expect(readRefreshToken(c, renewed.refresh_token)).toMatchObject({ fikenRefreshToken: "FR2", fikenAccessToken: "FA2", anonId: "anon1" });
  });

  it("rejects garbage", async () => {
    await expect(renewTokens(cfg, "garbage", 1)).rejects.toThrow(BlobError);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd api && npx vitest run test/auth/tokens.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`api/src/auth/tokens.ts`:
```ts
import type { Config } from "../config.js";
import { BlobError, decryptBlob, encryptBlob } from "../crypto/blob.js";
import { refreshFikenToken, type FikenTokens } from "../fiken/oauth.js";

export const ACCESS_TOKEN_SECONDS = 3600;
const RENEW_MARGIN_SECONDS = 60;

export interface AccessClaims { fikenAccessToken: string; anonId: string; exp: number }
export interface RefreshClaims { fikenRefreshToken: string; fikenAccessToken: string; fikenAccessExp: number; anonId: string }
export interface IssuedTokens { access_token: string; refresh_token: string; token_type: "bearer"; expires_in: number }

interface AccessWire { k: "a"; t: string; u: string; exp: number }
interface RefreshWire { k: "r"; r: string; t: string; te: number; u: string }

const nowSeconds = () => Math.floor(Date.now() / 1000);

function issue(cfg: Config, fikenAccessToken: string, fikenAccessExp: number, fikenRefreshToken: string, anonId: string, now: number): IssuedTokens {
  const expiresIn = Math.max(0, Math.min(ACCESS_TOKEN_SECONDS, fikenAccessExp - now));
  const access: AccessWire = { k: "a", t: fikenAccessToken, u: anonId, exp: now + expiresIn };
  const refresh: RefreshWire = { k: "r", r: fikenRefreshToken, t: fikenAccessToken, te: fikenAccessExp, u: anonId };
  return {
    access_token: encryptBlob(access, cfg.keys),
    refresh_token: encryptBlob(refresh, cfg.keys),
    token_type: "bearer",
    expires_in: expiresIn,
  };
}

export function issueTokens(cfg: Config, fiken: FikenTokens, anonId: string, now = nowSeconds()): IssuedTokens {
  return issue(cfg, fiken.access_token, now + fiken.expires_in, fiken.refresh_token, anonId, now);
}

export function readAccessToken(cfg: Config, token: string, now = nowSeconds()): AccessClaims {
  const wire = decryptBlob<Partial<AccessWire>>(token, cfg.keys, now);
  if (wire.k !== "a" || !wire.t || !wire.u || typeof wire.exp !== "number") throw new BlobError("invalid");
  return { fikenAccessToken: wire.t, anonId: wire.u, exp: wire.exp };
}

export function readRefreshToken(cfg: Config, token: string): RefreshClaims {
  const wire = decryptBlob<Partial<RefreshWire>>(token, cfg.keys);
  if (wire.k !== "r" || !wire.r || !wire.t || !wire.u || typeof wire.te !== "number") throw new BlobError("invalid");
  return { fikenRefreshToken: wire.r, fikenAccessToken: wire.t, fikenAccessExp: wire.te, anonId: wire.u };
}

export async function renewTokens(cfg: Config, refreshToken: string, now = nowSeconds()): Promise<IssuedTokens> {
  const claims = readRefreshToken(cfg, refreshToken);
  if (claims.fikenAccessExp - now > ACCESS_TOKEN_SECONDS + RENEW_MARGIN_SECONDS) {
    return issue(cfg, claims.fikenAccessToken, claims.fikenAccessExp, claims.fikenRefreshToken, claims.anonId, now);
  }
  const fresh = await refreshFikenToken(cfg, claims.fikenRefreshToken);
  return issueTokens(cfg, fresh, claims.anonId, now);
}
```

- [ ] **Step 4: Run tests**

Run: `cd api && npx vitest run test/auth/tokens.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add api/src/auth/tokens.ts api/test/auth/tokens.test.ts
git commit -m "One-hour wrapped access tokens; refresh reuses Fiken's token while valid

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Hono app, security headers, discovery, allowlisted registration

**Files:**
- Create: `api/src/app.ts`, `api/src/auth/clients.ts`, `api/src/auth/routes.ts`
- Test: `api/test/auth/clients.test.ts`, `api/test/auth/discovery.test.ts`

**Interfaces:**
- `createApp(cfg: Config): Hono` adds `Strict-Transport-Security` and `X-Content-Type-Options` to every response and mounts `authRoutes(cfg)`.
- `isAllowedRedirectUri(uri: string): boolean` and `clientLabel(uri: string): string` in `clients.ts`.
- Client id wire: signed `{ k: "c", ru: string[], n: string }` (`n` = client name, may be empty). `readClientId(cfg, clientId): { redirectUris: string[]; name: string }` throws `BlobError`.

- [ ] **Step 1: Failing tests**

`api/test/auth/clients.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { clientLabel, isAllowedRedirectUri } from "../../src/auth/clients.js";

describe("redirect allowlist", () => {
  it("accepts known clients and loopback", () => {
    for (const u of [
      "https://claude.ai/api/mcp/auth_callback",
      "https://chatgpt.com/connector_platform_oauth_redirect",
      "https://chatgpt.com/connector/oauth/abc-123",
      "http://localhost:3000/callback",
      "http://127.0.0.1:52341/oauth/callback",
    ]) expect(isAllowedRedirectUri(u), u).toBe(true);
  });

  it("rejects everything else", () => {
    for (const u of [
      "https://evil.example/cb",
      "https://claude.ai.evil.example/api/mcp/auth_callback",
      "https://claude.ai/api/mcp/auth_callback/../x",
      "https://claude.ai/other",
      "http://localhost.evil.example/cb",
      "http://evil.example:3000/cb",
      "not a url",
      "cursor://anysphere.cursor-retrieval/oauth",
    ]) expect(isAllowedRedirectUri(u), u).toBe(false);
  });

  it("labels clients for the consent page", () => {
    expect(clientLabel("https://claude.ai/api/mcp/auth_callback")).toBe("Claude (claude.ai)");
    expect(clientLabel("https://chatgpt.com/connector/oauth/x")).toBe("ChatGPT (chatgpt.com)");
    expect(clientLabel("http://localhost:3000/cb")).toBe("a program on this computer (localhost)");
  });
});
```

`api/test/auth/discovery.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { readClientId } from "../../src/auth/routes.js";
import { testConfig } from "../../src/config.js";

const cfg = testConfig();
const app = createApp(cfg);

describe("security headers", () => {
  it("sets HSTS and nosniff on every response", async () => {
    const res = await app.request("/");
    expect(res.headers.get("strict-transport-security")).toContain("max-age=");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("discovery", () => {
  it("serves protected resource metadata", async () => {
    const res = await app.request("/.well-known/oauth-protected-resource");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      resource: "https://fiken-mcp.test/mcp",
      authorization_servers: ["https://fiken-mcp.test"],
      bearer_methods_supported: ["header"],
    });
  });

  it("serves authorization server metadata", async () => {
    const res = await app.request("/.well-known/oauth-authorization-server");
    expect(await res.json()).toEqual({
      issuer: "https://fiken-mcp.test",
      authorization_endpoint: "https://fiken-mcp.test/authorize",
      token_endpoint: "https://fiken-mcp.test/token",
      registration_endpoint: "https://fiken-mcp.test/register",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  });
});

describe("register", () => {
  const post = (body: unknown) =>
    app.request("/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("returns a signed client id carrying the redirect uris and name", async () => {
    const res = await post({ client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.redirect_uris).toEqual(["https://claude.ai/api/mcp/auth_callback"]);
    expect(body.token_endpoint_auth_method).toBe("none");
    expect(body.client_secret).toBeUndefined();
    expect(readClientId(cfg, body.client_id)).toEqual({ redirectUris: ["https://claude.ai/api/mcp/auth_callback"], name: "Claude" });
  });

  it("rejects redirect uris outside the allowlist", async () => {
    const bad = await post({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback", "https://evil.example/cb"] });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("invalid_redirect_uri");
  });

  it("rejects missing redirect uris", async () => {
    const res = await post({ client_name: "x" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_client_metadata");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd api && npx vitest run test/auth/clients.test.ts test/auth/discovery.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`api/src/auth/clients.ts`:
```ts
/**
 * Redirect URIs we accept at dynamic registration. Anything else is
 * refused, so an attacker cannot register a client that receives codes.
 * Extend by pull request.
 */
interface KnownClient {
  label: string;
  matches: (url: URL) => boolean;
}

const KNOWN: KnownClient[] = [
  {
    label: "Claude (claude.ai)",
    matches: (u) => u.protocol === "https:" && u.host === "claude.ai" && u.pathname === "/api/mcp/auth_callback",
  },
  {
    label: "ChatGPT (chatgpt.com)",
    matches: (u) =>
      u.protocol === "https:" &&
      u.host === "chatgpt.com" &&
      (u.pathname === "/connector_platform_oauth_redirect" || /^\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(u.pathname)),
  },
  {
    label: "a program on this computer (localhost)",
    matches: (u) => u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1"),
  },
];

function parse(uri: string): URL | undefined {
  try {
    const url = new URL(uri);
    if (url.pathname.includes("/../") || url.pathname.endsWith("/..")) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

export function isAllowedRedirectUri(uri: string): boolean {
  const url = parse(uri);
  return url !== undefined && KNOWN.some((c) => c.matches(url));
}

export function clientLabel(uri: string): string {
  const url = parse(uri);
  return (url && KNOWN.find((c) => c.matches(url))?.label) ?? "an unknown client";
}
```

`api/src/auth/routes.ts` (this task adds discovery and register; Tasks 10 and 11 extend it):
```ts
import { Hono } from "hono";
import type { Config } from "../config.js";
import { BlobError, signBlob, verifyBlob } from "../crypto/blob.js";
import { isAllowedRedirectUri } from "./clients.js";

interface ClientWire { k: "c"; ru: string[]; n: string }

export function readClientId(cfg: Config, clientId: string): { redirectUris: string[]; name: string } {
  const wire = verifyBlob<Partial<ClientWire>>(clientId, cfg.keys);
  if (wire.k !== "c" || !Array.isArray(wire.ru)) throw new BlobError("invalid");
  return { redirectUris: wire.ru, name: typeof wire.n === "string" ? wire.n : "" };
}

export function authRoutes(cfg: Config): Hono {
  const app = new Hono();

  app.get("/.well-known/oauth-protected-resource", (c) =>
    c.json({ resource: `${cfg.publicUrl}/mcp`, authorization_servers: [cfg.publicUrl], bearer_methods_supported: ["header"] }),
  );

  app.get("/.well-known/oauth-authorization-server", (c) =>
    c.json({
      issuer: cfg.publicUrl,
      authorization_endpoint: `${cfg.publicUrl}/authorize`,
      token_endpoint: `${cfg.publicUrl}/token`,
      registration_endpoint: `${cfg.publicUrl}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    }),
  );

  app.post("/register", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { client_name?: unknown; redirect_uris?: unknown };
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || !uris.every((u) => typeof u === "string")) {
      return c.json({ error: "invalid_client_metadata", error_description: "redirect_uris required" }, 400);
    }
    if (!uris.every(isAllowedRedirectUri)) {
      return c.json({ error: "invalid_redirect_uri", error_description: "redirect_uri is not a known MCP client" }, 400);
    }
    const name = typeof body.client_name === "string" ? body.client_name.slice(0, 64) : "";
    const wire: ClientWire = { k: "c", ru: uris, n: name };
    return c.json(
      {
        client_id: signBlob(wire, cfg.keys),
        client_name: name || undefined,
        redirect_uris: uris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
      201,
    );
  });

  return app;
}
```

`api/src/app.ts`:
```ts
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { authRoutes } from "./auth/routes.js";
import type { Config } from "./config.js";

export function createApp(cfg: Config): Hono {
  const app = new Hono();
  app.use(
    "*",
    secureHeaders({
      strictTransportSecurity: "max-age=31536000; includeSubDomains",
      xContentTypeOptions: "nosniff",
      contentSecurityPolicy: undefined,
    }),
  );
  app.get("/", (c) => c.text("fiken-mcp\n"));
  app.route("/", authRoutes(cfg));
  return app;
}
```

- [ ] **Step 4: Run tests**

Run: `cd api && npx vitest run test/auth`
Expected: pass. If `secureHeaders` rejects `contentSecurityPolicy: undefined`, remove that line; the default sets no CSP.

- [ ] **Step 5: Commit**

```bash
git add api/src/app.ts api/src/auth/clients.ts api/src/auth/routes.ts api/test/auth/clients.test.ts api/test/auth/discovery.test.ts
git commit -m "Security headers, OAuth discovery, allowlisted client registration

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Consent page, authorize, callback

**Files:**
- Create: `api/src/auth/consent.ts`
- Modify: `api/src/auth/routes.ts`
- Test: `api/test/auth/authorize.test.ts`

**Interfaces:**
- `GET /authorize` validates and renders the consent page; `POST /authorize` (form) re-validates and redirects to Fiken.
- Login state (signed, 1 h): `{ k:"s", ru, cc, cs, exp }`. Code blob (signed, 5 min): `{ k:"d", fc, fs, cc, ru, exp }`. Exported: `type CodeWire`.
- `consentPage(opts: { clientLabel: string; clientName: string; redirectHost: string; fields: Record<string,string> }): string` returns HTML with a `<form method="post" action="/authorize">` carrying the fields as hidden inputs, HTML-escaped.

- [ ] **Step 1: Failing test**

`api/test/auth/authorize.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { testConfig } from "../../src/config.js";
import { signBlob, verifyBlob } from "../../src/crypto/blob.js";
import { pkceChallenge } from "../../src/crypto/pkce.js";

const cfg = testConfig();
const app = createApp(cfg);
const CLAUDE_CB = "https://claude.ai/api/mcp/auth_callback";

async function register(name = "Claude <b>x</b>") {
  const res = await app.request("/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: name, redirect_uris: [CLAUDE_CB] }),
  });
  return (await res.json()).client_id as string;
}

function params(clientId: string, overrides: Record<string, string> = {}) {
  return {
    response_type: "code",
    client_id: clientId,
    redirect_uri: CLAUDE_CB,
    code_challenge: pkceChallenge("verifier-123"),
    code_challenge_method: "S256",
    state: "client-state",
    ...overrides,
  };
}

const get = (p: Record<string, string>) => app.request(`/authorize?${new URLSearchParams(p)}`);
const post = (p: Record<string, string>) =>
  app.request("/authorize", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(p).toString() });

describe("GET /authorize (consent)", () => {
  it("renders a consent page naming the client, with the parameters as hidden fields, escaped", async () => {
    const res = await get(params(await register()));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await res.text();
    expect(html).toContain("Claude (claude.ai)");
    expect(html).toContain("Claude &lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain('name="code_challenge"');
    expect(html).toContain('action="/authorize"');
    expect(html).toContain("fiken.no");
  });

  it("rejects an unregistered redirect uri, a bad client id and a missing challenge", async () => {
    expect((await get(params(await register(), { redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect" }))).status).toBe(400);
    expect((await get(params("garbage"))).status).toBe(400);
    expect((await get(params(await register(), { code_challenge_method: "plain" }))).status).toBe(400);
  });
});

describe("POST /authorize", () => {
  it("redirects to Fiken with a signed one-hour state", async () => {
    const res = await post(params(await register()));
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://fiken.test/oauth/authorize");
    expect(loc.searchParams.get("client_id")).toBe("test-client-id");
    expect(loc.searchParams.get("redirect_uri")).toBe("https://fiken-mcp.test/callback");
    const state = verifyBlob<Record<string, unknown>>(loc.searchParams.get("state")!, cfg.keys);
    expect(state).toMatchObject({ k: "s", ru: CLAUDE_CB, cc: pkceChallenge("verifier-123"), cs: "client-state" });
    expect(state.exp as number).toBeGreaterThan(Date.now() / 1000 + 3500);
  });

  it("re-validates everything", async () => {
    expect((await post(params("garbage"))).status).toBe(400);
    expect((await post(params(await register(), { redirect_uri: "https://evil.example/cb" }))).status).toBe(400);
  });
});

describe("GET /callback", () => {
  async function fikenState() {
    const res = await post(params(await register()));
    return new URL(res.headers.get("location")!).searchParams.get("state")!;
  }

  it("wraps Fiken's code and returns the user to the client", async () => {
    const fs = await fikenState();
    const res = await app.request(`/callback?code=FIKENCODE&state=${encodeURIComponent(fs)}`);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe(CLAUDE_CB);
    expect(loc.searchParams.get("state")).toBe("client-state");
    const code = verifyBlob<Record<string, unknown>>(loc.searchParams.get("code")!, cfg.keys);
    expect(code).toMatchObject({ k: "d", fc: "FIKENCODE", fs, cc: pkceChallenge("verifier-123"), ru: CLAUDE_CB });
    expect(code.exp as number).toBeLessThan(Date.now() / 1000 + 301);
  });

  it("passes Fiken's error back to the client", async () => {
    const fs = await fikenState();
    const res = await app.request(`/callback?error=access_denied&state=${encodeURIComponent(fs)}`);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("error")).toBe("access_denied");
    expect(loc.searchParams.get("state")).toBe("client-state");
  });

  it("shows an error page for a tampered or expired state", async () => {
    expect((await app.request("/callback?code=x&state=bad")).status).toBe(400);
    const expired = signBlob({ k: "s", ru: CLAUDE_CB, cc: "c", cs: "s", exp: 1 }, cfg.keys);
    const res = await app.request(`/callback?code=x&state=${encodeURIComponent(expired)}`);
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/expired/i);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd api && npx vitest run test/auth/authorize.test.ts`
Expected: FAIL, 404 on /authorize.

- [ ] **Step 3: Consent page**

`api/src/auth/consent.ts`:
```ts
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

export function consentPage(opts: { clientLabel: string; clientName: string; redirectHost: string; fields: Record<string, string> }): string {
  const hidden = Object.entries(opts.fields)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join("\n      ");
  const who = opts.clientName ? `${esc(opts.clientName)} via ${esc(opts.clientLabel)}` : esc(opts.clientLabel);
  return `<!doctype html>
<html lang="no">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Koble til Fiken</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 3rem auto; padding: 0 1rem; color: #222; }
    .card { border: 1px solid #ddd; border-radius: 12px; padding: 1.5rem; }
    button { font-size: 1rem; padding: .75rem 1.25rem; border-radius: 8px; border: 0; background: #5b3df5; color: #fff; }
    .cancel { background: #eee; color: #222; margin-left: .5rem; }
    .muted { color: #666; font-size: .9rem; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Koble til Fiken</h1>
    <p><strong>${who}</strong> ber om tilgang til Fiken-kontoen din gjennom Fiken MCP.</p>
    <p class="muted">Etter at du fortsetter, logger du inn hos fiken.no og godkjenner tilgangen der. Svaret sendes tilbake til ${esc(opts.redirectHost)}.</p>
    <form method="post" action="/authorize">
      ${hidden}
      <button type="submit">Fortsett til Fiken</button>
      <a class="cancel" href="javascript:history.back()"><button type="button" class="cancel">Avbryt</button></a>
    </form>
  </div>
</body>
</html>
`;
}
```

- [ ] **Step 4: Routes**

Add to the imports in `api/src/auth/routes.ts`:
```ts
import { fikenAuthorizeUrl } from "../fiken/oauth.js";
import { clientLabel } from "./clients.js";
import { consentPage } from "./consent.js";
```

Add after `readClientId`:
```ts
interface StateWire { k: "s"; ru: string; cc: string; cs: string; exp: number }
export interface CodeWire { k: "d"; fc: string; fs: string; cc: string; ru: string; exp: number }

const LOGIN_WINDOW_SECONDS = 60 * 60;
const CODE_WINDOW_SECONDS = 5 * 60;
const now = () => Math.floor(Date.now() / 1000);

interface AuthorizeRequest { redirectUri: string; codeChallenge: string; clientState: string; clientName: string }

/** Validates authorize parameters; returns an error message or the validated request. */
function validateAuthorize(cfg: Config, q: Record<string, string | undefined>): { error: string } | { ok: AuthorizeRequest } {
  if (q.response_type !== "code") return { error: "response_type must be code" };
  let client: { redirectUris: string[]; name: string };
  try {
    client = readClientId(cfg, q.client_id ?? "");
  } catch {
    return { error: "invalid client_id" };
  }
  const redirectUri = q.redirect_uri ?? "";
  if (!client.redirectUris.includes(redirectUri)) return { error: "redirect_uri not registered for this client" };
  if (q.code_challenge_method !== "S256" || !q.code_challenge) return { error: "PKCE S256 required" };
  return { ok: { redirectUri, codeChallenge: q.code_challenge, clientState: q.state ?? "", clientName: client.name } };
}

const CONSENT_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
```

Add inside `authRoutes`, before `return app;`:
```ts
  app.get("/authorize", (c) => {
    const q = c.req.query();
    const v = validateAuthorize(cfg, q);
    if ("error" in v) return c.text(v.error, 400);
    const fields: Record<string, string> = {
      response_type: "code",
      client_id: q.client_id ?? "",
      redirect_uri: v.ok.redirectUri,
      code_challenge: v.ok.codeChallenge,
      code_challenge_method: "S256",
      state: v.ok.clientState,
    };
    const html = consentPage({
      clientLabel: clientLabel(v.ok.redirectUri),
      clientName: v.ok.clientName,
      redirectHost: new URL(v.ok.redirectUri).host,
      fields,
    });
    return c.html(html, 200, { "Content-Security-Policy": CONSENT_CSP, "Cache-Control": "no-store" });
  });

  app.post("/authorize", async (c) => {
    const q = Object.fromEntries(new URLSearchParams(await c.req.text())) as Record<string, string>;
    const v = validateAuthorize(cfg, q);
    if ("error" in v) return c.text(v.error, 400);
    const state: StateWire = { k: "s", ru: v.ok.redirectUri, cc: v.ok.codeChallenge, cs: v.ok.clientState, exp: now() + LOGIN_WINDOW_SECONDS };
    return c.redirect(fikenAuthorizeUrl(cfg, signBlob(state, cfg.keys)), 302);
  });

  app.get("/callback", (c) => {
    const q = c.req.query();
    let state: StateWire;
    try {
      const wire = verifyBlob<Partial<StateWire>>(q.state ?? "", cfg.keys);
      if (wire.k !== "s" || !wire.ru || !wire.cc) throw new BlobError("invalid");
      state = wire as StateWire;
    } catch (err) {
      const why = err instanceof BlobError && err.code === "expired" ? "The login took too long and expired." : "Invalid login state.";
      return c.text(`${why} Go back to the app and connect again.`, 400);
    }
    const back = new URL(state.ru);
    if (q.error) {
      back.searchParams.set("error", q.error);
      if (q.error_description) back.searchParams.set("error_description", q.error_description);
      back.searchParams.set("state", state.cs);
      return c.redirect(back.toString(), 302);
    }
    if (!q.code) return c.text("Missing code from Fiken.", 400);
    const code: CodeWire = { k: "d", fc: q.code, fs: q.state ?? "", cc: state.cc, ru: state.ru, exp: now() + CODE_WINDOW_SECONDS };
    back.searchParams.set("code", signBlob(code, cfg.keys));
    back.searchParams.set("state", state.cs);
    return c.redirect(back.toString(), 302);
  });
```

- [ ] **Step 5: Run tests**

Run: `cd api && npx vitest run test/auth`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add api/src/auth/consent.ts api/src/auth/routes.ts api/test/auth/authorize.test.ts
git commit -m "Consent page, authorize redirect to Fiken, callback wraps the code

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Token endpoint

**Files:**
- Modify: `api/src/auth/routes.ts`
- Test: `api/test/auth/token.test.ts`

**Interfaces:**
- `POST /token`, form-encoded or JSON. Grants `authorization_code` and `refresh_token`. Responses use `issueTokens` / `renewTokens` and carry `Cache-Control: no-store`, `Pragma: no-cache`. Errors: OAuth JSON, HTTP 400.

- [ ] **Step 1: Failing test**

`api/test/auth/token.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { issueTokens, readAccessToken, readRefreshToken } from "../../src/auth/tokens.js";
import { testConfig } from "../../src/config.js";
import { signBlob } from "../../src/crypto/blob.js";
import { pkceChallenge } from "../../src/crypto/pkce.js";

const CLAUDE_CB = "https://claude.ai/api/mcp/auth_callback";

function fikenFake() {
  const calls: Array<{ url: string; body: URLSearchParams | null }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? new URLSearchParams(init.body) : null;
    calls.push({ url, body });
    if (url.endsWith("/oauth/token")) {
      if (body?.get("code") === "BAD" || body?.get("refresh_token") === "REVOKED") {
        return Response.json({ error: "invalid_grant", error_description: "no" }, { status: 400 });
      }
      const suffix = body?.get("grant_type") === "refresh_token" ? "2" : "1";
      return Response.json({ access_token: "FA" + suffix, refresh_token: "FR" + suffix, token_type: "bearer", expires_in: 86157 });
    }
    if (url.endsWith("/user")) return Response.json({ name: "Jonas", email: "jonas@example.com" });
    return new Response("unexpected " + url, { status: 500 });
  };
  return { fetchImpl, calls };
}

async function setup() {
  const fiken = fikenFake();
  const cfg = testConfig({ fetch: fiken.fetchImpl });
  const app = createApp(cfg);
  const reg = await app.request("/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [CLAUDE_CB] }),
  });
  const clientId = (await reg.json()).client_id as string;
  const codeBlob = signBlob(
    { k: "d", fc: "FIKENCODE", fs: "fstate", cc: pkceChallenge("verifier-123"), ru: CLAUDE_CB, exp: Math.floor(Date.now() / 1000) + 300 },
    cfg.keys,
  );
  return { app, cfg, clientId, codeBlob, fiken };
}

function form(fields: Record<string, string>) {
  return { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() };
}

describe("POST /token authorization_code", () => {
  it("exchanges a valid code and returns wrapped tokens with no-store", async () => {
    const { app, cfg, clientId, codeBlob, fiken } = await setup();
    const res = await app.request("/token", form({ grant_type: "authorization_code", code: codeBlob, code_verifier: "verifier-123", redirect_uri: CLAUDE_CB, client_id: clientId }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("pragma")).toBe("no-cache");
    const body = await res.json();
    expect(body.token_type).toBe("bearer");
    expect(body.expires_in).toBe(3600);
    const access = readAccessToken(cfg, body.access_token);
    expect(access.fikenAccessToken).toBe("FA1");
    expect(access.anonId).toMatch(/^[0-9a-f]{32}$/);
    expect(readRefreshToken(cfg, body.refresh_token)).toMatchObject({ fikenRefreshToken: "FR1", fikenAccessToken: "FA1", anonId: access.anonId });
    const tokenCall = fiken.calls.find((c) => c.url.endsWith("/oauth/token"));
    expect(tokenCall?.body?.get("code")).toBe("FIKENCODE");
    expect(tokenCall?.body?.get("state")).toBe("fstate");
    expect(fiken.calls.some((c) => c.url.endsWith("/user"))).toBe(true);
  });

  it("rejects a wrong verifier, wrong redirect uri, wrong client, garbage code", async () => {
    const { app, codeBlob, clientId } = await setup();
    const base = { grant_type: "authorization_code", code: codeBlob, redirect_uri: CLAUDE_CB, client_id: clientId };
    expect((await app.request("/token", form({ ...base, code_verifier: "wrong" }))).status).toBe(400);
    expect((await app.request("/token", form({ ...base, code_verifier: "verifier-123", redirect_uri: "https://evil.example/cb" }))).status).toBe(400);
    expect((await app.request("/token", form({ ...base, code_verifier: "verifier-123", client_id: "garbage" }))).status).toBe(400);
    expect((await app.request("/token", form({ ...base, code_verifier: "verifier-123", code: "garbage" }))).status).toBe(400);
  });

  it("relays Fiken's invalid_grant", async () => {
    const { app, cfg, clientId } = await setup();
    const bad = signBlob({ k: "d", fc: "BAD", fs: "s", cc: pkceChallenge("v"), ru: CLAUDE_CB, exp: Math.floor(Date.now() / 1000) + 300 }, cfg.keys);
    const res = await app.request("/token", form({ grant_type: "authorization_code", code: bad, code_verifier: "v", redirect_uri: CLAUDE_CB, client_id: clientId }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");
  });
});

describe("POST /token refresh_token", () => {
  it("renews without calling Fiken while the wrapped token is fresh", async () => {
    const { app, cfg, clientId, codeBlob, fiken } = await setup();
    const first = await (await app.request("/token", form({ grant_type: "authorization_code", code: codeBlob, code_verifier: "verifier-123", redirect_uri: CLAUDE_CB, client_id: clientId }))).json();
    const before = fiken.calls.length;
    const res = await app.request("/token", form({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: clientId }));
    expect(res.status).toBe(200);
    expect(fiken.calls.length).toBe(before);
    const body = await res.json();
    expect(readAccessToken(cfg, body.access_token)).toMatchObject({ fikenAccessToken: "FA1", anonId: readAccessToken(cfg, first.access_token).anonId });
  });

  it("calls Fiken when the wrapped token is old, and relays invalid_grant when revoked", async () => {
    const { app, cfg } = await setup();
    const old = issueTokens(cfg, { access_token: "FA0", refresh_token: "FR0", expires_in: 100 }, "anon", Math.floor(Date.now() / 1000) - 50);
    const res = await app.request("/token", form({ grant_type: "refresh_token", refresh_token: old.refresh_token }));
    expect(res.status).toBe(200);
    expect(readAccessToken(cfg, (await res.json()).access_token).fikenAccessToken).toBe("FA2");

    const revoked = issueTokens(cfg, { access_token: "x", refresh_token: "REVOKED", expires_in: 1 }, "anon", 0);
    const bad = await app.request("/token", form({ grant_type: "refresh_token", refresh_token: revoked.refresh_token }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("invalid_grant");
  });

  it("rejects unknown grant types", async () => {
    const { app } = await setup();
    const res = await app.request("/token", form({ grant_type: "password" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("unsupported_grant_type");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd api && npx vitest run test/auth/token.test.ts`
Expected: FAIL, 404 on /token.

- [ ] **Step 3: Add the route**

Add to the imports in `api/src/auth/routes.ts`:
```ts
import { anonymousId } from "./anon.js";
import { issueTokens, renewTokens } from "./tokens.js";
import { verifyPkce } from "../crypto/pkce.js";
import { FikenOAuthError, exchangeFikenCode, fetchFikenUser } from "../fiken/oauth.js";
```

Add inside `authRoutes`, before `return app;`:
```ts
  app.post("/token", async (c) => {
    const contentType = c.req.header("content-type") ?? "";
    const fields: Record<string, string> = contentType.includes("json")
      ? ((await c.req.json().catch(() => ({}))) as Record<string, string>)
      : Object.fromEntries(new URLSearchParams(await c.req.text()));
    const noStore = { "Cache-Control": "no-store", Pragma: "no-cache" };
    const oauthError = (error: string, description: string) => c.json({ error, error_description: description }, 400, noStore);

    try {
      if (fields.grant_type === "authorization_code") {
        let code: CodeWire;
        try {
          const wire = verifyBlob<Partial<CodeWire>>(fields.code ?? "", cfg.keys);
          if (wire.k !== "d" || !wire.fc || !wire.cc || !wire.ru) throw new BlobError("invalid");
          code = wire as CodeWire;
        } catch {
          return oauthError("invalid_grant", "code invalid or expired");
        }
        let client: { redirectUris: string[] };
        try {
          client = readClientId(cfg, fields.client_id ?? "");
        } catch {
          return oauthError("invalid_client", "unknown client_id");
        }
        if (fields.redirect_uri !== code.ru || !client.redirectUris.includes(code.ru)) {
          return oauthError("invalid_grant", "redirect_uri mismatch");
        }
        if (!fields.code_verifier || !verifyPkce(fields.code_verifier, code.cc)) {
          return oauthError("invalid_grant", "PKCE verification failed");
        }
        const fiken = await exchangeFikenCode(cfg, code.fc, code.fs);
        const user = await fetchFikenUser(cfg, fiken.access_token);
        return c.json(issueTokens(cfg, fiken, anonymousId(user.email, cfg.userSalt)), 200, noStore);
      }

      if (fields.grant_type === "refresh_token") {
        try {
          return c.json(await renewTokens(cfg, fields.refresh_token ?? ""), 200, noStore);
        } catch (err) {
          if (err instanceof BlobError) return oauthError("invalid_grant", "refresh token invalid");
          throw err;
        }
      }

      return oauthError("unsupported_grant_type", "use authorization_code or refresh_token");
    } catch (err) {
      if (err instanceof FikenOAuthError) return oauthError("invalid_grant", err.description ?? err.error);
      throw err;
    }
  });
```

- [ ] **Step 4: Run tests**

Run: `cd api && npx vitest run test/auth`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add api/src/auth/routes.ts api/test/auth/token.test.ts
git commit -m "Token endpoint: PKCE-checked code exchange, refresh with reuse, no-store

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: MCP endpoint and list_companies

**Files:**
- Create: `api/src/mcp/server.ts`, `api/src/mcp/tools/companies.ts`, `api/src/mcp/routes.ts`
- Modify: `api/src/app.ts`
- Test: `api/test/mcp/companies.test.ts`, `api/test/mcp/routes.test.ts`

**Interfaces:**
- `createMcpServer(ctx: ToolContext): McpServer` with `ToolContext = { fiken: FikenClient; anonId: string }`.
- Convention for later plans: each file under `src/mcp/tools/` exports `register<Name>(server: McpServer, ctx: ToolContext): void`. Consequential tools set `annotations: { destructiveHint: true }` and say in their description that the model must restate the action and get explicit user confirmation first.
- `mcpRoutes(cfg: Config): Hono`: `POST /mcp` checks the bearer before anything else; 401 carries `WWW-Authenticate: Bearer resource_metadata="<publicUrl>/.well-known/oauth-protected-resource"`; `GET`/`DELETE /mcp` are 405.
- Helpers: `toolJson(value): CallToolResult`, `toolError(err): CallToolResult` (never includes token material; `FikenError.body` is already truncated).

- [ ] **Step 1: Failing tests**

`api/test/mcp/companies.test.ts`:
```ts
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { FikenQueue, createFikenClient } from "../../src/fiken/client.js";
import { createMcpServer } from "../../src/mcp/server.js";

async function connected(fetchImpl: typeof fetch) {
  const fiken = createFikenClient({ baseUrl: "https://api.test/v2", accessToken: "tok", fetch: fetchImpl, queue: new FikenQueue(0) });
  const server = createMcpServer({ fiken, anonId: "anon" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
  return client;
}

describe("list_companies", () => {
  it("returns name, slug and organisation number", async () => {
    const client = await connected(async () =>
      Response.json([
        { name: "byJoBa AS", slug: "byjoba-as", organizationNumber: "123456789", hasApiAccess: true },
        { name: "Test", slug: "test", organizationNumber: "987654321" },
      ]),
    );
    const tools = await client.listTools();
    const tool = tools.tools.find((t) => t.name === "list_companies");
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    const result = await client.callTool({ name: "list_companies", arguments: {} });
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    expect(JSON.parse(text)).toEqual([
      { name: "byJoBa AS", slug: "byjoba-as", organizationNumber: "123456789" },
      { name: "Test", slug: "test", organizationNumber: "987654321" },
    ]);
  });

  it("reports Fiken errors as tool errors without leaking the token", async () => {
    const client = await connected(async () => new Response("denied tok", { status: 403 }));
    const result = await client.callTool({ name: "list_companies", arguments: {} });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(text).toMatch(/403/);
    expect(text).not.toMatch(/Bearer/);
  });
});
```

`api/test/mcp/routes.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { issueTokens } from "../../src/auth/tokens.js";
import { testConfig } from "../../src/config.js";

let fikenCalls = 0;
const cfg = testConfig({
  fetch: async (input) => {
    fikenCalls++;
    if (String(input).endsWith("/companies")) return Response.json([{ name: "A", slug: "a", organizationNumber: "1" }]);
    return new Response("unexpected", { status: 500 });
  },
});
const app = createApp(cfg);
const token = issueTokens(cfg, { access_token: "FA", refresh_token: "FR", expires_in: 3600 }, "anon").access_token;

function rpc(body: unknown, auth = `Bearer ${token}`) {
  return app.request("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(auth ? { authorization: auth } : {}) },
    body: JSON.stringify(body),
  });
}

describe("POST /mcp", () => {
  it("rejects missing and invalid bearer tokens before doing any work", async () => {
    const before = fikenCalls;
    const missing = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_companies", arguments: {} } }, "");
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBe('Bearer resource_metadata="https://fiken-mcp.test/.well-known/oauth-protected-resource"');
    const bad = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_companies", arguments: {} } }, "Bearer nope");
    expect(bad.status).toBe(401);
    expect(fikenCalls).toBe(before);
  });

  it("answers initialize and tools/call as JSON", async () => {
    const init = await rpc({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    });
    expect(init.status).toBe(200);
    expect(init.headers.get("content-type")).toContain("application/json");
    expect((await init.json()).result.serverInfo.name).toBe("fiken-mcp");

    const call = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_companies", arguments: {} } });
    expect(call.status).toBe(200);
    const body = await call.json();
    expect(JSON.parse(body.result.content[0].text)).toEqual([{ name: "A", slug: "a", organizationNumber: "1" }]);
  });

  it("returns 405 for GET and DELETE", async () => {
    expect((await app.request("/mcp", { headers: { authorization: `Bearer ${token}` } })).status).toBe(405);
    expect((await app.request("/mcp", { method: "DELETE", headers: { authorization: `Bearer ${token}` } })).status).toBe(405);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd api && npx vitest run test/mcp`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`api/src/mcp/tools/companies.ts`:
```ts
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { toolError, toolJson, type ToolContext } from "../server.js";

interface FikenCompany {
  name: string;
  slug: string;
  organizationNumber?: string;
}

export function registerCompanies(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "list_companies",
    {
      title: "List companies",
      description: "Lists the Fiken companies the logged-in user can access, with the slug every other tool needs as companySlug.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const companies = await ctx.fiken.json<FikenCompany[]>("/companies");
        return toolJson(companies.map((c) => ({ name: c.name, slug: c.slug, organizationNumber: c.organizationNumber })));
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
```

`api/src/mcp/server.ts`:
```ts
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { FikenError, type FikenClient } from "../fiken/client.js";
import { registerCompanies } from "./tools/companies.js";

export interface ToolContext {
  fiken: FikenClient;
  anonId: string;
}

export function toolJson(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

export function toolError(err: unknown): CallToolResult {
  const text = err instanceof FikenError ? `Fiken responded ${err.status}: ${err.body}` : `Error: ${err instanceof Error ? err.message : String(err)}`;
  return { content: [{ type: "text", text }], isError: true };
}

export function createMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: "fiken-mcp", version: "0.1.0" });
  registerCompanies(server, ctx);
  return server;
}
```

`api/src/mcp/routes.ts`:
```ts
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { Hono } from "hono";
import { readAccessToken } from "../auth/tokens.js";
import type { Config } from "../config.js";
import { createFikenClient } from "../fiken/client.js";
import { createMcpServer } from "./server.js";

export function mcpRoutes(cfg: Config): Hono {
  const app = new Hono();
  const challenge = `Bearer resource_metadata="${cfg.publicUrl}/.well-known/oauth-protected-resource"`;

  app.post("/mcp", async (c) => {
    const auth = c.req.header("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    let claims;
    try {
      claims = readAccessToken(cfg, token);
    } catch {
      return c.body("Unauthorized", 401, { "WWW-Authenticate": challenge });
    }
    const fiken = createFikenClient({ baseUrl: cfg.fikenBaseUrl, accessToken: claims.fikenAccessToken, fetch: cfg.fetch });
    const server = createMcpServer({ fiken, anonId: claims.anonId });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    const parsedBody = await c.req.json().catch(() => undefined);
    return transport.handleRequest(c.req.raw, { parsedBody });
  });

  app.on(["GET", "DELETE"], "/mcp", (c) => c.text("Method Not Allowed", 405));

  return app;
}
```

Update `api/src/app.ts` to mount it: add `import { mcpRoutes } from "./mcp/routes.js";` and `app.route("/", mcpRoutes(cfg));` after the auth routes.

- [ ] **Step 4: Run tests**

Run: `cd api && npx vitest run`
Expected: everything passes.

- [ ] **Step 5: Commit**

```bash
git add api/src/mcp api/src/app.ts api/test/mcp
git commit -m "MCP endpoint with bearer-first check and list_companies tool

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: Lambda entry, api CDK stack, Fiken types

**Files:**
- Create: `api/src/lambda.ts`, `api/bin/api.ts`, `api/lib/api-stack.ts`, `api/lib/synthesizer.ts`, `api/src/fiken/types.d.ts` (generated)
- Test: `api/test/api-stack.test.ts`

**Interfaces:**
- Lambda env: `PUBLIC_URL=https://fiken-mcp.byjoba.com`, `PARAM_PREFIX=/fiken_mcp`. Stack name `fiken-mcp-api`. Output `ApiUrl`. Log groups `/aws/lambda/fiken-mcp-api` and `/aws/apigateway/fiken-mcp-api`, 30 days. Stage throttle 20 rps, burst 40. Permissions boundary `fiken-mcp-cfn-exec` applied to the stack.

- [ ] **Step 1: Generate the Fiken types**

Run: `cd api && npm run gen:fiken-types`
Expected: `src/fiken/types.d.ts` is created. Commit it; later plans import `paths` from it.

- [ ] **Step 2: Failing stack test**

`api/test/api-stack.test.ts`:
```ts
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ApiStack } from "../lib/api-stack.js";
import { synthesizer } from "../lib/synthesizer.js";

function synth() {
  const app = new App();
  const stack = new ApiStack(app, "fiken-mcp-api", { env: { account: "209479295726", region: "eu-west-1" }, synthesizer: synthesizer() });
  return Template.fromStack(stack);
}

describe("ApiStack", () => {
  it("creates the function with reserved concurrency 1 on Node 24 arm64 and a 30-day log group", () => {
    const t = synth();
    t.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "fiken-mcp-api",
      Runtime: "nodejs24.x",
      Architectures: ["arm64"],
      ReservedConcurrentExecutions: 1,
      Environment: { Variables: { PUBLIC_URL: "https://fiken-mcp.byjoba.com", PARAM_PREFIX: "/fiken_mcp" } },
    });
    t.hasResourceProperties("AWS::Logs::LogGroup", { LogGroupName: "/aws/lambda/fiken-mcp-api", RetentionInDays: 30 });
    t.hasResourceProperties("AWS::Logs::LogGroup", { LogGroupName: "/aws/apigateway/fiken-mcp-api", RetentionInDays: 30 });
  });

  it("applies the permissions boundary to every role", () => {
    const roles = synth().findResources("AWS::IAM::Role");
    expect(Object.keys(roles).length).toBeGreaterThan(0);
    for (const role of Object.values(roles)) expect(role.Properties.PermissionsBoundary).toBeDefined();
  });

  it("grants read on exactly the four parameters", () => {
    synth().hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ["ssm:DescribeParameters", "ssm:GetParameters", "ssm:GetParameter", "ssm:GetParameterHistory"],
            Resource: [
              "arn:aws:ssm:eu-west-1:209479295726:parameter/fiken_mcp/client_id",
              "arn:aws:ssm:eu-west-1:209479295726:parameter/fiken_mcp/client_secret",
              "arn:aws:ssm:eu-west-1:209479295726:parameter/fiken_mcp/signing_key",
              "arn:aws:ssm:eu-west-1:209479295726:parameter/fiken_mcp/user_salt",
            ],
          }),
        ]),
      },
    });
  });

  it("throttles the stage and writes access logs without headers", () => {
    const t = synth();
    t.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
      StageName: "$default",
      DefaultRouteSettings: { ThrottlingRateLimit: 20, ThrottlingBurstLimit: 40 },
      AccessLogSettings: { Format: Match.stringLikeRegexp("requestId") },
    });
    const stage = Object.values(t.findResources("AWS::ApiGatewayV2::Stage"))[0]!;
    expect(String(stage.Properties.AccessLogSettings.Format)).not.toMatch(/authorization|header/i);
  });

  it("puts the api on fiken-mcp.byjoba.com", () => {
    const t = synth();
    t.hasResourceProperties("AWS::ApiGatewayV2::DomainName", { DomainName: "fiken-mcp.byjoba.com" });
    t.hasResourceProperties("AWS::CertificateManager::Certificate", { DomainName: "fiken-mcp.byjoba.com", ValidationMethod: "DNS" });
    t.hasResourceProperties("AWS::Route53::RecordSet", { Name: "fiken-mcp.byjoba.com.", Type: "A" });
    t.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "ANY /{proxy+}" });
    t.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "ANY /" });
    t.hasResourceProperties("AWS::ApiGatewayV2::Api", { DisableExecuteApiEndpoint: true });
    expect(Object.keys(t.findOutputs("ApiUrl")).length).toBe(1);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd api && npx vitest run test/api-stack.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement**

`api/lib/synthesizer.ts`:
```ts
import { DefaultStackSynthesizer } from "aws-cdk-lib";

export const QUALIFIER = "fikenmcp";

export function synthesizer(): DefaultStackSynthesizer {
  return new DefaultStackSynthesizer({ qualifier: QUALIFIER });
}
```

`api/src/lambda.ts`:
```ts
import { handle } from "hono/aws-lambda";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

// Config (including Parameter Store reads) is loaded once per container.
const handlerPromise = loadConfig().then((cfg) => handle(createApp(cfg)));

export const handler = async (event: Parameters<Awaited<typeof handlerPromise>>[0], context: Parameters<Awaited<typeof handlerPromise>>[1]) =>
  (await handlerPromise)(event, context);
```

`api/lib/api-stack.ts`:
```ts
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { AccessLogFormat } from "aws-cdk-lib/aws-apigateway";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as ssm from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import { fileURLToPath } from "node:url";

const DOMAIN = "fiken-mcp.byjoba.com";
const ZONE_NAME = "byjoba.com";
const ZONE_ID = "Z04810525CNVQNP7ALNV";
const PARAM_PREFIX = "/fiken_mcp";
const PARAM_NAMES = ["client_id", "client_secret", "signing_key", "user_salt"];
const FUNCTION_NAME = "fiken-mcp-api";
const BOUNDARY_POLICY_NAME = "fiken-mcp-cfn-exec";

export class ApiStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    iam.PermissionsBoundary.of(this).apply(
      iam.ManagedPolicy.fromManagedPolicyName(this, "Boundary", BOUNDARY_POLICY_NAME),
    );

    const logGroup = new logs.LogGroup(this, "FunctionLogs", {
      logGroupName: `/aws/lambda/${FUNCTION_NAME}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const fn = new NodejsFunction(this, "Handler", {
      functionName: FUNCTION_NAME,
      entry: fileURLToPath(new URL("../src/lambda.ts", import.meta.url)),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(30),
      reservedConcurrentExecutions: 1,
      logGroup,
      environment: { PUBLIC_URL: `https://${DOMAIN}`, PARAM_PREFIX },
      bundling: {
        format: OutputFormat.ESM,
        target: "node24",
        minify: false,
        sourceMap: true,
        banner: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      },
    });

    for (const name of PARAM_NAMES) {
      ssm.StringParameter.fromSecureStringParameterAttributes(this, `Param-${name}`, { parameterName: `${PARAM_PREFIX}/${name}` }).grantRead(fn);
    }

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", { hostedZoneId: ZONE_ID, zoneName: ZONE_NAME });
    const certificate = new acm.Certificate(this, "Certificate", { domainName: DOMAIN, validation: acm.CertificateValidation.fromDns(zone) });
    const domainName = new apigwv2.DomainName(this, "Domain", { domainName: DOMAIN, certificate });

    const api = new apigwv2.HttpApi(this, "HttpApi", {
      apiName: "fiken-mcp",
      createDefaultStage: false,
      disableExecuteApiEndpoint: true,
    });
    const integration = new HttpLambdaIntegration("LambdaIntegration", fn);
    api.addRoutes({ path: "/", methods: [apigwv2.HttpMethod.ANY], integration });
    api.addRoutes({ path: "/{proxy+}", methods: [apigwv2.HttpMethod.ANY], integration });

    const accessLogs = new logs.LogGroup(this, "AccessLogs", {
      logGroupName: `/aws/apigateway/${FUNCTION_NAME}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    // Deliberately no headers and no query string: nothing here can carry a token.
    const accessLogFormat = AccessLogFormat.custom(
      JSON.stringify({
        requestId: "$context.requestId",
        ip: "$context.identity.sourceIp",
        requestTime: "$context.requestTime",
        method: "$context.httpMethod",
        path: "$context.path",
        status: "$context.status",
        responseLength: "$context.responseLength",
        integrationError: "$context.integrationErrorMessage",
      }),
    );
    new apigwv2.HttpStage(this, "Stage", {
      httpApi: api,
      stageName: "$default",
      autoDeploy: true,
      domainMapping: { domainName },
      throttle: { rateLimit: 20, burstLimit: 40 },
      accessLogSettings: { destination: new apigwv2.LogGroupLogDestination(accessLogs), format: accessLogFormat },
    });

    new route53.ARecord(this, "AliasRecord", {
      zone,
      recordName: "fiken-mcp",
      target: route53.RecordTarget.fromAlias(new targets.ApiGatewayv2DomainProperties(domainName.regionalDomainName, domainName.regionalHostedZoneId)),
    });

    new CfnOutput(this, "ApiUrl", { value: `https://${DOMAIN}` });
  }
}
```

`api/bin/api.ts`:
```ts
import { App } from "aws-cdk-lib";
import { ApiStack } from "../lib/api-stack.js";
import { synthesizer } from "../lib/synthesizer.js";

const app = new App();
new ApiStack(app, "fiken-mcp-api", { env: { account: "209479295726", region: "eu-west-1" }, synthesizer: synthesizer() });
```

- [ ] **Step 5: Run tests, typecheck and synth**

Run: `cd api && npx vitest run && npx tsc --noEmit && npx cdk synth --quiet`
Expected: all pass; synth bundles the Lambda with esbuild and succeeds without AWS credentials. Two notes for the implementer: `HttpStage` with `stageName: "$default"` and `createDefaultStage: false` is how CDK lets us set throttling on the default stage; if the assertion on `AccessLogSettings.Format` fails because CDK stringifies differently, adjust the matcher but keep the `not.toMatch(/authorization|header/i)` check.

- [ ] **Step 6: Commit**

```bash
git add api/src/lambda.ts api/bin api/lib api/test/api-stack.test.ts api/src/fiken/types.d.ts
git commit -m "api stack: Lambda on a throttled HTTP API with access logs at fiken-mcp.byjoba.com

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 14: GitHub Actions, CODEOWNERS, Dependabot, setup checklist

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/deploy.yml`, `.github/dependabot.yml`, `CODEOWNERS`, `docs/setup.md`
- Modify: `README.md`

**Interfaces:**
- Repo variable `AWS_DEPLOY_ROLE_ARN`, GitHub Environment `production`.
- Action pins (resolved 2026-09-22): `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1` (v7.0.1), `actions/setup-node@820762786026740c76f36085b0efc47a31fe5020` (v7.0.0), `aws-actions/configure-aws-credentials@e1253824e5c10ff9df46874f81ed3ec929e19cfd` (v6.3.0).

- [ ] **Step 1: CI workflow**

`.github/workflows/ci.yml`:
```yaml
name: ci
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run synth
```

- [ ] **Step 2: Deploy workflow**

`.github/workflows/deploy.yml`:
```yaml
name: deploy
on:
  push:
    branches: [main]
permissions:
  contents: read
  id-token: write
concurrency: deploy
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - uses: aws-actions/configure-aws-credentials@e1253824e5c10ff9df46874f81ed3ec929e19cfd # v6.3.0
        with:
          role-to-assume: ${{ vars.AWS_DEPLOY_ROLE_ARN }}
          aws-region: eu-west-1
      - run: npx cdk deploy fiken-mcp-iac --require-approval never
        working-directory: iac
      - run: npx cdk deploy fiken-mcp-api --require-approval never
        working-directory: api
```

- [ ] **Step 3: Dependabot and CODEOWNERS**

`.github/dependabot.yml`:
```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
```

`CODEOWNERS`:
```
/.github/   @jonasbarsten
/iac/       @jonasbarsten
/api/lib/   @jonasbarsten
/CODEOWNERS @jonasbarsten
```

- [ ] **Step 4: Setup checklist**

`docs/setup.md`:
```markdown
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
```

- [ ] **Step 5: README**

Add a "Development" section to `README.md` after the connector section:
```markdown
## Development

```
npm install
npm test
npm run typecheck
```

`api/` is the Lambda and its CDK stack; `iac/` is the shared
infrastructure stack. Deployments run from GitHub Actions only; see
`docs/setup.md` for the one-time setup.
```

- [ ] **Step 6: Commit**

```bash
git add .github CODEOWNERS docs/setup.md README.md
git commit -m "CI and deploy workflows pinned by SHA, CODEOWNERS, Dependabot, setup checklist

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 15: First deployment and end-to-end check

No code. This task is the acceptance test for the plan.

- [ ] **Step 1: Jonas completes `docs/setup.md`**, creates the GitHub repo `jonasbarsten/fiken-mcp`, pushes the branch, opens the PR, merges it, and approves the production deployment.

- [ ] **Step 2: Verify the deploy**

```bash
curl -si https://fiken-mcp.byjoba.com/.well-known/oauth-authorization-server | head -20
```
Expected: 200, `strict-transport-security` header present, JSON with `issuer` `https://fiken-mcp.byjoba.com`.

- [ ] **Step 3: Connect from Claude**

Claude Desktop or claude.ai: Customize, Connectors, Add custom connector, URL `https://fiken-mcp.byjoba.com/mcp`, sign-in required. Expected sequence: our consent page naming Claude, then Fiken's login and consent, then back in Claude. Ask "Hvilke selskaper har jeg i Fiken?" Expected: `list_companies` is called and the companies are listed with slugs.

- [ ] **Step 4: Connect from Claude Code**

```bash
claude mcp add --transport http fiken https://fiken-mcp.byjoba.com/mcp
```
`/mcp`, authenticate (consent page names "a program on this computer"), ask the same question.

- [ ] **Step 5: Negative check**

Register a client with an unknown redirect URI and confirm the 400:
```bash
curl -s -X POST https://fiken-mcp.byjoba.com/register -H 'content-type: application/json' \
  -d '{"redirect_uris":["https://evil.example/cb"]}'
```
Expected: `{"error":"invalid_redirect_uri", ...}`.

- [ ] **Step 6: Record the result** in `docs/setup.md` under a "Verified" heading with the date, on a branch, via PR.

---

## Self-review

**Spec coverage for this plan's scope:**
- Section 4 architecture and repo layout: Tasks 1, 2, 13. CI/CD security: Task 2 (trust policy on the environment claim, qualifier, scoped execution policy, boundary), Task 14 (SHA pins, CODEOWNERS, Dependabot, environment approval, branch protection, secret scanning, 2FA in `docs/setup.md`).
- Section 5 auth: keys and key ring (Task 3, 5), allowlist (Task 9), discovery and registration (Task 9), consent and authorize (Task 10), callback (Task 10), token with PKCE, one-hour wrappers, refresh reuse and no-store (Tasks 8, 11), bearer-first MCP check with 401 metadata (Task 12). Revocation statement is in the README from the spec.
- Section 7 concurrency and abuse limits: Task 6 queue and retry, Task 13 reserved concurrency and stage throttling, Task 12 bearer before any work.
- Section 7b: logging rules and secret-refusing logger (Task 4), 30-day log groups and header-free access logs (Task 13), HSTS and no-store (Tasks 9, 11), consent CSP (Task 10), spike deletion (Task 14 setup doc). Prompt-injection prefix and destructive-tool descriptions are plan 2 and 3 items, and the tool convention in Task 12 fixes the shape. Upload magic bytes are plan 3.
- Section 8: only `list_companies` here by design.
- Section 6 table: created in Task 2; writes are plan 2.

**Placeholders:** none. Every step has its code or its exact command.

**Type consistency:** `KeyRing` and `cfg.keys` replace the earlier single key everywhere; `readClientId` returns `{ redirectUris, name }` and Task 10 uses `client.name`; `renewTokens` is used by Task 11; `issueTokens(cfg, fiken, anonId, now)` signature is the same in Tasks 8, 11 and 12; `synthesizer()` exists in both workspaces; `CodeWire` fields `fc, fs, cc, ru, exp` match between Tasks 10 and 11.

## Rulings applied during execution (2026-09-22)

The code in the repository is authoritative where it differs from the
task text above. These are the deliberate differences:

- **Task 2, execution policy.** The plan's `ApiGateway` statement
  (`apigateway:*` on every API in the region) and `Certificates`
  statement (six ACM actions on `*`) were too broad for a shared account.
  `iac/lib/exec-policy.ts` pins API Gateway to `/apis`, `/apis/*`,
  `/domainnames`, `/domainnames/*` and `/tags/*`; splits ACM into
  `acm:RequestCertificate` gated on `acm:DomainNames =
  fiken-mcp.byjoba.com` (a request-tag gate was tried first and failed
  on 2026-09-27, because CloudFormation requests the certificate
  without tags and tags it afterwards), `acm:AddTagsToCertificate` gated
  on `aws:RequestTag/Project = fiken-mcp`, unconditioned read-only
  describe/list-tags, and delete/remove-tags gated on
  `aws:ResourceTag/Project = fiken-mcp`; and moves `iam:PassRole` into
  its own statement conditioned on `iam:PassedToService =
  lambda.amazonaws.com`. A test asserts that every `Resource: "*"`
  statement carries a condition, except the read-only `DnsRead`,
  `DynamoRead` and `CertificatesRead`.
- **Tasks 2 and 13, tagging.** Both apps call
  `Tags.of(app).add("Project", "fiken-mcp")` so the tag conditions above
  hold; tests assert the tag on the table, the roles, the function and
  the certificate. The iac stack carries a small Aspect to tag the OIDC
  provider's custom-resource role, which `Tags.of()` does not reach.
- **Task 8, test.** `expect(issued.access_token).not.toContain("FA")`
  was flaky (a two-letter sentinel can occur in base64url ciphertext);
  the test issues a token with a long sentinel instead.
- **Task 10, consent page.** The `javascript:history.back()` cancel link
  is blocked by the page's own CSP. Cancel is now a plain link back to
  the client's registered redirect URI with `error=access_denied` and the
  client's `state`, which is also the OAuth-correct way to cancel.
- **Task 13, SSM grant test.** CDK emits four single-resource statements
  for the four `grantRead` calls; the test asserts that shape.
