import type { Config } from "../config.js";
import { BlobError, decryptBlob, encryptBlob } from "../crypto/blob.js";
import { refreshFikenToken, type FikenTokens } from "../fiken/oauth.js";

export const ACCESS_TOKEN_SECONDS = 3600;
const RENEW_MARGIN_SECONDS = 60;

export interface AccessClaims { fikenAccessToken: string; anonId: string; exp: number }
export interface RefreshClaims { fikenRefreshToken: string; fikenAccessToken: string; fikenAccessExp: number; anonId: string }
export interface IssuedTokens { access_token: string; refresh_token: string; token_type: "bearer"; expires_in: number }

interface AccessWire { k: "a"; t: string; u: string; exp: number }
interface RefreshWire { k: "r"; r: string; t: string; te: number; u: string }

const nowSeconds = () => Math.floor(Date.now() / 1000);

function issue(cfg: Config, fikenAccessToken: string, fikenAccessExp: number, fikenRefreshToken: string, anonId: string, now: number): IssuedTokens {
  const expiresIn = Math.max(0, Math.min(ACCESS_TOKEN_SECONDS, fikenAccessExp - now));
  const access: AccessWire = { k: "a", t: fikenAccessToken, u: anonId, exp: now + expiresIn };
  const refresh: RefreshWire = { k: "r", r: fikenRefreshToken, t: fikenAccessToken, te: fikenAccessExp, u: anonId };
  return {
    access_token: encryptBlob(access, cfg.keys),
    refresh_token: encryptBlob(refresh, cfg.keys),
    token_type: "bearer",
    expires_in: expiresIn,
  };
}

export function issueTokens(cfg: Config, fiken: FikenTokens, anonId: string, now = nowSeconds()): IssuedTokens {
  return issue(cfg, fiken.access_token, now + fiken.expires_in, fiken.refresh_token, anonId, now);
}

export function readAccessToken(cfg: Config, token: string, now = nowSeconds()): AccessClaims {
  const wire = decryptBlob<Partial<AccessWire>>(token, cfg.keys, now);
  if (wire.k !== "a" || !wire.t || !wire.u || typeof wire.exp !== "number") throw new BlobError("invalid");
  return { fikenAccessToken: wire.t, anonId: wire.u, exp: wire.exp };
}

export function readRefreshToken(cfg: Config, token: string): RefreshClaims {
  const wire = decryptBlob<Partial<RefreshWire>>(token, cfg.keys);
  if (wire.k !== "r" || !wire.r || !wire.t || !wire.u || typeof wire.te !== "number") throw new BlobError("invalid");
  return { fikenRefreshToken: wire.r, fikenAccessToken: wire.t, fikenAccessExp: wire.te, anonId: wire.u };
}

export async function renewTokens(cfg: Config, refreshToken: string, now = nowSeconds()): Promise<IssuedTokens> {
  const claims = readRefreshToken(cfg, refreshToken);
  if (claims.fikenAccessExp - now > ACCESS_TOKEN_SECONDS + RENEW_MARGIN_SECONDS) {
    return issue(cfg, claims.fikenAccessToken, claims.fikenAccessExp, claims.fikenRefreshToken, claims.anonId, now);
  }
  const fresh = await refreshFikenToken(cfg, claims.fikenRefreshToken);
  return issueTokens(cfg, fresh, claims.anonId, now);
}
