/** Operations the notes name; a test checks each exists, so the notes cannot drift from the registry. */
export const NOTE_OPERATIONS = [
  "create_journal_entry", "create_purchase", "upload_receipts", "get_upload_url", "attach_inbox_document",
  "list_accounts", "create_invoice_draft", "create_invoice_from_draft", "send_invoice", "create_credit_note",
  "create_accrual", "write_off_sale",
] as const;

export const CONNECTOR_NOTES = `## Connector notes (fiken-mcp)

Fiken's help describes Fiken's screens. With this connector:

- «Fri postering» (Annet → Fri postering) is create_journal_entry via fiken_write. Amounts are in øre. With a VAT code (debitVatCode/creditVatCode, Fiken's numeric codes), a debit line's amount is net and a credit line's amount is gross.
- «Nytt kjøp» (Kjøp → Nytt kjøp) is create_purchase: kind cash_purchase with a bank paymentAccount and paymentDate, or kind supplier with supplierId and dueDate. Receipts come in through upload_receipts or get_upload_url, or from the inbox (list_inbox), and are linked with inboxDocumentId.
- «Betalt av ansatt» or «betalt privat» under Betaling on a purchase is not available in the API. Book it as one create_journal_entry: each expense on its account with its VAT code, the gross total credited to the account the article names (2911 for an employee), and attach the receipts with attach_inbox_document via fiken_write.
- Accounts written like 2930:1000X are an account with a person or contact sub-account; find the exact code with list_accounts.
- «Ny faktura» is create_invoice_draft, then create_invoice_from_draft; sending is send_invoice. A credit note is create_credit_note, on an issued invoice. Accruals («periodisering») are create_accrual, on a line of an already booked sale or purchase. Writing off a sale is write_off_sale, on an existing sale. All of these go via fiken_write.
- This connector cannot delete, reverse or cancel anything, run payroll («Lønn»), use the «Reiser og utlegg» add-on, or do year-end. When an article needs that, tell the user to do it in Fiken.
`;
