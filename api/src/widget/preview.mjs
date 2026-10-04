// Renders a booking preview for the preview widget. Takes the document and a
// send(text) callback so tests can run it with a fake DOM.
// Text only: every string goes into textContent, never into HTML.

const CONFIRM_TEXT = "Ja, før dette.";
const CHANGE_TEXT = "Jeg vil endre noe før det føres.";

function el(doc, tag, className, text) {
  const e = doc.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function pairs(doc, items, className) {
  const list = el(doc, "div", className);
  for (const { label, value } of items) {
    const row = el(doc, "div", "row");
    row.append(el(doc, "span", "label", label), el(doc, "span", "value", value));
    list.append(row);
  }
  return list;
}

function renderPreview(doc, root, preview, send) {
  let done = false;
  const buttons = [];
  const finish = (text, chosen) => {
    if (done) return;
    done = true;
    for (const b of buttons) b.disabled = true;
    chosen.className = `${chosen.className} chosen`.trim();
    send(text);
  };
  const button = (label, className, text) => {
    const b = el(doc, "button", className, label);
    b.type = "button";
    b.addEventListener("click", () => finish(text, b));
    buttons.push(b);
    return b;
  };

  root.append(el(doc, "p", "title", preview.title));
  root.append(pairs(doc, preview.summary, "summary"));

  if (preview.lines) {
    const table = el(doc, "table", "lines");
    const head = el(doc, "tr");
    for (const c of preview.lines.columns) head.append(el(doc, "th", "", c));
    const thead = el(doc, "thead");
    thead.append(head);
    const tbody = el(doc, "tbody");
    for (const r of preview.lines.rows) {
      const tr = el(doc, "tr");
      for (const c of r) tr.append(el(doc, "td", "", c));
      tbody.append(tr);
    }
    table.append(thead, tbody);
    const wrap = el(doc, "div", "table-wrap");
    wrap.append(table);
    root.append(wrap);
  }

  if (preview.totals && preview.totals.length > 0) root.append(pairs(doc, preview.totals, "totals"));

  const problems = preview.checks === "ok" ? [] : preview.checks;
  if (problems.length > 0) {
    const box = el(doc, "div", "checks");
    box.append(el(doc, "p", "checks-title", "Kan ikke føres slik:"));
    const ul = el(doc, "ul");
    for (const m of problems) ul.append(el(doc, "li", "", m));
    box.append(ul);
    root.append(box);
  }

  const actions = el(doc, "div", "actions");
  if (problems.length === 0) actions.append(button("Før dette", "primary", CONFIRM_TEXT));
  actions.append(button("Endre", "secondary", CHANGE_TEXT));
  root.append(actions);
}

export { renderPreview };
