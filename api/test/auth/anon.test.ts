import { describe, expect, it } from "vitest";
import { anonymousId } from "../../src/auth/anon.js";

const salt = Buffer.from("c".repeat(64), "hex");

describe("anonymousId", () => {
  it("is stable, salted and normalised", () => {
    const a = anonymousId("Jonas@Example.com ", salt);
    expect(a).toBe(anonymousId("jonas@example.com", salt));
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(anonymousId("jonas@example.com", Buffer.from("d".repeat(64), "hex")));
    expect(a).not.toContain("jonas");
  });
});
