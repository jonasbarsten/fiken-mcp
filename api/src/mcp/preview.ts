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

/** 123456 øre as `1 234,56 kr`, with a no-break space before kr. */
export function formatKroner(ore: number): string {
  return `${kroner.format(ore / 100)} kr`;
}

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

function cell(key: string, value: unknown): string {
  if (value === undefined || value === null) return "";
  if (MONEY.has(key) && typeof value === "number") return formatKroner(value);
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function linesTable(lines: unknown): Preview["lines"] {
  if (!Array.isArray(lines)) return undefined;
  const rows = lines.filter(isRecord);
  if (rows.length === 0) return undefined;
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return { columns, rows: rows.map((r) => columns.map((c) => cell(c, r[c]))) };
}

/** Debit-only and credit-only sums of a journal entry, plus a note when Fiken adds VAT. */
function journalTotals(lines: Array<Record<string, unknown>>): Preview["totals"] {
  let debit = 0;
  let credit = 0;
  let hasVat = false;
  for (const l of lines) {
    const amount = typeof l.amount === "number" ? l.amount : 0;
    if (l.debitVatCode !== undefined || l.creditVatCode !== undefined) hasVat = true;
    if (l.creditAccount === undefined && l.debitAccount !== undefined) debit += amount;
    else if (l.debitAccount === undefined && l.creditAccount !== undefined) credit += amount;
  }
  return [
    { label: "Debet", value: formatKroner(debit) },
    { label: "Kredit", value: formatKroner(credit) },
    ...(hasVat ? [{ label: "Mva", value: "Fiken beregner mva" }] : []),
  ];
}

/** Validates a write's args as the gateway would and describes it, without running it or calling Fiken. */
export function buildPreview(op: Operation, args: Record<string, unknown>): Preview {
  const parsed = op.input.strict().safeParse(args);
  const summary = Object.entries(args)
    .filter(([key, value]) => key !== "lines" && value !== undefined && value !== null && typeof value !== "object")
    .map(([key, value]) => ({ label: LABELS[key] ?? key, value: String(value) }));

  const preview: Preview = { operation: op.name, title: op.title, summary, checks: "ok" };
  if (typeof args.companySlug === "string") preview.companySlug = args.companySlug;
  const lines = linesTable(args.lines);
  if (lines) preview.lines = lines;

  if (op.name === "create_journal_entry" && Array.isArray(args.lines)) preview.totals = journalTotals(args.lines.filter(isRecord));

  if (!parsed.success) preview.checks = [z.prettifyError(parsed.error)];
  else if (op.name === "create_journal_entry") {
    const problem = checkJournalLines((parsed.data as { lines: Parameters<typeof checkJournalLines>[0] }).lines);
    if (problem !== undefined) preview.checks = [problem];
  }
  return preview;
}
