// Renders a short form for the form widget. Takes the document and a
// send(text) callback so tests can run it with a fake DOM.
// Text only: every string goes into textContent, never into HTML.

/** The one chat message a filled-in form becomes. `values` maps field name to a string, or a boolean for checkboxes. */
function formMessage(data, values) {
  const lines = [];
  for (const field of data.fields) {
    const raw = values[field.name];
    if (field.type === "checkbox") {
      lines.push(`- ${field.label}: ${raw === true ? "Ja" : "Nei"}`);
      continue;
    }
    const value = String(raw ?? "").trim();
    if (value === "") continue;
    const option = field.type === "select" ? (field.options ?? []).find((o) => o.value === value) : undefined;
    const shown = option && option.label !== option.value ? `${option.label} (${value})` : value;
    lines.push(`- ${field.label}: ${shown}`);
  }
  return [`${data.title}:`, ...lines].join("\n");
}

function renderForm(doc, root, data, send) {
  let done = false;
  const controls = [];
  const readers = {};
  const required = [];

  const title = doc.createElement("p");
  title.className = "title";
  title.textContent = data.title;
  root.append(title);

  const submit = doc.createElement("button");
  submit.type = "button";
  submit.className = "send";
  submit.textContent = data.submitLabel ?? "Send";

  const values = () => {
    const out = {};
    for (const field of data.fields) out[field.name] = readers[field.name]();
    return out;
  };
  const complete = () => required.every((read) => String(read()).trim() !== "");
  const refresh = () => {
    submit.disabled = done || !complete();
  };
  const finish = () => {
    if (done || !complete()) return;
    done = true;
    for (const c of controls) c.disabled = true;
    submit.disabled = true;
    send(formMessage(data, values()));
  };

  data.fields.forEach((field, i) => {
    const row = doc.createElement("div");
    row.className = "field";
    const label = doc.createElement("label");
    label.className = "label";
    label.textContent = field.label;
    label.htmlFor = `f${i}`;
    if (field.required) {
      const mark = doc.createElement("span");
      mark.className = "required";
      mark.textContent = " *";
      label.append(mark);
    }

    let control;
    if (field.type === "select") {
      control = doc.createElement("select");
      const blank = doc.createElement("option");
      blank.value = "";
      blank.textContent = "Velg …";
      control.append(blank);
      for (const o of field.options ?? []) {
        const opt = doc.createElement("option");
        opt.value = o.value;
        opt.textContent = o.label;
        control.append(opt);
      }
      control.value = field.value ?? "";
      readers[field.name] = () => control.value;
    } else if (field.type === "checkbox") {
      control = doc.createElement("input");
      control.type = "checkbox";
      control.checked = field.value === "true";
      readers[field.name] = () => control.checked === true;
    } else {
      control = doc.createElement("input");
      // Numbers and amounts are typed as «7,5» or «1 250,50», which a number input would refuse; the model converts them.
      control.type = field.type === "date" ? "date" : "text";
      if (field.type === "amount" || field.type === "number") control.inputMode = "decimal";
      control.value = field.value ?? "";
      readers[field.name] = () => control.value;
      control.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.isComposing) finish();
      });
    }
    control.id = `f${i}`;
    control.addEventListener("input", refresh);
    control.addEventListener("change", refresh);
    controls.push(control);
    // A checkbox is never empty, so it never blocks Send.
    if (field.required && field.type !== "checkbox") required.push(readers[field.name]);

    row.append(label, control);
    if (field.help) {
      const help = doc.createElement("p");
      help.className = "help";
      help.textContent = field.help;
      row.append(help);
    }
    root.append(row);
  });

  controls.push(submit);
  submit.addEventListener("click", finish);
  root.append(submit);
  refresh();
}

export { renderForm, formMessage };
