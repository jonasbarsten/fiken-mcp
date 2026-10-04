import type { Case } from "../cases/types.js";
import type { Grade } from "./grade.js";
import type { TranscriptEntry } from "./loop.js";

export type RunRecord = {
  caseId: string;
  area: string;
  reviewed: boolean;
  model: string;
  run: number;
  ms: number;
  usage: { input: number; output: number };
  expectBehaviour: Case["expect"]["behaviour"];
  grade: Grade;
  transcript: TranscriptEntry[];
};

const BEHAVIOUR_LABELS = { previewFirst: "forhåndsvisning", askChoice: "valgknapper", readHelp: "hjelpeartikkel" } as const;
type BehaviourKey = keyof typeof BEHAVIOUR_LABELS;
const ROW = /^\| ([^|]+?) \| ([^|]+?) \| (\d+\/\d+) \|/;

const passes = (cell: string): number => Number(cell.split("/")[0]);

function groups(runs: RunRecord[]): Map<string, RunRecord[]> {
  const out = new Map<string, RunRecord[]>();
  for (const r of runs) {
    const key = `${r.caseId}|${r.model}`;
    out.set(key, [...(out.get(key) ?? []), r]);
  }
  return out;
}

function behaviourCell(rs: RunRecord[]): string {
  const wanted = Object.entries(rs[0]!.expectBehaviour ?? {})
    .filter(([, v]) => v === true)
    .map(([k]) => k as BehaviourKey);
  return wanted.map((k) => `${BEHAVIOUR_LABELS[k]} ${rs.filter((r) => r.grade.behaviour[k]).length}/${rs.length}`).join(", ");
}

/** The report's summary as case|model → «passed/total». */
export function parseSummary(md: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of md.split("\n")) {
    const m = ROW.exec(line);
    if (m) out.set(`${m[1]}|${m[2]}`, m[3]!);
  }
  return out;
}

export function renderReport(runs: RunRecord[], startedAt: Date, previous?: Map<string, string>): string {
  const lines: string[] = [];
  const unreviewed = new Set(runs.filter((r) => !r.reviewed).map((r) => r.caseId)).size;
  lines.push(`# Evaluering ${startedAt.toISOString()}`, "");
  if (unreviewed > 0) lines.push(`${unreviewed} av sakene er ikke revidert av regnskapsfører.`, "");

  lines.push(previous ? "| Sak | Modell | Bestått | Atferd | Tokens inn/ut | Tid | Forrige |" : "| Sak | Modell | Bestått | Atferd | Tokens inn/ut | Tid |");
  lines.push(previous ? "|---|---|---|---|---|---|---|" : "|---|---|---|---|---|---|");
  for (const [key, rs] of groups(runs)) {
    const cell = `${rs.filter((r) => r.grade.outcome === "pass").length}/${rs.length}`;
    const tokens = `${rs.reduce((s, r) => s + r.usage.input, 0)}/${rs.reduce((s, r) => s + r.usage.output, 0)}`;
    const time = `${Math.round(rs.reduce((s, r) => s + r.ms, 0) / 1000)} s`;
    let row = `| ${rs[0]!.caseId} | ${rs[0]!.model} | ${cell} | ${behaviourCell(rs)} | ${tokens} | ${time} |`;
    if (previous) {
      const before = previous.get(key);
      const mark = before === undefined ? "ny" : passes(cell) > passes(before) ? `${before} ↑` : passes(cell) < passes(before) ? `${before} ↓` : before;
      row += ` ${mark} |`;
    }
    lines.push(row);
  }

  const input = runs.reduce((s, r) => s + r.usage.input, 0);
  const output = runs.reduce((s, r) => s + r.usage.output, 0);
  const seconds = Math.round(runs.reduce((s, r) => s + r.ms, 0) / 1000);
  lines.push("", `Tokens: ${input} inn, ${output} ut. Tid: ${seconds} s.`, "");

  const failures = runs.filter((r) => r.grade.outcome !== "pass");
  if (failures.length > 0) lines.push("## Feil", "");
  for (const r of failures) {
    lines.push(`### ${r.caseId} · ${r.model} · kjøring ${r.run}: ${r.grade.outcome}`, "");
    for (const p of r.grade.problems) lines.push(`- ${p}`);
    for (const n of r.grade.notes) lines.push(`- Merknad: ${n}`);
    lines.push("", "```text", ...r.transcript.map((t) => `${t.who}: ${t.text}`), "```", "");
  }
  return lines.join("\n");
}
