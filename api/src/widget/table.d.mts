export interface TableColumn {
  key: string;
  label: string;
  kind?: "text" | "amount" | "date";
}

export interface TableAction {
  label: string;
  message: string;
}

export interface TableRow {
  cells: Record<string, string | number>;
  actions?: TableAction[];
}

export interface TableData {
  title: string;
  columns: TableColumn[];
  rows: TableRow[];
  note?: string;
}

/** Øre as `1 250,00 kr`; a value that is not a number comes back as given. */
export function formatAmountCell(value: string | number): string;

/**
 * Loosely typed on purpose: `doc` and `root` are DOM objects, or fakes of them in tests. `acted` holds the indexes of
 * rows whose action was sent; it is read to start those rows disabled and added to on every click.
 */
export function renderTable(
  doc: { createElement(tag: string): any },
  root: { append(...els: any[]): void },
  data: TableData,
  send: (text: string) => void,
  acted?: Set<number>,
): void;
