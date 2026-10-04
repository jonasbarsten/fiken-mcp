import { describe, expect, it } from "vitest";
import { parseSummary, renderReport, type RunRecord } from "../src/report.js";

const run = (caseId: string, model: string, outcome: "pass" | "wrong", n: number): RunRecord => ({
  caseId, area: "utlegg", reviewed: false, model, run: n, ms: 1000, usage: { input: 100, output: 10 },
  expectBehaviour: { previewFirst: true },
  grade: { outcome, problems: outcome === "pass" ? [] : ["Forventet kredit 2911 500,00 kr, fikk ingen."], notes: [], behaviour: { previewFirst: outcome === "pass", askChoice: false, readHelp: false } },
  transcript: [{ who: "bruker", text: "Før et utlegg." }],
});

describe("renderReport", () => {
  const runs = [run("a", "sonnet", "pass", 1), run("a", "sonnet", "wrong", 2), run("a", "opus", "pass", 1)];
  const md = renderReport(runs, new Date("2026-10-04T10:00:00Z"));

  it("has a summary row per case and model with the pass count and behaviour", () => {
    expect(md).toContain("| a | sonnet | 1/2 | forhåndsvisning 1/2 |");
    expect(md).toContain("| a | opus | 1/1 | forhåndsvisning 1/1 |");
  });
  it("says the cases are not reviewed by an accountant", () => {
    expect(md).toContain("ikke revidert av regnskapsfører");
  });
  it("lists failures with problems and the transcript", () => {
    expect(md).toContain("### a · sonnet · kjøring 2: wrong");
    expect(md).toContain("- Forventet kredit 2911 500,00 kr, fikk ingen.");
    expect(md).toContain("bruker: Før et utlegg.");
  });
  it("round-trips the summary and marks changes against an earlier report", () => {
    expect(parseSummary(md)).toEqual(new Map([["a|sonnet", "1/2"], ["a|opus", "1/1"]]));
    const next = renderReport([run("a", "sonnet", "pass", 1), run("a", "sonnet", "pass", 2)], new Date(), parseSummary(md));
    expect(next).toContain("| a | sonnet | 2/2 | forhåndsvisning 2/2 | 1/2 ↑ |");
  });
});
