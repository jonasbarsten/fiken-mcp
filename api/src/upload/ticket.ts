import type { Config } from "../config.js";
import { BlobError, decryptBlob, encryptBlob } from "../crypto/blob.js";

export const UPLOAD_TICKET_SECONDS = 15 * 60;

export interface UploadTicket { fikenAccessToken: string; anonId: string; companySlug: string; exp: number }

interface TicketWire { k: "t"; t: string; u: string; s: string; exp: number }

const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * How long the next ticket is good for: the 15-minute window, clipped to what
 * is left of the caller's session. The ticket is a bearer credential for the
 * caller's Fiken token, so it must never outlive the access token it was minted
 * from — a session with two minutes left cannot hand out fifteen.
 */
export function uploadTicketSeconds(claims: { exp: number }, now = nowSeconds()): number {
  return Math.max(0, Math.min(UPLOAD_TICKET_SECONDS, claims.exp - now));
}

export function issueUploadTicket(
  cfg: Config,
  claims: { fikenAccessToken: string; anonId: string; exp: number },
  companySlug: string,
  now = nowSeconds(),
): string {
  const wire: TicketWire = { k: "t", t: claims.fikenAccessToken, u: claims.anonId, s: companySlug, exp: now + uploadTicketSeconds(claims, now) };
  return encryptBlob(wire, cfg.keys);
}

export function readUploadTicket(cfg: Config, ticket: string, now = nowSeconds()): UploadTicket {
  const wire = decryptBlob<Partial<TicketWire>>(ticket, cfg.keys, now);
  if (wire.k !== "t" || !wire.t || !wire.u || !wire.s || typeof wire.exp !== "number") throw new BlobError("invalid");
  return { fikenAccessToken: wire.t, anonId: wire.u, companySlug: wire.s, exp: wire.exp };
}
