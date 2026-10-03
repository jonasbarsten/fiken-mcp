import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const WEB = fileURLToPath(new URL("../../web/", import.meta.url));
// The stack ships api/src/assets/icon.png as a second deployment source, served at /icon.png.
const SERVED_ELSEWHERE: Record<string, string> = {
  "icon.png": fileURLToPath(new URL("../../api/src/assets/icon.png", import.meta.url)),
};
const read = (name: string) => readFileSync(WEB + name, "utf8");
const textFiles = readdirSync(WEB).filter((f) => /\.(html|css|js)$/.test(f));
// The early-access address, never written out in this public repo.
const EMAIL_SHA256 = "4991b58892e1753709431e15fc2e75767db61471c6714de666c9593eaa3963fd";

interface FakeElement { textContent: string }

/** Runs site.js in a sandbox with just enough DOM for the script's top level. */
function runSite(fetchImpl: () => Promise<unknown>) {
  const elements: Record<string, FakeElement> = {
    "stat-total": { textContent: "–" },
    "stat-active": { textContent: "–" },
    "stat-calls": { textContent: "–" },
  };
  const months: FakeElement[] = [{ textContent: "denne måneden" }, { textContent: "denne måneden" }];
  const context = vm.createContext({
    document: {
      getElementById: (id: string) => elements[id] ?? null,
      querySelectorAll: (selector: string) => (selector === ".month" ? months : []),
    },
    navigator: {},
    fetch: fetchImpl,
    Intl,
    Date,
    setTimeout,
    encodeURIComponent,
    String,
  });
  vm.runInContext(read("site.js"), context);
  return { context: context as unknown as { emailAddress(): string; loadStats(): Promise<void> }, elements, months };
}

const thisMonth = new Date().toISOString().slice(0, 7);
const ok = (body: unknown) => async () => ({ ok: true, json: async () => body });

describe("web content", () => {
  it("never contains the email address, a mailto: link or @gmail in any file", () => {
    expect(textFiles.length).toBeGreaterThan(0);
    for (const name of textFiles) {
      const text = read(name).toLowerCase();
      expect(text, name).not.toContain("mailto:");
      expect(text, name).not.toContain("@gmail");
      expect(text, name).not.toContain("jonasbarsten@");
      expect(text, name).not.toContain("gmail.com");
    }
  });

  it("builds the right address from the char codes", () => {
    const { context } = runSite(ok({ totalUsers: 0, months: [] }));
    expect(createHash("sha256").update(context.emailAddress()).digest("hex")).toBe(EMAIL_SHA256);
  });

  it("is a Norwegian page with no inline script or style, a GitHub link and the disclaimer", () => {
    for (const name of ["index.html", "404.html"]) {
      const page = read(name);
      expect(page, name).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
      expect(page, name).not.toMatch(/<style/);
      expect(page, name).not.toMatch(/\sstyle=/);
    }
    const html = read("index.html");
    expect(html).toContain('<html lang="nb">');
    expect(html).toContain('href="https://github.com/jonasbarsten/fiken-mcp"');
    expect(html).toContain("<h2>Ansvarsfraskrivelse</h2>");
    expect(html).toContain("byJoBa");
  });

  it("restores the copy label after repeated clicks", async () => {
    const button = {
      textContent: "Kopier",
      hidden: true,
      handler: undefined as undefined | (() => Promise<void>),
      addEventListener(_: string, fn: () => Promise<void>) { this.handler = fn; },
    };
    const elements: Record<string, unknown> = {
      "copy-url": button,
      "connector-url": { textContent: " https://example.test/mcp " },
    };
    const timers = new Map<number, () => void>();
    let nextId = 1;
    const context = vm.createContext({
      document: { getElementById: (id: string) => elements[id] ?? null, querySelectorAll: () => [] },
      navigator: { clipboard: { writeText: async () => {} } },
      fetch: async () => ({ ok: false }),
      Intl,
      Date,
      setTimeout: (fn: () => void) => { timers.set(nextId, fn); return nextId++; },
      clearTimeout: (id: number) => { timers.delete(id); },
      String,
    });
    vm.runInContext(read("site.js"), context);
    expect(button.hidden).toBe(false);
    await button.handler!();
    await button.handler!();
    expect(button.textContent).toBe("Kopiert");
    for (const fn of timers.values()) fn();
    expect(button.textContent).toBe("Kopier");
  });

  it("keeps [hidden] elements hidden despite .button's display", () => {
    expect(read("style.css")).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/);
  });

  it("references only files the site serves", () => {
    for (const name of ["index.html", "404.html"]) {
      const html = read(name);
      for (const [, ref] of html.matchAll(/(?:href|src)="(\/[^"#]*)"/g)) {
        const path = ref === "/" ? "index.html" : ref!.slice(1);
        const file = SERVED_ELSEWHERE[path] ?? WEB + path;
        expect(existsSync(file), `${name} -> ${ref}`).toBe(true);
      }
    }
  });

  it("fills the counters from /stats and names the month", async () => {
    const { context, elements, months } = runSite(
      ok({ totalUsers: 1234, months: [{ month: thisMonth, calls: 45, errors: 9, activeUsers: 3, tools: {} }] }),
    );
    await context.loadStats();
    expect(elements["stat-total"]!.textContent).toBe(new Intl.NumberFormat("nb-NO").format(1234));
    expect(elements["stat-active"]!.textContent).toBe("3");
    expect(elements["stat-calls"]!.textContent).toBe("45");
    const name = new Intl.DateTimeFormat("nb-NO", { month: "long", timeZone: "UTC" }).format(new Date());
    expect(months.map((m) => m.textContent)).toEqual([name, name]);
  });

  it("shows 0 for this month when /stats has no entry for it", async () => {
    const { context, elements } = runSite(ok({ totalUsers: 5, months: [{ month: "2000-01", calls: 9, errors: 0, activeUsers: 9, tools: {} }] }));
    await context.loadStats();
    expect(elements["stat-total"]!.textContent).toBe("5");
    expect(elements["stat-active"]!.textContent).toBe("0");
    expect(elements["stat-calls"]!.textContent).toBe("0");
  });

  it("keeps the dashes when /stats fails, answers non-2xx, or sends something unexpected", async () => {
    const cases: Array<() => Promise<unknown>> = [
      async () => { throw new TypeError("network"); },
      async () => ({ ok: false, json: async () => ({}) }),
      async () => ({ ok: true, json: async () => { throw new SyntaxError("html"); } }),
      ok(null),
      ok({ totalUsers: "x", months: "nope" }),
    ];
    for (const fetchImpl of cases) {
      const { context, elements } = runSite(fetchImpl);
      await context.loadStats();
      for (const id of ["stat-total", "stat-active", "stat-calls"]) {
        expect(elements[id]!.textContent).toBe("–");
      }
    }
  });
});
