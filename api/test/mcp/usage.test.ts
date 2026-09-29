import { describe, expect, it } from "vitest";
import { memoryUsageStore } from "../../src/usage/memory.js";
import { callJson, connected, fakeFiken } from "./helpers.js";

describe("usage counting", () => {
  it("records every tool call with its outcome, and my_usage reads it back", async () => {
    const usage = memoryUsageStore();
    const f = fakeFiken([
      { match: /\/companies$/, body: [{ name: "Demo", slug: "demo" }] },
      { match: /\/projects/, status: 500, body: "boom" },
    ]);
    const c = await connected(f.fetchImpl, { usage });
    expect((await callJson(c, "list_companies", {})).isError).toBe(false);
    expect((await callJson(c, "list_projects", { companySlug: "demo" })).isError).toBe(true);
    const mine = (await callJson(c, "my_usage", {})).json() as { anonId: string; months: Array<{ calls: number; errors: number; tools: Record<string, number> }> };
    expect(mine.anonId).toBe("anon");
    // my_usage reads before its own call is recorded (counters record after the handler).
    expect(mine.months[0]).toMatchObject({ calls: 2, errors: 1, tools: { list_companies: 1, list_projects: 1 } });
    expect((await usage.globalStats()).months[0]).toMatchObject({ calls: 3, activeUsers: 1, tools: { list_companies: 1, list_projects: 1, my_usage: 1 } });
  });

  it("a failing usage store never fails the tool", async () => {
    const usage = memoryUsageStore();
    usage.recordCall = async () => { throw new Error("dynamo down"); };
    const f = fakeFiken([{ match: /\/companies$/, body: [{ name: "Demo", slug: "demo" }] }]);
    const c = await connected(f.fetchImpl, { usage });
    expect((await callJson(c, "list_companies", {})).isError).toBe(false);
  });
});
