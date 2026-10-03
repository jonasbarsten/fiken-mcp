import type { Operation } from "./operations.js";
import { accountsOperations } from "./tools/accounts.js";
import { attachmentsOperations } from "./tools/attachments.js";
import { companiesOperations } from "./tools/companies.js";
import { contactsOperations } from "./tools/contacts.js";
import { creditNotesOperations } from "./tools/credit-notes.js";
import { inboxDocumentOperations } from "./tools/inbox-document.js";
import { inboxOperations } from "./tools/inbox.js";
import { invoicesOperations } from "./tools/invoices.js";
import { ledgerOperations } from "./tools/ledger.js";
import { paymentsOperations } from "./tools/payments.js";
import { productsOperations } from "./tools/products.js";
import { projectsOperations } from "./tools/projects.js";
import { purchasesOperations } from "./tools/purchases.js";
import { salesOperations } from "./tools/sales.js";
import { usageOperations } from "./tools/usage.js";

/** Every operation, in the order the tools were registered before the registry existed. */
export const OPERATIONS: readonly Operation[] = [
  ...companiesOperations,
  ...projectsOperations,
  ...accountsOperations,
  ...contactsOperations,
  ...purchasesOperations,
  ...attachmentsOperations,
  ...inboxOperations,
  ...inboxDocumentOperations,
  ...salesOperations,
  ...invoicesOperations,
  ...creditNotesOperations,
  ...paymentsOperations,
  ...productsOperations,
  ...ledgerOperations,
  ...usageOperations,
];

const BY_NAME = new Map(OPERATIONS.map((op) => [op.name, op]));

/** Any operation by name; the gateway uses its own map of visible operations, so this lookup serves the registry and tests. */
export function getOperation(name: string): Operation | undefined {
  return BY_NAME.get(name);
}
