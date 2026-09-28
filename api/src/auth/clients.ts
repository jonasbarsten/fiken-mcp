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
