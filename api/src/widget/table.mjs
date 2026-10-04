// Renders a table with optional row actions for the table widget. Takes the
// document and a send(text) callback so tests can run it with a fake DOM.
// Text only: every string goes into textContent, never into HTML.

const kroner = new Intl.NumberFormat("nb-NO", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * An amount cell (øre) as `1 250,00 kr`, no-break spaces. Keep in step with formatKroner in
 * src/mcp/preview.ts (a test compares them); a value that is not a number is shown as given.
 */
function formatAmountCell(value) {
  const ore = typeof value === "number" ? value : value === "" ? Number.NaN : Number(value);
  return Number.isFinite(ore) ? `${kroner.format(ore / 100)} kr` : String(value);
}

function cellText(column, value) {
  if (value === undefined || value === null) return "";
  return column.kind === "amount" ? formatAmountCell(value) : String(value);
}

/**
 * `acted` holds the indexes of rows whose action was already sent. The page keeps it across re-renders of the same
 * table, so a replayed tool result shows those rows disabled instead of offering the action again.
 */
function renderTable(doc, root, data, send, acted = new Set()) {
  const title = doc.createElement("p");
  title.className = "title";
  title.textContent = data.title;
  root.append(title);

  const wrap = doc.createElement("div");
  wrap.className = "scroll";
  const table = doc.createElement("table");
  const head = doc.createElement("tr");
  for (const column of data.columns) {
    const th = doc.createElement("th");
    th.textContent = column.label;
    if (column.kind === "amount") th.className = "amount";
    head.append(th);
  }
  const hasActions = data.rows.some((row) => row.actions?.length);
  if (hasActions) head.append(doc.createElement("th"));
  table.append(head);

  data.rows.forEach((row, index) => {
    const tr = doc.createElement("tr");
    for (const column of data.columns) {
      const td = doc.createElement("td");
      td.textContent = cellText(column, row.cells?.[column.key]);
      if (column.kind === "amount") td.className = "amount";
      tr.append(td);
    }
    if (hasActions) {
      const td = doc.createElement("td");
      td.className = "actions";
      const buttons = [];
      for (const action of row.actions ?? []) {
        const b = doc.createElement("button");
        b.type = "button";
        b.textContent = action.label;
        b.disabled = acted.has(index);
        b.addEventListener("click", () => {
          if (acted.has(index)) return;
          acted.add(index);
          for (const other of buttons) other.disabled = true;
          send(action.message);
        });
        buttons.push(b);
        td.append(b);
      }
      tr.append(td);
    }
    table.append(tr);
  });
  wrap.append(table);
  root.append(wrap);

  if (data.note) {
    const note = doc.createElement("p");
    note.className = "note";
    note.textContent = data.note;
    root.append(note);
  }
}

export { renderTable, formatAmountCell };
