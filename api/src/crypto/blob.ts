import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

export class BlobError extends Error {
  constructor(public readonly code: "invalid" | "expired") {
    super(`blob ${code}`);
  }
}

export interface KeyRing {
  active: string;
  keys: Map<string, { sign: Buffer; enc: Buffer }>;
}

const KID = /^[A-Za-z0-9_-]{1,16}$/;

export function keyRingFromParameter(value: string): KeyRing {
  const keys = new Map<string, { sign: Buffer; enc: Buffer }>();
  for (const entry of value.split(",")) {
    const [kid, hex] = entry.trim().split(":");
    if (!kid || !KID.test(kid) || !hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new Error("signing_key must be kid:hex64[,kid:hex64] with alphanumeric kids");
    }
    const master = Buffer.from(hex, "hex");
    keys.set(kid, {
      sign: Buffer.from(hkdfSync("sha256", master, "", "sign", 32)),
      enc: Buffer.from(hkdfSync("sha256", master, "", "enc", 32)),
    });
  }
  const active = keys.keys().next().value;
  if (!active) throw new Error("signing_key is empty");
  return { active, keys };
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

function parse<T>(json: Buffer, now: number): T {
  let payload: unknown;
  try {
    payload = JSON.parse(json.toString("utf8"));
  } catch {
    throw new BlobError("invalid");
  }
  if (payload && typeof payload === "object" && "exp" in payload) {
    const exp = (payload as { exp: unknown }).exp;
    if (typeof exp === "number" && exp < now) throw new BlobError("expired");
  }
  return payload as T;
}

function keyFor(ring: KeyRing, kid: string | undefined) {
  const key = kid ? ring.keys.get(kid) : undefined;
  if (!key) throw new BlobError("invalid");
  return key;
}

export function signBlob(payload: object, ring: KeyRing): string {
  const key = ring.keys.get(ring.active)!;
  const body = Buffer.from(JSON.stringify(payload));
  const tag = createHmac("sha256", key.sign).update(body).digest();
  return `v1.${ring.active}.${body.toString("base64url")}.${tag.toString("base64url")}`;
}

export function verifyBlob<T>(blob: string, ring: KeyRing, now = nowSeconds()): T {
  const parts = blob.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") throw new BlobError("invalid");
  const key = keyFor(ring, parts[1]);
  const body = Buffer.from(parts[2]!, "base64url");
  const tag = Buffer.from(parts[3]!, "base64url");
  const expected = createHmac("sha256", key.sign).update(body).digest();
  if (tag.length !== expected.length || !timingSafeEqual(tag, expected)) throw new BlobError("invalid");
  return parse<T>(body, now);
}

export function encryptBlob(payload: object, ring: KeyRing): string {
  const key = ring.keys.get(ring.active)!;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key.enc, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const data = Buffer.concat([ciphertext, cipher.getAuthTag()]);
  return `v1e.${ring.active}.${iv.toString("base64url")}.${data.toString("base64url")}`;
}

export function decryptBlob<T>(blob: string, ring: KeyRing, now = nowSeconds()): T {
  const parts = blob.split(".");
  if (parts.length !== 4 || parts[0] !== "v1e") throw new BlobError("invalid");
  const key = keyFor(ring, parts[1]);
  const iv = Buffer.from(parts[2]!, "base64url");
  const data = Buffer.from(parts[3]!, "base64url");
  if (iv.length !== 12 || data.length < 16) throw new BlobError("invalid");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key.enc, iv);
    decipher.setAuthTag(data.subarray(data.length - 16));
    const plain = Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
    return parse<T>(plain, now);
  } catch (err) {
    if (err instanceof BlobError) throw err;
    throw new BlobError("invalid");
  }
}
