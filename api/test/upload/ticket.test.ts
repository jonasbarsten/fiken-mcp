import { describe, expect, it } from "vitest";
import { testConfig } from "../../src/config.js";
import { BlobError } from "../../src/crypto/blob.js";
import { issueUploadTicket, readUploadTicket, UPLOAD_TICKET_SECONDS } from "../../src/upload/ticket.js";

const cfg = testConfig();
describe("upload ticket", () => {
  it("round-trips, hides the token, expires after 15 minutes", () => {
    const t = issueUploadTicket(cfg, { fikenAccessToken: "FIKEN-ACCESS-TOKEN-PLAINTEXT", anonId: "anon1" }, "demo", 1000);
    expect(t).not.toContain("FIKEN-ACCESS-TOKEN-PLAINTEXT");
    expect(readUploadTicket(cfg, t, 1000 + UPLOAD_TICKET_SECONDS)).toEqual({ fikenAccessToken: "FIKEN-ACCESS-TOKEN-PLAINTEXT", anonId: "anon1", companySlug: "demo", exp: 1000 + UPLOAD_TICKET_SECONDS });
    expect(() => readUploadTicket(cfg, t, 1000 + UPLOAD_TICKET_SECONDS + 1)).toThrow(BlobError);
  });
  it("rejects other blob kinds and garbage", () => {
    expect(() => readUploadTicket(cfg, "garbage")).toThrow(BlobError);
  });
});
