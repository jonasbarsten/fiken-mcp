export interface PreviewData {
  operation: string;
  title: string;
  companySlug?: string;
  summary: Array<{ label: string; value: string }>;
  lines?: { columns: string[]; rows: string[][] };
  totals?: Array<{ label: string; value: string }>;
  checks: "ok" | string[];
  ref: string;
}

/** Loosely typed on purpose: `doc` and `root` are DOM objects, or fakes of them in tests. */
export function renderPreview(
  doc: { createElement(tag: string): any },
  root: { append(...els: any[]): void },
  preview: PreviewData,
  send: (text: string) => void,
): void;
