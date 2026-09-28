import { describe, expect, it } from "vitest";
import { memoryUsageStore } from "../../src/usage/memory.js";

const sep = new Date("2026-09-15T10:00:00Z");
const oct = new Date("2026-10-02T10:00:00Z");

describe("memoryUsageStore", () => {
  it("counts calls, errors and tools per user-month and globally, and active users once per month", async () => {
    const s = memoryUsageStore();
    await s.recordCall("a", "list_companies", true, sep);
    await s.recordCall("a", "list_projects", false, sep);
    await s.recordCall("b", "list_companies", true, sep);
    await s.recordCall("a", "list_companies", true, oct);
    expect(await s.userMonths("a")).toEqual([
      { month: "2026-10", calls: 1, errors: 0, tools: { list_companies: 1 } },
      { month: "2026-09", calls: 2, errors: 1, tools: { list_companies: 1, list_projects: 1 } },
    ]);
    const g = await s.globalStats();
    expect(g.months).toEqual([
      { month: "2026-10", calls: 1, errors: 0, activeUsers: 1, tools: { list_companies: 1 } },
      { month: "2026-09", calls: 3, errors: 1, activeUsers: 2, tools: { list_companies: 2, list_projects: 1 } },
    ]);
  });

  it("counts a user once ever", async () => {
    const s = memoryUsageStore();
    await s.recordFirstLogin("a", sep);
    await s.recordFirstLogin("a", oct);
    await s.recordFirstLogin("b", oct);
    expect((await s.globalStats()).totalUsers).toBe(2);
    expect(s.dump().get("USER#a|PROFILE")).toEqual({ PK: "USER#a", SK: "PROFILE", firstSeen: "2026-09" });
  });

  it("starts empty", async () => {
    const s = memoryUsageStore();
    expect(await s.userMonths("nobody")).toEqual([]);
    expect(await s.globalStats()).toEqual({ totalUsers: 0, months: [] });
  });
});
