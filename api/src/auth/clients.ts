import type { Config } from "../config.js";
import { BlobError, verifyBlob } from "../crypto/blob.js";

/**
 * Redirect URIs we accept at dynamic registration. Anything else is
 * refused, so an attacker cannot register a client that receives codes.
 * Extend by pull request.
 */
interface KnownClient {
  label: string;
  matches: (url: URL) => boolean;
}

const KNOWN: KnownClient[] = [
  {
    label: "Claude (claude.ai)",
    matches: (u) => u.protocol === "https:" && u.host === "claude.ai" && u.pathname === "/api/mcp/auth_callback",
  },
  {
    label: "ChatGPT (chatgpt.com)",
    matches: (u) =>
      u.protocol === "https:" &&
      u.host === "chatgpt.com" &&
      (u.pathname === "/connector_platform_oauth_redirect" || /^\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(u.pathname)),
  },
  {
    label: "a program on this computer (localhost)",
    matches: (u) => u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1"),
  },
];

function parse(uri: string): URL | undefined {
  try {
    const url = new URL(uri);
    if (url.pathname.includes("/../") || url.pathname.endsWith("/..")) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

export function isAllowedRedirectUri(uri: string): boolean {
  const url = parse(uri);
  return url !== undefined && KNOWN.some((c) => c.matches(url));
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Whether the redirect URI a client sends is one it registered. Exact match, except that a loopback address may come
 * on any port (RFC 8252 7.3): native apps such as ChatGPT Desktop register http://127.0.0.1/callback/… and listen on
 * a random port. Host, path and query must still match.
 */
export function isRegisteredRedirectUri(registered: readonly string[], uri: string): boolean {
  if (registered.includes(uri)) return true;
  const url = parse(uri);
  if (!url || url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname)) return false;
  return registered.some((r) => {
    const reg = parse(r);
    return (
      reg !== undefined &&
      reg.protocol === "http:" &&
      reg.hostname === url.hostname &&
      reg.pathname === url.pathname &&
      reg.search === url.search
    );
  });
}

export function clientLabel(uri: string): string {
  const url = parse(uri);
  return (url && KNOWN.find((c) => c.matches(url))?.label) ?? "an unknown client";
}

/**
 * Hosts whose client id metadata documents we are willing to fetch. This
 * only decides where our server makes an outbound request; the redirect
 * URI allowlist above stays the control over where codes go.
 */
const CIMD_EXACT_HOSTS = ["claude.ai", "chatgpt.com"];
const CIMD_DOMAINS = ["anthropic.com", "openai.com"];

export function isAllowedCimdHost(host: string): boolean {
  // A host with a port never matches: the entries below carry none.
  const h = host.toLowerCase();
  if (CIMD_EXACT_HOSTS.includes(h)) return true;
  return CIMD_DOMAINS.some((d) => h === d || (h.endsWith(`.${d}`) && h.length > d.length + 1));
}

/** What a client id issued at /register carries, signed by us. */
export interface ClientWire {
  k: "c";
  ru: string[];
  n: string;
}

export function readClientId(cfg: Config, clientId: string): { redirectUris: string[]; name: string } {
  const wire = verifyBlob<Partial<ClientWire>>(clientId, cfg.keys);
  if (wire.k !== "c" || !Array.isArray(wire.ru)) throw new BlobError("invalid");
  return { redirectUris: wire.ru, name: typeof wire.n === "string" ? wire.n : "" };
}
