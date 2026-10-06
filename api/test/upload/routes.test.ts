import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { testConfig } from "../../src/config.js";
import { issueUploadTicket } from "../../src/upload/ticket.js";

/** A run of bytes distinctive enough that we would spot it in any log line. */
const MARKER = "RECEIPT-BYTES-MARKER";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new TextEncoder().encode(MARKER)]);

/** Session claims for a ticket: an hour of life left unless a test says otherwise. */
const claims = (fikenAccessToken = "FA") => ({ fikenAccessToken, anonId: "anon", exp: Math.floor(Date.now() / 1000) + 3600 });

function captureStdout() {
  const lines: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  return { lines };
}

function setup() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const cfg = testConfig({
    fetch: async (input, init) => {
      calls.push({ url: String(input), init });
      if (String(input).endsWith("/companies/demo/inbox")) return new Response(null, { status: 201, headers: { Location: "https://api.fiken.no/api/v2/companies/demo/inbox/1234134" } });
      return new Response("nope", { status: 500 });
    },
  });
  const app = createApp(cfg);
  const ticket = issueUploadTicket(cfg, claims(), "demo");
  return { app, cfg, calls, ticket };
}
const upload = (app: ReturnType<typeof createApp>, body: BodyInit | null, headers: Record<string, string>, query = "") =>
  app.request(`/upload${query}`, { method: "POST", headers, body });

describe("POST /upload", () => {
  it("forwards a valid file to the Fiken inbox as multipart and returns the document id", async () => {
    const { app, calls, ticket } = setup();
    const res = await upload(app, PNG, { "x-ticket": ticket, "x-filename": "kvittering.png", "content-type": "image/png", origin: "https://abc123.claudemcpcontent.com" });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ documentId: 1234134, name: "kvittering.png", size: PNG.length, type: "image/png" });
    expect(res.headers.get("access-control-allow-origin")).toBe("https://abc123.claudemcpcontent.com");
    const form = calls[0]?.init?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("filename")).toBe("kvittering.png");
    expect((form.get("file") as File).size).toBe(PNG.length);
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer FA");
  });

  it("decodes the percent-encoded filename the widget sends before sanitising it", async () => {
    const { app, ticket } = setup();
    const res = await upload(app, PNG, { "x-ticket": ticket, "x-filename": "kvittering%20(1).png", "content-type": "image/png" });
    expect(res.status).toBe(201);
    const name = (await res.json()).name;
    expect(name).toBe("kvittering1.png");
    expect(name).not.toContain("%20");
  });

  it("keeps a filename that is not valid percent-encoding instead of rejecting the upload", async () => {
    const { app, ticket } = setup();
    const res = await upload(app, PNG, { "x-ticket": ticket, "x-filename": "100%-kvittering.png", "content-type": "image/png" });
    expect(res.status).toBe(201);
    expect((await res.json()).name).toBe("100-kvittering.png");
  });

  it("answers the CORS preflight for the widget origin only", async () => {
    const { app } = setup();
    const ok = await app.request("/upload", { method: "OPTIONS", headers: { origin: "https://abc123.claudemcpcontent.com", "access-control-request-method": "POST", "access-control-request-headers": "x-ticket,x-filename" } });
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://abc123.claudemcpcontent.com");
    expect(ok.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("x-ticket");
    const bad = await app.request("/upload", { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("answers the CORS preflight for ChatGPT's widget sandbox too, and not for look-alikes", async () => {
    const { app } = setup();
    const preflight = (origin: string) =>
      app.request("/upload", { method: "OPTIONS", headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "x-ticket" } });
    const chatgpt = "https://fiken-mcp-abc.web-sandbox.oaiusercontent.com";
    expect((await preflight(chatgpt)).headers.get("access-control-allow-origin")).toBe(chatgpt);
    for (const bad of ["https://web-sandbox.oaiusercontent.com.evil.example", "https://evil.example/x.web-sandbox.oaiusercontent.com", "http://a.web-sandbox.oaiusercontent.com"]) {
      expect((await preflight(bad)).headers.get("access-control-allow-origin"), bad).toBeNull();
    }
  });

  it("refuses a missing, wrong or expired ticket before reading the body, and ignores a ticket in the query", async () => {
    const { app, cfg, calls } = setup();
    expect((await upload(app, PNG, { "content-type": "image/png" })).status).toBe(401);
    expect((await upload(app, PNG, { "x-ticket": "garbage", "content-type": "image/png" })).status).toBe(401);
    const expired = issueUploadTicket(cfg, claims(), "demo", 1);
    expect((await upload(app, PNG, { "x-ticket": expired, "content-type": "image/png" })).status).toBe(401);
    // The ticket only travels in a header, so it stays out of access logs and history.
    const viaQuery = await upload(app, PNG, { "content-type": "image/png", "x-filename": "r.png" }, `?ticket=${encodeURIComponent(issueUploadTicket(cfg, claims(), "demo"))}`);
    expect(viaQuery.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("refuses unsupported types, empty and oversized bodies without calling Fiken", async () => {
    const { app, calls, ticket } = setup();
    expect((await upload(app, new TextEncoder().encode("<html>"), { "x-ticket": ticket, "x-filename": "x.png", "content-type": "image/png" })).status).toBe(415);
    expect((await upload(app, null, { "x-ticket": ticket, "content-type": "image/png" })).status).toBe(400);
    const big = new Uint8Array(4 * 1024 * 1024 + 1);
    big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const res = await upload(app, big, { "x-ticket": ticket, "content-type": "image/png" });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: "too_large", limitBytes: 4 * 1024 * 1024 });
    expect(calls).toHaveLength(0);
  });

  it("answers a Fiken 401 as an expired ticket, so the widget tells the user to reopen the upload", async () => {
    const cfg = testConfig({ fetch: async () => new Response("token expired", { status: 401 }) });
    const app = createApp(cfg);
    const ticket = issueUploadTicket(cfg, claims(), "demo");
    const res = await upload(app, PNG, { "x-ticket": ticket, "x-filename": "r.png", "content-type": "image/png" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_ticket" });
  });

  it("relays Fiken's error body, truncated, as a 502", async () => {
    const cfg = testConfig({ fetch: async () => new Response(`inbox is full BEARER-FA ${"x".repeat(400)}`, { status: 400 }) });
    const app = createApp(cfg);
    const ticket = issueUploadTicket(cfg, claims("FIKEN-TOKEN-PLAINTEXT"), "demo");
    const out = captureStdout();
    const res = await upload(app, PNG, { "x-ticket": ticket, "x-filename": "r.png", "content-type": "image/png" });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toMatchObject({ error: "fiken", status: 400 });
    expect(body.message).toHaveLength(200);
    expect(body.message.startsWith("inbox is full BEARER-FA")).toBe(true);
    // The request log must carry neither the file's bytes nor any credential.
    const logged = out.lines.join("");
    expect(logged).not.toContain(MARKER);
    expect(logged).not.toContain("Bearer");
    expect(logged).not.toContain("FIKEN-TOKEN-PLAINTEXT");
    expect(logged).not.toContain(ticket);
  });
});
