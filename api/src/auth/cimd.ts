import type { Config } from "../config.js";
import { isAllowedCimdHost, readClientId } from "./clients.js";

/**
 * Client ID Metadata Documents: instead of registering at /register, a
 * client may present an https URL as its client_id and publish its
 * metadata there. We fetch that document from a short allowlist of hosts
 * and then treat the client exactly like a registered one; the redirect
 * URI allowlist is still re-checked on every use.
 */
export class CimdError extends Error {
  constructor(reason: string) {
    // Reasons stay short and carry no document body and no URL.
    super(reason);
    this.name = "CimdError";
  }
}

export interface ClientMetadata {
  redirectUris: string[];
  name: string;
}

const MAX_BODY_CHARS = 16384;
const TIMEOUT_MS = 3000;
const TTL_SECONDS = 60 * 60;
const MAX_ENTRIES = 64;
const MAX_NAME_CHARS = 64;

const cache = new Map<string, { expires: number; meta: ClientMetadata }>();

/** An https URL on an allowlisted host, with a path and no query or fragment. */
export function isCimdClientId(clientId: string): boolean {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    isAllowedCimdHost(url.host) &&
    url.pathname.length > 1 &&
    url.search === "" &&
    url.hash === "" &&
    url.username === "" &&
    url.password === ""
  );
}

export function clearCimdCache(): void {
  cache.clear();
}

function readDocument(clientId: string, text: string): ClientMetadata {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new CimdError("not json");
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) throw new CimdError("invalid document");
  const { client_id, redirect_uris, client_name } = doc as { client_id?: unknown; redirect_uris?: unknown; client_name?: unknown };
  // The document must claim the very URL we fetched it from.
  if (client_id !== clientId) throw new CimdError("invalid document");
  if (!Array.isArray(redirect_uris) || redirect_uris.length === 0 || !redirect_uris.every((u) => typeof u === "string")) {
    throw new CimdError("invalid document");
  }
  if (client_name !== undefined && typeof client_name !== "string") throw new CimdError("invalid document");
  return {
    redirectUris: redirect_uris as string[],
    name: typeof client_name === "string" ? client_name.slice(0, MAX_NAME_CHARS) : "",
  };
}

/** Fetches and validates the document, at most once an hour per URL. Failures are never cached. */
export async function fetchClientMetadata(cfg: Config, clientId: string, now = Math.floor(Date.now() / 1000)): Promise<ClientMetadata> {
  // Checked before any outbound request: we only ever fetch allowlisted hosts.
  if (!isCimdClientId(clientId)) throw new CimdError("not a metadata url");
  const hit = cache.get(clientId);
  if (hit && hit.expires > now) return hit.meta;

  let res: Response;
  try {
    res = await cfg.fetch(clientId, { redirect: "error", headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new CimdError("fetch failed");
  }
  if (res.status !== 200) throw new CimdError("bad status");
  let text: string;
  try {
    text = await res.text();
  } catch {
    throw new CimdError("fetch failed");
  }
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_CHARS) throw new CimdError("too large");
  const meta = readDocument(clientId, text);

  cache.delete(clientId);
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(clientId, { expires: now + TTL_SECONDS, meta });
  return meta;
}

/** A published identity is fetched; anything else must be one of our signed client ids. */
export async function resolveClient(cfg: Config, clientId: string): Promise<{ redirectUris: string[]; name: string }> {
  return isCimdClientId(clientId) ? fetchClientMetadata(cfg, clientId) : readClientId(cfg, clientId);
}
