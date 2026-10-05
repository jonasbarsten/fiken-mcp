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
    // The widget's limit must stay the route's limit (MAX_BYTES in src/upload/routes.ts).
    expect(html).toContain("MAX_UPLOAD_BYTES = 4 * 1024 * 1024");
    expect(html).toContain("Ferdig");
    expect(html).not.toContain("innerHTML");
    expect(html.length).toBeGreaterThan(500_000);
  });

  it("keeps the build version out of sight, in a meta tag", () => {
    expect(html).toMatch(/<meta name="widget-version" content="[0-9a-f]{8}" \/>/);
    expect(html).toContain("<h3>Kvitteringer</h3>");
  });

  it("takes dropped files on devices with a mouse, through the same upload path", () => {
    expect(html).toContain('id="drop"');
    expect(html).toContain("@media (hover: hover) and (pointer: fine)");
    expect(html).toContain('document.addEventListener("drop"');
    expect(html).toContain("handleFiles(dropped.filter(isReceiptFile))");
  });

  it("prefixes the summary block and gates image blocks on the host's declared modality", () => {
    // The summary names user-supplied file names, so it is untrusted like the rest.
    expect(html).toContain("${PREFIX}Uploaded to Fiken inbox of");
    // Fail open: text-only context only when the host lists modalities and leaves out image.
    expect(html).toContain('"image" in contextModalities');
    // A dead ticket must name every file of the batch, not just the one that hit the 401.
    expect(html).toContain("opplastingen utløp");
    expect(html).toContain("Bokfør den.");
  });
});
