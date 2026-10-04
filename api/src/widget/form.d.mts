export interface FormOption {
  label: string;
  value: string;
}

export interface FormField {
  name: string;
  label: string;
  type: "text" | "number" | "amount" | "date" | "select" | "checkbox";
  value?: string;
  options?: FormOption[];
  required?: boolean;
  help?: string;
}

export interface FormData {
  title: string;
  fields: FormField[];
  submitLabel?: string;
}

export function formMessage(data: Pick<FormData, "title" | "fields">, values: Record<string, string | boolean>): string;

/** Loosely typed on purpose: `doc` and `root` are DOM objects, or fakes of them in tests. */
export function renderForm(
  doc: { createElement(tag: string): any },
  root: { append(...els: any[]): void },
  data: FormData,
  send: (text: string) => void,
): void;
