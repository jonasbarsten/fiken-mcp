import { describe, expect, it } from "vitest";
import { issueTokens, readAccessToken } from "../../src/auth/tokens.js";
import { testConfig } from "../../src/config.js";
import { BlobError } from "../../src/crypto/blob.js";
import { issueViewTicket, readViewTicket, viewTicketSeconds, VIEW_TICKET_SECONDS } from "../../src/document/ticket.js";
import { issueUploadTicket, readUploadTicket } from "../../src/upload/ticket.js";

const cfg = testConfig();
const session = (exp: number) => ({ fikenAccessToken: "FIKEN-ACCESS-TOKEN-PLAINTEXT", anonId: "anon1", exp });
const FILE = "https://fiken.test/api/v2/files/abc";

describe("view ticket", () => {
  it("round-trips the file URL and nothing else it does not check, hides the token and the URL, expires after 5 minutes", () => {
    expect(VIEW_TICKET_SECONDS).toBe(300);
    const t = issueViewTicket(cfg, session(1_000_000), FILE, 1000);
    expect(t).not.toContain("FIKEN-ACCESS-TOKEN-PLAINTEXT");
    expect(t).not.toContain("files/abc");
    expect(readViewTicket(cfg, t, 1300)).toEqual({ fikenAccessToken: "FIKEN-ACCESS-TOKEN-PLAINTEXT", anonId: "anon1", fileUrl: FILE, exp: 1300 });
    expect(() => readViewTicket(cfg, t, 1301)).toThrow(BlobError);
  });

  it("never outlives the session it was minted from", () => {
    expect(viewTicketSeconds(session(1060), 1000)).toBe(60);
    const t = issueViewTicket(cfg, session(1060), FILE, 1000);
    expect(readViewTicket(cfg, t, 1060).exp).toBe(1060);
    expect(() => readViewTicket(cfg, t, 1061)).toThrow(BlobError);
    expect(viewTicketSeconds(session(900), 1000)).toBe(0);
  });

  it("is never accepted as an upload ticket, and an upload ticket is never accepted as a view ticket", () => {
    const live = session(Math.floor(Date.now() / 1000) + 3600);
    const view = issueViewTicket(cfg, live, FILE);
    const upload = issueUploadTicket(cfg, live, "demo");
    expect(() => readUploadTicket(cfg, view)).toThrow(expect.objectContaining({ code: "invalid" }));
    expect(() => readViewTicket(cfg, upload)).toThrow(expect.objectContaining({ code: "invalid" }));
  });

  it("rejects access tokens, garbage, and is not itself an access token", () => {
    const issued = issueTokens(cfg, { access_token: "FA", refresh_token: "FR", expires_in: 3600 }, "anon1");
    expect(() => readViewTicket(cfg, issued.access_token)).toThrow(BlobError);
    expect(() => readViewTicket(cfg, issued.refresh_token)).toThrow(BlobError);
    expect(() => readViewTicket(cfg, "garbage")).toThrow(BlobError);
    const view = issueViewTicket(cfg, session(Math.floor(Date.now() / 1000) + 3600), FILE);
    expect(() => readAccessToken(cfg, view)).toThrow(expect.objectContaining({ code: "invalid" }));
  });
});
