/** A DOM element that records what the widget logic does to it. */
export class FakeEl {
  children: FakeEl[] = [];
  textContent = "";
  disabled = false;
  className = "";
  type = "";
  value = "";
  placeholder = "";
  checked = false;
  inputMode = "";
  listeners: Record<string, Array<(e?: { key: string; isComposing?: boolean }) => void>> = {};
  replaceChildren?: () => void;
  constructor(public tag: string) {}
  append(...els: FakeEl[]) { this.children.push(...els); }
  addEventListener(ev: string, fn: (e?: { key: string; isComposing?: boolean }) => void) { (this.listeners[ev] ??= []).push(fn); }
  click() { for (const fn of this.listeners.click ?? []) fn(); }
  /** Fires an input or change event, as the browser does after the user edits the control. */
  fire(ev: string) { for (const fn of this.listeners[ev] ?? []) fn(); }
  key(key: string, isComposing = false) { for (const fn of this.listeners.keydown ?? []) fn({ key, isComposing }); }
  all(): FakeEl[] { return [this, ...this.children.flatMap((c) => c.all())]; }
}
