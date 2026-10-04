import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CHOICE_HTML, FORM_HTML, ICON_PNG, WIDGET_HTML } from "../src/assets.js";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...tsFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("static assets", () => {
  // esbuild flattens src/** into one index.mjs, so a relative asset URL only
  // resolves in the Lambda from a module at the src root. src/assets.ts is that
  // module; anywhere else the read throws at cold start and takes the API down.
  it("are read only by src/assets.ts, the one module at the src root that may", () => {
    const offenders: string[] = [];
    for (const file of tsFiles(SRC)) {
      if (file === `${SRC}/assets.ts`) continue;
      const source = readFileSync(file, "utf8");
      if (source.includes("readFileSync(new URL(") || source.includes('new URL("./assets') || source.includes('new URL("../')) {
        offenders.push(file.slice(SRC.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("load the built widgets and the icon", () => {
    expect(WIDGET_HTML.startsWith("<!doctype html>")).toBe(true);
    expect(CHOICE_HTML.startsWith("<!doctype html>")).toBe(true);
    expect(FORM_HTML.startsWith("<!doctype html>")).toBe(true);
    expect([...ICON_PNG.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });
});
