import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../src/assets/upload.html", import.meta.url), "utf8");

describe("built widget", () => {
  it("inlines the three bundles as globals and keeps the template's hooks", () => {
    expect(html).toContain("globalThis.__mcpApps=");
    expect(html).toContain("globalThis.__pdfjs=");
    expect(html).toContain("globalThis.__pdfjsWorker=");
    expect(html).not.toContain("/*__BUNDLE__*/");
    expect(html).not.toMatch(/<\/script>[^<]*<\/script>/); // no early close from an inlined bundle
    expect(html).toContain("UNTRUSTED DOCUMENT CONTENT");
    expect(html).toContain("Ferdig");
    expect(html).not.toContain("innerHTML");
    expect(html.length).toBeGreaterThan(500_000);
  });
});
