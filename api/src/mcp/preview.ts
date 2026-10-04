import { z } from "zod";
import type { Operation } from "./operations.js";
import { checkJournalLines } from "./tools/ledger.js";

export interface Preview {
  operation: string;
  title: string;
  companySlug?: string;
  summary: Array<{ label: string; value: string }>;
  lines?: { columns: string[]; rows: string[][] };
  totals?: Array<{ label: string; value: string }>;
  checks: "ok" | string[];
}

const kroner = new Intl.NumberFormat("nb-NO", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** 123456 minor units as `1 234,56 kr`, or `1 234,56 EUR` for a currency other than NOK; no-break space before the unit. */
export function formatAmount(minor: number, currency?: string): string {
  const unit = currency !== undefined && currency !== "NOK" ? currency : "kr";
  return `${kroner.format(minor / 100)} ${unit}`;
}

export function formatKroner(ore: number): string {
  return formatAmount(ore);
}

/** A credit note has no currency of its own: it follows the invoice it credits. */
const FOLLOWS_INVOICE = "(fakturaens valuta)";

const LABELS: Record<string, string> = {
  companySlug: "Foretak",
  date: "Dato",
  description: "Beskrivelse",
  kind: "Type",
  supplierId: "Leverandør (id)",
  customerId: "Kunde (id)",
  contactId: "Kontakt (id)",
  dueDate: "Forfall",
  paymentAccount: "Betalingskonto",
  paymentDate: "Betalingsdato",
  inboxDocumentId: "Vedlegg (innboks-id)",
  projectId: "Prosjekt (id)",
  currency: "Valuta",
};

/** Line keys that hold øre in the write operations' inputs (checked against api/src/mcp/tools). */
const MONEY = new Set(["amount", "net", "vat", "gross", "netPrice", "unitPrice"]);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function cell(key: string, value: unknown, currency?: string): string {
  if (value === undefined || value === null) return "";
  if (MONEY.has(key) && typeof value === "number") return formatAmount(value, currency);
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function linesTable(lines: unknown, currency?: string): Preview["lines"] {
  if (!Array.isArray(lines)) return undefined;
  const rows = lines.filter(isRecord);
  if (rows.length === 0) return undefined;
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return { columns, rows: rows.map((r) => columns.map((c) => cell(c, r[c], currency))) };
}

/** What is shown for a journal entry: a two-sided line counts on both sides. Journal amounts are always NOK. */
function journalTotals(lines: Array<Record<string, unknown>>): Preview["totals"] {
  let debit = 0;
  let credit = 0;
  let hasVat = false;
  for (const l of lines) {
    const amount = typeof l.amount === "number" ? l.amount : 0;
    if (l.debitVatCode !== undefined || l.creditVatCode !== undefined) hasVat = true;
    if (l.debitAccount !== undefined) debit += amount;
    if (l.creditAccount !== undefined) credit += amount;
  }
  return [
    { label: hasVat ? "Debet (eks. mva)" : "Debet", value: formatAmount(debit) },
    { label: "Kredit", value: formatAmount(credit) },
    ...(hasVat ? [{ label: "Mva", value: "Fiken legger til mva på sider med mva-kode" }] : []),
  ];
}

/**
 * Checks a write's args against its schema and describes them, without running it or calling Fiken.
 * After a successful parse the description shows the parsed args, so defaults the write will use appear.
 */
export function buildPreview(op: Operation, args: Record<string, unknown>): Preview {
  const parsed = op.input.strict().safeParse(args);
  const data: Record<string, unknown> = parsed.success ? (parsed.data as Record<string, unknown>) : args;
  const currency = typeof data.currency === "string" ? data.currency : op.name === "create_credit_note" ? FOLLOWS_INVOICE : undefined;
  const summary = Object.entries(data)
    .filter(([key, value]) => key !== "lines" && value !== undefined && value !== null)
    .map(([key, value]) => ({ label: LABELS[key] ?? key, value: cell(key, value, currency) }));

  const preview: Preview = { operation: op.name, title: op.title, summary, checks: "ok" };
  if (typeof data.companySlug === "string") preview.companySlug = data.companySlug;
  const lines = linesTable(data.lines, currency);
  if (lines) preview.lines = lines;

  if (op.name === "create_journal_entry" && Array.isArray(data.lines)) preview.totals = journalTotals(data.lines.filter(isRecord));

  if (!parsed.success) preview.checks = [z.prettifyError(parsed.error)];
  else if (op.name === "create_journal_entry") {
    const problem = checkJournalLines((parsed.data as { lines: Parameters<typeof checkJournalLines>[0] }).lines);
    if (problem !== undefined) preview.checks = [problem];
  }
  return preview;
}
