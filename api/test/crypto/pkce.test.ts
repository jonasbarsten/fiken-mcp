import { describe, expect, it } from "vitest";
import { pkceChallenge, verifyPkce } from "../../src/crypto/pkce.js";

describe("pkce", () => {
  // RFC 7636 appendix B test vector
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

  it("computes the RFC 7636 challenge", () => {
    expect(pkceChallenge(verifier)).toBe(challenge);
  });

  it("verifies matching and rejects mismatching pairs", () => {
    expect(verifyPkce(verifier, challenge)).toBe(true);
    expect(verifyPkce(verifier + "x", challenge)).toBe(false);
    expect(verifyPkce(verifier, "")).toBe(false);
  });
});
