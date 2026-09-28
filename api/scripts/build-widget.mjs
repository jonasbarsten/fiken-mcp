// Builds the MCP App upload widget into a single self-contained HTML file.
//
// The widget runs in a sandboxed iframe that may not load scripts from our
// domain, so every ES module it needs is inlined into the page. Each bundle
// ends in a single `export{...}` statement, which we rewrite into a global the
// widget code picks up. No public URL is baked in: the widget reads its
// upload URL and ticket from the tool result.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const TEMPLATE_PATH = new URL("../src/widget/upload.template.html", import.meta.url);
const OUT_PATH = new URL("../src/assets/upload.html", import.meta.url);

const BUNDLES = [
  ["/*__BUNDLE__*/", "@modelcontextprotocol/ext-apps/app-with-deps", "__mcpApps"],
  ["/*__PDFJS__*/", "pdfjs-dist/build/pdf.min.mjs", "__pdfjs"],
  ["/*__PDFJS_WORKER__*/", "pdfjs-dist/build/pdf.worker.min.mjs", "__pdfjsWorker"],
];

/** Reads an ES module bundle and rewrites its trailing `export{…}` into `globalThis.<name>={…}`. */
async function inlineEsm(specifier, globalName) {
  const bundle = await readFile(require.resolve(specifier), "utf8");
  const exportStart = bundle.lastIndexOf("export{");
  const exportEnd = bundle.lastIndexOf("}");
  if (exportStart === -1 || exportEnd < exportStart) throw new Error(`${specifier}: no trailing export{...} to rewrite`);
  const head = bundle.slice(0, exportStart);
  const mapped = bundle
    .slice(exportStart + "export{".length, exportEnd)
    .split(",")
    .map((entry) => {
      const [local, exported] = entry.trim().split(/\s+as\s+/);
      return `${exported ?? local}:${local}`;
    })
    .join(",");
  // A literal `</script` inside a bundle would close the inline script element.
  return `${head}globalThis.${globalName}={${mapped}};`.replaceAll("</script", "<\\/script");
}

async function main() {
  const template = await readFile(TEMPLATE_PATH, "utf8");
  let html = template;
  for (const [marker, specifier, globalName] of BUNDLES) {
    if (!html.includes(marker)) throw new Error(`template is missing ${marker}`);
    const code = await inlineEsm(specifier, globalName);
    html = html.replace(marker, () => code);
  }
  const version = createHash("sha256").update(template).digest("hex").slice(0, 8);
  html = html.replaceAll("__WIDGET_VERSION__", version);

  await mkdir(new URL("./", OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, html);
  console.log(`built widget ${version}: ${Math.round(html.length / 1024)} kB -> src/assets/upload.html`);
}

await main();
