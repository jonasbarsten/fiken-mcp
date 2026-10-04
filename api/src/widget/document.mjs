// Fetches a document through the /document route and shows it, for the
// document viewer widget. Takes the document and its dependencies (fetch, how
// to draw an image, how to render a PDF) so tests can run it with a fake DOM.
// Text only: every string goes into textContent, never into HTML.

const FAILED = "Kunne ikke hente dokumentet.";
const EXPIRED = "Visningen har utløpt. Be Claude om å vise dokumentet på nytt.";
const TOO_LARGE = "Dokumentet er for stort til å vises her. Åpne det i Fiken.";
const UNREADABLE = "Kunne ikke vise dokumentet.";

/** Status line text for a refused request: the route answers bare statuses. */
function refusalText(status) {
  if (status === 401) return EXPIRED;
  if (status === 413) return TOO_LARGE;
  return FAILED;
}

/**
 * Shows `data.filename`, fetches `data.documentUrl` with the ticket in a header (never in the URL, so it stays
 * out of logs), then hands an image to `deps.drawImage(blob)` (which returns the element to show) and a PDF to
 * `deps.renderPdf(bytes, container)`. The route types the answer by magic bytes, so its content-type is trusted.
 */
async function showDocument(doc, root, data, deps) {
  const title = doc.createElement("p");
  title.className = "title";
  title.textContent = data.filename ?? "";
  const status = doc.createElement("p");
  status.className = "status";
  status.textContent = "Henter dokumentet…";
  const view = doc.createElement("div");
  view.className = "view";
  root.append(title, status, view);

  let response;
  try {
    response = await deps.fetch(data.documentUrl, { headers: { "x-ticket": data.ticket } });
  } catch {
    status.textContent = FAILED;
    return;
  }
  if (!response.ok) {
    status.textContent = refusalText(response.status);
    return;
  }

  const type = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  try {
    if (type === "application/pdf") {
      await deps.renderPdf(new Uint8Array(await response.arrayBuffer()), view);
    } else if (type === "image/png" || type === "image/jpeg" || type === "image/gif") {
      view.append(await deps.drawImage(await response.blob()));
    } else {
      status.textContent = UNREADABLE;
      return;
    }
  } catch {
    status.textContent = UNREADABLE;
    return;
  }
  status.textContent = "";
}

/**
 * Page navigation for a PDF: shows page 1, then «Forrige» / «Neste» (only when there is more than one page).
 * `renderPage(n)` resolves to the element showing page n. Clicks while a page renders are ignored, so pages
 * cannot arrive out of order. `onChange` runs after every page, for the host's iframe height.
 */
async function renderPager(doc, root, numPages, renderPage, onChange = () => {}) {
  const page = doc.createElement("div");
  page.className = "page";
  const prev = doc.createElement("button");
  prev.type = "button";
  prev.textContent = "Forrige";
  const label = doc.createElement("span");
  label.className = "pages";
  const next = doc.createElement("button");
  next.type = "button";
  next.textContent = "Neste";

  if (numPages > 1) {
    const nav = doc.createElement("div");
    nav.className = "nav";
    nav.append(prev, label, next);
    root.append(nav);
  }
  root.append(page);

  let current = 0;
  let busy = false;
  async function show(n) {
    if (busy || n < 1 || n > numPages || n === current) return;
    busy = true;
    prev.disabled = true;
    next.disabled = true;
    try {
      page.replaceChildren(await renderPage(n));
      current = n;
      label.textContent = `Side ${n} av ${numPages}`;
    } finally {
      busy = false;
      prev.disabled = current <= 1;
      next.disabled = current >= numPages;
      onChange();
    }
  }
  prev.addEventListener("click", () => {
    show(current - 1).catch(() => {});
  });
  next.addEventListener("click", () => {
    show(current + 1).catch(() => {});
  });
  await show(1);
}

/** Above this many pixels a canvas fails or blanks out on iOS Safari, and the memory is wasted anyway. */
const MAX_CANVAS_PIXELS = 16_000_000;

/**
 * The scale to draw something `width` × `height` at so it is `targetWidth` CSS pixels wide on this screen: the
 * device pixel ratio counts, but at most 2x, and the canvas never exceeds MAX_CANVAS_PIXELS. An image at its own
 * size is `canvasScale(w, w, h, 1)`: 1, unless it is too large.
 */
function canvasScale(targetWidth, width, height, dpr) {
  const ratio = Number.isFinite(dpr) && dpr > 0 ? Math.min(dpr, 2) : 1;
  const scale = (targetWidth * ratio) / width;
  const limit = Math.sqrt(MAX_CANVAS_PIXELS / (width * height));
  return Math.min(scale, limit);
}

export { showDocument, renderPager, canvasScale, MAX_CANVAS_PIXELS };
