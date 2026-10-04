import { describe, expect, it } from "vitest";
import { answerChoice, answerForm } from "../src/user.js";

const replies = { company: "demo-as", default: "Ja, det stemmer.", choices: { "Hvilken konto": "6810" }, form: { amount: "500" } };

describe("answerChoice", () => {
  it("picks the company option and answers as the widget does", () => {
    expect(answerChoice({ question: "Hvilket foretak?", options: [{ label: "Annet AS", value: "annet-as" }, { label: "Demo AS", value: "demo-as" }] }, replies)).toBe("Demo AS (demo-as)");
  });
  it("uses choices by question fragment, then default", () => {
    const options = [{ label: "6800 Kontorrekvisita", value: "6800" }, { label: "6810 Datautstyr", value: "6810" }];
    expect(answerChoice({ question: "Hvilken konto skal brukes?", options }, replies)).toBe("6810 Datautstyr (6810)");
    expect(answerChoice({ question: "Noe annet?", options }, replies)).toBe("Ja, det stemmer.");
  });
});

describe("answerForm", () => {
  it("fills from replies.form, then suggested values, and writes the widget's message", () => {
    const text = answerForm({ title: "Utlegg", fields: [
      { name: "date", label: "Dato", type: "date", value: "2026-10-01" },
      { name: "amount", label: "Beløp", type: "amount" },
      { name: "private", label: "Betalt privat", type: "checkbox", value: "true" },
    ] }, replies);
    expect(text).toBe("Utlegg:\n- Dato: 2026-10-01\n- Beløp: 500\n- Betalt privat: Ja");
  });
});
