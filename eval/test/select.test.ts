import { describe, expect, it } from "vitest";
import { selectCases } from "../cases/index.js";
import type { Case } from "../cases/types.js";
import { MODELS, selectModels } from "../src/models.js";

const mk = (id: string, area: Case["area"]): Case => ({ id, area, prompt: "", source: "", reviewed: false, replies: { company: "x", default: "" }, expect: { operations: [], postings: [] } });

describe("selection", () => {
  it("selects cases by id or area, all without a filter, and refuses an unknown filter", () => {
    const cases = [mk("a", "kjøp"), mk("b", "salg")];
    expect(selectCases(cases).map((c) => c.id)).toEqual(["a", "b"]);
    expect(selectCases(cases, "b").map((c) => c.id)).toEqual(["b"]);
    expect(selectCases(cases, "kjøp").map((c) => c.id)).toEqual(["a"]);
    expect(() => selectCases(cases, "nope")).toThrow("Ingen sak eller område heter nope.");
  });
  it("selects models by key, both by default", () => {
    expect(MODELS).toEqual({ sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5" });
    expect(selectModels()).toEqual(["sonnet", "opus"]);
    expect(selectModels("opus")).toEqual(["opus"]);
    expect(() => selectModels("haiku")).toThrow("Ukjent modell haiku; bruk sonnet eller opus.");
  });
});
