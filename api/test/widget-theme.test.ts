import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const WIDGETS = ["upload", "choice", "form", "preview", "table", "document"];

describe("widget colour scheme", () => {
  // Without a declared color-scheme, a dark host paints an opaque white backdrop behind the
  // transparent widget, while the dark-mode CSS turns the text light: light text on white.
  it.each(WIDGETS)("%s declares that it supports light and dark", (name) => {
    const html = readFileSync(new URL(`../src/assets/${name}.html`, import.meta.url), "utf8");
    expect(html).toContain(":root { color-scheme: light dark; }");
  });
});
