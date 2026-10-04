import type { Config } from "../config.js";
import { BlobError, decryptBlob, encryptBlob } from "../crypto/blob.js";

export const VIEW_TICKET_SECONDS = 5 * 60;

export interface ViewTicket { fikenAccessToken: string; anonId: string; companySlug: string; fileUrl: string; exp: number }

/** Kind "v": every blob shares the key ring, so the tag alone keeps upload tickets, tokens and view tickets apart. */
interface TicketWire { k: "v"; t: string; u: string; s: string; f: string; exp: number }

const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * Five minutes, clipped to what is left of the caller's session. The ticket is a
 * bearer credential for the caller's Fiken token, limited to fetching one file,
 * and the widget spends it right after the tool result arrives.
 */
export function viewTicketSeconds(claims: { exp: number }, now = nowSeconds()): number {
  return Math.max(0, Math.min(VIEW_TICKET_SECONDS, claims.exp - now));
}

/** Seals the token with the one file URL it may fetch; the URL must come from Fiken, never from the model. */
export function issueViewTicket(
  cfg: Config,
  claims: { fikenAccessToken: string; anonId: string; exp: number },
  companySlug: string,
  fileUrl: string,
  now = nowSeconds(),
): string {
  const wire: TicketWire = { k: "v", t: claims.fikenAccessToken, u: claims.anonId, s: companySlug, f: fileUrl, exp: now + viewTicketSeconds(claims, now) };
  return encryptBlob(wire, cfg.keys);
}

export function readViewTicket(cfg: Config, ticket: string, now = nowSeconds()): ViewTicket {
  const wire = decryptBlob<Partial<TicketWire>>(ticket, cfg.keys, now);
  if (wire.k !== "v" || !wire.t || !wire.u || !wire.s || !wire.f || typeof wire.exp !== "number") throw new BlobError("invalid");
  return { fikenAccessToken: wire.t, anonId: wire.u, companySlug: wire.s, fileUrl: wire.f, exp: wire.exp };
}
