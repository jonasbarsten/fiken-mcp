import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { ALL_CASES, selectCases } from "../cases/index.js";
import { grade } from "./grade.js";
import { runConversation } from "./loop.js";
import { connectHost } from "./mcp.js";
import { MODELS, selectModels } from "./models.js";
import { parseSummary, renderReport, type RunRecord } from "./report.js";

const { values } = parseArgs({
  options: {
    case: { type: "string" },
    model: { type: "string" },
    runs: { type: "string", default: "3" },
    api: { type: "string", default: "https://api.fiken-mcp.byjoba.com" },
    compare: { type: "string" },
  },
});

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Sett ANTHROPIC_API_KEY i miljøet.");
  process.exit(1);
}

const cases = selectCases(ALL_CASES, values.case);
const models = selectModels(values.model);
const runs = Number(values.runs);
const previous = values.compare ? parseSummary(readFileSync(values.compare, "utf8")) : undefined;
const startedAt = new Date();

const host = await connectHost(values.api);
const anthropic = new Anthropic();
const model = { create: (p: Anthropic.MessageCreateParamsNonStreaming) => anthropic.messages.create(p) };
const records: RunRecord[] = [];

try {
  for (const c of cases) {
    for (const m of models) {
      for (let run = 1; run <= runs; run++) {
        const start = Date.now();
        const result = await runConversation({ host, model, modelId: MODELS[m], c });
        const g = grade(c.expect, result.trace);
        records.push({ caseId: c.id, area: c.area, reviewed: c.reviewed, model: m, run, ms: Date.now() - start, usage: result.usage, expectBehaviour: c.expect.behaviour, grade: g, transcript: result.transcript });
        console.log(`${c.id} ${m} ${run}: ${g.outcome}${g.problems[0] ? ` – ${g.problems[0]}` : ""}`);
      }
    }
  }
} finally {
  await host.close();
  const dir = new URL("../results/", import.meta.url);
  mkdirSync(dir, { recursive: true });
  const stamp = startedAt.toISOString().slice(0, 16).replace("T", "-").replace(":", "");
  const file = new URL(`${stamp}.md`, dir);
  writeFileSync(file, renderReport(records, startedAt, previous));
  console.log(`Rapport: ${file.pathname}`);
}
