import type { Case, Expected } from "../cases/types.js";
import { DEFAULT_ACCOUNT, isRate, toPostings, type Posting, type Proposal } from "./postings.js";

export type Call = { name: string; args: Record<string, unknown>; blocked?: boolean };
export type Trace = { calls: Call[]; proposal?: Proposal; error?: string };
export type Outcome = "pass" | "wrong" | "none" | "error";
export type Behaviour = { previewFirst: boolean; askChoice: boolean; readHelp: boolean };
export type Grade = { outcome: Outcome; problems: string[]; notes: string[]; behaviour: Behaviour };

/** Øre as «1234,50 kr», without thousands separators so reports and tests stay plain. */
export const kr = (ore: number): string => `${(ore / 100).toFixed(2).replace(".", ",")} kr`;
const sideName = (side: string): string => (side === "debit" ? "debet" : "kredit");

export function accountMatches(pattern: string, account: string): boolean {
  return pattern.endsWith("*") ? account.startsWith(pattern.slice(0, -1)) : account === pattern;
}

function postingMatches(e: Expected, p: Posting): boolean {
  return (
    e.side === p.side &&
    (p.account === DEFAULT_ACCOUNT || e.account.some((a) => accountMatches(a, p.account))) &&
    (e.net === undefined || e.net === p.net) &&
    (e.amount === undefined || e.amount === p.net + p.vatAmount) &&
    (e.vat === undefined || e.vat === p.vat)
  );
}

/** Gives each expected posting a different actual one; the actual indexes in order, or undefined when impossible. */
function assign(expected: Expected[], actual: Posting[], i = 0, used = new Set<number>()): number[] | undefined {
  if (i === expected.length) return [];
  for (let j = 0; j < actual.length; j++) {
    if (used.has(j) || !postingMatches(expected[i]!, actual[j]!)) continue;
    used.add(j);
    const rest = assign(expected, actual, i + 1, used);
    used.delete(j);
    if (rest) return [j, ...rest];
  }
  return undefined;
}

function describeExpected(e: Expected): string {
  const amount = e.amount !== undefined ? ` ${kr(e.amount)}` : "";
  const net = e.net !== undefined ? ` netto ${kr(e.net)}` : "";
  const vat = e.vat !== undefined ? ` mva ${e.vat}` : "";
  return `${sideName(e.side)} ${e.account.join("/")}${amount}${net}${vat}`;
}

function describeActual(p: Posting): string {
  const vat = p.vat !== undefined ? ` (netto ${kr(p.net)}, mva ${p.vat})` : "";
  return `${sideName(p.side)} ${p.account} ${kr(p.net + p.vatAmount)}${vat}`;
}

export function behaviourOf(calls: Call[]): Behaviour {
  const firstWrite = calls.findIndex((c) => c.blocked === true);
  const firstPreview = calls.findIndex((c) => c.name === "preview_booking");
  return {
    previewFirst: firstPreview !== -1 && (firstWrite === -1 || firstPreview < firstWrite),
    askChoice: calls.some((c) => c.name === "ask_user_choice"),
    readHelp: calls.some((c) => c.name === "fiken_read" && c.args.operation === "fiken_help_article"),
  };
}

export function grade(expect: Case["expect"], trace: Trace): Grade {
  const behaviour = behaviourOf(trace.calls);
  if (trace.error !== undefined) return { outcome: "error", problems: [trace.error], notes: [], behaviour };
  const p = trace.proposal;
  if (!p) return { outcome: "none", problems: ["Ingen føring ble foreslått."], notes: [], behaviour };

  const problems: string[] = [];
  if (!expect.operations.includes(p.operation)) problems.push(`Operasjonen ${p.operation} er ikke blant ${expect.operations.join(", ")}.`);
  for (const [key, value] of Object.entries(expect.args ?? {})) {
    if (JSON.stringify(p.args[key]) !== JSON.stringify(value)) problems.push(`Forventet ${key} ${JSON.stringify(value)}, fikk ${JSON.stringify(p.args[key])}.`);
  }

  const converted = toPostings(p);
  if (!converted) {
    const notes = [`${p.operation} har ingen omregning til posteringer; bare operasjonen er sjekket.`];
    return { outcome: problems.length ? "wrong" : "pass", problems, notes, behaviour };
  }

  const actual = converted.postings;
  const match = assign(expect.postings, actual);
  if (!match) {
    const used = new Set<number>();
    for (const e of expect.postings) {
      const j = actual.findIndex((a, k) => !used.has(k) && postingMatches(e, a));
      if (j !== -1) {
        used.add(j);
        continue;
      }
      const sameSide = actual.filter((a, k) => !used.has(k) && a.side === e.side).map(describeActual);
      problems.push(`Forventet ${describeExpected(e)}, fikk ${sameSide.length ? sameSide.join("; ") : "ingen"}.`);
    }
  } else if (expect.exact !== false) {
    actual.forEach((a, k) => {
      if (!match.includes(k)) problems.push(`Uventet ${describeActual(a)}.`);
    });
  }

  if (actual.every((a) => a.vat === undefined || isRate(a.vat))) {
    const total = (side: string) => actual.filter((a) => a.side === side).reduce((s, a) => s + a.net + a.vatAmount, 0);
    const debit = total("debit");
    const credit = total("credit");
    if (debit !== credit) problems.push(`Går ikke i balanse: debet ${kr(debit)}, kredit ${kr(credit)}.`);
  }

  return { outcome: problems.length ? "wrong" : "pass", problems, notes: converted.notes, behaviour };
}
