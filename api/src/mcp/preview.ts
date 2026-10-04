import { createHash } from "node:crypto";
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
  /** Ties an approval to this preview: the widget's «Før dette» sends it back. See previewRef. */
  ref: string;
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

/**
 * Writes whose amounts may be in another currency than NOK without a `currency` arg: a credit note follows the
 * invoice it credits, and an update keeps the draft's currency. Their amounts get a neutral unit instead of «kr».
 */
const UNIT_WITHOUT_CURRENCY: Record<string, string> = {
  create_credit_note: "(fakturaens valuta)",
  update_invoice_draft: "(utkastets valuta)",
};

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
  fee: "Gebyr",
  paymentFee: "Betalingsgebyr",
  hourlyRate: "Timepris",
};

/** Summary order: the labelled keys in LABELS order, then the rest; the sort is stable, so the rest keep the args' order. */
const LABEL_ORDER = Object.keys(LABELS);
const summaryRank = (key: string): number => {
  const i = LABEL_ORDER.indexOf(key);
  return i === -1 ? LABEL_ORDER.length : i;
};

/**
 * Keys, on the args or on their lines, that hold øre (or the document currency's smallest unit) in the write
 * operations' inputs. A test walks every write's schema and fails when an øre field is missing here.
 */
export const MONEY: ReadonlySet<string> = new Set(["amount", "net", "vat", "gross", "netPrice", "unitPrice", "fee", "paymentFee", "hourlyRate"]);

/** The same args as JSON whatever their key order. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : stableJson(v))).join(",")}]`;
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/** A short reference for one preview: the first 6 hex of SHA-256 over the operation and its (parsed) args. */
export function previewRef(operation: string, args: Record<string, unknown>): string {
  return createHash("sha256").update(`${operation}\n${stableJson(args)}`).digest("hex").slice(0, 6);
}

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
    { label: hasVat ? "Debet (før mva)" : "Debet", value: formatAmount(debit) },
    { label: hasVat ? "Kredit (før mva)" : "Kredit", value: formatAmount(credit) },
    ...(hasVat ? [{ label: "Mva", value: "Fiken legger mva til beløpet på sider med mva-kode; summene over er før det" }] : []),
  ];
}

/**
 * Checks a write's args against its schema and describes them, without running it or calling Fiken.
 * After a successful parse the description shows the parsed args, so defaults the write will use appear.
 */
export function buildPreview(op: Operation, args: Record<string, unknown>): Preview {
  const parsed = op.input.strict().safeParse(args);
  const data: Record<string, unknown> = parsed.success ? (parsed.data as Record<string, unknown>) : args;
  const currency = typeof data.currency === "string" ? data.currency : UNIT_WITHOUT_CURRENCY[op.name];
  const summary = Object.entries(data)
    .filter(([key, value]) => key !== "lines" && value !== undefined && value !== null)
    .sort(([a], [b]) => summaryRank(a) - summaryRank(b))
    .map(([key, value]) => ({ label: LABELS[key] ?? key, value: cell(key, value, currency) }));

  const preview: Preview = { operation: op.name, title: op.title, summary, checks: "ok", ref: previewRef(op.name, data) };
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
