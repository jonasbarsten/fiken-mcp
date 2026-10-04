import { readFileSync } from "node:fs";
import { describe, expect, it, vi, type Mock } from "vitest";
import { canvasScale, MAX_CANVAS_PIXELS, renderPager, showDocument, type DocumentDeps } from "../src/widget/document.mjs";
import { FakeEl } from "./fake-dom.js";
import { runPageScript } from "./page-script.js";

const doc = { createElement: (tag: string) => new FakeEl(tag) };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PDF = new TextEncoder().encode("%PDF-1.7\nrest");
const data = { documentUrl: "https://fiken-mcp.test/document", ticket: "v1e.t1.iv.sealed", filename: "<b>taxi</b>.png" };

const answer = (body: BodyInit | null, status = 200, type = "image/png") => async () => new Response(body, { status, headers: { "content-type": type } });

type MockDeps = { fetch: Mock; drawImage: Mock; renderPdf: Mock };

function deps(overrides: Partial<MockDeps> = {}) {
  const canvas = new FakeEl("canvas");
  const d: MockDeps = {
    fetch: vi.fn(answer(PNG)),
    drawImage: vi.fn(async () => canvas),
    renderPdf: vi.fn(async () => {}),
    ...overrides,
  };
  return { d, canvas };
}

async function show(overrides: Partial<MockDeps> = {}) {
  const root = new FakeEl("div");
  const { d, canvas } = deps(overrides);
  await showDocument(doc as never, root as never, data, d as unknown as DocumentDeps);
  const texts = root.all().map((e) => e.textContent);
  return { root, d, canvas, texts };
}

describe("document widget logic", () => {
  it("fetches the document URL with the ticket in a header and shows an image as the drawn canvas", async () => {
    const { root, d, canvas, texts } = await show();
    expect(d.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = d.fetch.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://fiken-mcp.test/document");
    expect(url).not.toContain("ticket");
    expect(new Headers(init.headers).get("x-ticket")).toBe("v1e.t1.iv.sealed");
    const blob = (d.drawImage.mock.calls[0] as unknown as [Blob])[0];
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(PNG);
    expect(root.all()).toContain(canvas);
    expect(texts).toContain("<b>taxi</b>.png");
    expect(texts).not.toContain("Henter dokumentet…");
    expect(d.renderPdf).not.toHaveBeenCalled();
  });

  it("hands a PDF's bytes to renderPdf with a container in the page", async () => {
    const { root, d } = await show({ fetch: vi.fn(answer(PDF, 200, "application/pdf")) });
    const [bytes, container] = d.renderPdf.mock.calls[0]! as unknown as [Uint8Array, FakeEl];
    expect(bytes).toEqual(PDF);
    expect(root.all()).toContain(container);
    expect(d.drawImage).not.toHaveBeenCalled();
  });

  it("says the document could not be fetched when the request fails or the route refuses it", async () => {
    for (const fetch of [vi.fn(async () => { throw new TypeError("network"); }), vi.fn(answer(null, 404)), vi.fn(answer(null, 502))]) {
      const { texts, d } = await show({ fetch });
      expect(texts).toContain("Kunne ikke hente dokumentet.");
      expect(d.drawImage).not.toHaveBeenCalled();
    }
  });

  it("tells the user to ask again when the ticket has expired, and that a huge file belongs in Fiken", async () => {
    expect((await show({ fetch: vi.fn(answer(null, 401)) })).texts).toContain("Visningen har utløpt. Be Claude om å vise dokumentet på nytt.");
    expect((await show({ fetch: vi.fn(answer(null, 413)) })).texts).toContain("Dokumentet er for stort til å vises her. Åpne det i Fiken.");
  });

  it("says the document could not be shown when rendering fails or the type is unknown", async () => {
    const failing = await show({ fetch: vi.fn(answer(PDF, 200, "application/pdf")), renderPdf: vi.fn(async () => { throw new Error("bad pdf"); }) });
    expect(failing.texts).toContain("Kunne ikke vise dokumentet.");
    expect((await show({ fetch: vi.fn(answer(PNG, 200, "text/html")) })).texts).toContain("Kunne ikke vise dokumentet.");
  });
});

describe("canvas scale", () => {
  it("renders at the target width times the device pixel ratio, at most 2x", () => {
    expect(canvasScale(600, 600, 800, 1)).toBe(1);
    expect(canvasScale(600, 300, 400, 2)).toBe(4);
    expect(canvasScale(600, 600, 800, 3)).toBe(2);
    expect(canvasScale(600, 600, 800, 0)).toBe(1);
    expect(canvasScale(600, 600, 800, Number.NaN)).toBe(1);
  });

  it("keeps the canvas at or under 16 million pixels", () => {
    for (const [w, h] of [[600, 60000], [10000, 10000], [5000, 4000], [612, 792 * 40]]) {
      const s = canvasScale(1200, w!, h!, 2);
      expect(w! * s * h! * s).toBeLessThanOrEqual(MAX_CANVAS_PIXELS);
      expect(s).toBeGreaterThan(0);
    }
    expect(MAX_CANVAS_PIXELS).toBe(16_000_000);
    // An image at its own size (dpr 1) that is too large is scaled down; a small one is left as is.
    expect(canvasScale(8000, 8000, 6000, 1)).toBeCloseTo(Math.sqrt(16_000_000 / 48_000_000));
    expect(canvasScale(800, 800, 600, 1)).toBe(1);
  });
});

describe("built page", () => {
  const html = readFileSync(new URL("../src/assets/document.html", import.meta.url), "utf8");
  it("destroys the previous pdf.js document before showing another, and sizes every canvas with canvasScale", () => {
    expect(html).toContain("currentPdf?.destroy()");
    expect(html.match(/canvasScale\(/g)!.length).toBeGreaterThanOrEqual(2);
  });
});

describe("PDF pager", () => {
  it("renders page 1, then moves with Forrige and Neste within the document", async () => {
    const root = new FakeEl("div");
    const rendered: number[] = [];
    const changes = vi.fn();
    await renderPager(doc as never, root as never, 3, async (n: number) => {
      rendered.push(n);
      const c = new FakeEl("canvas");
      c.textContent = `page ${n}`;
      return c;
    }, changes);
    const buttons = () => root.all().filter((e) => e.tag === "button");
    const [prev, next] = buttons();
    expect(prev!.textContent).toBe("Forrige");
    expect(next!.textContent).toBe("Neste");
    expect(rendered).toEqual([1]);
    expect(root.all().some((e) => e.textContent === "Side 1 av 3")).toBe(true);
    expect(prev!.disabled).toBe(true);
    next!.click();
    await vi.waitFor(() => expect(root.all().some((e) => e.textContent === "Side 2 av 3")).toBe(true));
    expect(root.all().filter((e) => e.tag === "canvas").map((e) => e.textContent)).toEqual(["page 2"]);
    next!.click();
    await vi.waitFor(() => expect(root.all().some((e) => e.textContent === "Side 3 av 3")).toBe(true));
    expect(next!.disabled).toBe(true);
    next!.click();
    prev!.click();
    await vi.waitFor(() => expect(root.all().some((e) => e.textContent === "Side 2 av 3")).toBe(true));
    expect(rendered).toEqual([1, 2, 3, 2]);
    expect(changes).toHaveBeenCalled();
  });

  it("shows a one-page document without navigation", async () => {
    const root = new FakeEl("div");
    await renderPager(doc as never, root as never, 1, async () => new FakeEl("canvas"));
    expect(root.all().filter((e) => e.tag === "button")).toHaveLength(0);
    expect(root.all().filter((e) => e.tag === "canvas")).toHaveLength(1);
  });
});

describe("built document widget", () => {
  const html = readFileSync(new URL("../src/assets/document.html", import.meta.url), "utf8");

  it("inlines the app bundle, pdf.js, its worker and the logic, and never uses innerHTML", () => {
    expect(html).toContain("globalThis.__mcpApps=");
    expect(html).toContain("globalThis.__pdfjs=");
    expect(html).toContain("globalThis.__pdfjsWorker=");
    expect(html).toContain("globalThis.__widget=");
    expect(html).not.toContain("/*__LOGIC__*/");
    expect(html).not.toMatch(/<\/script>[^<]*<\/script>/);
    expect(html).not.toContain("innerHTML");
  });

  it("fetches once per tool result, so a replayed result does not fetch again", async () => {
    const fetch = vi.fn(answer(PNG));
    const createImageBitmap = vi.fn(async () => ({ width: 2, height: 1 }));
    const page = await runPageScript(html, { showDocument, renderPager, canvasScale }, { fetch, createImageBitmap });
    page.fire(data);
    page.fire(data);
    await vi.waitFor(() => expect(createImageBitmap).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledTimes(1);
    page.fire({ ...data, ticket: "v1e.t1.iv.other" });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    page.fire({ documentUrl: "https://fiken-mcp.test/document" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
