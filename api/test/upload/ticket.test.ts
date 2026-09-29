import { describe, expect, it } from "vitest";
import { issueTokens, readAccessToken, readRefreshToken } from "../../src/auth/tokens.js";
import { testConfig } from "../../src/config.js";
import { BlobError } from "../../src/crypto/blob.js";
import { issueUploadTicket, readUploadTicket, uploadTicketSeconds, UPLOAD_TICKET_SECONDS } from "../../src/upload/ticket.js";

const cfg = testConfig();
const session = (exp: number) => ({ fikenAccessToken: "FIKEN-ACCESS-TOKEN-PLAINTEXT", anonId: "anon1", exp });

describe("upload ticket", () => {
  it("round-trips, hides the token, expires after 15 minutes", () => {
    const t = issueUploadTicket(cfg, session(1_000_000), "demo", 1000);
    expect(t).not.toContain("FIKEN-ACCESS-TOKEN-PLAINTEXT");
    expect(readUploadTicket(cfg, t, 1000 + UPLOAD_TICKET_SECONDS)).toEqual({ fikenAccessToken: "FIKEN-ACCESS-TOKEN-PLAINTEXT", anonId: "anon1", companySlug: "demo", exp: 1000 + UPLOAD_TICKET_SECONDS });
    expect(() => readUploadTicket(cfg, t, 1000 + UPLOAD_TICKET_SECONDS + 1)).toThrow(BlobError);
  });

  it("never outlives the session it was minted from", () => {
    // Two minutes of session left: the ticket gets two minutes, not fifteen.
    expect(uploadTicketSeconds(session(1120), 1000)).toBe(120);
    const t = issueUploadTicket(cfg, session(1120), "demo", 1000);
    expect(readUploadTicket(cfg, t, 1120).exp).toBe(1120);
    expect(() => readUploadTicket(cfg, t, 1121)).toThrow(BlobError);
    // An already-dead session cannot hand out any access at all.
    expect(uploadTicketSeconds(session(900), 1000)).toBe(0);
    expect(() => readUploadTicket(cfg, issueUploadTicket(cfg, session(900), "demo", 1000), 1001)).toThrow(BlobError);
  });

  it("rejects other blob kinds and garbage", () => {
    expect(() => readUploadTicket(cfg, "garbage")).toThrow(BlobError);
    // Every blob is sealed with the same key ring, so only the kind tag keeps an
    // access token from being spent as an upload ticket and the other way round.
    const issued = issueTokens(cfg, { access_token: "FA", refresh_token: "FR", expires_in: 3600 }, "anon1");
    expect(() => readUploadTicket(cfg, issued.access_token)).toThrow(BlobError);
    expect(() => readUploadTicket(cfg, issued.refresh_token)).toThrow(BlobError);
    // A live ticket (far-future session), so the refusal below is the kind tag, not expiry.
    const ticket = issueUploadTicket(cfg, session(Math.floor(Date.now() / 1000) + 3600), "demo");
    expect(() => readAccessToken(cfg, ticket)).toThrow(expect.objectContaining({ code: "invalid" }));
    expect(() => readRefreshToken(cfg, ticket)).toThrow(expect.objectContaining({ code: "invalid" }));
  });
});
