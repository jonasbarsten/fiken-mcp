export interface DocumentData {
  documentUrl: string;
  ticket: string;
  filename?: string;
}

export interface DocumentDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** Draws an image file and resolves to the element to show. */
  drawImage: (blob: Blob) => Promise<any>;
  /** Renders a PDF into `container` (pdf.js in the page, a fake in tests). */
  renderPdf: (bytes: Uint8Array, container: any) => Promise<void>;
}

/** Loosely typed on purpose: `doc` and `root` are DOM objects, or fakes of them in tests. */
export function showDocument(
  doc: { createElement(tag: string): any },
  root: { append(...els: any[]): void },
  data: DocumentData,
  deps: DocumentDeps,
): Promise<void>;

/** Shows page 1 of `numPages`, with «Forrige» / «Neste» when there is more than one. */
export function renderPager(
  doc: { createElement(tag: string): any },
  root: { append(...els: any[]): void },
  numPages: number,
  renderPage: (n: number) => Promise<any>,
  onChange?: () => void,
): Promise<void>;
