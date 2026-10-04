import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { testConfig } from "../../src/config.js";
import { issueViewTicket } from "../../src/document/ticket.js";
import { issueUploadTicket } from "../../src/upload/ticket.js";

/** A run of bytes distinctive enough that we would spot it in any log line. */
const MARKER = "DOCUMENT-BYTES-MARKER";
const enc = (s: string) => new TextEncoder().encode(s);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...enc(MARKER)]);
const PDF = new Uint8Array([...enc("%PDF-1.7\n"), ...enc(MARKER)]);
const FILE = "https://fiken.test/api/v2/files/abc";
const ORIGIN = "https://abc123.claudemcpcontent.com";

const claims = (fikenAccessToken = "FIKEN-TOKEN-PLAINTEXT") => ({ fikenAccessToken, anonId: "anon", exp: Math.floor(Date.now() / 1000) + 3600 });

function captureStdout() {
  const lines: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  return { lines };
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** A Fiken whose file host answers `body` (with `status`) and records every request. */
function setup(body: BodyInit | null = PNG, status = 200, headers: Record<string, string> = { "content-type": "application/octet-stream" }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const cfg = testConfig({
    fetch: async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(body, { status, headers });
    },
  });
  return { app: createApp(cfg), cfg, calls };
}

const get = (app: ReturnType<typeof createApp>, ticket: string | undefined, query = "") =>
  app.request(`/document${query}`, { headers: { origin: ORIGIN, ...(ticket === undefined ? {} : { "x-ticket": ticket }) } });

describe("GET /document", () => {
  it("downloads only the sealed file URL with the sealed token and answers it as an uncached PNG", async () => {
    const { app, cfg, calls } = setup();
    const res = await get(app, issueViewTicket(cfg, claims(), FILE));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
    expect(calls.map((c) => c.url)).toEqual([FILE]);
    expect(new Headers(calls[0]!.init?.headers).get("authorization")).toBe("Bearer FIKEN-TOKEN-PLAINTEXT");
  });

  it("types the answer by magic bytes, not by what Fiken claims", async () => {
    const { app, cfg } = setup(PDF, 200, { "content-type": "text/html" });
    const res = await get(app, issueViewTicket(cfg, claims(), FILE));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
  });

  it("refuses anything that is not a PNG, JPEG, GIF or PDF", async () => {
    const { app, cfg } = setup(enc("<html><script>alert(1)</script>"), 200, { "content-type": "image/png" });
    const res = await get(app, issueViewTicket(cfg, claims(), FILE));
    expect(res.status).toBe(415);
    expect(await res.text()).toBe("");
  });

  it("answers 401 with no detail for a missing, garbage, expired or upload ticket, before calling Fiken", async () => {
    const { app, cfg, calls } = setup();
    for (const ticket of [undefined, "", "garbage", issueViewTicket(cfg, claims(), FILE, 1), issueUploadTicket(cfg, claims(), "demo")]) {
      const res = await get(app, ticket);
      expect(res.status).toBe(401);
      expect(await res.text()).toBe("");
    }
    expect(calls).toHaveLength(0);
  });

  it("ignores a ticket in the query string, and never fetches a URL from it", async () => {
    const { app, cfg, calls } = setup();
    const ticket = encodeURIComponent(issueViewTicket(cfg, claims(), FILE));
    expect((await get(app, undefined, `?ticket=${ticket}`)).status).toBe(401);
    const res = await get(app, issueViewTicket(cfg, claims(), FILE), "?url=https%3A%2F%2Fevil.example%2Fx&fileUrl=https%3A%2F%2Fevil.example%2Fx");
    expect(res.status).toBe(200);
    expect(calls.map((c) => c.url)).toEqual([FILE]);
  });

  it("never sends the token outside Fiken, even for a sealed URL", async () => {
    const { app, cfg, calls } = setup();
    const res = await get(app, issueViewTicket(cfg, claims(), "https://evil.example/x"));
    expect(res.status).toBe(502);
    expect(calls).toHaveLength(0);
  });

  it("passes on a Fiken 404 as 404 and a Fiken 401 as 401, without Fiken's body", async () => {
    for (const status of [404, 401]) {
      const { app, cfg } = setup(enc("secret detail from Fiken"), status, { "content-type": "text/plain" });
      const res = await get(app, issueViewTicket(cfg, claims(), FILE));
      expect(res.status).toBe(status);
      expect(await res.text()).toBe("");
    }
  });

  it("refuses a file too large for a Lambda response", async () => {
    const big = new Uint8Array(4 * 1024 * 1024 + 1);
    big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const { app, cfg } = setup(big);
    expect((await get(app, issueViewTicket(cfg, claims(), FILE))).status).toBe(413);
  });

  it("answers the CORS preflight for the widget origin only", async () => {
    const { app } = setup();
    const ok = await app.request("/document", { method: "OPTIONS", headers: { origin: ORIGIN, "access-control-request-method": "GET", "access-control-request-headers": "x-ticket" } });
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(ok.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("x-ticket");
    const bad = await app.request("/document", { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "GET" } });
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("logs neither the ticket, the token nor the file", async () => {
    const { app, cfg } = setup();
    const ticket = issueViewTicket(cfg, claims(), FILE);
    const out = captureStdout();
    expect((await get(app, ticket)).status).toBe(200);
    expect((await get(app, "garbage")).status).toBe(401);
    const logged = out.lines.join("");
    expect(logged).toContain('"route":"/document"');
    expect(logged).not.toContain(ticket);
    expect(logged).not.toContain(MARKER);
    expect(logged).not.toContain("FIKEN-TOKEN-PLAINTEXT");
    expect(logged).not.toContain("files/abc");
  });
});
