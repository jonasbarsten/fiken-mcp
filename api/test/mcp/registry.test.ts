import { describe, expect, it } from "vitest";
import { CONCEPTS } from "../../src/mcp/operations.js";
import { OPERATIONS, getOperation } from "../../src/mcp/registry.js";
import { HOT_PATH } from "../../src/mcp/server.js";
import { connected, fakeFiken, mentionedOperations, operationTexts } from "./helpers.js";

const EXPECTED = [
  "list_companies", "list_projects", "list_accounts", "list_bank_accounts", "account_balances", "bank_balances",
  "search_contacts", "get_contact", "create_contact", "list_purchases", "get_purchase", "create_purchase",
  "attach_inbox_document", "get_attachments", "list_inbox", "get_inbox_document", "list_sales",
  "list_invoices", "get_invoice", "create_invoice", "create_invoice_draft", "create_invoice_from_draft", "send_invoice",
  "create_credit_note", "register_payment", "list_products", "get_journal_entries", "my_usage",
  "get_sale", "create_sale", "settle_sale", "write_off_sale", "list_payments",
  "get_journal_entry", "create_journal_entry", "list_transactions", "get_transaction",
  "create_purchase_draft", "list_purchase_drafts", "create_purchase_from_draft",
  "get_project", "create_project", "update_project", "get_product", "create_product", "update_product",
  "update_contact", "list_contact_persons", "add_contact_person",
  "list_invoice_drafts", "get_invoice_draft", "update_invoice_draft", "get_counters", "initialize_counter",
  "list_credit_notes", "get_credit_note", "send_credit_note",
  "create_offer_draft", "create_offer_from_draft", "send_offer", "list_offers", "list_offer_drafts",
  "create_order_confirmation_draft", "create_order_confirmation_from_draft", "list_order_confirmations", "list_order_confirmation_drafts",
  "create_invoice_draft_from_order_confirmation",
  "list_recurring_invoices", "create_recurring_invoice_from_draft", "set_recurring_invoice_job",
  "list_time_users", "list_activities", "create_activity", "list_time_entries", "create_time_entry", "create_invoice_draft_from_time_entries",
  "list_ehf_documents", "get_ehf_document", "create_accrual",
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
    const notDestructive = ["create_invoice_draft", "create_contact", "create_purchase_draft", "add_contact_person", "update_invoice_draft",
      "create_offer_draft", "create_order_confirmation_draft", "create_invoice_draft_from_order_confirmation",
      "create_invoice_draft_from_time_entries", "create_activity"];
    for (const op of OPERATIONS.filter((o) => o.kind === "write")) {
      expect(op.destructive, op.name).toBe(!notDestructive.includes(op.name));
      if (op.destructive) expect(op.description, op.name).toContain("Consequential");
    }
  });

  it("names the gateway wherever a text names an operation that is not a tool of its own", () => {
    const names = OPERATIONS.map((o) => o.name);
    for (const op of OPERATIONS) {
      for (const text of operationTexts(op)) {
        for (const { name, index } of mentionedOperations(text, names)) {
          if (name === op.name || (HOT_PATH as readonly string[]).includes(name)) continue;
          const after = text.slice(index + name.length, index + name.length + 60);
          expect(after, `${op.name} mentions ${name} in "${text}"`).toMatch(/fiken_read|fiken_write/);
        }
      }
    }
  });

  it("registers the hot-path operations as tools with their annotations, and no other operation", async () => {
    const c = await connected(fakeFiken([]).fetchImpl);
    const { tools } = await c.listTools();
    for (const op of OPERATIONS) {
      const tool = tools.find((t) => t.name === op.name);
      if (!(HOT_PATH as readonly string[]).includes(op.name)) {
        expect(tool, op.name).toBeUndefined();
        continue;
      }
      expect(tool, op.name).toBeDefined();
      expect(tool?.annotations?.readOnlyHint, op.name).toBe(op.kind === "read");
      if (op.kind === "write") expect(tool?.annotations?.destructiveHint, op.name).toBe(op.destructive);
    }
  });
});
