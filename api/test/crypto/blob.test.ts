import { describe, expect, it } from "vitest";
import { BlobError, decryptBlob, encryptBlob, keyRingFromParameter, signBlob, verifyBlob } from "../../src/crypto/blob.js";

const ring = keyRingFromParameter(`k1:${"a".repeat(64)}`);
const rotated = keyRingFromParameter(`k2:${"b".repeat(64)},k1:${"a".repeat(64)}`);
const other = keyRingFromParameter(`k1:${"c".repeat(64)}`);

describe("keyRingFromParameter", () => {
  it("parses kids and makes the first one active", () => {
    expect(rotated.active).toBe("k2");
    expect([...rotated.keys.keys()]).toEqual(["k2", "k1"]);
    expect(rotated.keys.get("k1")?.sign.length).toBe(32);
    expect(rotated.keys.get("k1")?.enc.length).toBe(32);
    expect(rotated.keys.get("k1")?.sign.equals(rotated.keys.get("k1")!.enc)).toBe(false);
  });

  it("rejects bad input", () => {
    expect(() => keyRingFromParameter("")).toThrow();
    expect(() => keyRingFromParameter("k1:abcd")).toThrow();
    expect(() => keyRingFromParameter(`k 1:${"a".repeat(64)}`)).toThrow();
  });
});

describe("signed blobs", () => {
  it("round-trips a payload and names the active kid", () => {
    const blob = signBlob({ a: 1, b: "x" }, ring);
    expect(blob.split(".")[1]).toBe("k1");
    expect(verifyBlob(blob, ring)).toEqual({ a: 1, b: "x" });
  });

  it("is url-safe", () => {
    expect(signBlob({ s: "æøå/+=" }, ring)).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it("verifies blobs signed by an older key still in the ring, and not by unknown kids", () => {
    const old = signBlob({ a: 1 }, ring);
    expect(verifyBlob(old, rotated)).toEqual({ a: 1 });
    expect(() => verifyBlob(signBlob({ a: 1 }, rotated), ring)).toThrow(BlobError);
  });

  it("rejects tampering, wrong keys and garbage", () => {
    const blob = signBlob({ a: 1 }, ring);
    const [v, kid, , tag] = blob.split(".");
    const forged = `${v}.${kid}.${Buffer.from(JSON.stringify({ a: 2 })).toString("base64url")}.${tag}`;
    expect(() => verifyBlob(forged, ring)).toThrow(BlobError);
    expect(() => verifyBlob(signBlob({ a: 1 }, other), ring)).toThrow(BlobError);
    expect(() => verifyBlob("nope", ring)).toThrow(BlobError);
    expect(() => verifyBlob("v1.k1.x.y", ring)).toThrow(BlobError);
  });

  it("enforces exp", () => {
    const blob = signBlob({ exp: 1000 }, ring);
    expect(() => verifyBlob(blob, ring, 1001)).toThrow(expect.objectContaining({ code: "expired" }));
    expect(verifyBlob(blob, ring, 999)).toEqual({ exp: 1000 });
  });
});

describe("encrypted blobs", () => {
  it("round-trips, hides the payload, and differs per call", () => {
    const blob = encryptBlob({ token: "secret" }, ring);
    expect(blob).not.toContain("secret");
    expect(blob.split(".")[1]).toBe("k1");
    expect(decryptBlob(blob, ring)).toEqual({ token: "secret" });
    expect(encryptBlob({ a: 1 }, ring)).not.toBe(encryptBlob({ a: 1 }, ring));
  });

  it("decrypts with an older key in the ring", () => {
    expect(decryptBlob(encryptBlob({ a: 1 }, ring), rotated)).toEqual({ a: 1 });
  });

  it("rejects the wrong key, tampering and exp", () => {
    const blob = encryptBlob({ a: 1, exp: 10 }, ring);
    expect(() => decryptBlob(blob, other)).toThrow(BlobError);
    expect(() => decryptBlob(blob.slice(0, -2) + "AA", ring)).toThrow(BlobError);
    expect(() => decryptBlob(blob, ring, 11)).toThrow(expect.objectContaining({ code: "expired" }));
  });

  it("does not accept a signed blob as encrypted or vice versa", () => {
    expect(() => decryptBlob(signBlob({ a: 1 }, ring), ring)).toThrow(BlobError);
    expect(() => verifyBlob(encryptBlob({ a: 1 }, ring), ring)).toThrow(BlobError);
  });
});
