# Fiken MCP Usage, 401 and CIMD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Anonymous usage counters in the DynamoDB table with a `my_usage` tool and a public `GET /stats`; a Fiken 401 during a tool call becomes an HTTP 401 so clients refresh; Claude's "published identity" (Client ID Metadata Documents) works as a client id.

**Architecture:** A `UsageStore` interface with an in-memory implementation (tests) and a DynamoDB implementation (production) behind `Config.usage`; every tool handler is wrapped once so the counters record after the call, never on the critical path of the Fiken request and never failing a tool; the MCP route inspects a session flag after the transport answers and swaps in a 401; CIMD resolution lives in one module that fetches and caches metadata documents from an allowlisted set of hosts.

**Tech Stack:** as before, plus `@aws-sdk/client-dynamodb` 3.1141.0 and `@aws-sdk/lib-dynamodb` 3.1141.0 (exact) in the api workspace.

**Spec:** docs/superpowers/specs/2026-09-22-fiken-mcp-design.md sections 6 (usage), 12 (Fiken 401), 14 (CIMD). Decision record: docs/superpowers/specs/2026-09-22-fiken-mcp-decision-record.md.

## Global Constraints

- Store no user data. The table holds pseudonymous counters only: `USER#<anon id>` rows with counts and a first-seen month, `GLOBAL` rows. Never a name, email, company slug, token or amount.
- Every Fiken call goes through `FikenClient`. CIMD documents are fetched with `cfg.fetch` directly (they are not Fiken calls): https only, allowlisted hosts only, no redirects, 3 s timeout, 16 KB cap.
- Never log a token, code, email, header, body or parameter value. Usage failures are logged as `usage_failed` with the tool name only.
- Tool conventions unchanged (companySlug, paging, øre, annotations, `isError` with Fiken's message).
- Never run `aws`, `cdk deploy`, `cdk bootstrap` or `cdk destroy`; `cdk synth` is fine. Never push to main. Branch `usage-and-cimd` (stacked on `receipts-flow`).
- Never modify files through shell commands; use the editor tools.
- Commit after every task with the trailers `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01ELoGmasq8hztag5VGsjesY`.
- Keep the README current (Task 5).

---

### Task 1: UsageStore, memory and DynamoDB implementations, config and stack wiring

**Files:**
- Create: `api/src/usage/store.ts`, `api/src/usage/dynamo.ts`, `api/src/usage/memory.ts`
- Modify: `api/src/config.ts` (`Config.usage`, `loadConfig` builds the DynamoDB store from `USAGE_TABLE_NAME`, `testConfig` uses the memory store), `api/lib/api-stack.ts` (import the table by export name, `grantReadWriteData`, env `USAGE_TABLE_NAME`), `api/package.json` (two exact dependencies), root `package-lock.json`
- Test: `api/test/usage/memory.test.ts`, `api/test/usage/dynamo.test.ts`, `api/test/config.test.ts` (extend), `api/test/api-stack.test.ts` (extend)

**Interfaces:**
```ts
// api/src/usage/store.ts
export interface MonthRow { month: string; calls: number; errors: number; tools: Record<string, number>; activeUsers?: number }
export interface UsageStore {
  /** Two ADD updates: USER#/MONTH# and GLOBAL/MONTH#. activeUsers increments when the user had no row for the month. */
  recordCall(anonId: string, tool: string, ok: boolean, now?: Date): Promise<void>;
  /** Conditional PROFILE put; on first success GLOBAL/ALL totalUsers += 1. */
  recordFirstLogin(anonId: string, now?: Date): Promise<void>;
  userMonths(anonId: string): Promise<MonthRow[]>;                    // newest first
  globalStats(): Promise<{ totalUsers: number; months: MonthRow[] }>; // newest first, at most 24
}
export const monthKey = (d: Date) => `MONTH#${d.toISOString().slice(0, 7)}`;
```
- Attribute names on a month row: `calls`, `errors`, `activeUsers` (GLOBAL only), and one attribute per tool named `tool#<name>` (a `#` in an attribute name needs an expression attribute name; use `#t` mapped to `tool#list_companies`). `PROFILE` row: `firstSeen` = `YYYY-MM`. `GLOBAL`/`ALL`: `totalUsers`.
- `dynamo.ts`: `export interface DynamoLike { send(command: unknown): Promise<unknown> }` and `export function dynamoUsageStore(client: DynamoLike, table: string): UsageStore` using `@aws-sdk/lib-dynamodb` commands (`UpdateCommand`, `PutCommand`, `QueryCommand`). `recordCall`: `UpdateCommand` on `USER#`/`MONTH#` with `ADD calls :one, errors :err, #t :one` (`:err` is 1 or 0), `ReturnValues: "ALL_OLD"`; then `UpdateCommand` on `GLOBAL`/`MONTH#` with the same ADDs plus `activeUsers :one` only when the first update returned no `Attributes` (no previous row). `recordFirstLogin`: `PutCommand` `{ PK, SK: "PROFILE", firstSeen }` with `ConditionExpression: "attribute_not_exists(PK)"`; on success `UpdateCommand` `GLOBAL`/`ALL` `ADD totalUsers :one`; a `ConditionalCheckFailedException` (by `name`) is swallowed. Queries: `QueryCommand` with `KeyConditionExpression: "PK = :pk AND begins_with(SK, :m)"`, `ScanIndexForward: false`, `Limit: 24`; `GLOBAL`/`ALL` via a `GetCommand`. Map rows to `MonthRow` (strip `tool#`).
- `memory.ts`: `memoryUsageStore(): UsageStore & { dump(): Map<string, Record<string, unknown>> }` with the same semantics, keyed `${PK}|${SK}`.
- `config.ts`: `usage: UsageStore` on `Config`; `loadConfig` requires `USAGE_TABLE_NAME` (error text names it) and builds `dynamoUsageStore(DynamoDBDocumentClient.from(new DynamoDBClient({})), name)`; `testConfig` uses `memoryUsageStore()`. Existing `loadConfig` test envs gain `USAGE_TABLE_NAME: "t"`.
- `api-stack.ts`: `const table = dynamodb.TableV2.fromTableName(this, "UsageTable", Fn.importValue("fiken-mcp-usage-table-name"))`; `table.grantReadWriteData(fn)`; env `USAGE_TABLE_NAME: table.tableName`.

- [ ] **Step 1: Failing tests**

`api/test/usage/memory.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { memoryUsageStore } from "../../src/usage/memory.js";

const sep = new Date("2026-09-15T10:00:00Z");
const oct = new Date("2026-10-02T10:00:00Z");

describe("memoryUsageStore", () => {
  it("counts calls, errors and tools per user-month and globally, and active users once per month", async () => {
    const s = memoryUsageStore();
    await s.recordCall("a", "list_companies", true, sep);
    await s.recordCall("a", "list_projects", false, sep);
    await s.recordCall("b", "list_companies", true, sep);
    await s.recordCall("a", "list_companies", true, oct);
    expect(await s.userMonths("a")).toEqual([
      { month: "2026-10", calls: 1, errors: 0, tools: { list_companies: 1 } },
      { month: "2026-09", calls: 2, errors: 1, tools: { list_companies: 1, list_projects: 1 } },
    ]);
    const g = await s.globalStats();
    expect(g.months).toEqual([
      { month: "2026-10", calls: 1, errors: 0, activeUsers: 1, tools: { list_companies: 1 } },
      { month: "2026-09", calls: 3, errors: 1, activeUsers: 2, tools: { list_companies: 2, list_projects: 1 } },
    ]);
  });

  it("counts a user once ever", async () => {
    const s = memoryUsageStore();
    await s.recordFirstLogin("a", sep);
    await s.recordFirstLogin("a", oct);
    await s.recordFirstLogin("b", oct);
    expect((await s.globalStats()).totalUsers).toBe(2);
    expect(s.dump().get("USER#a|PROFILE")).toEqual({ PK: "USER#a", SK: "PROFILE", firstSeen: "2026-09" });
  });

  it("starts empty", async () => {
    const s = memoryUsageStore();
    expect(await s.userMonths("nobody")).toEqual([]);
    expect(await s.globalStats()).toEqual({ totalUsers: 0, months: [] });
  });
});
```

`api/test/usage/dynamo.test.ts` (a recording fake client; assert the exact command inputs):
```ts
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { dynamoUsageStore } from "../../src/usage/dynamo.js";

type Sent = { name: string; input: Record<string, unknown> };
function fakeClient(answers: Array<unknown | Error>) {
  const sent: Sent[] = [];
  return {
    sent,
    async send(command: unknown) {
      const c = command as { constructor: { name: string }; input: Record<string, unknown> };
      sent.push({ name: c.constructor.name, input: c.input });
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next ?? {};
    },
  };
}
const sep = new Date("2026-09-15T10:00:00Z");

describe("dynamoUsageStore", () => {
  it("recordCall issues two ADD updates and increments activeUsers only on the user's first call of the month", async () => {
    const client = fakeClient([{}, {}, { Attributes: { calls: 3 } }, {}]);
    const s = dynamoUsageStore(client, "fiken-mcp-usage");
    await s.recordCall("anon1", "list_companies", false, sep);
    await s.recordCall("anon1", "list_companies", true, sep);
    expect(client.sent.map((x) => x.name)).toEqual(["UpdateCommand", "UpdateCommand", "UpdateCommand", "UpdateCommand"]);
    const [u1, g1, , g2] = client.sent;
    expect(u1!.input).toMatchObject({
      TableName: "fiken-mcp-usage",
      Key: { PK: "USER#anon1", SK: "MONTH#2026-09" },
      UpdateExpression: "ADD calls :one, errors :err, #t :one",
      ExpressionAttributeNames: { "#t": "tool#list_companies" },
      ExpressionAttributeValues: { ":one": 1, ":err": 1 },
      ReturnValues: "ALL_OLD",
    });
    expect(g1!.input).toMatchObject({
      Key: { PK: "GLOBAL", SK: "MONTH#2026-09" },
      UpdateExpression: "ADD calls :one, errors :err, #t :one, activeUsers :one",
    });
    expect(g2!.input).toMatchObject({ UpdateExpression: "ADD calls :one, errors :err, #t :one", ExpressionAttributeValues: { ":one": 1, ":err": 0 } });
    expect(new UpdateCommand(u1!.input as never)).toBeInstanceOf(UpdateCommand);
  });

  it("recordFirstLogin puts the profile once and bumps totalUsers only then", async () => {
    const failed = Object.assign(new Error("exists"), { name: "ConditionalCheckFailedException" });
    const client = fakeClient([{}, {}, failed]);
    const s = dynamoUsageStore(client, "t");
    await s.recordFirstLogin("anon1", sep);
    await s.recordFirstLogin("anon1", sep);
    expect(client.sent.map((x) => x.name)).toEqual(["PutCommand", "UpdateCommand", "PutCommand"]);
    expect(client.sent[0]!.input).toMatchObject({
      Item: { PK: "USER#anon1", SK: "PROFILE", firstSeen: "2026-09" },
      ConditionExpression: "attribute_not_exists(PK)",
    });
    expect(client.sent[1]!.input).toMatchObject({ Key: { PK: "GLOBAL", SK: "ALL" }, UpdateExpression: "ADD totalUsers :one" });
    expect(new PutCommand(client.sent[0]!.input as never)).toBeInstanceOf(PutCommand);
  });

  it("rethrows other errors from the profile put", async () => {
    const client = fakeClient([new Error("boom")]);
    await expect(dynamoUsageStore(client, "t").recordFirstLogin("anon1", sep)).rejects.toThrow("boom");
  });

  it("reads months newest first and maps tool attributes", async () => {
    const client = fakeClient([
      { Items: [{ PK: "USER#anon1", SK: "MONTH#2026-09", calls: 2, errors: 1, "tool#list_companies": 2 }] },
      { Items: [{ PK: "GLOBAL", SK: "MONTH#2026-09", calls: 5, errors: 1, activeUsers: 2, "tool#list_companies": 5 }] },
      { Item: { PK: "GLOBAL", SK: "ALL", totalUsers: 7 } },
    ]);
    const s = dynamoUsageStore(client, "t");
    expect(await s.userMonths("anon1")).toEqual([{ month: "2026-09", calls: 2, errors: 1, tools: { list_companies: 2 } }]);
    expect(await s.globalStats()).toEqual({ totalUsers: 7, months: [{ month: "2026-09", calls: 5, errors: 1, activeUsers: 2, tools: { list_companies: 5 } }] });
    expect(client.sent[0]!.input).toMatchObject({
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :m)",
      ExpressionAttributeValues: { ":pk": "USER#anon1", ":m": "MONTH#" },
      ScanIndexForward: false,
      Limit: 24,
    });
    expect(new QueryCommand(client.sent[0]!.input as never)).toBeInstanceOf(QueryCommand);
    expect(new GetCommand(client.sent[2]!.input as never)).toBeInstanceOf(GetCommand);
  });
});
```

`api/test/config.test.ts`: add `USAGE_TABLE_NAME: "usage"` to the env of the passing case and assert `typeof cfg.usage.recordCall === "function"`; add a case that a missing `USAGE_TABLE_NAME` rejects with `/USAGE_TABLE_NAME/`; `testConfig().usage.globalStats()` resolves to `{ totalUsers: 0, months: [] }`.

`api/test/api-stack.test.ts`: the function's `Environment.Variables` includes `USAGE_TABLE_NAME: { "Fn::ImportValue": "fiken-mcp-usage-table-name" }`; an `AWS::IAM::Policy` statement grants `dynamodb:UpdateItem`, `dynamodb:PutItem`, `dynamodb:Query`, `dynamodb:GetItem` (among the grant's actions) on a resource built from the imported table name (assert with `Match.objectLike` that the `Resource` array's first entry is an object containing `"Fn::Join"` with `"fiken-mcp-usage-table-name"` in its serialised form: `JSON.stringify(stmt.Resource)` contains `fiken-mcp-usage-table-name`).

- [ ] **Step 2: Run to verify failure**, **Step 3: Implement**. Install: `npm install --save --save-exact @aws-sdk/client-dynamodb@3.1141.0 @aws-sdk/lib-dynamodb@3.1141.0 --workspace api`. In `dynamo.ts` use `import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb"`. Note `lib-dynamodb` `UpdateCommand` etc. have `input` and their class `name`, which the fake relies on.
- [ ] **Step 4: Run tests**: `npm test`, `npm run typecheck`, `cd api && npx cdk synth --quiet`.
- [ ] **Step 5: Commit** `Usage store: memory and DynamoDB implementations, config, table grant`

---

### Task 2: Count every tool call; `my_usage`; `GET /stats`

**Files:**
- Modify: `api/src/mcp/server.ts` (`ToolContext.usage` is not needed: use `cfg.usage` via `ToolContext.usage: UsageStore`; add `counted()`), every file under `api/src/mcp/tools/` (wrap each handler), `api/src/mcp/routes.ts` (pass `usage: cfg.usage`), `api/src/auth/routes.ts` (`recordFirstLogin` after the authorization_code grant issues tokens; awaited, failures logged as `usage_failed`), `api/src/app.ts` (mount `statsRoutes(cfg)`), `api/test/mcp/helpers.ts` (`usage` in the context)
- Create: `api/src/mcp/tools/usage.ts` (`my_usage`), `api/src/stats.ts` (`statsRoutes(cfg)`)
- Test: `api/test/mcp/usage.test.ts`, `api/test/stats.test.ts`, `api/test/auth/token.test.ts` (extend)

**Interfaces:**
- `ToolContext` gains `usage: UsageStore`.
- `server.ts`: `export function counted<A>(ctx: ToolContext, name: string, handler: (args: A, extra: unknown) => Promise<CallToolResult>): (args: A, extra: unknown) => Promise<CallToolResult>`: runs the handler (a thrown error becomes `toolError(err)`), then `await ctx.usage.recordCall(ctx.anonId, name, !result.isError)` inside try/catch that logs `log("usage_failed", { tool: name })` and never throws, then returns the result. Every `server.registerTool(name, config, handler)` and `registerAppTool(...)` site passes `counted(ctx, name, handler)`.
- `my_usage`: no arguments; `readOnlyHint: true`; returns `{ anonId, months: MonthRow[] }` (the anon id is the user's own pseudonym; useful to compare against `/stats`). Description says the counters are pseudonymous and that nothing else is stored.
- `GET /stats` (unauthenticated): `cfg.usage.globalStats()` as JSON with `Cache-Control: public, max-age=300`. Errors from the store → 503 `{ error: "unavailable" }`.
- First login: in `/token` authorization_code, after `issueTokens`, `await cfg.usage.recordFirstLogin(anonId)` in a try/catch that logs `usage_failed` with `{ tool: "login" }`; the token response is unaffected either way.

- [ ] **Step 1: Failing tests**

`api/test/mcp/usage.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { memoryUsageStore } from "../../src/usage/memory.js";
import { callJson, connected, fakeFiken } from "./helpers.js";

describe("usage counting", () => {
  it("records every tool call with its outcome, and my_usage reads it back", async () => {
    const usage = memoryUsageStore();
    const f = fakeFiken([
      { match: /\/companies$/, body: [{ name: "Demo", slug: "demo" }] },
      { match: /\/projects/, status: 500, body: "boom" },
    ]);
    const c = await connected(f.fetchImpl, { usage });
    expect((await callJson(c, "list_companies", {})).isError).toBe(false);
    expect((await callJson(c, "list_projects", { companySlug: "demo" })).isError).toBe(true);
    const mine = (await callJson(c, "my_usage", {})).json() as { anonId: string; months: Array<{ calls: number; errors: number; tools: Record<string, number> }> };
    expect(mine.anonId).toBe("anon");
    expect(mine.months[0]).toMatchObject({ calls: 3, errors: 1, tools: { list_companies: 1, list_projects: 1, my_usage: 1 } });
    expect((await usage.globalStats()).months[0]).toMatchObject({ calls: 3, activeUsers: 1 });
  });

  it("a failing usage store never fails the tool", async () => {
    const usage = memoryUsageStore();
    usage.recordCall = async () => { throw new Error("dynamo down"); };
    const f = fakeFiken([{ match: /\/companies$/, body: [{ name: "Demo", slug: "demo" }] }]);
    const c = await connected(f.fetchImpl, { usage });
    expect((await callJson(c, "list_companies", {})).isError).toBe(false);
  });
});
```
`helpers.ts`: `connected(fetchImpl, opts?: { usage?: UsageStore })` builds the context with `usage: opts?.usage ?? memoryUsageStore()`.

`api/test/stats.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { testConfig } from "../src/config.js";

describe("GET /stats", () => {
  it("serves the global counters publicly with a cache header", async () => {
    const cfg = testConfig();
    await cfg.usage.recordFirstLogin("a", new Date("2026-09-15T00:00:00Z"));
    await cfg.usage.recordCall("a", "list_companies", true, new Date("2026-09-15T00:00:00Z"));
    const res = await createApp(cfg).request("/stats");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await res.json()).toEqual({ totalUsers: 1, months: [{ month: "2026-09", calls: 1, errors: 0, activeUsers: 1, tools: { list_companies: 1 } }] });
  });

  it("answers 503 when the store fails", async () => {
    const cfg = testConfig();
    cfg.usage.globalStats = async () => { throw new Error("down"); };
    const res = await createApp(cfg).request("/stats");
    expect(res.status).toBe(503);
  });
});
```

`api/test/auth/token.test.ts`: in the existing successful authorization_code test, assert afterwards that `(await cfg.usage.globalStats()).totalUsers` is 1 and that a second exchange for the same user (issue another code blob) leaves it at 1.

- [ ] **Step 2**, **Step 3** (wrap all 15 handlers: 14 existing plus `my_usage`; `registerAppTool`'s callback receives `(args, extra)` the same way), **Step 4**, **Step 5: Commit** `Usage counters on every tool call, my_usage, public /stats, first-login profile`

---

### Task 3: Fiken 401 during a tool call becomes HTTP 401

**Files:**
- Modify: `api/src/mcp/server.ts` (`ToolContext.session: { fikenUnauthorized: boolean }`; `errorText` sets nothing, but `counted()` sets `ctx.session.fikenUnauthorized = true` when the handler threw or returned a `FikenError` with status 401; to know that, `toolError` records the last error's status on the result: simplest is for `counted()` to catch `FikenError` thrown by handlers, and for `withCompany`/`toolError` paths to set the flag via a shared `noteFikenError(ctx, err)` call), `api/src/mcp/tools/common.ts` (`withCompany` calls `noteFikenError(ctx, err)` before `toolError`), `api/src/mcp/routes.ts` (after `handleRequest`, if the flag is set respond `401` with the `WWW-Authenticate` challenge and `{ error: "invalid_token" }`)
- Test: `api/test/mcp/routes.test.ts` (extend)

**Interfaces:** `export function noteFikenError(ctx: ToolContext, err: unknown): void` in `server.ts`; `ToolContext.session` created per request in `mcp/routes.ts` as `{ fikenUnauthorized: false }`; helpers create it too.

- [ ] **Step 1: Failing test** (in `routes.test.ts`, with a config whose fetch answers `/companies` with 401):
```ts
  it("turns a Fiken 401 during a tool call into an HTTP 401 so the client refreshes", async () => {
    const cfg401 = testConfig({ fetch: async () => new Response("expired", { status: 401 }) });
    const app401 = createApp(cfg401);
    const tok = issueTokens(cfg401, { access_token: "FA", refresh_token: "FR", expires_in: 3600 }, "anon").access_token;
    const res = await app401.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${tok}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_companies", arguments: {} } }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect(await res.json()).toEqual({ error: "invalid_token" });
  });
```
and assert that a tool call that fails with a Fiken 500 still returns 200 with `isError` (existing behaviour).
- [ ] **Steps 2–4**, **Step 5: Commit** `A Fiken 401 during a tool call answers 401 so the client refreshes`

---

### Task 4: Client ID Metadata Documents

**Files:**
- Create: `api/src/auth/cimd.ts`
- Modify: `api/src/auth/routes.ts` (`validateAuthorize` becomes async and uses `resolveClient`; `/token` authorization_code uses `resolveClient`; discovery metadata gains `client_id_metadata_document_supported: true`), `api/src/auth/clients.ts` (export `isAllowedCimdHost(host)`)
- Test: `api/test/auth/cimd.test.ts`, `api/test/auth/discovery.test.ts` (extend), `api/test/auth/authorize.test.ts` (extend), `api/test/auth/token.test.ts` (extend)

**Interfaces:**
```ts
// cimd.ts
export function isCimdClientId(clientId: string): boolean;   // https URL with an allowlisted host, a non-empty path, no query or fragment
export interface ClientMetadata { redirectUris: string[]; name: string }
/** Fetches the document once per hour per URL (in-memory cache, at most 64 entries); rejects on any deviation. */
export async function fetchClientMetadata(cfg: Config, clientId: string, now?: number): Promise<ClientMetadata>;
export async function resolveClient(cfg: Config, clientId: string): Promise<{ redirectUris: string[]; name: string }>; // CIMD → fetch; else readClientId
export function clearCimdCache(): void; // tests
```
- Allowed CIMD hosts (`clients.ts`): `claude.ai`, `anthropic.com` and its subdomains, `chatgpt.com`, `openai.com` and its subdomains. The redirect URI allowlist stays the control for where codes go.
- Fetch rules: `cfg.fetch(clientId, { redirect: "error", headers: { accept: "application/json" }, signal: AbortSignal.timeout(3000) })`; status must be 200; body read with a 16 KB cap (read `text()`, reject when longer); JSON object with `client_id` exactly equal to the URL, `redirect_uris` a non-empty array of strings, optional `client_name` string (max 64 chars kept). Any failure throws `BlobError("invalid")` so callers treat it like a bad client id (a `CimdError extends Error` with a short reason is fine if `readClientId` callers already catch generically; check `validateAuthorize` and `/token`, which catch everything and answer "invalid client_id"/`invalid_client`).
- `validateAuthorize` and the `/token` path require `redirect_uri` to be in the document's list and in our allowlist, exactly as for registered clients.

- [ ] **Step 1: Failing tests**

`api/test/auth/cimd.test.ts`:
```ts
import { beforeEach, describe, expect, it } from "vitest";
import { clearCimdCache, fetchClientMetadata, isCimdClientId, resolveClient } from "../../src/auth/cimd.js";
import { testConfig } from "../../src/config.js";

const DOC_URL = "https://claude.ai/.well-known/mcp-client.json";
const doc = { client_id: DOC_URL, client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] };
function cfgServing(body: unknown, status = 200) {
  const calls: string[] = [];
  const cfg = testConfig({ fetch: async (input) => { calls.push(String(input)); return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); } });
  return { cfg, calls };
}

describe("cimd", () => {
  beforeEach(() => clearCimdCache());

  it("recognises only https urls on allowlisted hosts with a path", () => {
    expect(isCimdClientId(DOC_URL)).toBe(true);
    expect(isCimdClientId("https://platform.openai.com/mcp/client.json")).toBe(true);
    expect(isCimdClientId("http://claude.ai/x.json")).toBe(false);
    expect(isCimdClientId("https://claude.ai")).toBe(false);
    expect(isCimdClientId("https://claude.ai/x.json?y=1")).toBe(false);
    expect(isCimdClientId("https://evil.example/x.json")).toBe(false);
    expect(isCimdClientId("https://claude.ai.evil.example/x.json")).toBe(false);
    expect(isCimdClientId("v1.k1.abc.def")).toBe(false);
  });

  it("fetches, validates and caches the document", async () => {
    const { cfg, calls } = cfgServing(doc);
    expect(await fetchClientMetadata(cfg, DOC_URL, 1000)).toEqual({ redirectUris: doc.redirect_uris, name: "Claude" });
    expect(await fetchClientMetadata(cfg, DOC_URL, 1000 + 3599)).toEqual({ redirectUris: doc.redirect_uris, name: "Claude" });
    expect(calls).toHaveLength(1);
    await fetchClientMetadata(cfg, DOC_URL, 1000 + 3601);
    expect(calls).toHaveLength(2);
  });

  it("rejects a mismatched client_id, missing redirect_uris, non-json, non-200 and oversized documents, and never fetches a non-allowlisted url", async () => {
    await expect(fetchClientMetadata(cfgServing({ ...doc, client_id: "https://claude.ai/other.json" }).cfg, DOC_URL)).rejects.toThrow();
    await expect(fetchClientMetadata(cfgServing({ client_id: DOC_URL }).cfg, DOC_URL)).rejects.toThrow();
    await expect(fetchClientMetadata(cfgServing("<html>").cfg, DOC_URL)).rejects.toThrow();
    await expect(fetchClientMetadata(cfgServing(doc, 404).cfg, DOC_URL)).rejects.toThrow();
    await expect(fetchClientMetadata(cfgServing({ ...doc, pad: "x".repeat(20_000) }).cfg, DOC_URL)).rejects.toThrow();
    const { cfg, calls } = cfgServing(doc);
    await expect(fetchClientMetadata(cfg, "https://evil.example/x.json")).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("resolveClient falls back to signed client ids", async () => {
    const { cfg } = cfgServing(doc);
    await expect(resolveClient(cfg, "garbage")).rejects.toThrow();
    expect(await resolveClient(cfg, DOC_URL)).toEqual({ redirectUris: doc.redirect_uris, name: "Claude" });
  });
});
```

`discovery.test.ts`: the authorization server metadata includes `client_id_metadata_document_supported: true`.

`authorize.test.ts`: with a config whose fetch serves `doc` for `DOC_URL`, `GET /authorize` with `client_id: DOC_URL` and the Claude redirect renders the consent page naming "Claude (claude.ai)"; with `redirect_uri` not in the document → 400; the full consent → post → callback sequence works with the CIMD client id (reuse `pressContinue`/`login` helpers with an override for `client_id`).

`token.test.ts`: authorization_code exchange with `client_id: DOC_URL` succeeds (fake Fiken as in `setup()`, plus the document served for `DOC_URL`); with a document whose `redirect_uris` lacks the code's `ru` → 400 `invalid_grant`.

- [ ] **Steps 2–4**, **Step 5: Commit** `Client ID Metadata Documents: Claude's published identity as a client id`

---

### Task 5: Docs

**Files:** `README.md` (my_usage, `/stats`, CIMD supported, privacy sentence about the counters unchanged), `docs/superpowers/specs/2026-09-22-fiken-mcp-design.md` (section 6: record after the call, awaited; section 12: 401 done; section 14: remove CIMD, usage, 401 from the lists), `docs/superpowers/specs/2026-09-22-fiken-mcp-decision-record.md` (why counters record after the call instead of in parallel: correct error counts, one code path, ~30 ms after the Fiken response), `CLAUDE.md` process line.

- [ ] **Commit** `Docs: usage counters, 401 refresh, CIMD`

---

### Task 6: Manual checks (Jonas)

After merge and deploy: `curl -s https://api.fiken-mcp.byjoba.com/stats` shows `totalUsers` 1 or 2 and this month's counters after a few tool calls; `my_usage` in Claude matches; in Claude Desktop's connector settings choose "Use Claude's published identity" and reconnect: the consent page names Claude and the login completes; revoke "Fiken MCP" in Fiken, call a tool, and confirm Claude re-authenticates instead of showing an error.

---

## Self-review

- Spec coverage: section 6 table rows, atomic ADDs, activeUsers and totalUsers semantics, `my_usage`, `/stats` with a cache header; section 12 Fiken 401 → 401 with `WWW-Authenticate`; section 14 CIMD as specified there. Not in this plan: the remaining Fiken tools (next plan).
- Placeholders: none.
- Type consistency: `ToolContext` gains `usage` (Task 2) and `session` (Task 3); helpers updated in the same tasks. `Config.usage` from Task 1 is what routes pass. `resolveClient` replaces `readClientId` at its two call sites in Task 4; `readClientId` stays exported for the signed path and tests.
