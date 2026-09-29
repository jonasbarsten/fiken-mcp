import { describe, expect, it } from "vitest";
import { loadConfig, testConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("reads env and Parameter Store", async () => {
    const asked: string[][] = [];
    const ssm = {
      async getParameters(names: string[]) {
        asked.push(names);
        return {
          "/fiken_mcp/client_id": "cid",
          "/fiken_mcp/client_secret": "csec",
          "/fiken_mcp/signing_key": `k1:${"a".repeat(64)}`,
          "/fiken_mcp/user_salt": "b".repeat(64),
        };
      },
    };
    const cfg = await loadConfig({ env: { PUBLIC_URL: "https://x.test/", USAGE_TABLE_NAME: "usage" }, ssm });
    expect(cfg.publicUrl).toBe("https://x.test");
    expect(cfg.fikenClientId).toBe("cid");
    expect(cfg.fikenClientSecret).toBe("csec");
    expect(cfg.keys.active).toBe("k1");
    expect(cfg.userSalt.length).toBe(32);
    expect(cfg.fikenBaseUrl).toBe("https://api.fiken.no/api/v2");
    expect(cfg.fikenFileBaseUrl).toBe("https://fiken.no/api/v2");
    expect(asked[0]).toEqual(["/fiken_mcp/client_id", "/fiken_mcp/client_secret", "/fiken_mcp/signing_key", "/fiken_mcp/user_salt"]);
    expect(typeof cfg.usage.recordCall).toBe("function");
  });

  it("fails on missing PUBLIC_URL or missing parameters", async () => {
    const ssm = { async getParameters() { return {}; } };
    await expect(loadConfig({ env: {}, ssm })).rejects.toThrow(/PUBLIC_URL/);
    await expect(loadConfig({ env: { PUBLIC_URL: "https://x.test" }, ssm })).rejects.toThrow(/USAGE_TABLE_NAME/);
    await expect(loadConfig({ env: { PUBLIC_URL: "https://x.test", USAGE_TABLE_NAME: "usage" }, ssm })).rejects.toThrow(/client_id/);
  });

  it("testConfig gives usable keys", () => {
    const cfg = testConfig();
    expect(cfg.keys.keys.size).toBe(1);
    expect(cfg.publicUrl).toBe("https://fiken-mcp.test");
  });

  it("testConfig usage store starts empty", async () => {
    const cfg = testConfig();
    await expect(cfg.usage.globalStats()).resolves.toEqual({ totalUsers: 0, months: [] });
  });
});
