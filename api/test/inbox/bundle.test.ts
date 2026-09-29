import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { minimalPdf } from "../fixtures/pdf.js";

describe("pdf-text in an esbuild bundle like the Lambda's", () => {
  it("extracts text", async () => {
    const outfile = join(mkdtempSync(join(tmpdir(), "fmcp-pdf-")), "index.mjs");
    await build({
      entryPoints: [new URL("../../src/inbox/pdf-text.ts", import.meta.url).pathname],
      bundle: true, platform: "node", format: "esm", target: "node24", outfile, logLevel: "silent",
      banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    });
    const mod = (await import(pathToFileURL(outfile).href)) as typeof import("../../src/inbox/pdf-text.js");
    expect((await mod.pdfPageTexts(minimalPdf(["Kiwi kr 89,90"]))).pages).toEqual(["Kiwi kr 89,90"]);
  }, 60_000);
});
