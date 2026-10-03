# Fiken MCP Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the Fiken areas the connector does not cover yet as operations behind the gateway: sales without an invoice, manual journal entries and transactions, purchase drafts, projects, products and contact maintenance, invoice drafts and number counters, credit note reads and sending, offers and order confirmations, recurring invoices, time tracking, the EHF inbox and accruals. Deletes and reversals stay out.

**Architecture:** Every new capability is an `Operation` (`api/src/mcp/operations.ts`) in a tool file under `api/src/mcp/tools/`, added to `OPERATIONS` in `api/src/mcp/registry.ts`. None becomes a real MCP tool: they are reached through `fiken_explore`, `fiken_read` and `fiken_write`. The patterns already in the code are reused: validation before any Fiken call, `defined()` bodies, read-back after a create with a "was created, do not repeat" error (`gatewayCall()` naming the exact gateway call), strict line schemas, `withCompany`, `counted()` via the gateway. Two shared helpers are extracted where three document types need the same thing: sending a document (invoice, credit note, offer) and creating an invoice-like draft (invoice, offer, order confirmation, recurring invoice).

**Tech Stack:** as before.

**Spec:** docs/superpowers/specs/2026-09-22-fiken-mcp-design.md sections 8 and 14. Decision record: docs/superpowers/specs/2026-09-22-fiken-mcp-decision-record.md. Fiken API: `https://api.fiken.no/api/v2/docs/swagger.yaml` (2.0.0), read 2026-09-29; every endpoint and field below is copied from it.

## Global Constraints

- New operations are gateway-only: `HOT_PATH` in `api/src/mcp/server.ts` does not change.
- Operation names match `^[a-z_]+$`, are unique, and use a concept from `CONCEPTS`. New concepts added in this plan: `offers`, `order_confirmations`, `recurring_invoices`, `time_tracking`, `ehf`. Transactions and accruals belong to `ledger`.
- Every description that names another operation which is not a `HOT_PATH` tool says how to call it (`(via fiken_read)` / `(via fiken_write)`); the existing registry test enforces this and runs over the new operations automatically. Every "from <op>" source must be a read (the per-concept completeness test in `options.test.ts` enforces it).
- Writes: `kind: "write"`, `destructive: true` and `CONFIRM` at the end of the description, except drafts, which are `destructive: false` and may omit `CONFIRM`. Money is integers in øre (`ORE`); NOK only where the tool says so.
- Line arrays are strict objects (a mistyped key is refused).
- Updates that Fiken implements as a full `PUT` (contacts, products, invoice drafts) are read-modify-write: GET the current object, overlay only the fields the caller gave, PUT the result, so a partial update never blanks other fields.
- No delete, reversal, cancel or write-off-undo operation. `write_off_sale` is included (it books a loss, it does not delete).
- Store no user data; never log values; every Fiken call through `FikenClient`.
- Never run `aws`, `cdk deploy`, `cdk bootstrap` or `cdk destroy`. Never push to main. Branch `coverage` from `operations` (09cde18).
- Never modify files through shell commands; use the editor tools.
- Commit after every task with the trailers `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01ELoGmasq8hztag5VGsjesY`.
- Each task adds its operation names to `EXPECTED` in `api/test/mcp/registry.test.ts` and keeps README's operation list current.

## Review Focus

1. **A partial update of a contact, product or invoice draft.** Only the given fields change; everything else Fiken had is sent back unchanged. Pinned in Tasks 4 and 5.
2. **A manual journal entry that does not balance.** Refused before any Fiken call with the sum of debits and credits named. Pinned in Task 2.
3. **Sending a credit note or an offer.** Same defaults and safety as `send_invoice` (method `["auto"]`, attachments included), shared code, "reaches the customer at once". Pinned in Tasks 5 and 6.
4. **Initializing an invoice or credit note counter that already exists.** Refused before the POST (the tool reads the counter first), so an existing number series is never reset. Pinned in Task 5.
5. **A time entry or recurring invoice job action on the wrong id.** Fiken's 404 comes back as "check the id" (the company exists), not "company not found". Covered by `withCompany`; pinned once in Task 7.

---

### Task 1: Sales without an invoice, settling, write-offs, payment lookups

**Files:** Modify `api/src/mcp/tools/sales.ts` (new operations), `api/src/mcp/tools/payments.ts` (`list_payments`), `api/src/mcp/registry.ts` (if a new export is needed). Test: `api/test/mcp/sales-more.test.ts`.

**Operations:**
- `get_sale` (read, sales): `GET /sales/{saleId}` → the `list_sales` trim plus `lines` (`{ description, netPrice, vat, vatType, account }`) and `payments` count.
- `create_sale` (write, sales, destructive): `POST /sales` then `GET /sales/{id}`. Input: `companySlug, date, kind: "cash_sale" | "external_invoice", lines` (strict `{ description, netPrice (øre), vat (øre), vatType, account?, projectId? }`, at least one), `currency` default `"NOK"`, `customerId?`, `dueDate?`, `kid?`, `paymentAccount?`, `paymentDate?`, `paymentFee?`, `projectId?`, `saleNumber?`. Validation before any call: `cash_sale` needs `paymentAccount` and `paymentDate`; `external_invoice` needs `customerId` and `dueDate`. Description: "Book income that was not invoiced through Fiken: a cash sale (card terminal, Vipps, cash, paid at once) or an invoice issued in another system (external_invoice). For an invoice sent from Fiken use create_invoice (via fiken_write)." + `ORE` + `CONFIRM`. Read-back failure: `Sale ${id} was created; fetching it back failed: ${message}. Do not create it again; ${gatewayCall("fiken_read", "get_sale", { companySlug, saleId: id })}.`
- `settle_sale` (write, sales, destructive): `PATCH /sales/{saleId}/settled` (no body). Description: "Mark a sale as settled without registering a payment (for example when it was settled by offsetting). To record money received use register_payment (via fiken_write)." + `CONFIRM`. Returns `{ saleId, settled: true }`.
- `write_off_sale` (write, sales, destructive): `PATCH /sales/{saleId}/writeOff` body `{ type, date, comment? }`, `type` one of `OVERDUE_6_MONTHS, COLLECTION_FAILED, CUSTOMER_BANKRUPTCY, DEEMED_IRRECOVERABLE`. Description: "Book a sale as a loss (tapsføring). The reason must be true for Fiken's rules; the date must be after the sale date." + `CONFIRM`. Returns `{ saleId, writtenOff: true, type }`.
- `list_payments` (read, payments): exactly one of `saleId`, `purchaseId` (refused otherwise, before any call); `GET /sales/{id}/payments` or `/purchases/{id}/payments` → `{ items: [{ paymentId, date, account, amount, fee }] }`.
- `FikenClient` has no PATCH-without-body helper: use `ctx.fiken.send`'s sibling if one exists, otherwise add `patch(path, body?)` to the client (PATCH through the queue and `onWrite`, resolves on 2xx, throws `FikenError` otherwise), with a client test.

- [ ] **Step 1: Failing tests** (`api/test/mcp/sales-more.test.ts`):
```ts
import { describe, expect, it } from "vitest";
import { callJson, connected, fakeFiken } from "./helpers.js";

const sale = { saleId: 9, saleNumber: "S9", date: "2026-09-29", kind: "cash_sale", netAmount: 10000, vatAmount: 2500, currency: "NOK", settled: true, deleted: false, totalPaid: 12500, outstandingBalance: 0,
  lines: [{ description: "Vipps", netPrice: 10000, vat: 2500, vatType: "HIGH", account: "3000", lineId: 1 }], salePayments: [{ paymentId: 1 }] };
const line = { description: "Vipps-salg", netPrice: 10000, vat: 2500, vatType: "HIGH", account: "3000" };

describe("sales", () => {
  it("create_sale books a cash sale and reads it back; validation runs first", async () => {
    const f = fakeFiken([
      { match: /\/sales$/, status: 201, headers: { location: "https://api.test/v2/companies/demo/sales/9" } },
      { match: /\/sales\/9$/, body: sale },
    ]);
    const c = await connected(f.fetchImpl);
    const noPay = await callJson(c, "create_sale", { companySlug: "demo", date: "2026-09-29", kind: "cash_sale", lines: [line] });
    expect(noPay.isError).toBe(true);
    expect(f.calls).toHaveLength(0);
    const typo = await callJson(c, "create_sale", { companySlug: "demo", date: "2026-09-29", kind: "cash_sale", paymentAccount: "1920:10001", paymentDate: "2026-09-29", lines: [{ ...line, netprice: 1 }] });
    expect(typo.isError).toBe(true);
    const ok = await callJson(c, "create_sale", { companySlug: "demo", date: "2026-09-29", kind: "cash_sale", paymentAccount: "1920:10001", paymentDate: "2026-09-29", lines: [line] });
    expect(ok.json()).toMatchObject({ saleId: 9, kind: "cash_sale", payments: 1 });
    expect(JSON.parse(String(f.calls[0]?.init?.body))).toEqual({ date: "2026-09-29", kind: "cash_sale", currency: "NOK", paymentAccount: "1920:10001", paymentDate: "2026-09-29", lines: [line] });
  });

  it("create_sale names the created sale when the read-back fails", async () => {
    const f = fakeFiken([
      { match: /\/sales$/, status: 201, headers: { location: "https://api.test/v2/companies/demo/sales/9" } },
      { match: /\/sales\/9$/, status: 500, body: "x" },
    ]);
    const c = await connected(f.fetchImpl);
    const r = await callJson(c, "create_sale", { companySlug: "demo", date: "2026-09-29", kind: "external_invoice", customerId: 7, dueDate: "2026-10-13", lines: [line] });
    expect(r.text).toContain("Sale 9 was created");
    expect(r.text).toContain('call fiken_read with {"operation":"get_sale"');
  });

  it("settle_sale and write_off_sale patch the sale", async () => {
    const f = fakeFiken([{ match: /\/sales\/9\/(settled|writeOff)$/, status: 200 }]);
    const c = await connected(f.fetchImpl);
    expect((await callJson(c, "settle_sale", { companySlug: "demo", saleId: 9 })).json()).toEqual({ saleId: 9, settled: true });
    expect(f.calls[0]?.init?.method).toBe("PATCH");
    const w = await callJson(c, "write_off_sale", { companySlug: "demo", saleId: 9, type: "COLLECTION_FAILED", date: "2026-09-29" });
    expect(w.json()).toEqual({ saleId: 9, writtenOff: true, type: "COLLECTION_FAILED" });
    expect(JSON.parse(String(f.calls[1]?.init?.body))).toEqual({ type: "COLLECTION_FAILED", date: "2026-09-29" });
  });

  it("list_payments needs exactly one target and trims", async () => {
    const f = fakeFiken([{ match: /\/purchases\/8\/payments$/, body: [{ paymentId: 4, date: "2026-09-29", account: "1920:10001", amount: 500, fee: 0, currency: "NOK" }] }]);
    const c = await connected(f.fetchImpl);
    expect((await callJson(c, "list_payments", { companySlug: "demo" })).isError).toBe(true);
    expect((await callJson(c, "list_payments", { companySlug: "demo", saleId: 1, purchaseId: 8 })).isError).toBe(true);
    expect(f.calls).toHaveLength(0);
    expect((await callJson(c, "list_payments", { companySlug: "demo", purchaseId: 8 })).json()).toEqual({ items: [{ paymentId: 4, date: "2026-09-29", account: "1920:10001", amount: 500, fee: 0 }] });
  });
});
```
- [ ] **Step 2** run to fail; **Step 3** implement; **Step 4** `npm test`, `npm run typecheck`; **Step 5: Commit** `Coverage: sales without an invoice, settle, write-off, payment lookups`

---

### Task 2: Manual journal entries and transactions

**Files:** Modify `api/src/mcp/tools/ledger.ts`. Test: `api/test/mcp/ledger-more.test.ts`.

**Operations:**
- `get_journal_entry` (read, ledger): `GET /journalEntries/{id}` → the `get_journal_entries` item trim.
- `create_journal_entry` (write, ledger, destructive): `POST /generalJournalEntries` with `{ description, open?, journalEntries: [{ description, date, lines }] }`. Input: `companySlug, description, date, lines` (strict, at least one: `{ amount (øre, positive), debitAccount?, creditAccount?, debitVatCode?, creditVatCode?, projectId? }`, each line needs `debitAccount` or `creditAccount`), `open?`. One journal entry per call (the request's array gets one element). Validation before any call: every line has at least one account; the sum of amounts on lines with only a `debitAccount` equals the sum on lines with only a `creditAccount` (a line with both is balanced by itself); otherwise `isError` `The entry does not balance: debit ${d} øre, credit ${c} øre.` Description: "Book a manual journal entry (fri postering): corrections, depreciation, salary, transfers between accounts. Each line moves amount (øre) to debitAccount and/or from creditAccount; debits and credits must balance. Fiken prefixes the description with 'Fri postering registrert via API: '." + `CONFIRM`. The 201 Location points at the journal entry (numeric id) or the transaction: read it back with `get_journal_entry` when the id resolves, and on a failed read-back return `Journal entry ${id} was created; ...` with the gateway call to `get_journal_entries` for the date. Record in the report which one Fiken returned in tests is unknowable; assume the journal entry and let the live check confirm.
- `list_transactions` (read, ledger): `GET /transactions` with `page, pageSize, createdDateGe, createdDateLe` → items `{ transactionId, createdDate, lastModifiedDate, description, type, entries: (entries ?? []).length }` (read `transaction` in the swagger for the exact fields; keep only what exists).
- `get_transaction` (read, ledger): `GET /transactions/{transactionId}` → full trimmed transaction including its journal entries (ids, numbers, dates, descriptions).

- [ ] **Step 1: Failing tests** (`api/test/mcp/ledger-more.test.ts`):
```ts
import { describe, expect, it } from "vitest";
import { callJson, connected, fakeFiken } from "./helpers.js";

const entry = { journalEntryId: 21, journalEntryNumber: 51, date: "2026-09-29", description: "Fri postering registrert via API: Avskrivning", lines: [{ amount: 100000, account: "6000" }, { amount: -100000, account: "1200" }], attachments: [] };

describe("manual journal entries", () => {
  it("refuses an entry that does not balance, before any call", async () => {
    const f = fakeFiken([]);
    const c = await connected(f.fetchImpl);
    const r = await callJson(c, "create_journal_entry", { companySlug: "demo", description: "Avskrivning", date: "2026-09-29",
      lines: [{ amount: 100000, debitAccount: "6000" }, { amount: 90000, creditAccount: "1200" }] });
    expect(r).toMatchObject({ isError: true, text: "The entry does not balance: debit 100000 øre, credit 90000 øre." });
    const noAccount = await callJson(c, "create_journal_entry", { companySlug: "demo", description: "x", date: "2026-09-29", lines: [{ amount: 1 }, { amount: 1, creditAccount: "1200" }] });
    expect(noAccount.isError).toBe(true);
    expect(f.calls).toHaveLength(0);
  });

  it("posts one entry and reads it back", async () => {
    const f = fakeFiken([
      { match: /\/generalJournalEntries$/, status: 201, headers: { location: "https://api.test/v2/companies/demo/journalEntries/21" } },
      { match: /\/journalEntries\/21$/, body: entry },
    ]);
    const c = await connected(f.fetchImpl);
    const lines = [{ amount: 100000, debitAccount: "6000" }, { amount: 100000, creditAccount: "1200" }];
    const r = await callJson(c, "create_journal_entry", { companySlug: "demo", description: "Avskrivning", date: "2026-09-29", lines });
    expect(r.json()).toMatchObject({ journalEntryId: 21, journalEntryNumber: 51 });
    expect(JSON.parse(String(f.calls[0]?.init?.body))).toEqual({ description: "Avskrivning", journalEntries: [{ description: "Avskrivning", date: "2026-09-29", lines }] });
  });

  it("a line with both accounts balances by itself", async () => {
    const f = fakeFiken([
      { match: /\/generalJournalEntries$/, status: 201, headers: { location: "https://api.test/v2/companies/demo/journalEntries/21" } },
      { match: /\/journalEntries\/21$/, body: entry },
    ]);
    const c = await connected(f.fetchImpl);
    const r = await callJson(c, "create_journal_entry", { companySlug: "demo", description: "Overføring", date: "2026-09-29", lines: [{ amount: 5000, debitAccount: "1920:10002", creditAccount: "1920:10001" }] });
    expect(r.isError).toBe(false);
  });
});
```
Add one read test for `list_transactions` (exact URL with `createdDateGe`) and `get_transaction` in the same file, against the trims above.
- [ ] **Step 2** run to fail; **Step 3** implement; **Step 4** `npm test`, `npm run typecheck`; **Step 5: Commit** `Coverage: manual journal entries and transactions`

---

### Task 3: Purchase drafts

**Files:** Modify `api/src/mcp/tools/purchases.ts`. Test: `api/test/mcp/purchase-drafts.test.ts`.

**Operations:**
- `create_purchase_draft` (write, purchases, not destructive): `POST /purchases/drafts` body `draftRequest`: `{ cash, paid, lines, contactId?, invoiceIssueDate?, dueDate?, invoiceNumber?, kid?, projectId?, currency?, payments? }`; lines strict `{ text, vatType, incomeAccount, net (øre), gross (øre), projectId? }` (Fiken names the expense account `incomeAccount` on draft lines; the description says so). Validation: `gross >= net` per line. Returns `{ draftId }`. Description: "Prepare a purchase for the user to review and approve in Fiken, instead of booking it directly with create_purchase. lines use Fiken's draft names: text, net and gross (øre), and incomeAccount for the expense account. The user can attach the receipt in Fiken, or create_purchase_from_draft (via fiken_write) books it."
- `list_purchase_drafts` (read, purchases): `GET /purchases/drafts` (paged) → `{ draftId, uuid, invoiceIssueDate, dueDate, contact: { contactId, name }?, cash, paid, lines: lines.length }` (read the swagger's draft result for exact names).
- `create_purchase_from_draft` (write, purchases, destructive): `POST /purchases/drafts/{draftId}/createPurchase` (no body) → Location of the purchase → `get_purchase` trim; failed read-back names the purchase with the gateway call to `get_purchase`. `CONFIRM`.

- [ ] **Step 1: Failing tests**: create draft (exact body; `gross < net` refused before any call; a mistyped line key refused), list drafts (trim), create from draft (no body sent; read-back; read-back failure text with `call fiken_read with {"operation":"get_purchase"`). Write them in the style of Task 1's tests.
- [ ] **Steps 2-5**; **Commit** `Coverage: purchase drafts`

---

### Task 4: Projects, products and contact maintenance

**Files:** Modify `api/src/mcp/tools/projects.ts`, `products.ts`, `contacts.ts`. Test: `api/test/mcp/master-data.test.ts`.

**Operations:**
- `get_project` (read): `GET /projects/{id}` → `{ projectId, number, name, description, startDate, endDate, completed, contact: { contactId, name }? }`.
- `create_project` (write, projects, destructive): `POST /projects` body `{ number, name, startDate, description?, endDate?, contactId?, completed? }` → read back with `get_project`. `CONFIRM`.
- `update_project` (write, projects, destructive): `PATCH /projects/{id}` with only the given fields of `{ name, description, startDate, endDate, contactId, completed }` (at least one; refused otherwise) → read back. Fiken's PATCH is partial, so no GET first.
- `get_product` (read): `GET /products/{id}` → the `list_products` trim plus `note` and `stock`.
- `create_product` (write, products, destructive): `POST /products` body `{ name, incomeAccount, vatType, active (default true), unitPrice?, productNumber?, note? }` → read back.
- `update_product` (write, products, destructive): read-modify-write: `GET /products/{id}`, overlay the given fields of `{ name, unitPrice, incomeAccount, vatType, active, productNumber, note }` (at least one), `PUT /products/{id}` with the full product minus read-only fields (`productId`, `createdDate`, `lastModifiedDate`) → return the trimmed result of the PUT's read-back (`GET` again).
- `update_contact` (write, contacts, destructive): read-modify-write on `GET /contacts/{id}` then `PUT /contacts/{id}`: overlay the given fields of `{ name, email, organizationNumber, phoneNumber, customer, supplier, inactive, bankAccountNumber, daysUntilInvoicingDueDate, address: { streetAddress, streetAddress2, city, postCode, country } }` (address fields merge into the existing address); strip read-only fields (`contactId`, `createdDate`, `lastModifiedDate`, `customerNumber`, `supplierNumber`, `customerAccountCode`, `supplierAccountCode`, `notes`, `documents`, `contactPerson`, `groups`) before the PUT. At least one field; refused otherwise. Returns the `get_contact` shape.
- `list_contact_persons` (read, contacts): `GET /contacts/{id}/contactPerson` → `{ items: [{ contactPersonId, name, email, phoneNumber }] }`.
- `add_contact_person` (write, contacts, not destructive): `POST /contacts/{id}/contactPerson` body `{ name, email, phoneNumber? }` → `{ contactPersonId }`. `CONFIRM`.

- [ ] **Step 1: Failing tests** (`api/test/mcp/master-data.test.ts`), including this read-modify-write test verbatim:
```ts
import { describe, expect, it } from "vitest";
import { callJson, connected, fakeFiken } from "./helpers.js";

describe("contact and product updates keep what they do not change", () => {
  it("update_contact overlays the given fields and sends the rest back", async () => {
    const current = { contactId: 5, createdDate: "2020-01-01", lastModifiedDate: "2026-01-01", name: "Kunde AS", email: "old@x.no", organizationNumber: "123",
      customerNumber: 10001, customer: true, supplier: false, inactive: false, bankAccountNumber: "12345678903", currency: "NOK", language: "NORWEGIAN",
      address: { streetAddress: "Gate 1", city: "Oslo", postCode: "0150", country: "Norge" }, notes: [{ x: 1 }], documents: [], contactPerson: [], groups: ["g"] };
    const f = fakeFiken([{ match: /\/contacts\/5$/, body: current }]);
    const c = await connected(f.fetchImpl);
    const r = await callJson(c, "update_contact", { companySlug: "demo", contactId: 5, email: "new@x.no", address: { city: "Bergen" } });
    expect(r.isError).toBe(false);
    const put = f.calls.find((x) => x.init?.method === "PUT");
    expect(JSON.parse(String(put?.init?.body))).toEqual({
      name: "Kunde AS", email: "new@x.no", organizationNumber: "123", customer: true, supplier: false, inactive: false, bankAccountNumber: "12345678903",
      currency: "NOK", language: "NORWEGIAN", address: { streetAddress: "Gate 1", city: "Bergen", postCode: "0150", country: "Norge" },
    });
    expect((await callJson(c, "update_contact", { companySlug: "demo", contactId: 5 })).isError).toBe(true);
  });
});
```
Add tests for: `update_product` sending the full product with one field changed; `create_project` body and read-back; `update_project` sending only the given fields with PATCH and refusing an empty update before any call; `add_contact_person` requiring `email`.
- [ ] **Steps 2-5**; **Commit** `Coverage: projects, products and contact maintenance`

---

### Task 5: Invoice drafts, number counters, credit note reads and sending

**Files:** Modify `api/src/mcp/tools/invoices.ts` (extract `sendDocument` and `createInvoiceishDraft`; add operations), `api/src/mcp/tools/credit-notes.ts`, `api/src/mcp/tools/common.ts` if the helpers belong there. Test: `api/test/mcp/drafts-counters.test.ts`.

**Interfaces:**
```ts
/** POST /<kind>/send with method (default ["auto"]), includeDocumentAttachments (default true) and the optional recipient fields. */
export function sendDocumentInput(): z.ZodRawShape; // the shared input fields
export async function sendDocument(ctx: ToolContext, slug: string, path: "invoices" | "creditNotes" | "offers", idField: "invoiceId" | "creditNoteId" | "offerId", id: number, fields: SendFields): Promise<void>;
/** POST /<path>/drafts with an invoiceishDraftRequest of the given type; returns the draft id from the Location. */
export async function createInvoiceishDraft(ctx: ToolContext, slug: string, path: "invoices" | "offers" | "orderConfirmations", type: DraftType, input: DraftInput): Promise<number>;
```
`send_invoice` and `create_invoice_draft` are refactored onto these with no behaviour change (their tests keep passing unchanged).

**Operations:**
- `list_invoice_drafts` (read, invoices): `GET /invoices/drafts` (paged) → `{ draftId, uuid, type, issueDate, daysUntilDueDate, customerId, net?, lines: lines.length }` (exact fields from the swagger's `invoiceishDraftResult`).
- `get_invoice_draft` (read, invoices): full draft with lines.
- `update_invoice_draft` (write, invoices, not destructive): read-modify-write over `GET` then `PUT /invoices/drafts/{id}` with the full `invoiceishDraftRequest` built from the current draft plus the given fields of `{ customerId, daysUntilDueDate, issueDate, invoiceText, yourReference, ourReference, bankAccountNumber, projectId, lines }` (lines, when given, replace all lines and go through `missingLineFields`). At least one field.
- `get_counters` (read, invoices): `GET /invoices/counter` and `GET /creditNotes/counter` → `{ invoice: value | null, creditNote: value | null }` (a 404 or empty answer means "not initialized": null).
- `initialize_counter` (write, invoices, destructive): input `kind: "invoice" | "credit_note"`, `value` (positive int, the first number to use). Reads the counter first; if it exists, `isError` `The ${kind} counter already exists (next number ${value}); it cannot be changed here.` with no POST. Otherwise `POST /invoices/counter` or `/creditNotes/counter` body `{ value }`. Description: "Start the invoice or credit note number series for a company that has never issued one (Fiken answers 409 'counter not initialized' until then). An existing series is never changed." + `CONFIRM`.
- `list_credit_notes` (read, credit_notes): `GET /creditNotes` (paged; `issueDateGe, issueDateLe, customerId, settled`) → the `create_credit_note` read-back trim.
- `get_credit_note` (read, credit_notes).
- `send_credit_note` (write, credit_notes, destructive): `sendDocument(..., "creditNotes", "creditNoteId", ...)`. Description mirrors `send_invoice`'s.

- [ ] **Step 1: Failing tests** (`api/test/mcp/drafts-counters.test.ts`), including:
```ts
import { describe, expect, it } from "vitest";
import { callJson, connected, fakeFiken } from "./helpers.js";

describe("counters", () => {
  it("initialize_counter never touches an existing series", async () => {
    const f = fakeFiken([{ match: /\/creditNotes\/counter$/, body: { value: 10005 } }]);
    const c = await connected(f.fetchImpl);
    const r = await callJson(c, "initialize_counter", { companySlug: "demo", kind: "credit_note", value: 1 });
    expect(r).toMatchObject({ isError: true, text: "The credit_note counter already exists (next number 10005); it cannot be changed here." });
    expect(f.calls.every((x) => (x.init?.method ?? "GET") === "GET")).toBe(true);
  });

  it("initialize_counter starts a missing series", async () => {
    const f = fakeFiken([{ match: /\/invoices\/counter$/, status: 404, body: "not found" }]);
    const c = await connected(f.fetchImpl);
    // The fake answers the POST with the same route; make the POST succeed by matching on method in a custom fetch if needed.
    const r = await callJson(c, "initialize_counter", { companySlug: "demo", kind: "invoice", value: 10001 });
    expect(r.isError).toBe(false);
    const post = f.calls.find((x) => x.init?.method === "POST");
    expect(JSON.parse(String(post?.init?.body))).toEqual({ value: 10001 });
  });
});
```
The second test needs a fetch that answers GET with 404 and POST with 201 on the same path; write a small method-aware fake in the test file (do not change `fakeFiken`). Also test: `send_credit_note` defaults (`method: ["auto"]`, `includeDocumentAttachments: true`) through the shared helper; `send_invoice`'s existing tests still pass; `update_invoice_draft` keeps unchanged fields (in the style of Task 4's contact test); `get_counters` maps a 404 to null.
- [ ] **Steps 2-5**; **Commit** `Coverage: invoice drafts, number counters, credit note reads and sending`

---

### Task 6: Offers and order confirmations

**Files:** Create `api/src/mcp/tools/offers.ts` (offers and order confirmations); modify `api/src/mcp/operations.ts` (`CONCEPTS` gains `offers: "Offers (tilbud) to customers"` and `order_confirmations: "Order confirmations (ordrebekreftelser)"`), `api/src/mcp/registry.ts`. Test: `api/test/mcp/offers.test.ts`.

**Operations** (all through `createInvoiceishDraft` / `sendDocument` from Task 5):
- `create_offer_draft` (write, offers, not destructive), `create_offer_from_draft` (write, offers, destructive: `POST /offers/drafts/{id}/createOffer` → `{ offerId }` from the Location), `send_offer` (write, offers, destructive), `list_offers` (read, offers: `GET /offers`, paged; trim to `{ offerId, offerNumber, issueDate, net, vat, gross, currency, customer: { contactId, name }? }` from the swagger's offer result).
- `create_order_confirmation_draft` (write, order_confirmations, not destructive), `create_order_confirmation_from_draft` (write, destructive → `{ confirmationId }`), `list_order_confirmations` (read, paged), `create_invoice_draft_from_order_confirmation` (write, order_confirmations, not destructive: `POST /orderConfirmations/{confirmationId}/createInvoiceDraft` → `{ draftId }`; description points to `create_invoice_from_draft (via fiken_write)`).
- Offer and order confirmation drafts take the same input as `create_invoice_draft` except `type` (fixed) and `bankAccountNumber` (optional: an offer is not paid).

- [ ] **Step 1: Failing tests**: offer draft body has `type: "offer"`; create from draft sends no body and returns the id from the Location; `send_offer` defaults through `sendDocument`; order confirmation to invoice draft returns `{ draftId }`; the new concepts appear in `fiken_explore` with these operations; a mistyped line key is refused.
- [ ] **Steps 2-5**; **Commit** `Coverage: offers and order confirmations`

---

### Task 7: Recurring invoices and time tracking

**Files:** Create `api/src/mcp/tools/recurring.ts`, `api/src/mcp/tools/time.ts`; modify `api/src/mcp/tools/invoices.ts` (`create_invoice_draft` accepts `type: "repeating_invoice"` with required `startDate` and `frequency: { interval (int ≥ 1), intervalUnit: DAY | WEEK | MONTH }`, optional `endDate`; validation before any call), `CONCEPTS` gains `recurring_invoices` and `time_tracking`. Test: `api/test/mcp/recurring-time.test.ts`.

**Operations:**
- `list_recurring_invoices` (read): `GET /recurringInvoices` (`customerId`, `active`, paged) → trimmed items incl. their job ids and status (exact fields from the swagger's recurring invoice result).
- `create_recurring_invoice_from_draft` (write, destructive): `POST /invoices/drafts/{draftId}/createRecurringInvoice` → `{ recurringInvoiceId }`. Description: the draft must be `type: repeating_invoice` (create it with create_invoice_draft (via fiken_write)); invoices are then issued (and, per the company's settings, sent) on the schedule. `CONFIRM`.
- `set_recurring_invoice_job` (write, destructive): `action: "pause" | "resume" | "stop"`, `recurringInvoiceId`, `jobId` → `POST /recurringInvoices/{id}/jobs/{jobId}/{action}`. `stop` is described as final.
- `list_time_users`, `list_activities` (reads, time_tracking): `GET /timeUsers` (`name`, `email`, paged), `GET /activities` (paged; trim from the swagger).
- `list_time_entries` (read): `GET /timeEntries` (`dateGe, dateLe, projectId, activityId, timeUserId, invoiced`, paged).
- `create_time_entry` (write, destructive): `POST /timeEntries` `{ date, hours (> 0), activityId, timeUserId, projectId?, description?, startTime?, internalNote? }` → `{ timeEntryId }`. `CONFIRM`.
- `create_invoice_draft_from_time_entries` (write, not destructive): `POST /timeEntries/createInvoiceDraft` `{ timeEntryIds (≥1), customerId, daysUntilDueDate, bankAccountNumber, groupBy?, includeTimeEntryDescriptions?, issueDate?, projectId?, invoiceText?, yourReference?, ourReference? }` → `{ draftId }`; points to `create_invoice_from_draft (via fiken_write)`.

- [ ] **Step 1: Failing tests**: a repeating_invoice draft without `frequency` or `startDate` is refused before any call, and with them the body carries `type: "repeating_invoice"`, `startDate`, `frequency`; `set_recurring_invoice_job` posts to the right path per action; `create_time_entry` refuses `hours: 0`; a 404 on `set_recurring_invoice_job` for a known company says "check the id" (Review Focus 5); `create_invoice_draft_from_time_entries` exact body.
- [ ] **Steps 2-5**; **Commit** `Coverage: recurring invoices and time tracking`

---

### Task 8: EHF inbox and accruals

**Files:** Create `api/src/mcp/tools/ehf.ts`; modify `api/src/mcp/tools/ledger.ts` (accruals), `api/src/mcp/tools/attachments.ts` (`attach_inbox_document` gains `ehfDocumentId` as an alternative to `inboxDocumentId` for purchases, sales and journal entries, whose Fiken endpoints accept it; exactly one of the two), `CONCEPTS` gains `ehf: "Incoming EHF e-invoices"`. Test: `api/test/mcp/ehf-accruals.test.ts`.

**Operations:**
- `list_ehf_documents` (read, ehf): `GET /ehf` (`status`, `issueDateGe`, `issueDateLe`, paged) → trimmed items (id, issuer, invoice number, dates, amounts, status; exact fields from the swagger's EHF result).
- `get_ehf_document` (read, ehf): `GET /ehf/{ehfDocumentId}` trimmed, plus its lines if present.
- `create_accrual` (write, ledger, destructive): exactly one of `saleId`, `purchaseId`; `lineId` (from `get_sale` or `get_purchase` (via fiken_read)), `startDate`, `periods` (int ≥ 2), `account?` → `POST /sales/{id}/accruals` or `/purchases/{id}/accruals` → `{ accrualId }`. Description: "Spread a sale or purchase line over several months (periodisering)." + `CONFIRM`. `get_purchase` and `get_sale` must expose `lineId` on lines for this; add it to both trims.

- [ ] **Step 1: Failing tests**: attach with `ehfDocumentId` to a purchase sends `ehfDocumentId` and not `inboxDocumentId`; both or neither refused; attaching an EHF document to an invoice is refused (Fiken's invoice endpoint takes a file only); `create_accrual` target rule and body; `lineId` present in `get_purchase` and `get_sale`.
- [ ] **Steps 2-5**; **Commit** `Coverage: EHF inbox and accruals`

---

### Task 9: Docs

**Files:** `README.md` (operation list per concept, new concepts in the options section), `docs/superpowers/specs/2026-09-22-fiken-mcp-design.md` (section 8 lists every operation; section 14: this plan done; what remains: deletes and reversals pending Jonas's decision, activities/groups/contact attachments/product sales report/bank account creation not covered, ChatGPT verification, the website), `docs/superpowers/specs/2026-09-22-fiken-mcp-decision-record.md` (read-modify-write for PUT updates; counters never reset; manual journal entries balanced before the call; write-off included as a booking, not a delete), `CLAUDE.md` process line, `docs/setup.md` ("Verify after deploying the coverage plan": in the demo company, initialize the credit note counter if missing and then run a full credit note; a cash sale; a manual journal entry; a purchase draft approved in Fiken's UI; update a contact's email and confirm nothing else changed in Fiken; create and send nothing to customers: offers and invoice sending need a real company and a jonasbj.com recipient).

- [ ] **Commit** `Docs: coverage of the remaining Fiken areas`

---

## Self-review

- Coverage against the gap list: sales without invoice, settle, write-off, payments lookup (T1); manual journal entries, transactions (T2); purchase drafts (T3); projects, products, contacts, contact persons (T4); invoice drafts list/get/update, counters, credit note reads and sending (T5); offers, order confirmations (T6); recurring invoices, time tracking (T7); EHF inbox, accruals (T8). Excluded by decision: deletes, reversals, cancelling; not covered: activities writes, groups, contact attachments, product sales report, creating bank accounts (named in T9).
- Placeholders: tasks 3, 5 (partly), 6, 7, 8 describe tests in prose rather than code where the pattern is identical to a fully written test in an earlier task and the exact response fields must come from the swagger's result schemas; the implementer copies the pattern and reads the schema. Each such test names its assertion.
- Type consistency: `sendDocument`, `createInvoiceishDraft` (T5) are used by T6 and T7; `lineId` on sale and purchase trims (T8) feeds `create_accrual`; `patch()` on the client (T1, if added) is used by T1 only.
- Review Focus: 1 → T4/T5 tests; 2 → T2 test; 3 → T5/T6 tests; 4 → T5 test; 5 → T7 test.
