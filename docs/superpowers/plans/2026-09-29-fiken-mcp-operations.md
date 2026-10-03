# Fiken MCP Operations Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace one-MCP-tool-per-Fiken-action with a small fixed tool list: a handful of hot-path tools plus `fiken_explore`, `fiken_read` and `fiken_write`, which reach every operation through a registry. Connector URLs can narrow what a connection exposes (`/mcp/readonly`, `/mcp/invoices,sales`) without storing anything.

**Architecture:** Every current tool becomes an `Operation` (name, concept, read or write, destructive flag, zod input, `run`). The registry is the single list. A few operations stay registered as real MCP tools because the receipts flow needs them without an extra round trip; every operation, including those, is reachable through the gateway. `fiken_explore` returns concepts, then a concept's operations with JSON Schema inputs; `fiken_read` and `fiken_write` validate `args` against the operation's zod schema and run it through the same `counted()` wrapper as before. Nothing about validation, read-backs, the write guard, trims or error texts changes: it moves, it is not rewritten.

**Why not dynamic tool lists:** Claude caches a connector's tool list until the connector is re-added (spec section 3, verified by the spike), and the server is stateless with no session to remember "contacts opened". Disclosure therefore happens in tool results.

**Tech Stack:** as before. `z.toJSONSchema` from zod 4 (verified present in the installed zod 4.6.5).

**Spec:** docs/superpowers/specs/2026-09-22-fiken-mcp-design.md sections 3, 8, 9, 12. Decision record: docs/superpowers/specs/2026-09-22-fiken-mcp-decision-record.md.

## Global Constraints

- Operation names stay exactly the current tool names (`list_sales`, `create_invoice`, ...). Usage counters, descriptions that name other operations, and existing tests keep working. Names match `^[a-z_]+$`.
- Behaviour of every operation is unchanged: same inputs, same Fiken calls, same outputs and error texts. Tests that exercised a tool now exercise the same operation.
- `upload_receipts` and `get_upload_url` stay real tools and are not operations (the widget is bound to a tool; the ticket needs the config).
- Store no user data. Connector options come from the URL path on every request.
- Every tool and every operation call is counted under the operation's name; gateway failures that never reach an operation (unknown name, wrong gateway, invalid args) are counted under the gateway's name as errors.
- Never log a token, code, email, header, body or parameter value.
- Never run `aws`, `cdk deploy`, `cdk bootstrap` or `cdk destroy`. Never push to main. Branch `operations` from main (2217687).
- Never modify files through shell commands; use the editor tools.
- Commit after every task with the trailers `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01ELoGmasq8hztag5VGsjesY`.
- Keep the README current (Task 4).

## Review Focus

1. **A write operation called through `fiken_read`.** Refused before any Fiken call with a message naming `fiken_write`; nothing runs. Pinned in Task 2.
2. **Arguments that do not match the operation's schema** (missing `companySlug`, a string where a number belongs, extra unknown keys). Refused before any Fiken call; the error names the operation, the problem and the expected input. Pinned in Task 2.
3. **`/mcp/readonly`.** No tool that can write is listed, `fiken_write` is absent, and `fiken_explore` lists no write operation; a write reached some other way (for example a hand-crafted `tools/call` to `fiken_write`) is refused. Pinned in Task 3.
4. **An unknown option in the connector path** (`/mcp/invoicez`). Answers 400 naming the unknown word and the valid ones, instead of silently exposing everything. Pinned in Task 3.
5. **OAuth discovery for an option path.** `/.well-known/oauth-protected-resource/mcp/readonly` returns `resource: <publicUrl>/mcp/readonly`, and a 401 on `/mcp/readonly` points `resource_metadata` there, so a client that checks the resource against the URL it was given accepts it. Pinned in Task 3.

---

### Task 1: Operations and the registry (no behaviour change)

**Files:**
- Create: `api/src/mcp/operations.ts` (types, `CONCEPTS`, `defineOperation`, `registerOperationTool`)
- Create: `api/src/mcp/registry.ts` (`OPERATIONS`, `getOperation`)
- Modify: every file in `api/src/mcp/tools/` except `common.ts` and `upload.ts`: replace `registerX(server, ctx)` with `export const xOperations: Operation[] = [...]` built with `defineOperation`, moving each tool's name, title, description, input schema, annotations and handler body unchanged. `upload.ts` stays as it is.
- Modify: `api/src/mcp/server.ts` (`registerAllTools` registers every operation from the registry as a real tool via `registerOperationTool`; imports of the removed `registerX` functions go)
- Test: `api/test/mcp/registry.test.ts`

**Interfaces:**
```ts
// api/src/mcp/operations.ts
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import type { z } from "zod";
import { counted, type ToolContext } from "./server.js";

export const CONCEPTS = {
  companies: "Companies the user can access, and their slugs",
  contacts: "Customers and suppliers",
  projects: "Projects that purchases and invoices can be booked on",
  accounts: "Chart of accounts, bank accounts and balances",
  ledger: "Journal entries",
  purchases: "Purchases (bilag) and their receipts",
  sales: "Sales, including invoiced ones",
  invoices: "Invoices and invoice drafts: create, issue, send",
  credit_notes: "Credit notes on issued invoices",
  payments: "Payments on sales and purchases",
  products: "Products and services the company sells",
  inbox: "The company's document inbox",
  attachments: "Files attached to purchases, sales, invoices and journal entries",
  usage: "Your own usage counters on this server",
} as const;
export type Concept = keyof typeof CONCEPTS;

export interface Operation<S extends z.ZodObject = z.ZodObject> {
  name: string;
  concept: Concept;
  kind: "read" | "write";
  /** False for reads and for writes that only prepare something (drafts). */
  destructive: boolean;
  title: string;
  description: string;
  input: S;
  run(ctx: ToolContext, args: z.output<S>): Promise<CallToolResult>;
}

export function defineOperation<S extends z.ZodObject>(op: Operation<S>): Operation {
  return op as unknown as Operation;
}

/** Registers an operation as a real MCP tool, counted under its own name. */
export function registerOperationTool(server: McpServer, ctx: ToolContext, op: Operation): void {
  server.registerTool(
    op.name,
    {
      title: op.title,
      description: op.description,
      inputSchema: op.input,
      annotations: op.kind === "read" ? { readOnlyHint: true } : { readOnlyHint: false, destructiveHint: op.destructive },
    },
    counted(ctx, op.name, (args) => op.run(ctx, args as never)),
  );
}
```
`defineOperation` exists so each operation's `run` is typed from its own schema while the registry holds a uniform `Operation[]`. If the cast can be avoided with a cleaner generic, do that; do not use `any`.

```ts
// api/src/mcp/registry.ts
export const OPERATIONS: readonly Operation[]; // every operation from every tools/*.ts file, in the order registerAllTools used
export function getOperation(name: string): Operation | undefined;
```
Concept of each current tool: `list_companies` companies; `search_contacts`, `get_contact`, `create_contact` contacts; `list_projects` projects; `list_accounts`, `list_bank_accounts`, `account_balances`, `bank_balances` accounts; `get_journal_entries` ledger; `list_purchases`, `get_purchase`, `create_purchase` purchases; `list_sales` sales; `list_invoices`, `get_invoice`, `create_invoice`, `create_invoice_draft`, `create_invoice_from_draft`, `send_invoice` invoices; `create_credit_note` credit_notes; `register_payment` payments; `list_products` products; `list_inbox`, `get_inbox_document` inbox; `attach_inbox_document`, `get_attachments` attachments; `my_usage` usage. `destructive` is `true` for every write except `create_invoice_draft` and `create_contact`, which today carry `destructiveHint: false` (checked 2026-09-29); `create_contact` keeps its `CONFIRM`.

- [ ] **Step 1: Failing test** (`api/test/mcp/registry.test.ts`):
```ts
import { describe, expect, it } from "vitest";
import { CONCEPTS } from "../../src/mcp/operations.js";
import { OPERATIONS, getOperation } from "../../src/mcp/registry.js";
import { connected, fakeFiken } from "./helpers.js";

const EXPECTED = [
  "list_companies", "list_projects", "list_accounts", "list_bank_accounts", "account_balances", "bank_balances",
  "search_contacts", "get_contact", "create_contact", "list_purchases", "get_purchase", "create_purchase",
  "attach_inbox_document", "get_attachments", "list_inbox", "get_inbox_document", "list_sales",
  "list_invoices", "get_invoice", "create_invoice", "create_invoice_draft", "create_invoice_from_draft", "send_invoice",
  "create_credit_note", "register_payment", "list_products", "get_journal_entries", "my_usage",
];

describe("operation registry", () => {
  it("holds every former tool once, with a known concept and a plain name", () => {
    expect([...OPERATIONS.map((o) => o.name)].sort()).toEqual([...EXPECTED].sort());
    for (const op of OPERATIONS) {
      expect(op.name).toMatch(/^[a-z_]+$/);
      expect(Object.keys(CONCEPTS)).toContain(op.concept);
      expect(getOperation(op.name)).toBe(op);
      if (op.kind === "read") expect(op.destructive).toBe(false);
    }
    expect(getOperation("nope")).toBeUndefined();
  });

  it("marks consequential writes and asks for confirmation in them", () => {
    // Drafts and new contacts are writes that are easy to undo in Fiken, so they are not destructive (unchanged from today).
    const notDestructive = ["create_invoice_draft", "create_contact"];
    for (const op of OPERATIONS.filter((o) => o.kind === "write")) {
      expect(op.destructive, op.name).toBe(!notDestructive.includes(op.name));
      if (op.name !== "create_invoice_draft") expect(op.description, op.name).toContain("Consequential");
    }
  });

  it("registers every operation as a tool with the same annotations as before", async () => {
    const c = await connected(fakeFiken([]).fetchImpl);
    const { tools } = await c.listTools();
    for (const op of OPERATIONS) {
      const tool = tools.find((t) => t.name === op.name);
      expect(tool, op.name).toBeDefined();
      expect(tool?.annotations?.readOnlyHint, op.name).toBe(op.kind === "read");
    }
  });
});
```
- [ ] **Step 2** run to fail. **Step 3** convert the files one by one; after each file run its existing test file. **Step 4** `npm test` and `npm run typecheck` from the root: every existing test passes unchanged except imports of removed `registerX` functions (there should be none outside `server.ts`). **Step 5: Commit** `Operations: every tool is an Operation in one registry (no behaviour change)`

---

### Task 2: The gateway tools; only hot-path operations stay real tools

**Files:**
- Create: `api/src/mcp/gateway.ts` (`registerGateway(server, ctx, visible)` registering `fiken_explore`, `fiken_read`, `fiken_write`)
- Modify: `api/src/mcp/server.ts` (`HOT_PATH`; `registerAllTools(server, ctx)` registers `HOT_PATH` operations as tools plus the gateway), `api/test/mcp/helpers.ts` (`callJson` routes non-real names through the gateway)
- Test: `api/test/mcp/gateway.test.ts`; adjust `api/test/mcp/tools.test.ts` only where it lists tools directly (the destructive/CONFIRM loop moves to registry.test.ts, which already covers it)

**Interfaces:**
- `export const HOT_PATH = ["list_companies", "list_projects", "list_accounts", "list_bank_accounts", "search_contacts", "list_inbox", "create_purchase"] as const;` The receipts flow on a phone needs these without an explore round trip.
- `registerGateway(server, ctx, visible: readonly Operation[])` where `visible` is the list the gateway may show and run (Task 3 narrows it; here it is `OPERATIONS`).
- `fiken_explore` input `{ path: z.string().optional().describe("Empty for the list of concepts; a concept such as invoices for its operations; an operation name for just that one") }`, read-only. Results (JSON via `toolJson`):
  - no path: `{ concepts: [{ name, summary, operations: string[] }], usage: "Pass an operation name and its args to fiken_read (reads) or fiken_write (writes). Operation names can also be used directly when an earlier result names them." }` listing only concepts that have at least one visible operation.
  - a concept: `{ concept, summary, operations: [{ name, kind, destructive, title, description, input }] }` where `input` is `z.toJSONSchema(op.input)`.
  - an operation name: that one entry.
  - anything else: `isError` `Unknown path "<path>". Concepts: <comma list>.`
- `fiken_read` input `{ operation: z.string().min(1), args: z.record(z.string(), z.unknown()).default({}) }`, read-only. `fiken_write` same input, `readOnlyHint: false, destructiveHint: true`, description ends with `CONFIRM`.
  - Unknown operation (or not in `visible`): `isError` `Unknown operation "<name>". Call fiken_explore to see what exists.`
  - Wrong gateway: `isError` `<name> is a write operation; call it with fiken_write.` (and the mirror `... is a read operation; call it with fiken_read.`).
  - Invalid args: `op.input.strict()` would reject extra keys; use `op.input.strict().safeParse(args)` so a mistyped key is caught. On failure `isError` `Invalid arguments for <name>: <z.prettifyError(error)>\nExpected input: <JSON.stringify(z.toJSONSchema(op.input))>`.
  - These three failures are recorded as `counted(ctx, "<gateway name>", ...)` errors; they make no Fiken call.
  - Success: `counted(ctx, op.name, () => op.run(ctx, parsed.data))`, so counters, the write guard and `noteFikenError` behave exactly as for a real tool.
- Descriptions: `fiken_explore` "Find what this connector can do in Fiken beyond the tools listed directly: call with no path for the list of concepts (contacts, invoices, sales, ...), then with a concept to get its operations and their exact inputs." `fiken_read` "Run a read operation found with fiken_explore, with its args. Reads never change anything in Fiken." `fiken_write` "Run a write operation found with fiken_explore, with its args. Writes change the company's accounting in Fiken; some are final (an issued invoice cannot be deleted, a sent invoice has reached the customer). " + `CONFIRM`.
- Test helper: `callJson(client, name, args)` calls the tool directly when `name` is a real tool (a `HOT_PATH` name, a `fiken_*` gateway tool, `upload_receipts` or `get_upload_url`) and otherwise calls `fiken_read` or `fiken_write` (chosen by `getOperation(name).kind`) with `{ operation: name, args }`. `my_usage` is an operation, so it goes through `fiken_read`. The return shape is unchanged, so existing tests keep their assertions.

- [ ] **Step 1: Failing tests** (`api/test/mcp/gateway.test.ts`):
```ts
import { describe, expect, it } from "vitest";
import { memoryUsageStore } from "../../src/usage/memory.js";
import { connected, fakeFiken } from "./helpers.js";

type Block = { type: string; text?: string };
async function call(c: Awaited<ReturnType<typeof connected>>, name: string, args: Record<string, unknown>) {
  const r = await c.callTool({ name, arguments: args });
  const text = (r.content as Block[])[0]?.text ?? "";
  return { isError: r.isError === true, text, json: () => JSON.parse(text) as unknown };
}

describe("gateway", () => {
  it("lists only the hot path, the gateway and the upload tools", async () => {
    const c = await connected(fakeFiken([]).fetchImpl);
    expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual([
      "create_purchase", "fiken_explore", "fiken_read", "fiken_write", "list_accounts", "list_bank_accounts",
      "list_companies", "list_inbox", "list_projects", "search_contacts",
    ]);
  });

  it("explores concepts, then a concept's operations with JSON Schema inputs", async () => {
    const c = await connected(fakeFiken([]).fetchImpl);
    const root = (await call(c, "fiken_explore", {})).json() as { concepts: Array<{ name: string; operations: string[] }> };
    expect(root.concepts.find((x) => x.name === "invoices")?.operations).toContain("send_invoice");
    const inv = (await call(c, "fiken_explore", { path: "invoices" })).json() as { operations: Array<{ name: string; kind: string; input: { properties: Record<string, unknown> } }> };
    const send = inv.operations.find((o) => o.name === "send_invoice");
    expect(send?.kind).toBe("write");
    expect(Object.keys(send?.input.properties ?? {})).toEqual(expect.arrayContaining(["companySlug", "invoiceId", "method"]));
    expect((await call(c, "fiken_explore", { path: "send_invoice" })).json()).toMatchObject({ name: "send_invoice", kind: "write" });
    const bad = await call(c, "fiken_explore", { path: "invoicez" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("Concepts: ");
  });

  it("runs a read through fiken_read and counts it under the operation's name", async () => {
    const usage = memoryUsageStore();
    const f = fakeFiken([{ match: /\/sales\?/, headers: { "Fiken-Api-Result-Count": "0" }, body: [] }]);
    const c = await connected(f.fetchImpl, { usage });
    const r = await call(c, "fiken_read", { operation: "list_sales", args: { companySlug: "demo" } });
    expect(r.json()).toEqual({ items: [], total: 0, page: 0, pageSize: 25 });
    expect((await usage.userMonths("anon"))[0]?.tools).toEqual({ list_sales: 1 });
  });

  it("refuses the wrong gateway, an unknown operation and bad args before any Fiken call", async () => {
    const usage = memoryUsageStore();
    const f = fakeFiken([]);
    const c = await connected(f.fetchImpl, { usage });
    const wrong = await call(c, "fiken_read", { operation: "send_invoice", args: { companySlug: "demo", invoiceId: 1 } });
    expect(wrong).toMatchObject({ isError: true, text: "send_invoice is a write operation; call it with fiken_write." });
    const mirror = await call(c, "fiken_write", { operation: "list_sales", args: { companySlug: "demo" } });
    expect(mirror.text).toBe("list_sales is a read operation; call it with fiken_read.");
    const unknown = await call(c, "fiken_read", { operation: "list_salez", args: {} });
    expect(unknown.text).toBe('Unknown operation "list_salez". Call fiken_explore to see what exists.');
    const invalid = await call(c, "fiken_read", { operation: "get_invoice", args: { companySlug: "demo", invoiceId: "77", invoiceID: 77 } });
    expect(invalid.isError).toBe(true);
    expect(invalid.text).toContain("Invalid arguments for get_invoice");
    expect(invalid.text).toContain("Expected input:");
    expect(f.calls).toHaveLength(0);
    expect((await usage.userMonths("anon"))[0]).toMatchObject({ calls: 4, errors: 4, tools: { fiken_read: 3, fiken_write: 1 } });
  });

  it("runs a write through fiken_write with the same validation and write guard", async () => {
    const session = { fikenUnauthorized: false, wrote: false };
    const f = fakeFiken([
      { match: /\/invoices$/, status: 201, headers: { location: "https://api.test/v2/companies/demo/invoices/77" } },
      { match: /\/invoices\/77$/, status: 401, body: "expired" },
    ]);
    const c = await connected(f.fetchImpl, { session });
    const line = { description: "Konsulenttimer", quantity: 1, unitPrice: 100000, vatType: "HIGH", incomeAccount: "3000" };
    const r = await call(c, "fiken_write", { operation: "create_invoice", args: {
      companySlug: "demo", customerId: 7, issueDate: "2026-09-29", dueDate: "2026-10-13", bankAccountCode: "1920:10001", lines: [line],
    } });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Invoice 77 was created");
    expect(session.fikenUnauthorized).toBe(false);
  });
});
```
- [ ] **Step 2** run to fail. **Step 3** implement; update `helpers.ts` so every existing test still passes through the gateway. **Step 4** `npm test`, `npm run typecheck`. **Step 5: Commit** `Gateway: fiken_explore, fiken_read, fiken_write; hot-path operations stay real tools`

---

### Task 3: Connector options in the URL path

**Files:**
- Create: `api/src/mcp/options.ts` (`parseConnectorOptions`, `visibleOperations`)
- Modify: `api/src/mcp/routes.ts` (accept `POST /mcp/:options`, 405 for GET/DELETE on it too, pass options to `createMcpServer`; the 401 challenge's `resource_metadata` follows the request path), `api/src/mcp/server.ts` (`createMcpServer(ctx, publicUrl?, cfg?, options?)`), `api/src/mcp/gateway.ts` (uses `visible`), `api/src/auth/routes.ts` (`GET /.well-known/oauth-protected-resource/mcp/:options` mirrors the path; `GET /.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp` keep answering for `/mcp`)
- Test: `api/test/mcp/options.test.ts`, `api/test/auth/discovery.test.ts` (extend), `api/test/mcp/routes.test.ts` (extend)

**Interfaces:**
```ts
export interface ConnectorOptions { readOnly: boolean; concepts?: ReadonlySet<Concept> }
/** "" → everything; "readonly" → reads only; "invoices,sales" → those concepts; "invoices,readonly" → both. */
export function parseConnectorOptions(segment: string): { ok: ConnectorOptions } | { error: string };
export function visibleOperations(options: ConnectorOptions): readonly Operation[];
```
- Parsing: split on `,`, trim, lower-case, drop empty parts; `readonly` sets `readOnly`; every other word must be a key of `CONCEPTS`, else `{ error: "Unknown connector option \"<word>\". Use readonly and any of: <concept list>." }`. A path with only `readonly` leaves `concepts` undefined.
- `visibleOperations`: all operations, minus writes when `readOnly`, restricted to `concepts ∪ {companies}` when `concepts` is set (`list_companies` is always needed for slugs).
- `createMcpServer` registers: hot-path operations that are visible; the gateway with `visible` (and `fiken_write` only when at least one visible operation is a write); the upload tools only when not `readOnly` and `inbox` or `purchases` is visible (or no concept filter).
- Routes: `/mcp` behaves as today (`options = { readOnly: false }`). `/mcp/:options` parses; an error answers `400` JSON `{ error: "invalid_connector_options", message }` after the bearer check (an unauthenticated request still gets the 401 challenge first). The challenge for `/mcp/<segment>` is `Bearer error="invalid_token", resource_metadata="<publicUrl>/.well-known/oauth-protected-resource/mcp/<segment>"`; for `/mcp` it stays exactly as today.
- Discovery: `/.well-known/oauth-protected-resource/mcp/<segment>` returns the same body as today with `resource: "<publicUrl>/mcp/<segment>"`; an invalid segment answers 404.

- [ ] **Step 1: Failing tests.** `api/test/mcp/options.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { parseConnectorOptions, visibleOperations } from "../../src/mcp/options.js";
import { connected, fakeFiken } from "./helpers.js";

describe("connector options", () => {
  it("parses readonly and concepts, and names an unknown word", () => {
    expect(parseConnectorOptions("")).toEqual({ ok: { readOnly: false } });
    expect(parseConnectorOptions("readonly")).toEqual({ ok: { readOnly: true } });
    const both = parseConnectorOptions("Invoices, sales,readonly");
    expect("ok" in both && both.ok.readOnly).toBe(true);
    expect("ok" in both && [...(both.ok.concepts ?? [])].sort()).toEqual(["invoices", "sales"]);
    const bad = parseConnectorOptions("invoicez");
    expect("error" in bad && bad.error).toMatch(/^Unknown connector option "invoicez"\. Use readonly and any of: /);
  });

  it("readonly hides every write; a concept filter keeps companies", () => {
    const ro = parseConnectorOptions("readonly");
    if (!("ok" in ro)) throw new Error("parse");
    expect(visibleOperations(ro.ok).every((o) => o.kind === "read")).toBe(true);
    const inv = parseConnectorOptions("invoices");
    if (!("ok" in inv)) throw new Error("parse");
    expect(new Set(visibleOperations(inv.ok).map((o) => o.concept))).toEqual(new Set(["invoices", "companies"]));
  });

  it("a readonly server lists no writing tool and refuses a write through the gateway", async () => {
    const f = fakeFiken([]);
    const c = await connected(f.fetchImpl, { options: { readOnly: true } });
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("fiken_write");
    expect(names).not.toContain("create_purchase");
    expect(names).not.toContain("upload_receipts");
    const explore = await c.callTool({ name: "fiken_explore", arguments: { path: "invoices" } });
    expect((explore.content as Array<{ text: string }>)[0]?.text).not.toContain('"kind": "write"');
    const r = await c.callTool({ name: "fiken_read", arguments: { operation: "send_invoice", args: { companySlug: "demo", invoiceId: 1 } } });
    expect(r.isError).toBe(true);
    expect(f.calls).toHaveLength(0);
  });
});
```
`connected()` gains `opts.options?: ConnectorOptions`, passed to `createMcpServer`. In a readonly server `send_invoice` is not visible, so `fiken_read` answers the "Unknown operation" text (the operation does not exist for this connection); the test asserts only `isError` and no call.

`api/test/auth/discovery.test.ts` (add):
```ts
  it("mirrors a connector option path in the protected resource metadata", async () => {
    const res = await app.request("/.well-known/oauth-protected-resource/mcp/readonly");
    expect(res.status).toBe(200);
    expect((await res.json()).resource).toBe("https://fiken-mcp.test/mcp/readonly");
    expect((await app.request("/.well-known/oauth-protected-resource/mcp/invoicez")).status).toBe(404);
    expect((await (await app.request("/.well-known/oauth-protected-resource/mcp")).json()).resource).toBe("https://fiken-mcp.test/mcp");
  });
```
(use the file's existing `app`; adapt the base URL to what its other assertions use.)

`api/test/mcp/routes.test.ts` (add; uses the file's `rpc` pattern with a path parameter or an inline request):
```ts
  it("serves option paths: a 401 points at their own metadata, an unknown option is a 400", async () => {
    const unauth = await app.request("/mcp/readonly", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get("www-authenticate")).toBe('Bearer error="invalid_token", resource_metadata="https://fiken-mcp.test/.well-known/oauth-protected-resource/mcp/readonly"');
    const bad = await app.request("/mcp/invoicez", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("invalid_connector_options");
    const ro = await app.request("/mcp/readonly", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const names = ((await ro.json()).result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain("fiken_read");
    expect(names).not.toContain("fiken_write");
  });
```
- [ ] **Step 2** run to fail; **Step 3** implement; **Step 4** `npm test`, `npm run typecheck`; **Step 5: Commit** `Connector options in the URL path: /mcp/readonly, /mcp/<concepts>`

---

### Task 4: Docs

**Files:** `README.md` (the tool list becomes: the hot-path tools, the upload tools, and `fiken_explore`/`fiken_read`/`fiken_write` with the concepts and their operations listed underneath; a "Connector URL options" section: `https://api.fiken-mcp.byjoba.com/mcp` for everything, `/mcp/readonly`, `/mcp/invoices,sales`, `/mcp/invoices,readonly`, with the concept names), `docs/superpowers/specs/2026-09-22-fiken-mcp-design.md` (section 8 describes the gateway, the hot path and the registry; section 14 records this plan as done and names the next plan: adding the Fiken areas not yet covered as operations, deletes and reversals excluded until decided), `docs/superpowers/specs/2026-09-22-fiken-mcp-decision-record.md` (why progressive disclosure through tool results and not dynamic tool lists (Claude's cached tool list, the stateless server); why read and write are separate gateway tools (host confirmation follows annotations); why options live in the path and not a query string (protected resource metadata must match the URL the client was given); what the hot path is and why), `CLAUDE.md` (process line), `docs/setup.md` ("Verify after deploying the operations plan": re-add the connector (tool lists are cached) and check the new tool list; ask Claude to "send invoice 10042" and confirm it explores, then uses `fiken_write` with a confirmation; add a second connector with `/mcp/readonly` in Claude and confirm login works and no write tool appears; run the receipts flow on a phone and confirm it still needs no `fiken_explore`).
- [ ] **Commit** `Docs: the operations gateway and connector URL options`

---

## Self-review

- Spec coverage: every former tool reachable (Task 1 registry test, Task 2 gateway tests); hot path unchanged for the receipts flow (Task 2 tool list); options without storage (Task 3). The Fiken areas not yet covered are the next plan, named in Task 4.
- Placeholders: none. Each task has tests and interfaces.
- Type consistency: `Operation`, `CONCEPTS`, `Concept` (Task 1) are used by the gateway (Task 2) and options (Task 3); `registerGateway(server, ctx, visible)` (Task 2) receives `visibleOperations(options)` (Task 3); `connected()` gains `options` in Task 3.
- Review Focus: lines 1 and 2 → Task 2 gateway tests; 3 → Task 3 options test; 4 and 5 → Task 3 routes and discovery tests.
