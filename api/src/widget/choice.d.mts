export interface ChoiceOption {
  label: string;
  value: string;
  description?: string;
}

export interface ChoiceData {
  question: string;
  options: ChoiceOption[];
  allowOther?: boolean;
}

export function choiceMessage(option: ChoiceOption): string;

/** Loosely typed on purpose: `doc` and `root` are DOM objects, or fakes of them in tests. */
export function renderChoice(
  doc: { createElement(tag: string): any },
  root: { append(...els: any[]): void },
  data: ChoiceData,
  send: (text: string) => void,
): void;
