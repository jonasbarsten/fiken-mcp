import type { Config } from "../config.js";
import { BlobError, decryptBlob, encryptBlob } from "../crypto/blob.js";

export const UPLOAD_TICKET_SECONDS = 15 * 60;

export interface UploadTicket { fikenAccessToken: string; anonId: string; companySlug: string; exp: number }

interface TicketWire { k: "t"; t: string; u: string; s: string; exp: number }

const nowSeconds = () => Math.floor(Date.now() / 1000);

export function issueUploadTicket(cfg: Config, claims: { fikenAccessToken: string; anonId: string }, companySlug: string, now = nowSeconds()): string {
  const wire: TicketWire = { k: "t", t: claims.fikenAccessToken, u: claims.anonId, s: companySlug, exp: now + UPLOAD_TICKET_SECONDS };
  return encryptBlob(wire, cfg.keys);
}

export function readUploadTicket(cfg: Config, ticket: string, now = nowSeconds()): UploadTicket {
  const wire = decryptBlob<Partial<TicketWire>>(ticket, cfg.keys, now);
  if (wire.k !== "t" || !wire.t || !wire.u || !wire.s || typeof wire.exp !== "number") throw new BlobError("invalid");
  return { fikenAccessToken: wire.t, anonId: wire.u, companySlug: wire.s, exp: wire.exp };
}
