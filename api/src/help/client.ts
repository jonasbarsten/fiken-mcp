/**
 * Reads Fiken's public help for the model: the llms.txt index and each
 * article as Markdown. Only hjelp.fiken.no, with a timeout, a size cap and a
 * short in-memory cache so a busy conversation does not refetch the index.
 * No token and no user data is ever sent: these are public pages.
 */

export interface HelpIndexEntry { slug: string; title: string }
export interface HelpArticle { slug: string; title: string; lastUpdated?: string; url: string; deprioritized: boolean; body: string }
export interface HelpClient {
  index(): Promise<HelpIndexEntry[]>;
  article(slug: string): Promise<HelpArticle>;
}

export class HelpError extends Error {}

export const HELP_BASE = "https://hjelp.fiken.no";
const HOST = "hjelp.fiken.no";
const SLUG = /^[a-z0-9-]+$/;
const INDEX_LINE = /^- \[(.+)\]\(https:\/\/hjelp\.fiken\.no\/([a-z0-9-]+)\.md\)\s*$/;
const IMAGE_LINE = /^\s*!\[[^\]]*\]\([^)]*\)\s*$/;

export function filterIndex(entries: HelpIndexEntry[], query: string | undefined): HelpIndexEntry[] {
  const words = (query ?? "").toLowerCase().split(/\s+/).filter((w) => w !== "");
  if (words.length === 0) return entries;
  return entries.filter((e) => {
    const title = e.title.toLowerCase();
    return words.every((w) => title.includes(w));
  });
}

function parseIndex(text: string): HelpIndexEntry[] {
  const out: HelpIndexEntry[] = [];
  for (const line of text.split("\n")) {
    const m = INDEX_LINE.exec(line.trim());
    if (m) out.push({ slug: m[2]!, title: m[1]!.trim() });
  }
  return out;
}

function parseArticle(slug: string, text: string): HelpArticle {
  const normal = text.replace(/\r\n/g, "\n");
  const fm = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normal);
  const front = fm?.[1] ?? "";
  const rest = fm ? fm[2]! : normal;
  const field = (key: string) => new RegExp(`^\\s*${key}:\\s*(.+)$`, "m").exec(front)?.[1]?.trim().replace(/^"(.*)"$/, "$1");
  const body = rest
    .split("\n")
    .filter((l) => !IMAGE_LINE.test(l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return {
    slug,
    title: field("title") ?? slug,
    lastUpdated: field("last_updated"),
    url: field("canonical") ?? `${HELP_BASE}/${slug}`,
    deprioritized: field("chatbot_deprioritize") === "true",
    body,
  };
}

export function createHelpClient(opts: { fetch?: typeof fetch; now?: () => number; ttlMs?: number; timeoutMs?: number; maxBytes?: number } = {}): HelpClient {
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? 3_600_000;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const maxBytes = opts.maxBytes ?? 500_000;
  const cache = new Map<string, { at: number; text: string }>();

  async function get(path: string): Promise<string> {
    const hit = cache.get(path);
    if (hit && now() - hit.at < ttlMs) return hit.text;
    const url = `${HELP_BASE}/${path}`;
    let res: Response;
    try {
      res = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "text/markdown, text/plain" } });
    } catch {
      throw new HelpError(`Fiken's help (${url}) did not answer.`);
    }
    if (res.url && new URL(res.url).hostname !== HOST) throw new HelpError(`Refusing a redirect outside hjelp.fiken.no (${res.url}).`);
    if (res.status === 404) throw new HelpError(`No help article at ${url}. Find the right slug with fiken_help_index.`);
    if (!res.ok) throw new HelpError(`Fiken's help answered ${res.status} for ${url}.`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new HelpError(`The help page ${url} is too large (${bytes.byteLength} bytes).`);
    const text = new TextDecoder().decode(bytes);
    cache.set(path, { at: now(), text });
    return text;
  }

  return {
    async index() {
      return parseIndex(await get("llms.txt"));
    },
    async article(slug) {
      if (!SLUG.test(slug)) throw new HelpError(`"${slug}" is not a help article slug (a-z, 0-9, -). Find it with fiken_help_index.`);
      return parseArticle(slug, await get(`${slug}.md`));
    },
  };
}
