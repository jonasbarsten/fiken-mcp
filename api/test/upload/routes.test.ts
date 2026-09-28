import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { testConfig } from "../../src/config.js";
import { issueUploadTicket } from "../../src/upload/ticket.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
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
  const ticket = issueUploadTicket(cfg, { fikenAccessToken: "FA", anonId: "anon" }, "demo");
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

  it("refuses a missing, wrong or expired ticket before reading the body, and takes the ticket from the query for curl", async () => {
    const { app, cfg, calls } = setup();
    expect((await upload(app, PNG, { "content-type": "image/png" })).status).toBe(401);
    expect((await upload(app, PNG, { "x-ticket": "garbage", "content-type": "image/png" })).status).toBe(401);
    const expired = issueUploadTicket(cfg, { fikenAccessToken: "FA", anonId: "anon" }, "demo", 1);
    expect((await upload(app, PNG, { "x-ticket": expired, "content-type": "image/png" })).status).toBe(401);
    expect(calls).toHaveLength(0);
    const viaQuery = await upload(app, PNG, { "content-type": "image/png", "x-filename": "r.png" }, `?ticket=${encodeURIComponent(issueUploadTicket(cfg, { fikenAccessToken: "FA", anonId: "anon" }, "demo"))}`);
    expect(viaQuery.status).toBe(201);
  });

  it("refuses unsupported types, empty and oversized bodies without calling Fiken", async () => {
    const { app, calls, ticket } = setup();
    expect((await upload(app, new TextEncoder().encode("<html>"), { "x-ticket": ticket, "x-filename": "x.png", "content-type": "image/png" })).status).toBe(415);
    expect((await upload(app, null, { "x-ticket": ticket, "content-type": "image/png" })).status).toBe(400);
    const big = new Uint8Array(4.5 * 1024 * 1024 + 1);
    big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const res = await upload(app, big, { "x-ticket": ticket, "content-type": "image/png" });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: "too_large" });
    expect(calls).toHaveLength(0);
  });

  it("maps a Fiken failure to 502 without the token and never logs the file", async () => {
    const cfg = testConfig({ fetch: async () => new Response("inbox is full BEARER-FA", { status: 400 }) });
    const app = createApp(cfg);
    const ticket = issueUploadTicket(cfg, { fikenAccessToken: "FA", anonId: "anon" }, "demo");
    const res = await upload(app, PNG, { "x-ticket": ticket, "x-filename": "r.png", "content-type": "image/png" });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "fiken", status: 400, message: "inbox is full BEARER-FA" });
  });
});
