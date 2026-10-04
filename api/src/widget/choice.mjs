// Renders a multiple-choice question for the choice widget. Takes the
// document and a send(text) callback so tests can run it with a fake DOM.
// Text only: every string goes into textContent, never into HTML.

function choiceMessage(option) {
  return option.value === option.label ? option.label : `${option.label} (${option.value})`;
}

function renderChoice(doc, root, data, send) {
  let done = false;
  const buttons = [];
  const finish = (text, chosen) => {
    if (done) return;
    done = true;
    for (const b of buttons) b.disabled = true;
    if (chosen) chosen.className = `${chosen.className} chosen`.trim();
    send(text);
  };

  const q = doc.createElement("p");
  q.className = "question";
  q.textContent = data.question;
  root.append(q);

  for (const option of data.options) {
    const b = doc.createElement("button");
    b.type = "button";
    b.className = "option";
    const label = doc.createElement("span");
    label.className = "label";
    label.textContent = option.label;
    b.append(label);
    if (option.description) {
      const d = doc.createElement("span");
      d.className = "description";
      d.textContent = option.description;
      b.append(d);
    }
    b.addEventListener("click", () => finish(choiceMessage(option), b));
    buttons.push(b);
    root.append(b);
  }

  if (data.allowOther) {
    const row = doc.createElement("div");
    row.className = "other";
    const input = doc.createElement("input");
    input.type = "text";
    input.placeholder = "Annet …";
    const b = doc.createElement("button");
    b.type = "button";
    b.textContent = "Send";
    b.addEventListener("click", () => {
      const text = String(input.value ?? "").trim();
      if (text !== "") finish(text, b);
    });
    buttons.push(b);
    row.append(input, b);
    root.append(row);
  }
}

export { renderChoice, choiceMessage };
