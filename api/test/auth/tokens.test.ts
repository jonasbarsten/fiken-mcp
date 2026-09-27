import { describe, expect, it } from "vitest";
import { ACCESS_TOKEN_SECONDS, issueTokens, readAccessToken, readRefreshToken, renewTokens } from "../../src/auth/tokens.js";
import { testConfig } from "../../src/config.js";
import { BlobError } from "../../src/crypto/blob.js";

const cfg = testConfig();
const fiken = { access_token: "FA", refresh_token: "FR", expires_in: 86157 };

describe("issueTokens", () => {
  it("issues one-hour encrypted wrappers", () => {
    const issued = issueTokens(cfg, fiken, "anon1", 1000);
    expect(issued.token_type).toBe("bearer");
    expect(issued.expires_in).toBe(ACCESS_TOKEN_SECONDS);
    // A two-letter sentinel can appear by chance in base64url ciphertext; use a long one.
    const leaky = issueTokens(cfg, { ...fiken, access_token: "PLAINTEXT-FIKEN-ACCESS-TOKEN" }, "anon1", 1000);
    expect(leaky.access_token).not.toContain("PLAINTEXT-FIKEN-ACCESS-TOKEN");
    expect(readAccessToken(cfg, issued.access_token, 1050)).toEqual({ fikenAccessToken: "FA", anonId: "anon1", exp: 1000 + ACCESS_TOKEN_SECONDS });
    expect(readRefreshToken(cfg, issued.refresh_token)).toEqual({ fikenRefreshToken: "FR", anonId: "anon1" });
  });

  it("never issues longer than Fiken's own expiry", () => {
    const issued = issueTokens(cfg, { ...fiken, expires_in: 120 }, "anon1", 1000);
    expect(issued.expires_in).toBe(120);
  });

  it("access tokens expire; refresh tokens do not; kinds are not interchangeable", () => {
    const issued = issueTokens(cfg, fiken, "anon1", 1000);
    expect(() => readAccessToken(cfg, issued.access_token, 1000 + ACCESS_TOKEN_SECONDS + 1)).toThrow(BlobError);
    expect(readRefreshToken(cfg, issued.refresh_token).fikenRefreshToken).toBe("FR");
    expect(() => readRefreshToken(cfg, issued.access_token)).toThrow(BlobError);
    expect(() => readAccessToken(cfg, issued.refresh_token, 1000)).toThrow(BlobError);
  });
});

describe("renewTokens", () => {
  it("calls Fiken's refresh on every renewal, even when the previous Fiken token is fresh", async () => {
    const sent: string[] = [];
    const c = testConfig({
      fetch: async (_input, init) => {
        sent.push(new URLSearchParams(String(init?.body)).get("refresh_token") ?? "");
        return Response.json({ access_token: "FA2", refresh_token: "FR2", expires_in: 86157 });
      },
    });
    const issued = issueTokens(c, fiken, "anon1", 1000);
    const renewed = await renewTokens(c, issued.refresh_token, 1010);
    expect(sent).toEqual(["FR"]);
    expect(readAccessToken(c, renewed.access_token, 1010)).toEqual({ fikenAccessToken: "FA2", anonId: "anon1", exp: 1010 + ACCESS_TOKEN_SECONDS });
    expect(readRefreshToken(c, renewed.refresh_token)).toEqual({ fikenRefreshToken: "FR2", anonId: "anon1" });
  });

  it("rejects garbage", async () => {
    await expect(renewTokens(cfg, "garbage", 1)).rejects.toThrow(BlobError);
  });
});
