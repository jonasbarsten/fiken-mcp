import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { testConfig } from "../src/config.js";

describe("GET /stats", () => {
  it("serves the global counters publicly with a cache header", async () => {
    const cfg = testConfig();
    await cfg.usage.recordFirstLogin("a", new Date("2026-09-15T00:00:00Z"));
    await cfg.usage.recordCall("a", "list_companies", true, new Date("2026-09-15T00:00:00Z"));
    const res = await createApp(cfg).request("/stats");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await res.json()).toEqual({ totalUsers: 1, months: [{ month: "2026-09", calls: 1, errors: 0, activeUsers: 1, tools: { list_companies: 1 } }] });
  });

  it("answers 503 when the store fails", async () => {
    const cfg = testConfig();
    cfg.usage.globalStats = async () => { throw new Error("down"); };
    const res = await createApp(cfg).request("/stats");
    expect(res.status).toBe(503);
  });
});
