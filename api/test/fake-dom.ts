/** A DOM element that records what the widget logic does to it. */
export class FakeEl {
  children: FakeEl[] = [];
  textContent = "";
  disabled = false;
  className = "";
  type = "";
  value = "";
  placeholder = "";
  listeners: Record<string, Array<() => void>> = {};
  replaceChildren?: () => void;
  constructor(public tag: string) {}
  append(...els: FakeEl[]) { this.children.push(...els); }
  addEventListener(ev: string, fn: () => void) { (this.listeners[ev] ??= []).push(fn); }
  click() { for (const fn of this.listeners.click ?? []) fn(); }
  all(): FakeEl[] { return [this, ...this.children.flatMap((c) => c.all())]; }
}
