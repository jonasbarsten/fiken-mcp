# Fiken MCP website Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve a Norwegian landing page at `https://fiken-mcp.byjoba.com` from a new `fiken-mcp-web` CDK stack, deploy each stack only when its files change, and rework the README.

**Architecture:** `/web` holds static files (no build). `iac/lib/web-stack.ts` defines a private S3 bucket, a CloudFront distribution (bucket by Origin Access Control, plus `/stats` forwarded to the API), apex DNS records and a `BucketDeployment` of `/web`. `iac/lib/deploy-targets.ts` maps changed paths to stacks; `deploy.yml` runs it in a `changes` job against the last successful deploy and gates each `cdk deploy` step on its flag.

**Tech Stack:** AWS CDK 2.271 (`aws-cdk-lib`), TypeScript 6, vitest 5, Node 24 (runs `.ts` files natively by type stripping), GitHub Actions, plain HTML/CSS/JS.

**Spec:** `docs/superpowers/specs/2026-10-03-fiken-mcp-website-design.md`

## Global Constraints

- Never modify a file through a shell command: every file change goes through the Edit or Write tool. Bash is for reading, searching, building, testing and git only.
- Never run `cdk deploy` or any deploy command locally. `cdk synth` and tests are fine.
- Work on branch `website` (already exists, holds the spec). Never push to `main`.
- The early-access email address must never appear in plain text anywhere in the repo (web files, tests, docs, plan, commit messages), nor as a literal `mailto:` string or `@gmail` substring in `web/`. It exists only as the reversed char-code array `[109,111,99,46,108,105,97,109,103,64,110,101,116,115,114,97,98,115,97,110,111,106]`, checked against SHA-256 `4991b58892e1753709431e15fc2e75767db61471c6714de666c9593eaa3963fd`.
- Site domain `fiken-mcp.byjoba.com`; certificate ARN `arn:aws:acm:us-east-1:209479295726:certificate/6814f406-e879-4458-9a45-739a1639ee30`; zone `byjoba.com`, id `Z04810525CNVQNP7ALNV`; account `209479295726`, region `eu-west-1`; bootstrap qualifier `fikenmcp`.
- Bucket name `fiken-mcp-web-209479295726` (prefix `fiken-mcp-web-`); AWS CLI layer name `fiken-mcp-web-awscli`; every role carries the `fiken-mcp-cfn-exec` permissions boundary.
- CSP exactly: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`.
- No access logging on the distribution; no analytics; no cookies; no inline `<script>` or `<style>`.
- Site language bokmål, `<html lang="nb">`. Copy exactly as in this plan (it is the spec's copy); Jonas reviews wording in the PR.
- No Fiken logo or colours. GitHub mark only as the unmodified Primer Octicons `mark-github-16` path given in Task 4.
- Reuse the action pins already in `.github/workflows/*.yml`; add no new third-party actions.
- No em dashes in AWS resource names or descriptions.
- Keep the README accurate; footer signature «byJoBa (Jonas Barsten)».
- Commit trailers on every commit:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01ELoGmasq8hztag5VGsjesY`

## Review Focus

1. `/stats` unreachable, returning a non-2xx (CloudFront maps 403/404 to the HTML 404 page) or JSON without the current month: the three counters must show `–` (fetch failure) or `0` (month missing), never `NaN`, `undefined` or a thrown error. Pinned in Task 4.
2. A deploy run that was rejected, failed or cancelled as a superseded pending run: its changes must still deploy in the next run. Pinned by diffing against the last *successful* run (Task 5) and by `deploy-targets` tests (Task 1).
3. A merge touching only docs or tests: no `production` approval prompt and no stack deploy. Pinned in Tasks 1 and 5.
4. The `BucketDeployment` Lambda, its layer and its role must fit the `fiken-mcp-*` names and the boundary the execution policy allows, or the first deploy fails in CloudFormation. Pinned in Task 3 (layer name, boundary on every role) and Task 2 (policy statements).
5. The email address leaking through any file in `web/` or a test. Pinned in Task 4.

---

### Task 1: deploy-targets

**Files:**
- Create: `iac/lib/deploy-targets.ts`
- Test: `iac/test/deploy-targets.test.ts`

**Interfaces:**
- Produces: `export type StackKey = "iac" | "web" | "api"`, `export const STACK_KEYS: StackKey[]`, `export function stacksFor(path: string): StackKey[]`, `export function deployTargets(paths: string[]): Record<StackKey, boolean>`. Run as a script (`node iac/lib/deploy-targets.ts < changed.txt`), it prints `iac=<bool>`, `web=<bool>`, `api=<bool>` lines for `$GITHUB_OUTPUT`.

- [ ] **Step 1: Write the failing test**

```ts
// iac/test/deploy-targets.test.ts
import { describe, expect, it } from "vitest";
import { deployTargets, stacksFor } from "../lib/deploy-targets.js";

describe("stacksFor", () => {
  it.each([
    ["web/index.html", ["web"]],
    ["web/site.js", ["web"]],
    ["iac/lib/web-stack.ts", ["web"]],
    ["iac/lib/iac-stack.ts", ["iac"]],
    ["iac/lib/exec-policy.ts", ["iac", "web"]],
    ["iac/bin/iac.ts", ["iac", "web"]],
    ["iac/lib/synthesizer.ts", ["iac", "web"]],
    ["iac/package.json", ["iac", "web"]],
    ["iac/cdk.json", ["iac", "web"]],
    ["api/src/mcp/context.ts", ["api"]],
    ["api/lib/api-stack.ts", ["api"]],
    ["api/package.json", ["api"]],
    ["package.json", ["iac", "web", "api"]],
    ["package-lock.json", ["iac", "web", "api"]],
    ["tsconfig.base.json", ["iac", "web", "api"]],
    [".github/workflows/deploy.yml", ["iac", "web", "api"]],
    ["iac/test/web-stack.test.ts", []],
    ["api/test/mcp/tools.test.ts", []],
    ["iac/lib/deploy-targets.ts", []],
    ["docs/setup.md", []],
    ["README.md", []],
    ["LICENSE", []],
    ["CLAUDE.md", []],
    [".github/workflows/ci.yml", []],
    ["webby.txt", []],
  ])("%s -> %j", (path, expected) => {
    expect(stacksFor(path)).toEqual(expected);
  });
});

describe("deployTargets", () => {
  it("deploys nothing for no changes", () => {
    expect(deployTargets([])).toEqual({ iac: false, web: false, api: false });
  });

  it("deploys only the web stack for a web-only change", () => {
    expect(deployTargets(["web/index.html", "web/style.css"])).toEqual({ iac: false, web: true, api: false });
  });

  it("deploys only the api for an api change plus docs", () => {
    expect(deployTargets(["api/src/app.ts", "docs/setup.md", "README.md"])).toEqual({ iac: false, web: false, api: true });
  });

  it("combines flags across paths", () => {
    expect(deployTargets(["iac/lib/iac-stack.ts", "web/index.html"])).toEqual({ iac: true, web: true, api: false });
  });

  it("ignores blank lines and surrounding whitespace", () => {
    expect(deployTargets(["", "  web/index.html  ", " "])).toEqual({ iac: false, web: true, api: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace iac -- deploy-targets`
Expected: FAIL, cannot find module `../lib/deploy-targets.js`.

- [ ] **Step 3: Write the implementation**

```ts
// iac/lib/deploy-targets.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Which stacks a change to each path needs deployed. deploy.yml pipes the
 * files changed since the last successful deploy into this script, which
 * runs under Node's built-in type stripping (no install needed), so keep it
 * free of imports beyond node:* and of non-erasable TypeScript syntax.
 */
export type StackKey = "iac" | "web" | "api";
export const STACK_KEYS: StackKey[] = ["iac", "web", "api"];

const SHARED = new Set(["package.json", "package-lock.json", "tsconfig.base.json", ".github/workflows/deploy.yml"]);

export function stacksFor(path: string): StackKey[] {
  if (SHARED.has(path)) return ["iac", "web", "api"];
  if (path.startsWith("iac/test/") || path.startsWith("api/test/") || path === "iac/lib/deploy-targets.ts") return [];
  if (path.startsWith("web/") || path === "iac/lib/web-stack.ts") return ["web"];
  if (path === "iac/lib/iac-stack.ts") return ["iac"];
  // exec-policy.ts holds the site constants too, so it feeds both stacks.
  if (path.startsWith("iac/")) return ["iac", "web"];
  if (path.startsWith("api/")) return ["api"];
  return [];
}

export function deployTargets(paths: string[]): Record<StackKey, boolean> {
  const targets: Record<StackKey, boolean> = { iac: false, web: false, api: false };
  for (const raw of paths) {
    const path = raw.trim();
    if (path === "") continue;
    for (const key of stacksFor(path)) targets[key] = true;
  }
  return targets;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const targets = deployTargets(readFileSync(0, "utf8").split("\n"));
  for (const key of STACK_KEYS) console.log(`${key}=${targets[key]}`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test --workspace iac -- deploy-targets`
Expected: PASS (all cases).

- [ ] **Step 5: Verify the script runs under plain Node (as the workflow will)**

Run: `printf 'web/index.html\ndocs/setup.md\n' | node iac/lib/deploy-targets.ts`
Expected output (an ExperimentalWarning on stderr is fine):
```
iac=false
web=true
api=false
```
Then `npm run typecheck --workspace iac` passes.

- [ ] **Step 6: Commit**

```bash
git add iac/lib/deploy-targets.ts iac/test/deploy-targets.test.ts
git commit -m "deploy-targets: map changed paths to the stacks to deploy"
```

---

### Task 2: Execution policy for the site

**Files:**
- Modify: `iac/lib/exec-policy.ts` (constants at the top, new statements at the end of `execPolicyStatements`)
- Modify: `iac/lib/iac-stack.ts` (import `ZONE_NAME` instead of declaring it)
- Test: `iac/test/iac-stack.test.ts` (add one test)

**Interfaces:**
- Produces in `exec-policy.ts`: `export const ZONE_NAME = "byjoba.com"`, `export const SITE_DOMAIN = "fiken-mcp.byjoba.com"`, `export const SITE_BUCKET_PREFIX = "fiken-mcp-web-"`, `export const SITE_LAYER_NAME = "fiken-mcp-web-awscli"`. Existing exports `DOMAIN`, `ZONE_ID`, `EXEC_POLICY_NAME` stay.

- [ ] **Step 1: Write the failing test** (append inside `describe("IacStack", ...)` in `iac/test/iac-stack.test.ts`)

```ts
  it("lets CloudFormation manage the site bucket, CloudFront resources and the deployment layer, scoped by name", () => {
    const t = synth();
    const policy = Object.values(t.findResources("AWS::IAM::ManagedPolicy"))[0]!;
    const statements = policy.Properties.PolicyDocument.Statement as Array<{ Sid?: string; Action: string | string[]; Resource: string | string[] }>;
    const bySid = (sid: string) => statements.find((s) => s.Sid === sid)!;

    expect(bySid("SiteBucket").Action).toBe("s3:*");
    expect(bySid("SiteBucket").Resource).toEqual(["arn:aws:s3:::fiken-mcp-web-*", "arn:aws:s3:::fiken-mcp-web-*/*"]);

    expect(bySid("CloudFront").Action).toBe("cloudfront:*");
    expect(bySid("CloudFront").Resource).toEqual([
      "arn:aws:cloudfront::209479295726:distribution/*",
      "arn:aws:cloudfront::209479295726:origin-access-control/*",
      "arn:aws:cloudfront::209479295726:cache-policy/*",
      "arn:aws:cloudfront::209479295726:response-headers-policy/*",
    ]);

    expect(bySid("SiteLayer").Action).toEqual(["lambda:PublishLayerVersion", "lambda:GetLayerVersion", "lambda:DeleteLayerVersion"]);
    expect(bySid("SiteLayer").Resource).toEqual([
      "arn:aws:lambda:eu-west-1:209479295726:layer:fiken-mcp-web-awscli",
      "arn:aws:lambda:eu-west-1:209479295726:layer:fiken-mcp-web-awscli:*",
    ]);
  }, STACK_TEST_TIMEOUT_MS);
```

(If the neighbouring tests do not pass `STACK_TEST_TIMEOUT_MS` as the third argument, match whatever they do.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace iac -- iac-stack`
Expected: FAIL, `Cannot read properties of undefined (reading 'Action')` for `SiteBucket`.

- [ ] **Step 3: Implement**

In `iac/lib/exec-policy.ts`, after the `DOMAIN` export add:

```ts
export const ZONE_NAME = "byjoba.com";
/** The website on the apex, served by the fiken-mcp-web stack. */
export const SITE_DOMAIN = "fiken-mcp.byjoba.com";
/** The site bucket is named with this prefix plus the account id. */
export const SITE_BUCKET_PREFIX = "fiken-mcp-web-";
/** BucketDeployment's AWS CLI layer gets no name of its own; web-stack sets this one so the policy can pin it. */
export const SITE_LAYER_NAME = "fiken-mcp-web-awscli";
```

At the end of the array returned by `execPolicyStatements`, after `AssumeBootstrapRoles`, add:

```ts
    new iam.PolicyStatement({
      // The website bucket, and (as the boundary on the BucketDeployment
      // Lambda) the object writes that upload and prune the site.
      sid: "SiteBucket",
      actions: ["s3:*"],
      resources: [`arn:aws:s3:::${SITE_BUCKET_PREFIX}*`, `arn:aws:s3:::${SITE_BUCKET_PREFIX}*/*`],
    }),
    new iam.PolicyStatement({
      // CloudFront ARNs carry generated ids, so these are pinned to the
      // account and resource type. Also covers the deployment Lambda's
      // CreateInvalidation and GetInvalidation on the distribution.
      sid: "CloudFront",
      actions: ["cloudfront:*"],
      resources: ["distribution", "origin-access-control", "cache-policy", "response-headers-policy"].map(
        (type) => `arn:aws:cloudfront::${account}:${type}/*`,
      ),
    }),
    new iam.PolicyStatement({
      sid: "SiteLayer",
      actions: ["lambda:PublishLayerVersion", "lambda:GetLayerVersion", "lambda:DeleteLayerVersion"],
      resources: [
        `arn:aws:lambda:${region}:${account}:layer:${SITE_LAYER_NAME}`,
        `arn:aws:lambda:${region}:${account}:layer:${SITE_LAYER_NAME}:*`,
      ],
    }),
```

In `iac/lib/iac-stack.ts`, delete `const ZONE_NAME = "byjoba.com";` and add `ZONE_NAME` to the import from `./exec-policy.js`.

- [ ] **Step 4: Run tests**

Run: `npm test --workspace iac && npm run typecheck --workspace iac`
Expected: PASS, including the existing "never grants an unconditioned wildcard resource" test (no new statement uses `*`).

- [ ] **Step 5: Commit**

```bash
git add iac/lib/exec-policy.ts iac/lib/iac-stack.ts iac/test/iac-stack.test.ts
git commit -m "Execution policy: site bucket, CloudFront and the deployment layer"
```

---

### Task 3: The fiken-mcp-web stack

**Files:**
- Create: `iac/lib/web-stack.ts`
- Modify: `iac/bin/iac.ts`
- Create: `web/index.html` (placeholder for now; Task 4 writes the real one) — only if `web/` does not exist yet, because `Source.asset` needs the directory at synth time.
- Test: `iac/test/web-stack.test.ts`

**Interfaces:**
- Consumes: `SITE_DOMAIN`, `SITE_BUCKET_PREFIX`, `SITE_LAYER_NAME`, `ZONE_ID`, `ZONE_NAME`, `DOMAIN`, `EXEC_POLICY_NAME` from `./exec-policy.js` (Task 2).
- Produces: `export class WebStack extends Stack`, `export const SITE_CERTIFICATE_ARN`, `export const CONTENT_SECURITY_POLICY` from `iac/lib/web-stack.ts`; stack id `fiken-mcp-web`.

- [ ] **Step 1: Create the placeholder `web/index.html`** (Write tool)

```html
<!doctype html>
<html lang="nb"><head><meta charset="utf-8"><title>Fiken MCP</title></head><body></body></html>
```

- [ ] **Step 2: Write the failing test**

```ts
// iac/test/web-stack.test.ts
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { CONTENT_SECURITY_POLICY, SITE_CERTIFICATE_ARN, WebStack } from "../lib/web-stack.js";
import { synthesizer } from "../lib/synthesizer.js";

const STACK_TEST_TIMEOUT_MS = 60_000;

function synth() {
  const app = new App();
  const stack = new WebStack(app, "fiken-mcp-web", {
    env: { account: "209479295726", region: "eu-west-1" },
    synthesizer: synthesizer(),
  });
  return Template.fromStack(stack);
}

describe("WebStack", () => {
  it("creates a private, SSL-only, retained bucket named for the account", () => {
    const t = synth();
    t.hasResource("AWS::S3::Bucket", {
      DeletionPolicy: "Retain",
      Properties: Match.objectLike({
        BucketName: "fiken-mcp-web-209479295726",
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      }),
    });
    t.hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Effect: "Deny", Condition: { Bool: { "aws:SecureTransport": "false" } } }),
        ]),
      },
    });
  }, STACK_TEST_TIMEOUT_MS);

  it("serves the apex over HTTPS with the us-east-1 certificate, no logging, and a 404 page", () => {
    const t = synth();
    expect(SITE_CERTIFICATE_ARN).toBe("arn:aws:acm:us-east-1:209479295726:certificate/6814f406-e879-4458-9a45-739a1639ee30");
    const dist = Object.values(t.findResources("AWS::CloudFront::Distribution"))[0]!.Properties.DistributionConfig;
    expect(dist.Aliases).toEqual(["fiken-mcp.byjoba.com"]);
    expect(dist.ViewerCertificate).toEqual({
      AcmCertificateArn: SITE_CERTIFICATE_ARN,
      MinimumProtocolVersion: "TLSv1.2_2021",
      SslSupportMethod: "sni-only",
    });
    expect(dist.Logging).toBeUndefined();
    expect(dist.DefaultRootObject).toBe("index.html");
    expect(dist.HttpVersion).toBe("http2and3");
    expect(dist.PriceClass).toBe("PriceClass_100");
    expect(dist.DefaultCacheBehavior.ViewerProtocolPolicy).toBe("redirect-to-https");
    expect(dist.CustomErrorResponses).toEqual([
      { ErrorCode: 403, ResponseCode: 404, ResponsePagePath: "/404.html" },
      { ErrorCode: 404, ResponseCode: 404, ResponsePagePath: "/404.html" },
    ]);
    t.resourceCountIs("AWS::CloudFront::OriginAccessControl", 1);
  }, STACK_TEST_TIMEOUT_MS);

  it("forwards /stats to the API with a 300 s cache that keys on nothing", () => {
    const t = synth();
    const dist = Object.values(t.findResources("AWS::CloudFront::Distribution"))[0]!.Properties.DistributionConfig;
    const api = dist.Origins.find((o: { DomainName: unknown }) => o.DomainName === "api.fiken-mcp.byjoba.com");
    expect(api.CustomOriginConfig.OriginProtocolPolicy).toBe("https-only");
    expect(dist.CacheBehaviors).toHaveLength(1);
    const stats = dist.CacheBehaviors[0];
    expect(stats.PathPattern).toBe("/stats");
    expect(stats.TargetOriginId).toBe(api.Id);
    expect(stats.ViewerProtocolPolicy).toBe("redirect-to-https");
    expect(stats.OriginRequestPolicyId).toBeUndefined();
    t.hasResourceProperties("AWS::CloudFront::CachePolicy", {
      CachePolicyConfig: Match.objectLike({
        DefaultTTL: 300,
        MaxTTL: 300,
        MinTTL: 0,
        ParametersInCacheKeyAndForwardedToOrigin: Match.objectLike({
          CookiesConfig: { CookieBehavior: "none" },
          HeadersConfig: { HeaderBehavior: "none" },
          QueryStringsConfig: { QueryStringBehavior: "none" },
        }),
      }),
    });
  }, STACK_TEST_TIMEOUT_MS);

  it("sends the security headers and the exact CSP on both behaviors", () => {
    const t = synth();
    expect(CONTENT_SECURITY_POLICY).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    t.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: {
          ContentSecurityPolicy: { ContentSecurityPolicy: CONTENT_SECURITY_POLICY, Override: true },
          ContentTypeOptions: { Override: true },
          FrameOptions: { FrameOption: "DENY", Override: true },
          ReferrerPolicy: { ReferrerPolicy: "no-referrer", Override: true },
          StrictTransportSecurity: { AccessControlMaxAgeSec: 31536000, IncludeSubdomains: true, Override: true },
        },
      }),
    });
    const [policyId] = Object.keys(t.findResources("AWS::CloudFront::ResponseHeadersPolicy"));
    const dist = Object.values(t.findResources("AWS::CloudFront::Distribution"))[0]!.Properties.DistributionConfig;
    expect(dist.DefaultCacheBehavior.ResponseHeadersPolicyId).toEqual({ Ref: policyId });
    expect(dist.CacheBehaviors[0].ResponseHeadersPolicyId).toEqual({ Ref: policyId });
  }, STACK_TEST_TIMEOUT_MS);

  it("points A and AAAA records on the apex at the distribution", () => {
    const t = synth();
    const [distId] = Object.keys(t.findResources("AWS::CloudFront::Distribution"));
    for (const type of ["A", "AAAA"]) {
      // CloudFrontTarget supplies CloudFront's alias zone id through a
      // partition mapping, so only the DNS name is pinned here.
      t.hasResourceProperties("AWS::Route53::RecordSet", {
        Name: "fiken-mcp.byjoba.com.",
        Type: type,
        HostedZoneId: "Z04810525CNVQNP7ALNV",
        AliasTarget: Match.objectLike({ DNSName: { "Fn::GetAtt": [distId, "DomainName"] } }),
      });
    }
  }, STACK_TEST_TIMEOUT_MS);

  it("deploys /web with pruning and a full invalidation, through a layer the execution policy can name", () => {
    const t = synth();
    t.hasResourceProperties("Custom::CDKBucketDeployment", {
      Prune: true,
      DistributionPaths: ["/*"],
    });
    t.hasResourceProperties("AWS::Lambda::LayerVersion", { LayerName: "fiken-mcp-web-awscli" });
  }, STACK_TEST_TIMEOUT_MS);

  it("puts the fiken-mcp-cfn-exec boundary on every role", () => {
    const t = synth();
    const roles = t.findResources("AWS::IAM::Role");
    expect(Object.keys(roles).length).toBeGreaterThan(0);
    for (const role of Object.values(roles)) {
      expect(JSON.stringify(role.Properties.PermissionsBoundary)).toContain(":iam::209479295726:policy/fiken-mcp-cfn-exec");
    }
  }, STACK_TEST_TIMEOUT_MS);

  it("outputs the bucket, the distribution id and its domain", () => {
    const t = synth();
    t.hasOutput("SiteBucketName", {});
    t.hasOutput("DistributionId", {});
    t.hasOutput("DistributionDomainName", {});
  }, STACK_TEST_TIMEOUT_MS);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test --workspace iac -- web-stack`
Expected: FAIL, cannot find module `../lib/web-stack.js`.

- [ ] **Step 4: Write the stack**

```ts
// iac/lib/web-stack.ts
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import type { Construct } from "constructs";
import { fileURLToPath } from "node:url";
import { DOMAIN, EXEC_POLICY_NAME, SITE_BUCKET_PREFIX, SITE_DOMAIN, SITE_LAYER_NAME, ZONE_ID, ZONE_NAME } from "./exec-policy.js";

/** Requested once by hand in us-east-1 (CloudFront requires that region) and DNS-validated; see docs/setup.md. */
export const SITE_CERTIFICATE_ARN = "arn:aws:acm:us-east-1:209479295726:certificate/6814f406-e879-4458-9a45-739a1639ee30";

/** Everything the page loads is its own file; CSS and JS are never inline. */
export const CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const WEB_DIR = fileURLToPath(new URL("../../web", import.meta.url));

/**
 * The landing page at the apex: a private bucket behind CloudFront, /stats
 * forwarded to the API so the page reads it same-origin, and the /web
 * folder uploaded on every deploy. No access logs: the site collects nothing.
 */
export class WebStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    iam.PermissionsBoundary.of(this).apply(iam.ManagedPolicy.fromManagedPolicyName(this, "Boundary", EXEC_POLICY_NAME));

    const bucket = new s3.Bucket(this, "SiteBucket", {
      bucketName: `${SITE_BUCKET_PREFIX}${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // The content is rebuilt from git; RETAIN avoids an auto-delete custom resource.
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const headers = new cloudfront.ResponseHeadersPolicy(this, "SecurityHeaders", {
      securityHeadersBehavior: {
        contentSecurityPolicy: { contentSecurityPolicy: CONTENT_SECURITY_POLICY, override: true },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER, override: true },
        strictTransportSecurity: { accessControlMaxAge: Duration.days(365), includeSubdomains: true, override: true },
      },
    });

    // The API answers /stats with Cache-Control max-age=300; nothing varies it.
    const statsCache = new cloudfront.CachePolicy(this, "StatsCache", {
      defaultTtl: Duration.seconds(300),
      maxTtl: Duration.seconds(300),
      minTtl: Duration.seconds(0),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
    });

    const distribution = new cloudfront.Distribution(this, "Distribution", {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: headers,
      },
      additionalBehaviors: {
        // No origin request policy: the API sees its own host name.
        "/stats": {
          origin: new origins.HttpOrigin(DOMAIN, { protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: statsCache,
          responseHeadersPolicy: headers,
        },
      },
      domainNames: [SITE_DOMAIN],
      certificate: acm.Certificate.fromCertificateArn(this, "Certificate", SITE_CERTIFICATE_ARN),
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultRootObject: "index.html",
      errorResponses: [403, 404].map((httpStatus) => ({ httpStatus, responseHttpStatus: 404, responsePagePath: "/404.html" })),
    });

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", { hostedZoneId: ZONE_ID, zoneName: ZONE_NAME });
    const recordName = SITE_DOMAIN.slice(0, -(ZONE_NAME.length + 1));
    const target = route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution));
    new route53.ARecord(this, "AliasRecord", { zone, recordName, target });
    new route53.AaaaRecord(this, "AliasRecordIpv6", { zone, recordName, target });

    const content = new s3deploy.BucketDeployment(this, "Content", {
      sources: [s3deploy.Source.asset(WEB_DIR)],
      destinationBucket: bucket,
      distribution,
      distributionPaths: ["/*"],
    });
    // BucketDeployment's AWS CLI layer gets a CloudFormation-generated name;
    // pin it so the execution policy can name it (SiteLayer statement).
    const layer = content.node.findChild("AwsCliLayer").node.defaultChild as lambda.CfnLayerVersion;
    layer.layerName = SITE_LAYER_NAME;

    new CfnOutput(this, "SiteBucketName", { value: bucket.bucketName });
    new CfnOutput(this, "DistributionId", { value: distribution.distributionId });
    new CfnOutput(this, "DistributionDomainName", { value: distribution.distributionDomainName });
  }
}
```

If `content.node.findChild("AwsCliLayer")` throws (child id differs in this CDK version), list the children with `content.node.children.map((c) => c.node.id)` in a scratch run, use the actual id, and keep the test's `LayerName` assertion unchanged.

- [ ] **Step 5: Add the stack to the app**

`iac/bin/iac.ts` becomes:

```ts
import { App, Tags } from "aws-cdk-lib";
import { IacStack } from "../lib/iac-stack.js";
import { synthesizer } from "../lib/synthesizer.js";
import { WebStack } from "../lib/web-stack.js";

const app = new App();
Tags.of(app).add("Project", "fiken-mcp");
const env = { account: "209479295726", region: "eu-west-1" };
new IacStack(app, "fiken-mcp-iac", { env, synthesizer: synthesizer() });
new WebStack(app, "fiken-mcp-web", { env, synthesizer: synthesizer() });
```

- [ ] **Step 6: Run tests and synth**

Run: `npm test --workspace iac && npm run typecheck --workspace iac && npm run synth --workspace iac`
Expected: all PASS; synth lists both stacks without errors.

Also check in `iac/cdk.out/fiken-mcp-web.template.json` that the BucketDeployment Lambda has no `FunctionName` (CloudFormation then names it `fiken-mcp-web-…`, inside the `fiken-mcp-*` Lambda statement) and that its role's policy asks only for S3 on the assets and site buckets plus `cloudfront:CreateInvalidation`/`GetInvalidation`. Note any surprise in the task report.

- [ ] **Step 7: Commit**

```bash
git add iac/lib/web-stack.ts iac/bin/iac.ts iac/test/web-stack.test.ts web/index.html
git commit -m "fiken-mcp-web stack: bucket, CloudFront with /stats, apex records, content upload"
```

---

### Task 4: The page

**Files:**
- Create: `web/index.html` (replaces the placeholder), `web/404.html`, `web/style.css`, `web/site.js`
- Create: `web/icon.png` — a byte copy of `api/src/assets/icon.png`. Binary files cannot go through the Write tool; copying an existing binary with `cp api/src/assets/icon.png web/icon.png` is the one allowed shell file operation in this plan (it creates no text the reviewer needs to diff). Verify with `cmp`.
- Test: `iac/test/web-content.test.ts`

**Interfaces:**
- Consumes: the file names the CSP allows (`/style.css`, `/site.js`, `/icon.png`), and `/stats` JSON shape `{ totalUsers: number, months: Array<{ month: "YYYY-MM", calls: number, errors: number, activeUsers: number, tools: Record<string, number> }> }`.
- Produces: `site.js` top-level functions `emailAddress(): string`, `loadStats(): Promise<void>` (global in a classic script; the test calls them through `node:vm`).

- [ ] **Step 1: Write the failing test**

```ts
// iac/test/web-content.test.ts
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const WEB = fileURLToPath(new URL("../../web/", import.meta.url));
const read = (name: string) => readFileSync(WEB + name, "utf8");
const textFiles = readdirSync(WEB).filter((f) => /\.(html|css|js)$/.test(f));
// The early-access address, never written out in this public repo.
const EMAIL_SHA256 = "4991b58892e1753709431e15fc2e75767db61471c6714de666c9593eaa3963fd";

interface FakeElement { textContent: string }

/** Runs site.js in a sandbox with just enough DOM for the script's top level. */
function runSite(fetchImpl: () => Promise<unknown>) {
  const elements: Record<string, FakeElement> = {
    "stat-total": { textContent: "–" },
    "stat-active": { textContent: "–" },
    "stat-calls": { textContent: "–" },
  };
  const months: FakeElement[] = [{ textContent: "denne måneden" }, { textContent: "denne måneden" }];
  const context = vm.createContext({
    document: {
      getElementById: (id: string) => elements[id] ?? null,
      querySelectorAll: (selector: string) => (selector === ".month" ? months : []),
    },
    navigator: {},
    fetch: fetchImpl,
    Intl,
    Date,
    setTimeout,
    encodeURIComponent,
    String,
  });
  vm.runInContext(read("site.js"), context);
  return { context: context as unknown as { emailAddress(): string; loadStats(): Promise<void> }, elements, months };
}

const thisMonth = new Date().toISOString().slice(0, 7);
const ok = (body: unknown) => async () => ({ ok: true, json: async () => body });

describe("web content", () => {
  it("never contains the email address, a mailto: link or @gmail in any file", () => {
    expect(textFiles.length).toBeGreaterThan(0);
    for (const name of textFiles) {
      const text = read(name).toLowerCase();
      expect(text, name).not.toContain("mailto:");
      expect(text, name).not.toContain("@gmail");
      expect(text, name).not.toContain("jonasbarsten@");
      expect(text, name).not.toContain("gmail.com");
    }
  });

  it("builds the right address from the char codes", () => {
    const { context } = runSite(ok({ totalUsers: 0, months: [] }));
    expect(createHash("sha256").update(context.emailAddress()).digest("hex")).toBe(EMAIL_SHA256);
  });

  it("is a Norwegian page with no inline script or style, a GitHub link and the disclaimer", () => {
    const html = read("index.html");
    expect(html).toContain('<html lang="nb">');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).not.toMatch(/<style/);
    expect(html).not.toMatch(/\sstyle=/);
    expect(html).toContain('href="https://github.com/jonasbarsten/fiken-mcp"');
    expect(html).toContain("<h2>Ansvarsfraskrivelse</h2>");
    expect(html).toContain("byJoBa");
  });

  it("references only files that exist in web/", () => {
    for (const name of ["index.html", "404.html"]) {
      const html = read(name);
      for (const [, ref] of html.matchAll(/(?:href|src)="(\/[^"#]*)"/g)) {
        const path = ref === "/" ? "index.html" : ref!.slice(1);
        expect(existsSync(WEB + path), `${name} -> ${ref}`).toBe(true);
      }
    }
  });

  it("fills the counters from /stats and names the month", async () => {
    const { context, elements, months } = runSite(
      ok({ totalUsers: 1234, months: [{ month: thisMonth, calls: 45, errors: 9, activeUsers: 3, tools: {} }] }),
    );
    await context.loadStats();
    expect(elements["stat-total"]!.textContent).toBe(new Intl.NumberFormat("nb-NO").format(1234));
    expect(elements["stat-active"]!.textContent).toBe("3");
    expect(elements["stat-calls"]!.textContent).toBe("45");
    const name = new Intl.DateTimeFormat("nb-NO", { month: "long", timeZone: "UTC" }).format(new Date());
    expect(months.map((m) => m.textContent)).toEqual([name, name]);
  });

  it("shows 0 for this month when /stats has no entry for it", async () => {
    const { context, elements } = runSite(ok({ totalUsers: 5, months: [{ month: "2000-01", calls: 9, errors: 0, activeUsers: 9, tools: {} }] }));
    await context.loadStats();
    expect(elements["stat-total"]!.textContent).toBe("5");
    expect(elements["stat-active"]!.textContent).toBe("0");
    expect(elements["stat-calls"]!.textContent).toBe("0");
  });

  it("keeps the dashes when /stats fails, answers non-2xx, or sends something unexpected", async () => {
    const cases: Array<() => Promise<unknown>> = [
      async () => { throw new TypeError("network"); },
      async () => ({ ok: false, json: async () => ({}) }),
      async () => ({ ok: true, json: async () => { throw new SyntaxError("html"); } }),
      ok(null),
      ok({ totalUsers: "x", months: "nope" }),
    ];
    for (const fetchImpl of cases) {
      const { context, elements } = runSite(fetchImpl);
      await context.loadStats();
      for (const id of ["stat-total", "stat-active", "stat-calls"]) {
        expect(elements[id]!.textContent).toBe("–");
      }
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace iac -- web-content`
Expected: FAIL (no `site.js`, placeholder `index.html` lacks the GitHub link).

- [ ] **Step 3: Write `web/site.js`**

```js
"use strict";

// The early-access address as reversed char codes, so bots scanning the page
// or the public repo never see it as text. It is built only on click.
const EMAIL_CODES = [109, 111, 99, 46, 108, 105, 97, 109, 103, 64, 110, 101, 116, 115, 114, 97, 98, 115, 97, 110, 111, 106];
const EMAIL_SUBJECT = "Tilgang til Fiken MCP";

function emailAddress() {
  return String.fromCharCode(...EMAIL_CODES.slice().reverse());
}

function showEmail(button) {
  const address = emailAddress();
  const link = document.createElement("a");
  link.href = ["mail", "to:"].join("") + address + "?subject=" + encodeURIComponent(EMAIL_SUBJECT);
  link.textContent = address;
  link.className = "email-link";
  button.replaceWith(link);
  link.focus();
}

function setupCopy(button, text) {
  if (!navigator.clipboard) return;
  button.hidden = false;
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    const label = button.textContent;
    button.textContent = "Kopiert";
    setTimeout(() => {
      button.textContent = label;
    }, 2000);
  });
}

function isCount(value) {
  return typeof value === "number" && Number.isFinite(value);
}

// /stats keys months in UTC, so the page names the month in UTC as well.
async function loadStats() {
  const now = new Date();
  const monthKey = now.toISOString().slice(0, 7);
  const monthName = new Intl.DateTimeFormat("nb-NO", { month: "long", timeZone: "UTC" }).format(now);
  for (const el of document.querySelectorAll(".month")) el.textContent = monthName;

  let stats;
  try {
    const res = await fetch("/stats");
    if (!res.ok) return;
    stats = await res.json();
  } catch {
    return;
  }
  if (!stats || !isCount(stats.totalUsers) || !Array.isArray(stats.months)) return;

  const month = stats.months.find((m) => m && m.month === monthKey);
  const format = new Intl.NumberFormat("nb-NO");
  const show = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = format.format(isCount(value) ? value : 0);
  };
  show("stat-total", stats.totalUsers);
  show("stat-active", month ? month.activeUsers : 0);
  show("stat-calls", month ? month.calls : 0);
}

const emailButton = document.getElementById("show-email");
if (emailButton) emailButton.addEventListener("click", () => showEmail(emailButton), { once: true });

const copyButton = document.getElementById("copy-url");
const connectorUrl = document.getElementById("connector-url");
if (copyButton && connectorUrl) setupCopy(copyButton, connectorUrl.textContent.trim());

loadStats();
```

The HTML ships each counter as `–`; that is the no-data state `loadStats` leaves alone on any failure.

- [ ] **Step 4: Write `web/index.html`**

```html
<!doctype html>
<html lang="nb">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Fiken MCP: Fiken i Claude og ChatGPT</title>
  <meta name="description" content="Koble Fiken til Claude eller ChatGPT. Bokfør kvitteringer, lag fakturaer og få svar om regnskapet rett fra chatten.">
  <link rel="icon" href="/icon.png" type="image/png">
  <link rel="stylesheet" href="/style.css">
  <script src="/site.js" defer></script>
</head>
<body>
  <header class="hero">
    <img class="logo" src="/icon.png" alt="" width="96" height="96">
    <h1>Fiken MCP</h1>
    <p class="lead">Koble Fiken til Claude eller ChatGPT, og be assistenten bokføre kvitteringer, lage fakturaer eller finne tall i regnskapet. Alt skjer direkte i ditt eget Fiken-foretak.</p>
    <div class="actions">
      <a class="button primary" href="#tilgang">Bli med fra starten</a>
      <a class="button" href="https://github.com/jonasbarsten/fiken-mcp">
        <svg class="mark" aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M6.766 11.328c-2.063-.25-3.516-1.734-3.516-3.656 0-.781.281-1.625.75-2.188-.203-.515-.172-1.609.063-2.062.625-.078 1.468.25 1.968.703.594-.187 1.219-.281 1.985-.281.765 0 1.39.094 1.953.265.484-.437 1.344-.765 1.969-.687.218.422.25 1.515.046 2.047.5.593.766 1.39.766 2.203 0 1.922-1.453 3.375-3.547 3.64.531.344.89 1.094.89 1.954v1.625c0 .468.391.734.86.547C13.781 14.359 16 11.53 16 8.03 16 3.61 12.406 0 7.984 0 3.563 0 0 3.61 0 8.031a7.88 7.88 0 0 0 5.172 7.422c.422.156.828-.125.828-.547v-1.25c-.219.094-.5.156-.75.156-1.031 0-1.64-.562-2.078-1.609-.172-.422-.36-.672-.719-.719-.187-.015-.25-.093-.25-.187 0-.188.313-.328.625-.328.453 0 .844.281 1.25.86.313.452.64.655 1.031.655s.641-.14 1-.5c.266-.265.47-.5.657-.656"/></svg>
        Åpen kildekode på GitHub
      </a>
    </div>
  </header>

  <main>
    <section id="tilgang">
      <h2>Bli med fra starten</h2>
      <p>Fiken MCP er helt nytt. Foreløpig er appen registrert hos Fiken som en utviklingsapp, og da kan høyst fem personer bruke den. Når fem brukere er aktive, kan jeg søke Fiken om produksjonsstatus, og da kan alle ta den i bruk.</p>
      <p>Vil du være en av de første? Send meg en e-post med adressen du logger inn i Fiken med, så legger jeg deg til. Det er bare noen få plasser.</p>
      <p class="email"><button type="button" id="show-email" class="button primary">Vis e-postadressen</button></p>
      <noscript><p class="note">Slå på JavaScript for å se e-postadressen.</p></noscript>
    </section>

    <section>
      <h2>Dette kan du gjøre</h2>
      <ul class="features">
        <li><strong>Kvitteringer.</strong> Ta bilde av kvitteringen eller last opp PDF-en, så bokfører assistenten kjøpet med riktig konto og mva.</li>
        <li><strong>Salg og fakturaer.</strong> Lag fakturautkast, opprett og send fakturaer, og lag kreditnotaer.</li>
        <li><strong>Kunder, leverandører og produkter.</strong> Søk dem opp, opprett nye eller oppdater dem.</li>
        <li><strong>Oversikt.</strong> Spør om saldoer, banken, ubetalte fakturaer eller hva som er bokført på en konto.</li>
        <li><strong>Prosjekter og timer.</strong> Før timer på prosjekter og fakturer dem.</li>
        <li><strong>Bare lesetilgang.</strong> Skal assistenten bare lese og ikke endre noe? Bruk adressen som slutter på <code>/mcp/readonly</code>.</li>
      </ul>
    </section>

    <section>
      <h2>Slik kommer du i gang</h2>
      <p>Du trenger:</p>
      <ul>
        <li>et Fiken-foretak med tilleggstjenesten API (Foretak → Tilleggstjenester → API, 99 kr i måneden; den er alltid inkludert i testforetak)</li>
        <li>tilgang til appen (se over)</li>
        <li>Claude eller ChatGPT</li>
      </ul>
      <h3>Claude <span class="muted">(nettleser, Mac, PC og mobil)</span></h3>
      <p>Gå til Customize → Connectors, trykk Add og velg Add custom connector. Gi koblingen et navn, for eksempel Fiken, og lim inn denne adressen:</p>
      <p class="url"><code id="connector-url">https://api.fiken-mcp.byjoba.com/mcp</code> <button type="button" id="copy-url" class="button small" hidden>Kopier</button></p>
      <p>Logg inn med Fiken når du blir bedt om det. Menyene i Claude er på engelsk.</p>
      <h3>Claude Code</h3>
      <pre><code>claude mcp add --transport http fiken https://api.fiken-mcp.byjoba.com/mcp</code></pre>
      <h3>ChatGPT</h3>
      <p>Ikke testet ennå.</p>
    </section>

    <section>
      <h2>Personvern</h2>
      <p>Tjenesten lagrer ingen av dataene dine. Filer og regnskapsdata går gjennom serveren på vei til og fra Fiken, men blir verken lagret eller logget. Det samme gjelder innloggingen din hos Fiken.</p>
      <p>Det eneste som tas vare på, er anonym bruksstatistikk: hvor mange ganger hvert verktøy er brukt per måned, og om det gikk bra. Tellingen knyttes til en kode som lages fra e-postadressen din, og koden kan ikke regnes tilbake til adressen.</p>
      <p>Kobler du fra i Claude eller ChatGPT, glemmer bare den appen innloggingen. For å stenge tilgangen helt går du i Fiken til Rediger konto → Sikkerhet → Apper du har gitt tilgang til og fjerner tilgangen for Fiken MCP. Gjør det også hvis du tror at en enhet eller konto er på avveie.</p>
    </section>

    <section>
      <h2>Bruk så langt</h2>
      <dl class="stats">
        <div><dt>brukere totalt</dt><dd id="stat-total">–</dd></div>
        <div><dt>aktive brukere i <span class="month">denne måneden</span></dt><dd id="stat-active">–</dd></div>
        <div><dt>kall i <span class="month">denne måneden</span></dt><dd id="stat-calls">–</dd></div>
      </dl>
      <p class="muted">Tallene oppdateres hvert femte minutt.</p>
    </section>

    <section>
      <h2>Ansvarsfraskrivelse</h2>
      <p>Fiken MCP er et uavhengig prosjekt med åpen kildekode og har ingen tilknytning til Fiken AS. Tjenesten leveres som den er, uten noen form for garanti.</p>
      <p>KI-assistenter kan ta feil. Du er selv ansvarlig for alt som bokføres, faktureres eller sendes fra foretaket ditt, også når assistenten gjør det for deg. Kontroller alltid resultatet i Fiken. Jeg er ikke ansvarlig for feil i regnskapet eller for tap som følger av at du bruker tjenesten.</p>
    </section>
  </main>

  <footer>
    <a href="https://github.com/jonasbarsten/fiken-mcp">Kildekoden ligger på GitHub</a>
    <span aria-hidden="true">·</span>
    <a href="https://github.com/jonasbarsten/fiken-mcp/blob/main/LICENSE">MIT-lisens</a>
    <span aria-hidden="true">·</span>
    <span>byJoBa <small>(Jonas Barsten)</small></span>
  </footer>
</body>
</html>
```

HTML requires `<dt>` before `<dd>` in each group; `style.css` uses `order` to show the number above its label.

- [ ] **Step 5: Write `web/404.html`**

```html
<!doctype html>
<html lang="nb">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Siden finnes ikke · Fiken MCP</title>
  <link rel="icon" href="/icon.png" type="image/png">
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <main class="notfound">
    <img class="logo" src="/icon.png" alt="" width="64" height="64">
    <h1>Denne siden finnes ikke.</h1>
    <p><a class="button primary" href="/">Til forsiden</a></p>
  </main>
</body>
</html>
```

- [ ] **Step 6: Write `web/style.css`**

```css
:root {
  --ink: #1d2433;
  --muted: #5b6475;
  --bg: #fbfbf8;
  --card: #ffffff;
  --line: #e3e5e8;
  --accent: #0b6e4f;
  --accent-ink: #ffffff;
  color-scheme: light dark;
}

@media (prefers-color-scheme: dark) {
  :root {
    --ink: #e8eaee;
    --muted: #a3abb9;
    --bg: #12151b;
    --card: #1a1f27;
    --line: #2b313b;
    --accent: #3fbf8f;
    --accent-ink: #0d1a14;
  }
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font: 17px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}

a { color: var(--accent); }

.hero, main, footer {
  max-width: 44rem;
  margin: 0 auto;
  padding: 0 1.25rem;
}

.hero { padding-top: 4rem; padding-bottom: 2rem; text-align: center; }
.logo { border-radius: 22%; }
h1 { font-size: 2.5rem; line-height: 1.15; margin: 1rem 0 0.5rem; }
.lead { font-size: 1.2rem; color: var(--muted); margin: 0 auto 1.75rem; max-width: 36rem; }

.actions { display: flex; gap: 0.75rem; justify-content: center; flex-wrap: wrap; }

.button {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.7rem 1.2rem;
  border-radius: 0.6rem;
  border: 1px solid var(--line);
  background: var(--card);
  color: var(--ink);
  font: inherit;
  font-weight: 600;
  text-decoration: none;
  cursor: pointer;
}
.button:hover { border-color: var(--accent); }
.button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
.button.small { padding: 0.3rem 0.7rem; font-size: 0.9rem; }
.mark { flex: none; }

section {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 1rem;
  padding: 1.5rem 1.5rem 1rem;
  margin: 0 0 1.25rem;
}
h2 { margin: 0 0 0.75rem; font-size: 1.4rem; }
h3 { margin: 1.25rem 0 0.25rem; font-size: 1.05rem; }

.features { padding-left: 1.1rem; }
.features li { margin-bottom: 0.5rem; }

code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.9em; }
pre, .url code {
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 0.5rem;
  padding: 0.5rem 0.75rem;
}
pre { overflow-x: auto; }
.url { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
.url code { overflow-wrap: anywhere; }

.email-link { font-weight: 600; font-size: 1.1rem; }

.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: 1rem; margin: 0 0 0.5rem; }
.stats div { display: flex; flex-direction: column; }
.stats dd { order: -1; margin: 0; font-size: 2rem; font-weight: 700; color: var(--accent); }
.stats dt { color: var(--muted); }

.muted, .note { color: var(--muted); }

footer {
  padding-top: 1rem;
  padding-bottom: 3rem;
  display: flex;
  gap: 0.6rem;
  justify-content: center;
  flex-wrap: wrap;
  color: var(--muted);
}

.notfound { text-align: center; padding-top: 6rem; }

@media (max-width: 30rem) {
  h1 { font-size: 2rem; }
  .actions .button { width: 100%; justify-content: center; }
  section { padding: 1.25rem 1rem 0.75rem; }
}
```

- [ ] **Step 7: Copy the icon**

Run: `cp api/src/assets/icon.png web/icon.png && cmp api/src/assets/icon.png web/icon.png && echo same`
Expected: `same`.

- [ ] **Step 8: Run tests**

Run: `npm test --workspace iac && npm run typecheck --workspace iac && npm run synth --workspace iac`
Expected: PASS.

- [ ] **Step 9: Look at it**

Run `python3 -m http.server 4173 --directory web` in the background (do not install a server package) and open `http://localhost:4173/` in a browser if one is available to you; otherwise skip and say so in the report. The counters stay `–` locally (no `/stats`), which is the expected fallback. Check: buttons side by side on desktop and stacked under 30rem; the email button shows the address; dark mode readable. Stop the server afterwards.

- [ ] **Step 10: Commit**

```bash
git add web iac/test/web-content.test.ts
git commit -m "The landing page: Norwegian copy, email button, counters, GitHub button"
```

---

### Task 5: Deploy only what changed

**Files:**
- Modify: `.github/workflows/deploy.yml`
- Test: `iac/test/deploy-workflow.test.ts`

**Interfaces:**
- Consumes: `node iac/lib/deploy-targets.ts` (Task 1) printing `iac=…`, `web=…`, `api=…`; stack ids `fiken-mcp-iac`, `fiken-mcp-web` (Task 3), `fiken-mcp-api`.

- [ ] **Step 1: Write the failing test**

```ts
// iac/test/deploy-workflow.test.ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(new URL("../../.github/workflows/deploy.yml", import.meta.url), "utf8");

describe("deploy.yml", () => {
  it("gates each stack's deploy step on its own flag, in the order iac, web, api", () => {
    const steps = [...workflow.matchAll(/if: needs\.changes\.outputs\.(\w+) == 'true'\s*\n\s*run: npx cdk deploy (fiken-mcp-\w+) /g)].map(
      (m) => [m[1], m[2]],
    );
    expect(steps).toEqual([
      ["iac", "fiken-mcp-iac"],
      ["web", "fiken-mcp-web"],
      ["api", "fiken-mcp-api"],
    ]);
  });

  it("asks for production approval only when something will deploy", () => {
    expect(workflow).toContain(
      "if: needs.changes.outputs.iac == 'true' || needs.changes.outputs.web == 'true' || needs.changes.outputs.api == 'true'",
    );
    expect(workflow).toMatch(/environment: production/);
  });

  it("diffs against the last successful deploy, not the previous commit", () => {
    expect(workflow).toContain("--status success");
    expect(workflow).toContain("fetch-depth: 0");
    expect(workflow).toContain("node iac/lib/deploy-targets.ts");
    expect(workflow).not.toContain("HEAD~1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace iac -- deploy-workflow`
Expected: FAIL (current workflow has no `changes` job).

- [ ] **Step 3: Rewrite `.github/workflows/deploy.yml`**

Keep the existing action pins exactly (copy the `uses:` lines from the current file).

```yaml
name: deploy
on:
  push:
    branches: [main]
permissions:
  contents: read
concurrency: deploy
jobs:
  changes:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      actions: read
    outputs:
      iac: ${{ steps.targets.outputs.iac }}
      web: ${{ steps.targets.outputs.web }}
      api: ${{ steps.targets.outputs.api }}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: 24
      # Compare with the last commit whose deploy succeeded, so a rejected,
      # failed or superseded run never drops its changes from the next one.
      - id: targets
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          base=$(gh run list --repo "$GITHUB_REPOSITORY" --workflow deploy --branch main --status success --limit 1 --json headSha --jq '.[0].headSha // empty')
          if [ -n "$base" ] && git cat-file -e "$base^{commit}" 2>/dev/null; then
            echo "Changed since the last successful deploy ($base):"
            git diff --name-only "$base" "$GITHUB_SHA" | tee changed.txt
            node iac/lib/deploy-targets.ts < changed.txt | tee -a "$GITHUB_OUTPUT"
          else
            echo "No successful deploy to compare with; deploying everything."
            printf 'iac=true\nweb=true\napi=true\n' | tee -a "$GITHUB_OUTPUT"
          fi
  deploy:
    needs: changes
    if: needs.changes.outputs.iac == 'true' || needs.changes.outputs.web == 'true' || needs.changes.outputs.api == 'true'
    runs-on: ubuntu-latest
    environment: production
    permissions:
      contents: read
      id-token: write
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
      # iac first: it holds the execution policy the other stacks rely on.
      - if: needs.changes.outputs.iac == 'true'
        run: npx cdk deploy fiken-mcp-iac --require-approval never
        working-directory: iac
      - if: needs.changes.outputs.web == 'true'
        run: npx cdk deploy fiken-mcp-web --require-approval never
        working-directory: iac
      - if: needs.changes.outputs.api == 'true'
        run: npx cdk deploy fiken-mcp-api --require-approval never
        working-directory: api
```

- [ ] **Step 4: Run tests**

Run: `npm test --workspace iac -- deploy-workflow`
Expected: PASS. If `actionlint` is installed locally (`command -v actionlint`), run `actionlint .github/workflows/deploy.yml` too; do not install it.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/deploy.yml iac/test/deploy-workflow.test.ts
git commit -m "deploy: a changes job, and deploy each stack only when its files changed"
```

---

### Task 6: LICENSE, README and docs

**Files:**
- Create: `LICENSE`
- Modify: `README.md` (replace lines 1-12, the title and intro, with the new opening; add a `## Website` section before `## Development`; add the footer at the end)
- Modify: `docs/setup.md` (new section after `## Fiken`; new verify section at the end)
- Modify: `docs/superpowers/specs/2026-09-22-fiken-mcp-design.md` (section 14 website bullet)
- Modify: `CLAUDE.md` (Process paragraph)

- [ ] **Step 1: `LICENSE`**

```
MIT License

Copyright (c) 2026 Jonas Barsten

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 2: README opening.** Replace everything from `# fiken-mcp` up to (not including) `## What it can do` with:

```markdown
<p align="center">
  <img src="api/src/assets/icon.png" alt="" width="112" height="112">
</p>

<h1 align="center">Fiken MCP</h1>

<p align="center">
  <strong>Your Fiken accounting, from Claude and ChatGPT.</strong><br>
  Book receipts from a photo, send invoices, and ask about your numbers in plain language.
</p>

<p align="center">
  <a href="https://github.com/jonasbarsten/fiken-mcp/actions/workflows/ci.yml"><img src="https://github.com/jonasbarsten/fiken-mcp/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT licence"></a>
  <a href="https://fiken-mcp.byjoba.com"><img src="https://img.shields.io/badge/site-fiken--mcp.byjoba.com-0b6e4f.svg" alt="Website"></a>
</p>

---

A remote [MCP](https://modelcontextprotocol.io) server for the
[Fiken](https://fiken.no) accounting API. Fiken customers log in with
Fiken themselves and use it from Claude (web, desktop, mobile, Claude
Code) and ChatGPT, on their own AI subscription. Full read and write
access, and nothing stored on our side.

> **Early access.** Fiken's development status caps the app at five
> users, and it needs five active users before it can apply for
> production status. Want in? Use the email button on
> [fiken-mcp.byjoba.com](https://fiken-mcp.byjoba.com) and you will be
> added as an approved user.

## What you can ask

| You say | It does |
|---|---|
| "Book these three receipts" (with photos) | Reads each receipt, finds the supplier, books a purchase with account and VAT, and attaches the original |
| "Invoice Acme for 10 hours of consulting at 1 200 kr" | Creates the invoice, and sends it when you confirm |
| "Which invoices are overdue?" | Lists unpaid invoices past their due date |
| "What is the balance on 1920 today?" | Reads the account balance |
| "Log 3 hours on project MCP-1 for today" | Creates the time entry |
| "Credit invoice 10521" | Issues a full credit note |

## Quick start

1. Make sure the Fiken company has the API add-on (Foretak →
   Tilleggstjenester → API; always on for test companies).
2. In Claude: Customize → Connectors → Add → Add custom connector, URL
   `https://api.fiken-mcp.byjoba.com/mcp`. Log in with Fiken.
3. Ask away.

Claude Code:

```
claude mcp add --transport http fiken https://api.fiken-mcp.byjoba.com/mcp
```

Details, read-only and narrower connections: [Adding the connector](#adding-the-connector).

## Privacy and responsibility

Nothing you send is stored: files and accounting data pass through the
server's memory on their way to Fiken. Only anonymous usage counters are
kept ([details](#privacy)).

This is an independent open-source project, not affiliated with Fiken AS,
provided as is under the [MIT licence](LICENSE). AI assistants make
mistakes; you are responsible for what is booked, invoiced or sent from
your company. Check the result in Fiken.

## How it works

```
Claude / ChatGPT ──MCP over HTTPS──▶ API Gateway ──▶ Lambda (Hono) ──▶ Fiken API
        ▲                                               │
        └──── OAuth: you log in with Fiken ◀────────────┘
```

One stateless Lambda serves MCP, OAuth and file uploads. Fiken allows one
concurrent request, so every call goes through one queue. The tool list
stays short: a few hot-path tools plus `fiken_explore`, `fiken_read` and
`fiken_write`, which reach every Fiken operation.

Status: live at `https://api.fiken-mcp.byjoba.com` for a handful of
test users. The receipts flow works end to end: pick receipts in the
chat, they land in the Fiken inbox, the model reads them and books each
one as a purchase with the original attached. Invoices, credit notes and
payments are covered too.

```

Every claim in that table must match an operation that exists in `api/src/mcp/tools/` (check: `create_purchase`, `create_invoice`/`send_invoice`, `list_invoices`, `account_balances`, `create_time_entry`, `create_credit_note`). If one does not, drop the row rather than invent behaviour.

- [ ] **Step 3: README `## Website` section**, inserted right before `## Development`:

```markdown
## Website

`https://fiken-mcp.byjoba.com` is a static Norwegian page in `web/`
(`index.html`, `404.html`, `style.css`, `site.js`, `icon.png`; no build
step). The `fiken-mcp-web` stack in `iac/lib/web-stack.ts` serves it:
a private S3 bucket behind CloudFront (Origin Access Control), `/stats`
forwarded to the API so the page reads the counters from its own domain,
strict security headers (all CSS and JS in files, never inline), no
access logs, and A/AAAA records on the apex. A `BucketDeployment`
uploads `web/` and invalidates the cache on deploy. The early-access
email address exists only as char codes in `site.js` and is assembled on
click; a test fails if it appears in plain text.

The deploy workflow deploys only what changed since the last successful
deploy (`iac/lib/deploy-targets.ts`): `web/**` deploys only the web
stack, `api/**` only the API, docs and tests nothing at all.
```

- [ ] **Step 4: README footer.** Append at the very end of the file:

```markdown

---

<p align="center">MIT licence · byJoBa (Jonas Barsten)</p>
```

- [ ] **Step 5: `docs/setup.md`.** After the `## Fiken` section add:

```markdown
## Website certificate

CloudFront needs its certificate in us-east-1. Requested by hand on
2026-10-03 for `fiken-mcp.byjoba.com`, DNS-validated in the byjoba.com
zone: `arn:aws:acm:us-east-1:209479295726:certificate/6814f406-e879-4458-9a45-739a1639ee30`
(`SITE_CERTIFICATE_ARN` in `iac/lib/web-stack.ts`). It auto-renews while
the validation CNAME exists. Before the first deploy, confirm in the ACM
console (us-east-1) that it is Issued.
```

At the end of the file add:

```markdown
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
- A later merge touching only `web/` runs only the `fiken-mcp-web` step,
  and a docs-only merge asks for no approval.
```

- [ ] **Step 6: Design spec section 14.** Replace the website bullet's opening `- **Website at \`https://fiken-mcp.byjoba.com\` (to build, section 10).**` with `- **Website at \`https://fiken-mcp.byjoba.com\` (built 2026-10-03; see \`2026-10-03-fiken-mcp-website-design.md\`).**` and change the line «Still to build after that: ChatGPT verification and the website.» to «Still to build after that: ChatGPT verification.»

- [ ] **Step 7: `CLAUDE.md`.** In the Process paragraph replace «Next: the decision on deletes, reversals and cancelling, ChatGPT verification and the website (spec section 14).» with «Website plan executed 2026-10-03 (`web/`, stack `fiken-mcp-web`, per-stack deploys; see `docs/superpowers/plans/2026-10-03-fiken-mcp-website.md`). Next: the decision on deletes, reversals and cancelling, and ChatGPT verification (spec section 14).»

- [ ] **Step 8: Check**

Run: `npm test && npm run typecheck`
Expected: PASS. Then `grep -rn "gmail" README.md docs CLAUDE.md web iac/test` must print only `iac/test/web-content.test.ts` lines that contain `@gmail`/`gmail.com` as the forbidden substrings, never the full address.

- [ ] **Step 9: Commit**

```bash
git add LICENSE README.md docs/setup.md docs/superpowers/specs/2026-09-22-fiken-mcp-design.md CLAUDE.md
git commit -m "MIT licence, README for GitHub, website docs"
```

---

## After the plan

- Push `website`, open a PR to `main`. In the PR body ask Jonas to review the Norwegian copy (`web/index.html`) and to confirm the us-east-1 certificate is Issued before merging.
- On merge the workflow has no successful run with the new `changes` job yet, but `gh run list` finds the last successful old-style run, so it diffs from there: this PR touches `iac/lib/exec-policy.ts` (iac, web), `package-lock.json` only if dependencies changed (none planned), and `.github/workflows/deploy.yml` (all three). Expect all three stacks to deploy, iac first.
- Then run the "Verify after deploying the website plan" list in `docs/setup.md`.
