import type { Config } from "../config.js";
import { BlobError, decryptBlob, encryptBlob } from "../crypto/blob.js";
import { refreshFikenToken, type FikenTokens } from "../fiken/oauth.js";

export const ACCESS_TOKEN_SECONDS = 3600;

export interface AccessClaims { fikenAccessToken: string; anonId: string; exp: number }
export interface RefreshClaims { fikenRefreshToken: string; anonId: string }
export interface IssuedTokens { access_token: string; refresh_token: string; token_type: "bearer"; expires_in: number }

interface AccessWire { k: "a"; t: string; u: string; exp: number }
interface RefreshWire { k: "r"; r: string; u: string }

const nowSeconds = () => Math.floor(Date.now() / 1000);

export function issueTokens(cfg: Config, fiken: FikenTokens, anonId: string, now = nowSeconds()): IssuedTokens {
  const expiresIn = Math.max(0, Math.min(ACCESS_TOKEN_SECONDS, fiken.expires_in));
  const access: AccessWire = { k: "a", t: fiken.access_token, u: anonId, exp: now + expiresIn };
  const refresh: RefreshWire = { k: "r", r: fiken.refresh_token, u: anonId };
  return {
    access_token: encryptBlob(access, cfg.keys),
    refresh_token: encryptBlob(refresh, cfg.keys),
    token_type: "bearer",
    expires_in: expiresIn,
  };
}

export function readAccessToken(cfg: Config, token: string, now = nowSeconds()): AccessClaims {
  const wire = decryptBlob<Partial<AccessWire>>(token, cfg.keys, now);
  if (wire.k !== "a" || !wire.t || !wire.u || typeof wire.exp !== "number") throw new BlobError("invalid");
  return { fikenAccessToken: wire.t, anonId: wire.u, exp: wire.exp };
}

export function readRefreshToken(cfg: Config, token: string): RefreshClaims {
  const wire = decryptBlob<Partial<RefreshWire>>(token, cfg.keys);
  if (wire.k !== "r" || !wire.r || !wire.u) throw new BlobError("invalid");
  return { fikenRefreshToken: wire.r, anonId: wire.u };
}

/** Every renewal asks Fiken for a fresh token, so a grant revoked in Fiken is refused within the hour. */
export async function renewTokens(cfg: Config, refreshToken: string, now = nowSeconds()): Promise<IssuedTokens> {
  const claims = readRefreshToken(cfg, refreshToken);
  const fresh = await refreshFikenToken(cfg, claims.fikenRefreshToken);
  return issueTokens(cfg, fresh, claims.anonId, now);
}
