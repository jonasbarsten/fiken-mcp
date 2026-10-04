import { choiceMessage, type ChoiceOption } from "../../api/src/widget/choice.mjs";
import { formMessage, type FormField } from "../../api/src/widget/form.mjs";
import type { Replies } from "../cases/types.js";

/** The simulated user's click on an ask_user_choice widget, as the widget would send it. */
export function answerChoice(args: Record<string, unknown>, replies: Replies): string {
  const options = Array.isArray(args.options) ? (args.options as ChoiceOption[]) : [];
  const question = typeof args.question === "string" ? args.question : "";
  const company = options.find((o) => o.value === replies.company);
  if (company) return choiceMessage(company);
  for (const [fragment, wanted] of Object.entries(replies.choices ?? {})) {
    if (!question.includes(fragment)) continue;
    const option = options.find((o) => o.value === wanted || o.label === wanted);
    return option ? choiceMessage(option) : wanted;
  }
  return replies.default;
}

/** The simulated user's filled-in ask_user_form, as the widget would send it. */
export function answerForm(args: Record<string, unknown>, replies: Replies): string {
  const fields = Array.isArray(args.fields) ? (args.fields as FormField[]) : [];
  const title = typeof args.title === "string" ? args.title : "";
  const values: Record<string, string | boolean> = {};
  for (const f of fields) {
    const v = replies.form?.[f.name] ?? f.value;
    if (v === undefined) continue;
    values[f.name] = f.type === "checkbox" ? v === "true" : v;
  }
  return formMessage({ title, fields }, values);
}
