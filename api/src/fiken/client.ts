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
  upload(path: string, form: FormData, query?: Query): Promise<{ id: number; location: string }>;
}

function withQuery(path: string, query: Query = {}): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined) params.set(k, String(v));
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

function locatedId(res: Response): { id: number; location: string } {
  const location = res.headers.get("location");
  const id = Number(location?.split("/").pop());
  if (!location || !Number.isInteger(id)) throw new FikenError(502, "no Location header");
  return { id, location };
}

export function createFikenClient(opts: { baseUrl: string; accessToken: string; fetch: typeof fetch; queue?: FikenQueue }): FikenClient {
  const queue = opts.queue ?? globalQueue;

  async function once(path: string, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${opts.accessToken}`);
    if (!headers.has("accept")) headers.set("accept", "application/json");
    return opts.fetch(`${opts.baseUrl}${path}`, { ...init, headers });
  }

  const doFetch = (path: string, init?: RequestInit) =>
    queue.run(async () => {
      const first = await once(path, init);
      if (first.status !== 429) return first;
      await sleep(1000);
      return once(path, init);
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
    async upload(path: string, form: FormData, query?: Query) {
      const res = await doFetch(withQuery(path, query), { method: "POST", body: form });
      if (!res.ok) throw new FikenError(res.status, await res.text());
      return locatedId(res);
    },
  };
}
