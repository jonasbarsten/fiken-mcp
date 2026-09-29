export class FikenError extends Error {
  constructor(public readonly status: number, public readonly body: string) {
    super(`Fiken ${status}`);
    this.body = body.slice(0, 500);
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Serialises calls: the next one starts `gapMs` after the previous one settled. */
export class FikenQueue {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly gapMs = 300) {}

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.then(
      () => sleep(this.gapMs),
      () => sleep(this.gapMs),
    );
    return result;
  }
}

export const globalQueue = new FikenQueue(300);

export type Query = Record<string, string | number | boolean | undefined>;

export interface FikenClient {
  fetch(path: string, init?: RequestInit): Promise<Response>;
  json<T>(path: string, init?: RequestInit): Promise<T>;
  list<T>(path: string, query?: Query): Promise<{ items: T[]; total: number | undefined }>;
  create(path: string, body: unknown, query?: Query): Promise<{ id: number; location: string }>;
  /** POST JSON to an action endpoint that answers 2xx without a Location. */
  send(path: string, body: unknown): Promise<void>;
  /** Location of the created resource; `id` only when its last path segment is numeric (inbox documents yes, attachments carry a UUID). */
  upload(path: string, form: FormData, query?: Query): Promise<{ id: number | undefined; location: string }>;
  /**
   * Fetches a file from Fiken's API, with the user's token. Takes an absolute URL under `baseUrl/` or a path
   * starting with a single `/`; anything else is refused before any request, so the token never leaves Fiken.
   */
  download(url: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; contentType: string | null }>;
}

export const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;

function withQuery(path: string, query: Query = {}): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined) params.set(k, String(v));
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

function locatedId(res: Response): { id: number; location: string } {
  const location = res.headers.get("location");
  const m = location ? /\/(\d+)\/?$/.exec(location) : null;
  if (!location || !m) throw new FikenError(502, "Location header missing or without a numeric id");
  return { id: Number(m[1]), location };
}

export function createFikenClient(opts: { baseUrl: string; accessToken: string; fetch: typeof fetch; queue?: FikenQueue; onWrite?: () => void }): FikenClient {
  const queue = opts.queue ?? globalQueue;

  async function once(path: string, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${opts.accessToken}`);
    if (!headers.has("accept")) headers.set("accept", "application/json");
    return opts.fetch(`${opts.baseUrl}${path}`, { ...init, headers });
  }

  const doFetch = (path: string, init?: RequestInit) =>
    queue.run(async () => {
      let res = await once(path, init);
      if (res.status === 429) {
        await sleep(1000);
        res = await once(path, init);
      }
      if (res.ok && (init?.method ?? "GET").toUpperCase() !== "GET") opts.onWrite?.();
      return res;
    });

  return {
    fetch: doFetch,
    async json<T>(path: string, init?: RequestInit): Promise<T> {
      const res = await doFetch(path, init);
      if (!res.ok) throw new FikenError(res.status, await res.text());
      return (await res.json()) as T;
    },
    async list<T>(path: string, query?: Query) {
      const res = await doFetch(withQuery(path, query));
      if (!res.ok) throw new FikenError(res.status, await res.text());
      const count = res.headers.get("fiken-api-result-count");
      return { items: (await res.json()) as T[], total: count === null ? undefined : Number(count) };
    },
    async create(path: string, body: unknown, query?: Query) {
      const res = await doFetch(withQuery(path, query), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new FikenError(res.status, await res.text());
      return locatedId(res);
    },
    async send(path: string, body: unknown) {
      const res = await doFetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new FikenError(res.status, await res.text());
    },
    async upload(path: string, form: FormData, query?: Query) {
      const res = await doFetch(withQuery(path, query), { method: "POST", body: form });
      if (!res.ok) throw new FikenError(res.status, await res.text());
      const location = res.headers.get("location");
      if (!location) throw new FikenError(502, "Location header missing");
      const m = /\/(\d+)\/?$/.exec(location);
      return { id: m ? Number(m[1]) : undefined, location };
    },
    async download(url: string) {
      // The trailing "/" keeps "https://api.test/v2files" and "https://api.test.evil.example" out;
      // "//host/..." is protocol-relative, so it counts as a foreign absolute URL.
      let path: string;
      if (url.startsWith(`${opts.baseUrl}/`)) path = url.slice(opts.baseUrl.length);
      else if (url.startsWith("/") && !url.startsWith("//")) path = url;
      else throw new FikenError(400, "refusing to fetch a URL outside the Fiken API");
      const res = await doFetch(path, { headers: { accept: "*/*" } });
      if (!res.ok) throw new FikenError(res.status, await res.text());
      const tooLarge = () => new FikenError(413, "document larger than 10 MB");
      if (Number(res.headers.get("content-length") ?? 0) > MAX_DOWNLOAD_BYTES) throw tooLarge();
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength > MAX_DOWNLOAD_BYTES) throw tooLarge();
      return { bytes, contentType: res.headers.get("content-type") };
    },
  };
}
