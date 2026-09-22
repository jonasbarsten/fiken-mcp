# Fiken MCP Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deployed MCP server at `https://fiken-mcp.byjoba.com/mcp` that Claude can add as a custom connector, log into with Fiken, and call `list_companies` on.

**Architecture:** One Lambda behind an HTTP API serves OAuth discovery, dynamic client registration, a stateless authorize/callback/token flow that wraps Fiken's tokens in encrypted blobs, and a stateless MCP Streamable HTTP endpoint. A separate `iac` stack holds the DynamoDB usage table and the GitHub OIDC deploy role. Nothing is stored per user.

**Tech Stack:** TypeScript, Node 24, Hono 4 (`hono/aws-lambda`), `@modelcontextprotocol/server` 2, zod 4, AWS CDK 2 (`aws-cdk-lib` 2.270), vitest 5, esbuild via `NodejsFunction`, `@aws-sdk/client-ssm` 3.

**Spec:** `docs/superpowers/specs/2026-09-22-fiken-mcp-design.md` (sections 4, 5, 7 and the CI/CD part of 4 are implemented here; sections 6, 8 and 9 are later plans).

## Global Constraints

- Store no user data. No tokens, files or accounting data written anywhere. Only the usage table (created here, written to in plan 2).
- Secrets only in Parameter Store SecureStrings `/fiken_mcp/client_id`, `/fiken_mcp/client_secret`, `/fiken_mcp/signing_key`, `/fiken_mcp/user_salt`. Never in code, env vars, or the CloudFormation template. Load the `aws-secrets-manager` skill before touching secret handling; never fetch secret values into context.
- All Fiken calls go through `fikenFetch` (one in-process queue, 300 ms gap, one retry on 429). Lambda reserved concurrency 1.
- Region `eu-west-1`, account `209479295726`, profile `byjoba`, domain `fiken-mcp.byjoba.com`, hosted zone `byjoba.com` id `Z04810525CNVQNP7ALNV`.
- Public repo `jonasbarsten/fiken-mcp`. Feature branches and PRs; never push to `main`. Never run `cdk deploy` from a developer machine except the one documented bootstrap deploy of the `iac` stack, which Jonas runs himself.
- Never modify files through shell commands (no heredocs, `sed -i`, redirects). Use the editor tools.
- Every file change that touches `package.json` or a workflow must use the exact versions listed in Task 1; they were verified against the registries on 2026-09-22.
- Amounts from Fiken are integers in øre; pass them through unchanged.
- Commit after every task with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## File structure

```
package.json                     npm workspaces: api, iac; root scripts
tsconfig.base.json               shared compiler options
.github/workflows/ci.yml         typecheck + test + synth on PRs and pushes
.github/workflows/deploy.yml     cdk deploy from the production environment
iac/
  package.json  cdk.json  tsconfig.json
  bin/iac.ts                     CDK app entry
  lib/iac-stack.ts               DynamoDB table, GitHub OIDC provider, deploy role
  test/iac-stack.test.ts         CDK assertions
api/
  package.json  cdk.json  tsconfig.json  vitest.config.ts
  bin/api.ts                     CDK app entry
  lib/api-stack.ts               Lambda, HTTP API, domain, certificate, SSM grants
  src/lambda.ts                  Lambda entry: handle(app)
  src/app.ts                     builds the Hono app from a Config
  src/config.ts                  Config type, env + Parameter Store loader
  src/crypto/blob.ts             signed and encrypted blobs with expiry
  src/crypto/pkce.ts             S256 verification
  src/auth/anon.ts               anonymous user id
  src/auth/tokens.ts             wrap/unwrap our access and refresh tokens
  src/auth/routes.ts             discovery, register, authorize, callback, token
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
- Create: `package.json`, `tsconfig.base.json`, `api/package.json`, `api/tsconfig.json`, `api/vitest.config.ts`, `iac/package.json`, `iac/tsconfig.json`
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

If `tsc --noEmit` from TypeScript 7 rejects the project for a reason unrelated to our code, pin `typescript` to `5.9.3` instead and note it in the commit message.

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
  "app": "npx tsx bin/api.ts",
  "context": {
    "@aws-cdk/core:newStyleStackSynthesis": true
  }
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
Expected: the smoke test passes in the api workspace; iac reports no test files (that is fine until Task 2).

Run: `npm run typecheck`
Expected: passes (no source yet).

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "Scaffold npm workspaces for api and iac

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: iac stack: usage table, GitHub OIDC provider, deploy role

**Files:**
- Create: `iac/bin/iac.ts`, `iac/lib/iac-stack.ts`
- Test: `iac/test/iac-stack.test.ts`

**Interfaces:**
- Produces: CloudFormation exports `fiken-mcp-usage-table-name` and `fiken-mcp-usage-table-arn` (used by plan 2), output `DeployRoleArn` (used by Task 14).

- [ ] **Step 1: Write the failing test**

`iac/test/iac-stack.test.ts`:
```ts
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { IacStack } from "../lib/iac-stack.js";

function synth() {
  const app = new App();
  const stack = new IacStack(app, "fiken-mcp-iac", {
    env: { account: "209479295726", region: "eu-west-1" },
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
    t.hasResource("AWS::DynamoDB::GlobalTable", {
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
    });
  });

  it("creates the GitHub OIDC provider", () => {
    synth().hasResourceProperties("Custom::AWSCDKOpenIdConnectProvider", {
      Url: "https://token.actions.githubusercontent.com",
      ClientIDList: ["sts.amazonaws.com"],
    });
  });

  it("pins the deploy role to the repo's production environment", () => {
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
                "token.actions.githubusercontent.com:sub":
                  "repo:jonasbarsten/fiken-mcp:environment:production",
              },
            },
          },
        ],
      },
    });
  });

  it("lets the deploy role assume only the CDK bootstrap roles", () => {
    const t = synth();
    t.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: [
          {
            Action: "sts:AssumeRole",
            Effect: "Allow",
            Resource: "arn:aws:iam::209479295726:role/cdk-hnb659fds-*-role-209479295726-eu-west-1",
          },
        ],
      },
    });
  });

  it("exports the table name and arn", () => {
    const t = synth();
    t.hasOutput("UsageTableName", { Export: { Name: "fiken-mcp-usage-table-name" } });
    t.hasOutput("UsageTableArn", { Export: { Name: "fiken-mcp-usage-table-arn" } });
    t.hasOutput("DeployRoleArn", {});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd iac && npx vitest run`
Expected: FAIL, cannot find `../lib/iac-stack.js`.

- [ ] **Step 3: Implement the stack**

`iac/lib/iac-stack.ts`:
```ts
import { CfnOutput, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";

const GITHUB_REPO = "jonasbarsten/fiken-mcp";
const GITHUB_ENVIRONMENT = "production";

export class IacStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

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
      description: "Assumed by GitHub Actions in the production environment of " + GITHUB_REPO,
      assumedBy: new iam.OpenIdConnectPrincipal(githubProvider, {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": `repo:${GITHUB_REPO}:environment:${GITHUB_ENVIRONMENT}`,
        },
      }),
    });

    // cdk deploy only needs to assume the bootstrap roles; they carry the real permissions.
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["sts:AssumeRole"],
        resources: [`arn:aws:iam::${this.account}:role/cdk-hnb659fds-*-role-${this.account}-${this.region}`],
      }),
    );

    new CfnOutput(this, "UsageTableName", {
      value: table.tableName,
      exportName: "fiken-mcp-usage-table-name",
    });
    new CfnOutput(this, "UsageTableArn", {
      value: table.tableArn,
      exportName: "fiken-mcp-usage-table-arn",
    });
    new CfnOutput(this, "DeployRoleArn", { value: deployRole.roleArn });
  }
}
```

`iac/bin/iac.ts`:
```ts
import { App } from "aws-cdk-lib";
import { IacStack } from "../lib/iac-stack.js";

const app = new App();
new IacStack(app, "fiken-mcp-iac", {
  env: { account: "209479295726", region: "eu-west-1" },
});
```

- [ ] **Step 4: Run tests and synth**

Run: `cd iac && npx vitest run && npx cdk synth --quiet`
Expected: 5 tests pass; synth succeeds without AWS credentials.

- [ ] **Step 5: Commit**

```bash
git add iac
git commit -m "iac stack: usage table, GitHub OIDC provider, deploy role

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 6: One-off bootstrap deploy (Jonas, by hand)**

This is the only deploy ever run from a machine, because the deploy role has to exist before GitHub can deploy anything. Jonas runs, from `iac/`:

```bash
npx cdk deploy fiken-mcp-iac --profile byjoba
```

Record the `DeployRoleArn` output; Task 14 needs it.

---

### Task 3: Signed and encrypted blobs

**Files:**
- Create: `api/src/crypto/blob.ts`
- Test: `api/test/crypto/blob.test.ts`

**Interfaces:**
- Produces:
  - `signBlob(payload: object, key: Buffer): string`
  - `verifyBlob<T>(blob: string, key: Buffer, now?: number): T` throws `BlobError` on bad signature, malformed input, or `exp` (unix seconds) in the past
  - `encryptBlob(payload: object, key: Buffer): string`
  - `decryptBlob<T>(blob: string, key: Buffer, now?: number): T` same error rules
  - `class BlobError extends Error { code: "invalid" | "expired" }`
  - `keyFromHex(hex: string): Buffer` (32 bytes required)

- [ ] **Step 1: Write the failing tests**

`api/test/crypto/blob.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import {
  BlobError,
  decryptBlob,
  encryptBlob,
  keyFromHex,
  signBlob,
  verifyBlob,
} from "../../src/crypto/blob.js";

const key = keyFromHex("a".repeat(64));
const otherKey = keyFromHex("b".repeat(64));

describe("signed blobs", () => {
  it("round-trips a payload", () => {
    const blob = signBlob({ a: 1, b: "x" }, key);
    expect(verifyBlob(blob, key)).toEqual({ a: 1, b: "x" });
  });

  it("is url-safe", () => {
    const blob = signBlob({ s: "æøå/+=" }, key);
    expect(blob).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it("rejects a tampered payload", () => {
    const blob = signBlob({ a: 1 }, key);
    const [v, payload, tag] = blob.split(".");
    const forged = `${v}.${Buffer.from(JSON.stringify({ a: 2 })).toString("base64url")}.${tag}`;
    expect(() => verifyBlob(forged, key)).toThrow(BlobError);
    expect(payload).not.toBe(undefined);
  });

  it("rejects a blob signed with another key", () => {
    expect(() => verifyBlob(signBlob({ a: 1 }, otherKey), key)).toThrow(BlobError);
  });

  it("rejects garbage", () => {
    expect(() => verifyBlob("nope", key)).toThrow(BlobError);
    expect(() => verifyBlob("v1.x.y", key)).toThrow(BlobError);
  });

  it("enforces exp", () => {
    const blob = signBlob({ exp: 1000 }, key);
    expect(() => verifyBlob(blob, key, 1001)).toThrow(expect.objectContaining({ code: "expired" }));
    expect(verifyBlob(blob, key, 999)).toEqual({ exp: 1000 });
  });
});

describe("encrypted blobs", () => {
  it("round-trips and hides the payload", () => {
    const blob = encryptBlob({ token: "secret" }, key);
    expect(blob).not.toContain("secret");
    expect(Buffer.from(blob.split(".")[2] ?? "", "base64url").toString()).not.toContain("secret");
    expect(decryptBlob(blob, key)).toEqual({ token: "secret" });
  });

  it("produces different ciphertext each time", () => {
    expect(encryptBlob({ a: 1 }, key)).not.toBe(encryptBlob({ a: 1 }, key));
  });

  it("rejects the wrong key, tampering and exp", () => {
    const blob = encryptBlob({ a: 1, exp: 10 }, key);
    expect(() => decryptBlob(blob, otherKey)).toThrow(BlobError);
    expect(() => decryptBlob(blob.slice(0, -2) + "AA", key)).toThrow(BlobError);
    expect(() => decryptBlob(blob, key, 11)).toThrow(expect.objectContaining({ code: "expired" }));
  });
});

describe("keyFromHex", () => {
  it("requires 32 bytes", () => {
    expect(() => keyFromHex("abcd")).toThrow();
    expect(keyFromHex("0".repeat(64)).length).toBe(32);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd api && npx vitest run test/crypto/blob.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`api/src/crypto/blob.ts`:
```ts
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export class BlobError extends Error {
  constructor(public readonly code: "invalid" | "expired") {
    super(`blob ${code}`);
  }
}

export function keyFromHex(hex: string): Buffer {
  const key = Buffer.from(hex, "hex");
  if (key.length !== 32) throw new Error("key must be 32 bytes (64 hex chars)");
  return key;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

function checkExp(payload: unknown, now: number): void {
  if (payload && typeof payload === "object" && "exp" in payload) {
    const exp = (payload as { exp: unknown }).exp;
    if (typeof exp === "number" && exp < now) throw new BlobError("expired");
  }
}

function parse<T>(json: Buffer, now: number): T {
  let payload: unknown;
  try {
    payload = JSON.parse(json.toString("utf8"));
  } catch {
    throw new BlobError("invalid");
  }
  checkExp(payload, now);
  return payload as T;
}

export function signBlob(payload: object, key: Buffer): string {
  const body = Buffer.from(JSON.stringify(payload));
  const tag = createHmac("sha256", key).update(body).digest();
  return `v1.${body.toString("base64url")}.${tag.toString("base64url")}`;
}

export function verifyBlob<T>(blob: string, key: Buffer, now = nowSeconds()): T {
  const parts = blob.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") throw new BlobError("invalid");
  const body = Buffer.from(parts[1]!, "base64url");
  const tag = Buffer.from(parts[2]!, "base64url");
  const expected = createHmac("sha256", key).update(body).digest();
  if (tag.length !== expected.length || !timingSafeEqual(tag, expected)) throw new BlobError("invalid");
  return parse<T>(body, now);
}

export function encryptBlob(payload: object, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `v1e.${iv.toString("base64url")}.${Buffer.concat([ciphertext, authTag]).toString("base64url")}`;
}

export function decryptBlob<T>(blob: string, key: Buffer, now = nowSeconds()): T {
  const parts = blob.split(".");
  if (parts.length !== 3 || parts[0] !== "v1e") throw new BlobError("invalid");
  const iv = Buffer.from(parts[1]!, "base64url");
  const data = Buffer.from(parts[2]!, "base64url");
  if (iv.length !== 12 || data.length < 16) throw new BlobError("invalid");
  const ciphertext = data.subarray(0, data.length - 16);
  const authTag = data.subarray(data.length - 16);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
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
git commit -m "Signed and encrypted blobs with expiry

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: PKCE and anonymous ids

**Files:**
- Create: `api/src/crypto/pkce.ts`, `api/src/auth/anon.ts`
- Test: `api/test/crypto/pkce.test.ts`, `api/test/auth/anon.test.ts`

**Interfaces:**
- Produces: `pkceChallenge(verifier: string): string` (base64url SHA-256), `verifyPkce(verifier: string, challenge: string): boolean`, `anonymousId(email: string, salt: Buffer): string` (32 hex chars, lowercase-and-trim on the email).

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

- [ ] **Step 2: Run to verify failure**

Run: `cd api && npx vitest run test/crypto/pkce.test.ts test/auth/anon.test.ts`
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

- [ ] **Step 4: Run tests**

Run: `cd api && npx vitest run test/crypto/pkce.test.ts test/auth/anon.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add api/src/crypto/pkce.ts api/src/auth/anon.ts api/test/crypto/pkce.test.ts api/test/auth/anon.test.ts
git commit -m "PKCE verification and anonymous user ids

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
    publicUrl: string;            // "https://fiken-mcp.byjoba.com", no trailing slash
    fikenClientId: string;
    fikenClientSecret: string;
    signingKey: Buffer;           // 32 bytes
    userSalt: Buffer;             // 32 bytes
    fikenBaseUrl: string;         // "https://api.fiken.no/api/v2"
    fikenOAuthBaseUrl: string;    // "https://fiken.no/oauth"
    fetch: typeof fetch;          // injectable for tests
  }
  export function loadConfig(deps?: { env?: NodeJS.ProcessEnv; ssm?: SsmLike; fetch?: typeof fetch }): Promise<Config>
  export interface SsmLike { getParameters(names: string[]): Promise<Record<string, string>> }
  export function testConfig(overrides?: Partial<Config>): Config   // for tests, fixed keys
  ```
- Env consumed: `PUBLIC_URL` (required), `PARAM_PREFIX` (default `/fiken_mcp`).

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
          "/fiken_mcp/signing_key": "a".repeat(64),
          "/fiken_mcp/user_salt": "b".repeat(64),
        };
      },
    };
    const cfg = await loadConfig({ env: { PUBLIC_URL: "https://x.test/" }, ssm });
    expect(cfg.publicUrl).toBe("https://x.test");
    expect(cfg.fikenClientId).toBe("cid");
    expect(cfg.fikenClientSecret).toBe("csec");
    expect(cfg.signingKey.length).toBe(32);
    expect(cfg.userSalt.length).toBe(32);
    expect(cfg.fikenBaseUrl).toBe("https://api.fiken.no/api/v2");
    expect(asked[0]).toEqual([
      "/fiken_mcp/client_id",
      "/fiken_mcp/client_secret",
      "/fiken_mcp/signing_key",
      "/fiken_mcp/user_salt",
    ]);
  });

  it("fails on missing PUBLIC_URL or missing parameters", async () => {
    const ssm = { async getParameters() { return {}; } };
    await expect(loadConfig({ env: {}, ssm })).rejects.toThrow(/PUBLIC_URL/);
    await expect(loadConfig({ env: { PUBLIC_URL: "https://x.test" }, ssm })).rejects.toThrow(/client_id/);
  });

  it("testConfig gives usable keys", () => {
    const cfg = testConfig();
    expect(cfg.signingKey.length).toBe(32);
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
import { keyFromHex } from "./crypto/blob.js";

export interface Config {
  publicUrl: string;
  fikenClientId: string;
  fikenClientSecret: string;
  signingKey: Buffer;
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
    signingKey: keyFromHex(get("signing_key")),
    userSalt: keyFromHex(get("user_salt")),
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
    signingKey: keyFromHex("1".repeat(64)),
    userSalt: keyFromHex("2".repeat(64)),
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
git commit -m "Config loader: env plus Parameter Store

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
  export class FikenError extends Error { status: number; body: string }
  export interface FikenClient {
    fetch(path: string, init?: RequestInit): Promise<Response>;   // path relative to fikenBaseUrl, e.g. "/companies"
    json<T>(path: string, init?: RequestInit): Promise<T>;        // throws FikenError on non-2xx
  }
  export function createFikenClient(opts: { baseUrl: string; accessToken: string; fetch: typeof fetch; queue?: FikenQueue }): FikenClient
  export class FikenQueue { constructor(gapMs?: number); run<T>(fn: () => Promise<T>): Promise<T> }
  export const globalQueue: FikenQueue   // one per Lambda container, 300 ms gap
  ```
- Behaviour: every call goes through the queue (serialised, 300 ms after the previous call finished). On 429, wait 1000 ms and retry once. Sends `Authorization: Bearer <token>` and `Accept: application/json`.

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
    super(`Fiken ${status}: ${body.slice(0, 200)}`);
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

export function createFikenClient(opts: {
  baseUrl: string;
  accessToken: string;
  fetch: typeof fetch;
  queue?: FikenQueue;
}): FikenClient {
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
  export function fikenAuthorizeUrl(cfg: Config, state: string): string
  export function exchangeFikenCode(cfg: Config, code: string, state: string): Promise<FikenTokens>
  export function refreshFikenToken(cfg: Config, refreshToken: string): Promise<FikenTokens>
  export function fetchFikenUser(cfg: Config, accessToken: string): Promise<{ name: string; email: string }>
  ```
- The redirect URI is always `${cfg.publicUrl}/callback`. Token calls use HTTP Basic with client id and secret, form-encoded bodies, and go through `globalQueue`.

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
    super(`Fiken OAuth error ${error}${description ? `: ${description}` : ""}`);
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
  return tokenRequest(cfg, {
    grant_type: "authorization_code",
    code,
    redirect_uri: fikenRedirectUri(cfg),
    state,
  });
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
Expected: pass. (The global queue's 300 ms gap runs on real timers here; the suite still finishes in well under a second per test.)

- [ ] **Step 5: Commit**

```bash
git add api/src/fiken/oauth.ts api/test/fiken/oauth.test.ts
git commit -m "Fiken OAuth client: authorize url, code exchange, refresh, user

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Our tokens: wrapping Fiken tokens

**Files:**
- Create: `api/src/auth/tokens.ts`
- Test: `api/test/auth/tokens.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface AccessClaims { fikenAccessToken: string; anonId: string; exp: number }
  export interface RefreshClaims { fikenRefreshToken: string; anonId: string }
  export function issueTokens(cfg: Config, fiken: FikenTokens, anonId: string, now?: number): { access_token: string; refresh_token: string; token_type: "bearer"; expires_in: number }
  export function readAccessToken(cfg: Config, token: string, now?: number): AccessClaims   // throws BlobError
  export function readRefreshToken(cfg: Config, token: string): RefreshClaims               // throws BlobError
  ```
- Wire format inside the blobs uses short keys: access `{ t, u, exp }`, refresh `{ r, u }`. Both are encrypted blobs.

- [ ] **Step 1: Failing test**

`api/test/auth/tokens.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { issueTokens, readAccessToken, readRefreshToken } from "../../src/auth/tokens.js";
import { testConfig } from "../../src/config.js";
import { BlobError } from "../../src/crypto/blob.js";

const cfg = testConfig();

describe("tokens", () => {
  it("issues encrypted wrappers and reads them back", () => {
    const issued = issueTokens(cfg, { access_token: "FA", refresh_token: "FR", expires_in: 100 }, "anon1", 1000);
    expect(issued.token_type).toBe("bearer");
    expect(issued.expires_in).toBe(100);
    expect(issued.access_token).not.toContain("FA");
    expect(readAccessToken(cfg, issued.access_token, 1050)).toEqual({ fikenAccessToken: "FA", anonId: "anon1", exp: 1100 });
    expect(readRefreshToken(cfg, issued.refresh_token)).toEqual({ fikenRefreshToken: "FR", anonId: "anon1" });
  });

  it("access tokens expire, refresh tokens do not", () => {
    const issued = issueTokens(cfg, { access_token: "FA", refresh_token: "FR", expires_in: 100 }, "anon1", 1000);
    expect(() => readAccessToken(cfg, issued.access_token, 1101)).toThrow(BlobError);
    expect(readRefreshToken(cfg, issued.refresh_token).fikenRefreshToken).toBe("FR");
  });

  it("rejects an access token used as a refresh token", () => {
    const issued = issueTokens(cfg, { access_token: "FA", refresh_token: "FR", expires_in: 100 }, "anon1", 1000);
    expect(() => readRefreshToken(cfg, issued.access_token)).toThrow(BlobError);
    expect(() => readAccessToken(cfg, issued.refresh_token, 1000)).toThrow(BlobError);
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
import type { FikenTokens } from "../fiken/oauth.js";

export interface AccessClaims { fikenAccessToken: string; anonId: string; exp: number }
export interface RefreshClaims { fikenRefreshToken: string; anonId: string }

interface AccessWire { k: "a"; t: string; u: string; exp: number }
interface RefreshWire { k: "r"; r: string; u: string }

const nowSeconds = () => Math.floor(Date.now() / 1000);

export function issueTokens(cfg: Config, fiken: FikenTokens, anonId: string, now = nowSeconds()) {
  const access: AccessWire = { k: "a", t: fiken.access_token, u: anonId, exp: now + fiken.expires_in };
  const refresh: RefreshWire = { k: "r", r: fiken.refresh_token, u: anonId };
  return {
    access_token: encryptBlob(access, cfg.signingKey),
    refresh_token: encryptBlob(refresh, cfg.signingKey),
    token_type: "bearer" as const,
    expires_in: fiken.expires_in,
  };
}

export function readAccessToken(cfg: Config, token: string, now = nowSeconds()): AccessClaims {
  const wire = decryptBlob<Partial<AccessWire>>(token, cfg.signingKey, now);
  if (wire.k !== "a" || !wire.t || !wire.u || typeof wire.exp !== "number") throw new BlobError("invalid");
  return { fikenAccessToken: wire.t, anonId: wire.u, exp: wire.exp };
}

export function readRefreshToken(cfg: Config, token: string): RefreshClaims {
  const wire = decryptBlob<Partial<RefreshWire>>(token, cfg.signingKey);
  if (wire.k !== "r" || !wire.r || !wire.u) throw new BlobError("invalid");
  return { fikenRefreshToken: wire.r, anonId: wire.u };
}
```

- [ ] **Step 4: Run tests**

Run: `cd api && npx vitest run test/auth/tokens.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add api/src/auth/tokens.ts api/test/auth/tokens.test.ts
git commit -m "Wrap Fiken tokens in encrypted access and refresh tokens

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Hono app, discovery documents, client registration

**Files:**
- Create: `api/src/app.ts`, `api/src/auth/routes.ts`
- Test: `api/test/auth/discovery.test.ts`

**Interfaces:**
- Produces: `createApp(cfg: Config): Hono` in `app.ts`; `authRoutes(cfg: Config): Hono` in `auth/routes.ts` mounted at `/`. Client id wire format: signed blob `{ k: "c", ru: string[], iat: number }`. Helper exported for later tasks: `readClientId(cfg, clientId): { redirectUris: string[] }` (throws `BlobError`).
- Registration accepts redirect URIs that are `https://…`, or `http://localhost…` / `http://127.0.0.1…` (Claude Code's loopback).

- [ ] **Step 1: Failing test**

`api/test/auth/discovery.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { readClientId } from "../../src/auth/routes.js";
import { testConfig } from "../../src/config.js";

const cfg = testConfig();
const app = createApp(cfg);

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
    expect(res.status).toBe(200);
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
  it("returns a signed client id carrying the redirect uris", async () => {
    const res = await app.request("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.redirect_uris).toEqual(["https://claude.ai/api/mcp/auth_callback"]);
    expect(body.token_endpoint_auth_method).toBe("none");
    expect(body.client_secret).toBeUndefined();
    expect(readClientId(cfg, body.client_id)).toEqual({ redirectUris: ["https://claude.ai/api/mcp/auth_callback"] });
  });

  it("accepts loopback http and rejects other http", async () => {
    const ok = await app.request("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://localhost:3000/cb", "http://127.0.0.1:5555/cb"] }),
    });
    expect(ok.status).toBe(201);
    const bad = await app.request("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }),
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("invalid_redirect_uri");
  });

  it("rejects missing redirect uris", async () => {
    const res = await app.request("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "x" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_client_metadata");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd api && npx vitest run test/auth/discovery.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`api/src/auth/routes.ts` (this task adds discovery and register; Tasks 10 and 11 extend the same file):
```ts
import { Hono } from "hono";
import type { Config } from "../config.js";
import { BlobError, signBlob, verifyBlob } from "../crypto/blob.js";

interface ClientWire { k: "c"; ru: string[]; iat: number }

export function readClientId(cfg: Config, clientId: string): { redirectUris: string[] } {
  const wire = verifyBlob<Partial<ClientWire>>(clientId, cfg.signingKey);
  if (wire.k !== "c" || !Array.isArray(wire.ru)) throw new BlobError("invalid");
  return { redirectUris: wire.ru };
}

function isAllowedRedirect(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
}

export function authRoutes(cfg: Config): Hono {
  const app = new Hono();

  app.get("/.well-known/oauth-protected-resource", (c) =>
    c.json({
      resource: `${cfg.publicUrl}/mcp`,
      authorization_servers: [cfg.publicUrl],
      bearer_methods_supported: ["header"],
    }),
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
    if (!uris.every(isAllowedRedirect)) {
      return c.json({ error: "invalid_redirect_uri", error_description: "redirect_uris must be https or loopback http" }, 400);
    }
    const wire: ClientWire = { k: "c", ru: uris, iat: Math.floor(Date.now() / 1000) };
    return c.json(
      {
        client_id: signBlob(wire, cfg.signingKey),
        client_name: typeof body.client_name === "string" ? body.client_name : undefined,
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
import { authRoutes } from "./auth/routes.js";
import type { Config } from "./config.js";

export function createApp(cfg: Config): Hono {
  const app = new Hono();
  app.get("/", (c) => c.text("fiken-mcp\n"));
  app.route("/", authRoutes(cfg));
  return app;
}
```

- [ ] **Step 4: Run tests**

Run: `cd api && npx vitest run test/auth/discovery.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add api/src/app.ts api/src/auth/routes.ts api/test/auth/discovery.test.ts
git commit -m "OAuth discovery documents and stateless client registration

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Authorize and callback

**Files:**
- Modify: `api/src/auth/routes.ts`
- Test: `api/test/auth/authorize.test.ts`

**Interfaces:**
- Login state (signed, 1 h): `{ k: "s", ru, cc, cs, exp }` = client redirect URI, PKCE challenge, client state.
- Code blob (signed, 5 min): `{ k: "d", fc, fs, cc, ru, exp }` = Fiken code, the exact Fiken state string, PKCE challenge, client redirect URI.
- Exported for Task 11 tests: `type CodeWire = { k: "d"; fc: string; fs: string; cc: string; ru: string; exp: number }`.

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

async function register() {
  const res = await app.request("/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [CLAUDE_CB] }),
  });
  return (await res.json()).client_id as string;
}

function authorizeUrl(clientId: string, overrides: Record<string, string> = {}) {
  const p = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CLAUDE_CB,
    code_challenge: pkceChallenge("verifier-123"),
    code_challenge_method: "S256",
    state: "client-state",
    ...overrides,
  });
  return `/authorize?${p}`;
}

describe("authorize", () => {
  it("redirects to Fiken with a signed state", async () => {
    const res = await app.request(authorizeUrl(await register()));
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://fiken.test/oauth/authorize");
    expect(loc.searchParams.get("client_id")).toBe("test-client-id");
    expect(loc.searchParams.get("redirect_uri")).toBe("https://fiken-mcp.test/callback");
    const state = verifyBlob<Record<string, unknown>>(loc.searchParams.get("state")!, cfg.signingKey);
    expect(state).toMatchObject({ k: "s", ru: CLAUDE_CB, cc: pkceChallenge("verifier-123"), cs: "client-state" });
    expect(state.exp as number).toBeGreaterThan(Date.now() / 1000 + 3500);
  });

  it("rejects an unregistered redirect uri", async () => {
    const res = await app.request(authorizeUrl(await register(), { redirect_uri: "https://evil.example/cb" }));
    expect(res.status).toBe(400);
  });

  it("rejects a bad client id and a missing challenge", async () => {
    expect((await app.request(authorizeUrl("garbage"))).status).toBe(400);
    expect((await app.request(authorizeUrl(await register(), { code_challenge_method: "plain" }))).status).toBe(400);
  });
});

describe("callback", () => {
  it("wraps Fiken's code and returns the user to the client", async () => {
    const auth = await app.request(authorizeUrl(await register()));
    const fikenState = new URL(auth.headers.get("location")!).searchParams.get("state")!;
    const res = await app.request(`/callback?code=FIKENCODE&state=${encodeURIComponent(fikenState)}`);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe(CLAUDE_CB);
    expect(loc.searchParams.get("state")).toBe("client-state");
    const code = verifyBlob<Record<string, unknown>>(loc.searchParams.get("code")!, cfg.signingKey);
    expect(code).toMatchObject({ k: "d", fc: "FIKENCODE", fs: fikenState, cc: pkceChallenge("verifier-123"), ru: CLAUDE_CB });
    expect(code.exp as number).toBeLessThan(Date.now() / 1000 + 301);
  });

  it("passes Fiken's error back to the client", async () => {
    const auth = await app.request(authorizeUrl(await register()));
    const fikenState = new URL(auth.headers.get("location")!).searchParams.get("state")!;
    const res = await app.request(`/callback?error=access_denied&state=${encodeURIComponent(fikenState)}`);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("error")).toBe("access_denied");
    expect(loc.searchParams.get("state")).toBe("client-state");
  });

  it("shows an error page for a tampered or expired state", async () => {
    expect((await app.request("/callback?code=x&state=bad")).status).toBe(400);
    const expired = signBlob({ k: "s", ru: CLAUDE_CB, cc: "c", cs: "s", exp: 1 }, cfg.signingKey);
    const res = await app.request(`/callback?code=x&state=${encodeURIComponent(expired)}`);
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/expired/i);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd api && npx vitest run test/auth/authorize.test.ts`
Expected: FAIL, 404 on /authorize.

- [ ] **Step 3: Add the routes**

Add to `api/src/auth/routes.ts`, after the imports:
```ts
import { fikenAuthorizeUrl } from "../fiken/oauth.js";

interface StateWire { k: "s"; ru: string; cc: string; cs: string; exp: number }
export interface CodeWire { k: "d"; fc: string; fs: string; cc: string; ru: string; exp: number }

const LOGIN_WINDOW_SECONDS = 60 * 60;
const CODE_WINDOW_SECONDS = 5 * 60;
const now = () => Math.floor(Date.now() / 1000);
```

Add inside `authRoutes`, before `return app;`:
```ts
  app.get("/authorize", (c) => {
    const q = c.req.query();
    if (q.response_type !== "code") return c.text("response_type must be code", 400);
    let client: { redirectUris: string[] };
    try {
      client = readClientId(cfg, q.client_id ?? "");
    } catch {
      return c.text("invalid client_id", 400);
    }
    const redirectUri = q.redirect_uri ?? "";
    if (!client.redirectUris.includes(redirectUri)) return c.text("redirect_uri not registered", 400);
    if (q.code_challenge_method !== "S256" || !q.code_challenge) return c.text("PKCE S256 required", 400);
    const state: StateWire = {
      k: "s",
      ru: redirectUri,
      cc: q.code_challenge,
      cs: q.state ?? "",
      exp: now() + LOGIN_WINDOW_SECONDS,
    };
    return c.redirect(fikenAuthorizeUrl(cfg, signBlob(state, cfg.signingKey)), 302);
  });

  app.get("/callback", (c) => {
    const q = c.req.query();
    let state: StateWire;
    try {
      const wire = verifyBlob<Partial<StateWire>>(q.state ?? "", cfg.signingKey);
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
    const code: CodeWire = {
      k: "d",
      fc: q.code,
      fs: q.state ?? "",
      cc: state.cc,
      ru: state.ru,
      exp: now() + CODE_WINDOW_SECONDS,
    };
    back.searchParams.set("code", signBlob(code, cfg.signingKey));
    back.searchParams.set("state", state.cs);
    return c.redirect(back.toString(), 302);
  });
```

- [ ] **Step 4: Run tests**

Run: `cd api && npx vitest run test/auth`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add api/src/auth/routes.ts api/test/auth/authorize.test.ts
git commit -m "Authorize redirects to Fiken; callback wraps the code for the client

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Token endpoint

**Files:**
- Modify: `api/src/auth/routes.ts`
- Test: `api/test/auth/token.test.ts`

**Interfaces:**
- `POST /token` accepts `application/x-www-form-urlencoded` (also JSON). Grants: `authorization_code` (code, code_verifier, redirect_uri, client_id) and `refresh_token` (refresh_token). Responses use `issueTokens`. Errors are OAuth error JSON with HTTP 400: `invalid_grant`, `invalid_request`, `invalid_client`, `unsupported_grant_type`.

- [ ] **Step 1: Failing test**

`api/test/auth/token.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { readAccessToken, readRefreshToken } from "../../src/auth/tokens.js";
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
    cfg.signingKey,
  );
  return { app, cfg, clientId, codeBlob, fiken };
}

function form(fields: Record<string, string>) {
  return { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() };
}

describe("POST /token authorization_code", () => {
  it("exchanges a valid code and returns wrapped tokens", async () => {
    const { app, cfg, clientId, codeBlob, fiken } = await setup();
    const res = await app.request("/token", form({ grant_type: "authorization_code", code: codeBlob, code_verifier: "verifier-123", redirect_uri: CLAUDE_CB, client_id: clientId }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token_type).toBe("bearer");
    expect(body.expires_in).toBe(86157);
    const access = readAccessToken(cfg, body.access_token);
    expect(access.fikenAccessToken).toBe("FA1");
    expect(access.anonId).toMatch(/^[0-9a-f]{32}$/);
    expect(readRefreshToken(cfg, body.refresh_token)).toEqual({ fikenRefreshToken: "FR1", anonId: access.anonId });
    const tokenCall = fiken.calls.find((c) => c.url.endsWith("/oauth/token"));
    expect(tokenCall?.body?.get("code")).toBe("FIKENCODE");
    expect(tokenCall?.body?.get("state")).toBe("fstate");
    expect(fiken.calls.some((c) => c.url.endsWith("/user"))).toBe(true);
  });

  it("rejects a wrong verifier, wrong redirect uri, wrong client", async () => {
    const { app, codeBlob, clientId } = await setup();
    const base = { grant_type: "authorization_code", code: codeBlob, redirect_uri: CLAUDE_CB, client_id: clientId };
    expect((await app.request("/token", form({ ...base, code_verifier: "wrong" }))).status).toBe(400);
    expect((await app.request("/token", form({ ...base, code_verifier: "verifier-123", redirect_uri: "https://evil.example/cb" }))).status).toBe(400);
    expect((await app.request("/token", form({ ...base, code_verifier: "verifier-123", client_id: "garbage" }))).status).toBe(400);
    expect((await app.request("/token", form({ ...base, code_verifier: "verifier-123", code: "garbage" }))).status).toBe(400);
  });

  it("relays Fiken's invalid_grant", async () => {
    const { app, cfg, clientId } = await setup();
    const bad = signBlob({ k: "d", fc: "BAD", fs: "s", cc: pkceChallenge("v"), ru: CLAUDE_CB, exp: Math.floor(Date.now() / 1000) + 300 }, cfg.signingKey);
    const res = await app.request("/token", form({ grant_type: "authorization_code", code: bad, code_verifier: "v", redirect_uri: CLAUDE_CB, client_id: clientId }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");
  });
});

describe("POST /token refresh_token", () => {
  it("refreshes and keeps the anonymous id", async () => {
    const { app, cfg, clientId, codeBlob } = await setup();
    const first = await (await app.request("/token", form({ grant_type: "authorization_code", code: codeBlob, code_verifier: "verifier-123", redirect_uri: CLAUDE_CB, client_id: clientId }))).json();
    const res = await app.request("/token", form({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: clientId }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(readAccessToken(cfg, body.access_token)).toMatchObject({ fikenAccessToken: "FA2", anonId: readAccessToken(cfg, first.access_token).anonId });
    expect(readRefreshToken(cfg, body.refresh_token).fikenRefreshToken).toBe("FR2");
  });

  it("returns invalid_grant when Fiken rejects the refresh", async () => {
    const { app, cfg } = await setup();
    const { issueTokens } = await import("../../src/auth/tokens.js");
    const revoked = issueTokens(cfg, { access_token: "x", refresh_token: "REVOKED", expires_in: 1 }, "anon", 0);
    const res = await app.request("/token", form({ grant_type: "refresh_token", refresh_token: revoked.refresh_token }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");
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
import { issueTokens, readRefreshToken } from "./tokens.js";
import { verifyPkce } from "../crypto/pkce.js";
import { FikenOAuthError, exchangeFikenCode, fetchFikenUser, refreshFikenToken } from "../fiken/oauth.js";
```

Add inside `authRoutes`, before `return app;`:
```ts
  app.post("/token", async (c) => {
    const contentType = c.req.header("content-type") ?? "";
    const fields: Record<string, string> = contentType.includes("json")
      ? ((await c.req.json().catch(() => ({}))) as Record<string, string>)
      : Object.fromEntries(new URLSearchParams(await c.req.text()));
    const oauthError = (error: string, description: string) =>
      c.json({ error, error_description: description }, 400);

    try {
      if (fields.grant_type === "authorization_code") {
        let code: CodeWire;
        try {
          const wire = verifyBlob<Partial<CodeWire>>(fields.code ?? "", cfg.signingKey);
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
        return c.json(issueTokens(cfg, fiken, anonymousId(user.email, cfg.userSalt)));
      }

      if (fields.grant_type === "refresh_token") {
        let claims;
        try {
          claims = readRefreshToken(cfg, fields.refresh_token ?? "");
        } catch {
          return oauthError("invalid_grant", "refresh token invalid");
        }
        const fiken = await refreshFikenToken(cfg, claims.fikenRefreshToken);
        return c.json(issueTokens(cfg, fiken, claims.anonId));
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
git commit -m "Token endpoint: PKCE-checked code exchange and refresh via Fiken

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: MCP endpoint and list_companies

**Files:**
- Create: `api/src/mcp/server.ts`, `api/src/mcp/tools/companies.ts`, `api/src/mcp/routes.ts`
- Modify: `api/src/app.ts`
- Test: `api/test/mcp/companies.test.ts`, `api/test/mcp/routes.test.ts`

**Interfaces:**
- `createMcpServer(ctx: ToolContext): McpServer` where `ToolContext = { fiken: FikenClient; anonId: string }`.
- Tool registration convention for later plans: each file under `src/mcp/tools/` exports `register<Name>(server: McpServer, ctx: ToolContext): void`.
- `mcpRoutes(cfg: Config): Hono` mounts `POST /mcp`; missing or invalid bearer returns 401 with `WWW-Authenticate: Bearer resource_metadata="<publicUrl>/.well-known/oauth-protected-resource"`; `GET /mcp` and `DELETE /mcp` return 405.
- Tool results: `{ content: [{ type: "text", text }] }`; errors `{ content: [{ type: "text", text }], isError: true }`.

- [ ] **Step 1: Failing tests**

`api/test/mcp/companies.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { FikenQueue, createFikenClient } from "../../src/fiken/client.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";

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
    expect(tools.tools.map((t) => t.name)).toContain("list_companies");
    const result = await client.callTool({ name: "list_companies", arguments: {} });
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    expect(JSON.parse(text)).toEqual([
      { name: "byJoBa AS", slug: "byjoba-as", organizationNumber: "123456789" },
      { name: "Test", slug: "test", organizationNumber: "987654321" },
    ]);
  });

  it("reports Fiken errors as tool errors", async () => {
    const client = await connected(async () => new Response("denied", { status: 403 }));
    const result = await client.callTool({ name: "list_companies", arguments: {} });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]?.text).toMatch(/403/);
  });
});
```

`api/test/mcp/routes.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { issueTokens } from "../../src/auth/tokens.js";
import { testConfig } from "../../src/config.js";

const cfg = testConfig({
  fetch: async (input) => {
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
  it("rejects missing and invalid bearer tokens with resource metadata", async () => {
    const missing = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, "");
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBe('Bearer resource_metadata="https://fiken-mcp.test/.well-known/oauth-protected-resource"');
    const bad = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, "Bearer nope");
    expect(bad.status).toBe(401);
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

- [ ] **Step 2: Add the client package for tests and run to verify failure**

Add to `api/package.json` devDependencies: `"@modelcontextprotocol/client": "2.0.0"`. Run `npm install` at the root.

Run: `cd api && npx vitest run test/mcp`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`api/src/mcp/tools/companies.ts`:
```ts
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ToolContext } from "../server.js";
import { toolError, toolJson } from "../server.js";

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
      description:
        "Lists the Fiken companies the logged-in user can access, with the slug that every other tool needs as companySlug.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const companies = await ctx.fiken.json<FikenCompany[]>("/companies");
        return toolJson(
          companies.map((c) => ({ name: c.name, slug: c.slug, organizationNumber: c.organizationNumber })),
        );
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
```

`api/src/mcp/server.ts`:
```ts
import { McpServer } from "@modelcontextprotocol/server";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { FikenClient } from "../fiken/client.js";
import { FikenError } from "../fiken/client.js";
import { registerCompanies } from "./tools/companies.js";

export interface ToolContext {
  fiken: FikenClient;
  anonId: string;
}

export function toolJson(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

export function toolError(err: unknown): CallToolResult {
  const text = err instanceof FikenError ? `Fiken responded ${err.status}: ${err.body}` : `Error: ${String(err)}`;
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
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    const parsedBody = await c.req.json().catch(() => undefined);
    return transport.handleRequest(c.req.raw, { parsedBody });
  });

  app.on(["GET", "DELETE"], "/mcp", (c) => c.text("Method Not Allowed", 405));

  return app;
}
```

Update `api/src/app.ts`:
```ts
import { Hono } from "hono";
import { authRoutes } from "./auth/routes.js";
import type { Config } from "./config.js";
import { mcpRoutes } from "./mcp/routes.js";

export function createApp(cfg: Config): Hono {
  const app = new Hono();
  app.get("/", (c) => c.text("fiken-mcp\n"));
  app.route("/", authRoutes(cfg));
  app.route("/", mcpRoutes(cfg));
  return app;
}
```

- [ ] **Step 4: Run tests**

Run: `cd api && npx vitest run`
Expected: everything passes. If `InMemoryTransport` is not exported from `@modelcontextprotocol/server` in the installed version, import it from `@modelcontextprotocol/core` instead (it is exported there as well); do not change the test's behaviour.

- [ ] **Step 5: Commit**

```bash
git add api/src/mcp api/src/app.ts api/test/mcp api/package.json package-lock.json
git commit -m "MCP endpoint with bearer check and list_companies tool

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: Lambda entry, api CDK stack, Fiken types

**Files:**
- Create: `api/src/lambda.ts`, `api/bin/api.ts`, `api/lib/api-stack.ts`, `api/src/fiken/types.d.ts` (generated)
- Test: `api/test/api-stack.test.ts`

**Interfaces:**
- Lambda env: `PUBLIC_URL=https://fiken-mcp.byjoba.com`, `PARAM_PREFIX=/fiken_mcp`.
- Stack name `fiken-mcp-api`. Output `ApiUrl`.

- [ ] **Step 1: Generate the Fiken types**

Run: `cd api && npm run gen:fiken-types`
Expected: `src/fiken/types.d.ts` is created (large). Commit it; later plans import `paths` from it.

- [ ] **Step 2: Failing stack test**

`api/test/api-stack.test.ts`:
```ts
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ApiStack } from "../lib/api-stack.js";

function synth() {
  const app = new App();
  const stack = new ApiStack(app, "fiken-mcp-api", { env: { account: "209479295726", region: "eu-west-1" } });
  return Template.fromStack(stack);
}

describe("ApiStack", () => {
  it("creates the function with reserved concurrency 1 on Node 24 arm64", () => {
    synth().hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs24.x",
      Architectures: ["arm64"],
      ReservedConcurrentExecutions: 1,
      Environment: { Variables: { PUBLIC_URL: "https://fiken-mcp.byjoba.com", PARAM_PREFIX: "/fiken_mcp" } },
    });
  });

  it("grants read on exactly the four parameters", () => {
    const t = synth();
    t.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: [
          {
            Action: ["ssm:DescribeParameters", "ssm:GetParameters", "ssm:GetParameter", "ssm:GetParameterHistory"],
            Effect: "Allow",
            Resource: [
              "arn:aws:ssm:eu-west-1:209479295726:parameter/fiken_mcp/client_id",
              "arn:aws:ssm:eu-west-1:209479295726:parameter/fiken_mcp/client_secret",
              "arn:aws:ssm:eu-west-1:209479295726:parameter/fiken_mcp/signing_key",
              "arn:aws:ssm:eu-west-1:209479295726:parameter/fiken_mcp/user_salt",
            ],
          },
        ],
      },
    });
  });

  it("puts the api on fiken-mcp.byjoba.com", () => {
    const t = synth();
    t.hasResourceProperties("AWS::ApiGatewayV2::DomainName", { DomainName: "fiken-mcp.byjoba.com" });
    t.hasResourceProperties("AWS::CertificateManager::Certificate", { DomainName: "fiken-mcp.byjoba.com", ValidationMethod: "DNS" });
    t.hasResourceProperties("AWS::Route53::RecordSet", { Name: "fiken-mcp.byjoba.com.", Type: "A" });
    t.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "ANY /{proxy+}" });
    t.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "ANY /" });
    expect(Object.keys(t.findOutputs("ApiUrl")).length).toBe(1);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd api && npx vitest run test/api-stack.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement**

`api/src/lambda.ts`:
```ts
import { handle } from "hono/aws-lambda";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

// Config (including Parameter Store reads) is loaded once per container.
const appPromise = loadConfig().then((cfg) => handle(createApp(cfg)));

export const handler = async (event: Parameters<Awaited<typeof appPromise>>[0], context: Parameters<Awaited<typeof appPromise>>[1]) =>
  (await appPromise)(event, context);
```

`api/lib/api-stack.ts`:
```ts
import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
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

export class ApiStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    const fn = new NodejsFunction(this, "Handler", {
      entry: fileURLToPath(new URL("../src/lambda.ts", import.meta.url)),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(30),
      reservedConcurrentExecutions: 1,
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
      ssm.StringParameter.fromSecureStringParameterAttributes(this, `Param-${name}`, {
        parameterName: `${PARAM_PREFIX}/${name}`,
      }).grantRead(fn);
    }

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", { hostedZoneId: ZONE_ID, zoneName: ZONE_NAME });
    const certificate = new acm.Certificate(this, "Certificate", {
      domainName: DOMAIN,
      validation: acm.CertificateValidation.fromDns(zone),
    });
    const domainName = new apigwv2.DomainName(this, "Domain", { domainName: DOMAIN, certificate });

    const api = new apigwv2.HttpApi(this, "HttpApi", {
      apiName: "fiken-mcp",
      defaultDomainMapping: { domainName },
      disableExecuteApiEndpoint: true,
    });
    const integration = new HttpLambdaIntegration("LambdaIntegration", fn);
    api.addRoutes({ path: "/", methods: [apigwv2.HttpMethod.ANY], integration });
    api.addRoutes({ path: "/{proxy+}", methods: [apigwv2.HttpMethod.ANY], integration });

    new route53.ARecord(this, "AliasRecord", {
      zone,
      recordName: "fiken-mcp",
      target: route53.RecordTarget.fromAlias(
        new targets.ApiGatewayv2DomainProperties(domainName.regionalDomainName, domainName.regionalHostedZoneId),
      ),
    });

    new CfnOutput(this, "ApiUrl", { value: `https://${DOMAIN}` });
  }
}
```

`api/bin/api.ts`:
```ts
import { App } from "aws-cdk-lib";
import { ApiStack } from "../lib/api-stack.js";

const app = new App();
new ApiStack(app, "fiken-mcp-api", { env: { account: "209479295726", region: "eu-west-1" } });
```

- [ ] **Step 5: Run tests, typecheck and synth**

Run: `cd api && npx vitest run && npx tsc --noEmit && npx cdk synth --quiet`
Expected: all pass; synth bundles the Lambda with esbuild and succeeds without AWS credentials. If the SSM grant assertion fails only on the exact action list, copy the action list the synthesized template actually contains into the test; the resources list must stay exactly those four parameters.

- [ ] **Step 6: Commit**

```bash
git add api/src/lambda.ts api/bin api/lib api/test/api-stack.test.ts api/src/fiken/types.d.ts
git commit -m "api stack: Lambda on HTTP API at fiken-mcp.byjoba.com; generated Fiken types

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 14: GitHub Actions and the manual setup checklist

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/deploy.yml`, `docs/setup.md`
- Modify: `README.md`

**Interfaces:**
- Repo variable `AWS_DEPLOY_ROLE_ARN` (the `DeployRoleArn` output from Task 2), GitHub Environment `production`.

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
      - uses: actions/checkout@v7.0.1
      - uses: actions/setup-node@v7.0.0
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
      - uses: actions/checkout@v7.0.1
      - uses: actions/setup-node@v7.0.0
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - uses: aws-actions/configure-aws-credentials@v6.3.0
        with:
          role-to-assume: ${{ vars.AWS_DEPLOY_ROLE_ARN }}
          aws-region: eu-west-1
      - run: npx cdk deploy fiken-mcp-iac --require-approval never
        working-directory: iac
      - run: npx cdk deploy fiken-mcp-api --require-approval never
        working-directory: api
```

- [ ] **Step 3: Setup checklist**

`docs/setup.md`:
```markdown
# One-time setup

Everything here is done once by Jonas. Nothing in it needs repeating for
normal development.

## AWS (byjoba, eu-west-1)

1. Parameter Store SecureStrings (`/fiken_mcp/client_id` and
   `/fiken_mcp/client_secret` already exist):
   - `/fiken_mcp/signing_key`: 64 hex characters from `openssl rand -hex 32`
   - `/fiken_mcp/user_salt`: 64 hex characters from `openssl rand -hex 32`
   Create them in the console or with `aws ssm put-parameter --type SecureString`.
   Never paste the values anywhere else.
2. Deploy the iac stack once from a machine (the deploy role must exist
   before GitHub can deploy): `cd iac && npx cdk deploy fiken-mcp-iac --profile byjoba`.
   Note the `DeployRoleArn` output.

## GitHub (jonasbarsten/fiken-mcp)

1. Settings, Environments, New environment `production`:
   - Required reviewers: jonasbarsten
   - Deployment branches: selected branches, `main` only
2. Settings, Secrets and variables, Actions, Variables:
   `AWS_DEPLOY_ROLE_ARN` = the DeployRoleArn output.
3. Settings, Branches, add rule for `main`: require a pull request,
   require 1 approving review, require status checks (`check`), block
   direct pushes.
4. Settings, Actions, General: workflow permissions read-only; "Require
   approval for all outside collaborators".

## Fiken

In the "Fiken MCP" app under Rediger konto, API: add redirect URI
`https://fiken-mcp.byjoba.com/callback`. Add each tester's Fiken login
under "Godkjente brukere" while the app is in development status.

## First deploy

Merge the first PR to `main`, approve the `production` deployment when
GitHub asks, and watch the `deploy` workflow. The certificate validation
step can take a few minutes on the first run.
```

- [ ] **Step 4: README**

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

- [ ] **Step 5: Commit**

```bash
git add .github docs/setup.md README.md
git commit -m "CI and deploy workflows; one-time setup checklist

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 15: First deployment and end-to-end check

No code. This task is the acceptance test for the plan.

- [ ] **Step 1: Jonas completes `docs/setup.md`**, creates the GitHub repo `jonasbarsten/fiken-mcp`, pushes the branch, opens the PR, merges it, and approves the production deployment.

- [ ] **Step 2: Verify the deploy**

Run from anywhere:
```bash
curl -s https://fiken-mcp.byjoba.com/.well-known/oauth-authorization-server
```
Expected: the metadata JSON with `issuer` `https://fiken-mcp.byjoba.com`.

- [ ] **Step 3: Connect from Claude**

In Claude Desktop or claude.ai: Customize, Connectors, Add custom connector, URL `https://fiken-mcp.byjoba.com/mcp`, sign-in required. Claude registers, opens Fiken's login, and returns. Ask "Hvilke selskaper har jeg i Fiken?" Expected: Claude calls `list_companies` and lists the companies with slugs.

- [ ] **Step 4: Connect from Claude Code**

```bash
claude mcp add --transport http fiken https://fiken-mcp.byjoba.com/mcp
```
Then `/mcp` in Claude Code, authenticate, and ask the same question.

- [ ] **Step 5: Record the result** in `docs/setup.md` under a "Verified" heading with the date, then commit on a branch and open a PR.

---

## Self-review

**Spec coverage for this plan's scope:**
- Section 4 architecture: Tasks 1, 2, 13, 14. Repo layout: Task 1. CI/CD security controls: Tasks 2 and 14 (trust policy on environment claim, environment approval, bootstrap-role-only permissions, branch protection and Actions settings in `docs/setup.md`).
- Section 5 auth steps 1 to 6: Tasks 9 (discovery, registration), 10 (authorize, callback), 11 (token, anonymous id, wrapped tokens via Task 8), 12 (bearer check and 401 with resource metadata).
- Section 7 concurrency: Task 6 queue and retry, Task 13 reserved concurrency.
- Section 8: only `list_companies` here by design; the rest is plan 2.
- Section 6 table: created in Task 2; writes are plan 2.
- Company selection via `companySlug`: convention noted in Task 12 for later tools.

**Placeholders:** none. Every step has its code or its exact command.

**Type consistency:** `Config` fields, `FikenClient.json`, `FikenTokens`, `issueTokens`/`readAccessToken`/`readRefreshToken`, `readClientId`, `CodeWire`, `ToolContext`, `toolJson`/`toolError` are defined once and used with the same names in every later task.
