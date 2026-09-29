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

  it("list sends only defined query params and reads the total from Fiken's header", async () => {
    const { fetchImpl, calls } = fakeFetch([
      () => new Response(JSON.stringify([{ a: 1 }]), { status: 200, headers: { "content-type": "application/json", "Fiken-Api-Result-Count": "42" } }),
    ]);
    const client = createFikenClient({ baseUrl: "https://api.test/v2", accessToken: "tok", fetch: fetchImpl, queue: new FikenQueue(0) });
    const p = client.list<{ a: number }>("/companies/x/projects", { page: 0, pageSize: 25, completed: false, name: undefined });
    await vi.runAllTimersAsync();
    expect(await p).toEqual({ items: [{ a: 1 }], total: 42 });
    expect(calls[0]?.url).toBe("https://api.test/v2/companies/x/projects?page=0&pageSize=25&completed=false");
  });

  it("create posts json and returns the id from the Location header", async () => {
    const { fetchImpl, calls } = fakeFetch([
      () => new Response(null, { status: 201, headers: { Location: "https://api.fiken.no/api/v2/companies/x/purchases/2888156" } }),
    ]);
    const client = createFikenClient({ baseUrl: "https://api.test/v2", accessToken: "tok", fetch: fetchImpl, queue: new FikenQueue(0) });
    const p = client.create("/companies/x/purchases", { kind: "cash_purchase" });
    await vi.runAllTimersAsync();
    expect(await p).toEqual({ id: 2888156, location: "https://api.fiken.no/api/v2/companies/x/purchases/2888156" });
    expect(calls[0]?.init?.method).toBe("POST");
    expect(new Headers(calls[0]?.init?.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ kind: "cash_purchase" });
  });

  it("create accepts a trailing slash in Location and refuses a non-numeric id", async () => {
    const { fetchImpl } = fakeFetch([
      () => new Response(null, { status: 201, headers: { Location: "https://api.fiken.no/api/v2/companies/x/purchases/2888156/" } }),
      () => new Response(null, { status: 201, headers: { Location: "https://api.fiken.no/api/v2/companies/x/purchases/abc" } }),
    ]);
    const client = createFikenClient({ baseUrl: "https://api.test/v2", accessToken: "tok", fetch: fetchImpl, queue: new FikenQueue(0) });
    const ok = client.create("/companies/x/purchases", {});
    await vi.runAllTimersAsync();
    expect((await ok).id).toBe(2888156);
    const bad = client.create("/companies/x/purchases", {});
    bad.catch(() => {}); // Suppress unhandled rejection
    await vi.runAllTimersAsync();
    await expect(bad).rejects.toMatchObject({ status: 502 });
  });

  it("create fails loudly without a Location header and on a 4xx", async () => {
    const { fetchImpl } = fakeFetch([
      () => new Response(null, { status: 201 }),
      () => new Response("bad request", { status: 400 }),
    ]);
    const client = createFikenClient({ baseUrl: "https://api.test/v2", accessToken: "tok", fetch: fetchImpl, queue: new FikenQueue(0) });
    const p1 = client.create("/companies/x/purchases", {});
    p1.catch(() => {}); // Suppress unhandled rejection
    await vi.runAllTimersAsync();
    await expect(p1).rejects.toMatchObject({ status: 502, body: expect.stringContaining("most likely created. Do not repeat it") });
    const p2 = client.create("/companies/x/purchases", {});
    p2.catch(() => {}); // Suppress unhandled rejection
    await vi.runAllTimersAsync();
    await expect(p2).rejects.toMatchObject({ status: 400, body: "bad request" });
  });

  it("attach resolves on a 2xx with or without Location and throws on a refusal", async () => {
    const { fetchImpl, calls } = fakeFetch([
      () => new Response(null, { status: 201 }),
      () => new Response("no", { status: 400 }),
    ]);
    const writes: string[] = [];
    const client = createFikenClient({ baseUrl: "https://api.test/v2", accessToken: "tok", fetch: fetchImpl, queue: new FikenQueue(0), onWrite: () => writes.push("w") });
    const ok = client.attach("/companies/x/sales/1/attachments", new FormData(), { inboxDocumentId: 7 });
    await vi.runAllTimersAsync();
    await expect(ok).resolves.toBeUndefined();
    expect(calls[0]?.url).toBe("https://api.test/v2/companies/x/sales/1/attachments?inboxDocumentId=7");
    expect(writes).toEqual(["w"]);
    const bad = client.attach("/companies/x/sales/1/attachments", new FormData());
    bad.catch(() => {});
    await vi.runAllTimersAsync();
    await expect(bad).rejects.toMatchObject({ status: 400, body: "no" });
  });

  it("upload posts multipart form data untouched and appends query params", async () => {
    const { fetchImpl, calls } = fakeFetch([
      () => new Response(null, { status: 201, headers: { Location: "https://api.fiken.no/api/v2/companies/x/inbox/1234134" } }),
    ]);
    const client = createFikenClient({ baseUrl: "https://api.test/v2", accessToken: "tok", fetch: fetchImpl, queue: new FikenQueue(0) });
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), "r.png");
    const p = client.upload("/companies/x/purchases/1/attachments", form, { inboxDocumentId: 7 });
    await vi.runAllTimersAsync();
    expect(await p).toEqual({ id: 1234134, location: "https://api.fiken.no/api/v2/companies/x/inbox/1234134" });
    expect(calls[0]?.url).toBe("https://api.test/v2/companies/x/purchases/1/attachments?inboxDocumentId=7");
    expect(calls[0]?.init?.body).toBe(form);
    expect(new Headers(calls[0]?.init?.headers).has("content-type")).toBe(false);
  });

  it("upload tolerates a UUID Location (attachments) and still fails without any Location", async () => {
    const { fetchImpl } = fakeFetch([
      () => new Response(null, { status: 201, headers: { Location: "https://api.fiken.no/api/v2/companies/x/purchases/1/attachments/745b2f15-1234-4408-8bf2-b1d2d7610cb2" } }),
      () => new Response(null, { status: 201 }),
    ]);
    const client = createFikenClient({ baseUrl: "https://api.test/v2", accessToken: "tok", fetch: fetchImpl, queue: new FikenQueue(0) });
    const ok = client.upload("/companies/x/purchases/1/attachments", new FormData(), { inboxDocumentId: 7 });
    await vi.runAllTimersAsync();
    expect(await ok).toEqual({ id: undefined, location: "https://api.fiken.no/api/v2/companies/x/purchases/1/attachments/745b2f15-1234-4408-8bf2-b1d2d7610cb2" });
    const bad = client.upload("/companies/x/purchases/1/attachments", new FormData());
    bad.catch(() => {}); // Suppress unhandled rejection
    await vi.runAllTimersAsync();
    await expect(bad).rejects.toMatchObject({ status: 502 });
  });

  it("reports successful writes through onWrite, and only those", async () => {
    vi.useRealTimers(); // the queue's gap sleep would never fire under the describe's fake timers
    let writes = 0;
    const answers: Record<string, Response> = {};
    const client = createFikenClient({
      baseUrl: "https://api.test/v2",
      accessToken: "tok",
      queue: new FikenQueue(0),
      onWrite: () => { writes++; },
      fetch: async (input, init) => {
        const key = `${init?.method ?? "GET"} ${String(input)}`;
        return answers[key] ?? new Response("nope", { status: 500 });
      },
    });
    answers["GET https://api.test/v2/companies"] = Response.json([]);
    await client.json("/companies");
    expect(writes).toBe(0);
    answers["POST https://api.test/v2/companies/demo/contacts"] = new Response(null, { status: 201, headers: { location: "https://api.test/v2/companies/demo/contacts/5" } });
    await client.create("/companies/demo/contacts", { name: "x" });
    expect(writes).toBe(1);
    answers["POST https://api.test/v2/companies/demo/sales"] = new Response("bad", { status: 400 });
    await expect(client.create("/companies/demo/sales", {})).rejects.toThrow();
    expect(writes).toBe(1);
  });

  it("send posts JSON and resolves without a Location; a refusal throws", async () => {
    vi.useRealTimers();
    const seen: Array<{ url: string; body: unknown }> = [];
    const client = createFikenClient({
      baseUrl: "https://api.test/v2", accessToken: "tok", queue: new FikenQueue(0),
      fetch: async (input, init) => {
        seen.push({ url: String(input), body: JSON.parse(String(init?.body)) });
        return String(input).endsWith("/send") ? new Response(null, { status: 200 }) : new Response("nei", { status: 400 });
      },
    });
    await client.send("/companies/demo/invoices/send", { invoiceId: 77 });
    expect(seen[0]).toEqual({ url: "https://api.test/v2/companies/demo/invoices/send", body: { invoiceId: 77 } });
    await expect(client.send("/companies/demo/other", {})).rejects.toMatchObject({ status: 400 });
  });

  it("patch sends PATCH with an optional body, resolves on 2xx and throws otherwise", async () => {
    vi.useRealTimers();
    const seen: Array<{ url: string; method: string | undefined; body: unknown }> = [];
    let writes = 0;
    const client = createFikenClient({
      baseUrl: "https://api.test/v2", accessToken: "tok", queue: new FikenQueue(0), onWrite: () => { writes++; },
      fetch: async (input, init) => {
        seen.push({ url: String(input), method: init?.method, body: init?.body });
        return String(input).endsWith("/settled") ? new Response(null, { status: 200 }) : new Response("nei", { status: 400 });
      },
    });
    await client.patch("/companies/demo/sales/9/settled");
    expect(seen[0]).toEqual({ url: "https://api.test/v2/companies/demo/sales/9/settled", method: "PATCH", body: undefined });
    await expect(client.patch("/companies/demo/sales/9/writeOff", { type: "x" })).rejects.toMatchObject({ status: 400 });
    expect(seen[1]?.body).toBe(JSON.stringify({ type: "x" }));
    expect(writes).toBe(1);
  });

  it("put sends PUT with a JSON body, resolves on 2xx and throws otherwise", async () => {
    vi.useRealTimers();
    const seen: Array<{ url: string; method: string | undefined; body: unknown }> = [];
    let writes = 0;
    const client = createFikenClient({
      baseUrl: "https://api.test/v2", accessToken: "tok", queue: new FikenQueue(0), onWrite: () => { writes++; },
      fetch: async (input, init) => {
        seen.push({ url: String(input), method: init?.method, body: init?.body });
        return String(input).endsWith("/products/3") ? new Response(null, { status: 200 }) : new Response("nei", { status: 400 });
      },
    });
    await client.put("/companies/demo/products/3", { name: "Spade" });
    expect(seen[0]).toEqual({ url: "https://api.test/v2/companies/demo/products/3", method: "PUT", body: JSON.stringify({ name: "Spade" }) });
    await expect(client.put("/companies/demo/products/4", {})).rejects.toMatchObject({ status: 400 });
    expect(writes).toBe(1);
  });

  it("send reports onWrite once on success and not on a refusal", async () => {
    vi.useRealTimers();
    let writes = 0;
    const client = createFikenClient({
      baseUrl: "https://api.test/v2", accessToken: "tok", queue: new FikenQueue(0),
      onWrite: () => { writes++; },
      fetch: async (input) => (String(input).endsWith("/send") ? new Response(null, { status: 200 }) : new Response("nei", { status: 400 })),
    });
    await client.send("/companies/demo/invoices/send", {});
    expect(writes).toBe(1);
    await expect(client.send("/companies/demo/other", {})).rejects.toThrow();
    expect(writes).toBe(1);
  });

  it("download only talks to the Fiken API host and caps the size", async () => {
    vi.useRealTimers();
    const urls: string[] = [];
    const client = createFikenClient({
      baseUrl: "https://api.test/v2", accessToken: "tok", queue: new FikenQueue(0),
      fetch: async (input, init) => {
        urls.push(String(input));
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer tok");
        if (String(input).endsWith("/big")) return new Response("x", { headers: { "content-length": String(11 * 1024 * 1024) } });
        return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "application/pdf" } });
      },
    });
    expect(await client.download("https://api.test/v2/files/abc")).toEqual({ bytes: new Uint8Array([1, 2, 3]), contentType: "application/pdf" });
    expect(await client.download("/files/abc")).toMatchObject({ contentType: "application/pdf" });
    await expect(client.download("https://evil.example/v2/files/abc")).rejects.toMatchObject({ status: 400 });
    await expect(client.download("https://api.test.evil.example/files/abc")).rejects.toMatchObject({ status: 400 });
    await expect(client.download("https://api.test/v2files/abc")).rejects.toMatchObject({ status: 400 });
    await expect(client.download("//evil.example/files/abc")).rejects.toMatchObject({ status: 400 });
    await expect(client.download("https://api.test/v2/big")).rejects.toMatchObject({ status: 413 });
    expect(urls).toEqual(["https://api.test/v2/files/abc", "https://api.test/v2/files/abc", "https://api.test/v2/big"]);
  });

  it("download also takes Fiken's file host, fetched as is, and nothing near it", async () => {
    vi.useRealTimers();
    const seen: Array<{ url: string; auth: string | null }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      seen.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
      return new Response(new Uint8Array([4]), { headers: { "content-type": "image/png" } });
    };
    const client = createFikenClient({ baseUrl: "https://api.test/v2", fileBaseUrl: "https://files.test/v2", accessToken: "tok", queue: new FikenQueue(0), fetch: fetchImpl });
    expect(await client.download("https://files.test/v2/files/abc")).toEqual({ bytes: new Uint8Array([4]), contentType: "image/png" });
    await expect(client.download("https://files.test/v2files/abc")).rejects.toMatchObject({ status: 400 });
    await expect(client.download("https://files.test.evil.example/v2/files/abc")).rejects.toMatchObject({ status: 400 });
    await expect(client.download("https://files.test/other/abc")).rejects.toMatchObject({ status: 400 });
    expect(seen).toEqual([{ url: "https://files.test/v2/files/abc", auth: "Bearer tok" }]);

    const noFileHost = createFikenClient({ baseUrl: "https://api.test/v2", accessToken: "tok", queue: new FikenQueue(0), fetch: fetchImpl });
    await expect(noFileHost.download("https://files.test/v2/files/abc")).rejects.toMatchObject({ status: 400 });
    expect(seen).toHaveLength(1);
  });
});
