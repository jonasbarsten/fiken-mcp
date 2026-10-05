// Renders a multiple-choice question for the choice widget. Takes the
// document and a send(text) callback so tests can run it with a fake DOM.
// Text only: every string goes into textContent, never into HTML.

function choiceMessage(option) {
  return option.value === option.label ? option.label : `${option.label} (${option.value})`;
}

// Claude puts the widget's message in the chat composer; the user still has to press send.
const HINT = "Svaret ligger i meldingsfeltet – trykk send i chatten.";

function renderChoice(doc, root, data, send) {
  let done = false;
  // Buttons and the «Annet» field: all of them are disabled once the user has answered.
  const controls = [];
  const finish = (text, chosen) => {
    if (done) return;
    done = true;
    for (const c of controls) c.disabled = true;
    if (chosen) chosen.className = `${chosen.className} chosen`.trim();
    send(text);
    const hint = doc.createElement("p");
    hint.className = "hint";
    hint.textContent = HINT;
    root.append(hint);
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
    controls.push(b);
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
    b.textContent = "Bruk";
    const submit = () => {
      const text = String(input.value ?? "").trim();
      if (text !== "") finish(text, b);
    };
    b.addEventListener("click", submit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) submit();
    });
    controls.push(input, b);
    row.append(input, b);
    root.append(row);
  }
}

export { renderChoice, choiceMessage };
