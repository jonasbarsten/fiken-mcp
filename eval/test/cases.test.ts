import { describe, expect, it } from "vitest";
import { OPERATIONS } from "../../api/src/mcp/registry.js";
import { ALL_CASES } from "../cases/index.js";

const writes = new Set(OPERATIONS.filter((o) => o.kind === "write").map((o) => o.name));

describe("the cases", () => {
  it("are 25, with unique kebab-case ids, in all four areas", () => {
    expect(ALL_CASES).toHaveLength(25);
    const ids = ALL_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(new Set(ALL_CASES.map((c) => c.area))).toEqual(new Set(["kjøp", "utlegg", "salg", "bilag"]));
  });

  it("name only real write operations", () => {
    for (const c of ALL_CASES) for (const op of c.expect.operations) expect(writes.has(op), `${c.id}: ${op}`).toBe(true);
  });

  it("expect postings that balance where amounts are given", () => {
    for (const c of ALL_CASES) {
      const gross = (side: string) =>
        c.expect.postings
          .filter((p) => p.side === side)
          .reduce((s, p) => s + (p.amount ?? (p.net !== undefined ? p.net + Math.round((p.net * Number(p.vat ?? 0)) / 100) : 0)), 0);
      if (c.expect.postings.length > 0 && c.expect.exact !== false) expect(gross("debit"), c.id).toBe(gross("credit"));
    }
  });

  it("allow create_purchase only where a purchase can give the expected credit (bank or supplier, not an employee)", () => {
    for (const c of ALL_CASES) {
      if (!c.expect.operations.includes("create_purchase")) continue;
      const credits = c.expect.postings.filter((p) => p.side === "credit").flatMap((p) => p.account);
      expect(credits.every((a) => a.startsWith("1920") || a.startsWith("2400")), c.id).toBe(true);
    }
  });

  it("expect only accounts that exist in the demo company's chart (checked with list_accounts 2026-10-04)", () => {
    const chart = new Set([
      "1250", "1749", "1920:10001", "2255", "2911", "2915", "3000", "3020", "3220", "4330", "6017", "6553", "6560", "6800", "6890",
      "6901", "6907", "6940", "7140", "7500", "7770", "8040", "8051",
    ]);
    for (const c of ALL_CASES) {
      for (const p of c.expect.postings) {
        for (const a of p.account) if (!a.endsWith("*")) expect(chart.has(a), `${c.id}: ${a}`).toBe(true);
      }
    }
  });

  it("all point to a source and are unreviewed until an accountant has checked them", () => {
    for (const c of ALL_CASES) {
      expect(c.source.length, c.id).toBeGreaterThan(0);
      expect(c.reviewed, c.id).toBe(false);
    }
  });
});
