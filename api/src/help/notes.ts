/** Operations the notes name; a test checks each exists, so the notes cannot drift from the registry. */
export const NOTE_OPERATIONS = [
  "create_journal_entry", "create_purchase", "upload_receipts", "get_upload_url", "attach_inbox_document",
  "list_accounts", "create_invoice_draft", "create_invoice_from_draft", "send_invoice", "create_credit_note",
  "create_accrual", "write_off_sale", "get_journal_entries",
] as const;

export const CONNECTOR_NOTES = `## Connector notes (fiken-mcp)

Fiken's help describes Fiken's screens. With this connector:

- «Fri postering» (Annet → Fri postering) is create_journal_entry via fiken_write. Amounts are in øre. On a side that carries a VAT code (debitVatCode/creditVatCode) the amount is net and Fiken adds the VAT, also on a line with both a debit and a credit account; a side without a code takes the amount as given (e.g. the gross total credited to 2911 or the bank). Fiken refuses an entry that does not balance, counting the VAT it adds. Fiken uses the Tax Administration's standard codes: input VAT on purchases 1 = 25 % (to 2711), 11 = 15 %, 13 = 12 % (passenger transport, hotels); output VAT on sales 3 = 25 % (to 2701), 31 = 15 %, 33 = 12 %; for any other code read it from an existing booking at that rate (get_journal_entries returns each line's vatCode, via fiken_read). Tell the user which code and VAT amount you will use before writing.
- «Nytt kjøp» (Kjøp → Nytt kjøp) is create_purchase: kind cash_purchase with a bank paymentAccount and paymentDate, or kind supplier with supplierId and dueDate. Receipts come in through upload_receipts or get_upload_url, or from the inbox (list_inbox), and are linked with inboxDocumentId.
- «Betalt av ansatt» or «betalt privat» under Betaling on a purchase is not available in the API. Book it as one create_journal_entry: each expense on its account with its VAT code, the gross total credited to the account the article names (2911 for an employee), and attach the receipts with attach_inbox_document via fiken_write.
- Accounts written like 2930:1000X are an account with a person or contact sub-account; find the exact code with list_accounts.
- «Ny faktura» is create_invoice_draft, then create_invoice_from_draft; sending is send_invoice. A credit note is create_credit_note, on an issued invoice. Accruals («periodisering») are create_accrual, on a line of an already booked sale or purchase. Writing off a sale is write_off_sale, on an existing sale. All of these go via fiken_write.
- This connector cannot delete, reverse or cancel anything, run payroll («Lønn»), use the «Reiser og utlegg» add-on, or do year-end. When an article needs that, tell the user to do it in Fiken.
`;
