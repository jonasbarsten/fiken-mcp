import { afterEach, describe, expect, it, vi } from "vitest";
import { log, withRequestId } from "../src/log.js";

describe("log", () => {
  afterEach(() => vi.restoreAllMocks());

  it("writes one json line with event and fields", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    log("request", { method: "POST", route: "/mcp", status: 200, ms: 12 });
    const line = JSON.parse(String(out.mock.calls[0]?.[0]));
    expect(line).toMatchObject({ event: "request", method: "POST", route: "/mcp", status: 200, ms: 12 });
    expect(typeof line.ts).toBe("string");
  });

  it("binds a request id", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    withRequestId("req-1")("x", { a: 1 });
    expect(JSON.parse(String(out.mock.calls[0]?.[0])).requestId).toBe("req-1");
  });

  it("refuses to log token-like values, blobs and emails", () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(() => log("x", { h: "Bearer abc.def" })).toThrow(/refusing/);
    expect(() => log("x", { b: "v1e.k1.aaaa.bbbb" })).toThrow(/refusing/);
    expect(() => log("x", { b: "v1.k1.aaaa.bbbb" })).toThrow(/refusing/);
    expect(() => log("x", { e: "jonas@example.com" })).toThrow(/refusing/);
    expect(() => log("x", { ok: "fiken 401" })).not.toThrow();
  });
});
