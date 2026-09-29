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
