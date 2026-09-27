import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FikenError, FikenQueue, createFikenClient } from "../../src/fiken/client.js";

function fakeFetch(responses: Array<() => Response>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    return next();
  };
  return { fetchImpl, calls };
}

describe("createFikenClient", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("prefixes the base url and sends the bearer token", async () => {
    const { fetchImpl, calls } = fakeFetch([() => Response.json([{ slug: "a" }])]);
    const client = createFikenClient({ baseUrl: "https://api.test/v2", accessToken: "tok", fetch: fetchImpl, queue: new FikenQueue(0) });
    const p = client.json<unknown[]>("/companies");
    await vi.runAllTimersAsync();
    expect(await p).toEqual([{ slug: "a" }]);
    expect(calls[0]?.url).toBe("https://api.test/v2/companies");
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer tok");
  });

  it("throws FikenError with status and body on non-2xx", async () => {
    const { fetchImpl } = fakeFetch([() => new Response("nope", { status: 404 })]);
    const client = createFikenClient({ baseUrl: "https://api.test/v2", accessToken: "tok", fetch: fetchImpl, queue: new FikenQueue(0) });
    const p = client.json("/companies/x");
    p.catch(() => {}); // Suppress unhandled rejection
    await vi.runAllTimersAsync();
    try {
      await p;
      expect.fail("should have thrown");
    } catch (err: any) {
      expect(err).toMatchObject({ status: 404, body: "nope" });
      expect(err).toBeInstanceOf(FikenError);
    }
  });

  it("retries once on 429 after one second", async () => {
    const { fetchImpl, calls } = fakeFetch([
      () => new Response("slow down", { status: 429 }),
      () => Response.json({ ok: true }),
    ]);
    const client = createFikenClient({ baseUrl: "https://api.test/v2", accessToken: "tok", fetch: fetchImpl, queue: new FikenQueue(0) });
    const p = client.json("/companies");
    await vi.advanceTimersByTimeAsync(999);
    expect(calls.length).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.runAllTimersAsync();
    expect(await p).toEqual({ ok: true });
    expect(calls.length).toBe(2);
  });

  it("serialises calls through the queue with a gap", async () => {
    const order: string[] = [];
    const queue = new FikenQueue(300);
    const a = queue.run(async () => { order.push("a-start"); await new Promise((r) => setTimeout(r, 50)); order.push("a-end"); });
    const b = queue.run(async () => { order.push("b-start"); });
    await vi.advanceTimersByTimeAsync(50);
    expect(order).toEqual(["a-start", "a-end"]);
    await vi.advanceTimersByTimeAsync(299);
    expect(order).toEqual(["a-start", "a-end"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(order).toEqual(["a-start", "a-end", "b-start"]);
    await Promise.all([a, b]);
  });

  it("keeps the queue alive after a failure", async () => {
    const queue = new FikenQueue(0);
    await expect(queue.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    const p = queue.run(async () => 42);
    await vi.runAllTimersAsync();
    expect(await p).toBe(42);
  });
});
