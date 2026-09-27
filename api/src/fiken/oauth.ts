import type { Config } from "../config.js";
import { createFikenClient, globalQueue } from "./client.js";

export interface FikenTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export class FikenOAuthError extends Error {
  constructor(public readonly error: string, public readonly description?: string) {
    super(`Fiken OAuth error ${error}`);
  }
}

export function fikenRedirectUri(cfg: Config): string {
  return `${cfg.publicUrl}/callback`;
}

export function fikenAuthorizeUrl(cfg: Config, state: string): string {
  const url = new URL(`${cfg.fikenOAuthBaseUrl}/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", cfg.fikenClientId);
  url.searchParams.set("redirect_uri", fikenRedirectUri(cfg));
  url.searchParams.set("state", state);
  return url.toString();
}

async function tokenRequest(cfg: Config, form: Record<string, string>): Promise<FikenTokens> {
  const basic = Buffer.from(`${cfg.fikenClientId}:${cfg.fikenClientSecret}`).toString("base64");
  const res = await globalQueue.run(() =>
    cfg.fetch(`${cfg.fikenOAuthBaseUrl}/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${basic}`,
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams(form).toString(),
    }),
  );
  const body = (await res.json().catch(() => ({}))) as Partial<FikenTokens> & { error?: string; error_description?: string };
  if (!res.ok || body.error || !body.access_token || !body.refresh_token) {
    throw new FikenOAuthError(body.error ?? `http_${res.status}`, body.error_description);
  }
  return { access_token: body.access_token, refresh_token: body.refresh_token, expires_in: body.expires_in ?? 3600 };
}

export function exchangeFikenCode(cfg: Config, code: string, state: string): Promise<FikenTokens> {
  return tokenRequest(cfg, { grant_type: "authorization_code", code, redirect_uri: fikenRedirectUri(cfg), state });
}

export function refreshFikenToken(cfg: Config, refreshToken: string): Promise<FikenTokens> {
  return tokenRequest(cfg, { grant_type: "refresh_token", refresh_token: refreshToken });
}

export function fetchFikenUser(cfg: Config, accessToken: string): Promise<{ name: string; email: string }> {
  const client = createFikenClient({ baseUrl: cfg.fikenBaseUrl, accessToken, fetch: cfg.fetch });
  return client.json<{ name: string; email: string }>("/user");
}
