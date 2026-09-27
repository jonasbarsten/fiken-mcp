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

export interface FikenClient {
  fetch(path: string, init?: RequestInit): Promise<Response>;
  json<T>(path: string, init?: RequestInit): Promise<T>;
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
  };
}
