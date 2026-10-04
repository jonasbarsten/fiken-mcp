// Builds the MCP App widgets into single self-contained HTML files.
//
// A widget runs in a sandboxed iframe that may not load scripts from our
// domain, so every ES module it needs is inlined into the page. Each bundle
// ends in a single `export{...}` statement, which we rewrite into a global the
// widget code picks up. No public URL is baked in: widgets read what they need
// from the tool result.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * Each widget reads src/widget/<name>.template.html and writes src/assets/<name>.html.
 * A bundle is [marker in the template, package specifier or file URL, global name].
 */
const WIDGETS = [
  {
    name: "upload",
    bundles: [
      ["/*__BUNDLE__*/", "@modelcontextprotocol/ext-apps/app-with-deps", "__mcpApps"],
      ["/*__PDFJS__*/", "pdfjs-dist/build/pdf.min.mjs", "__pdfjs"],
      ["/*__PDFJS_WORKER__*/", "pdfjs-dist/build/pdf.worker.min.mjs", "__pdfjsWorker"],
    ],
  },
  {
    name: "choice",
    bundles: [
      ["/*__BUNDLE__*/", "@modelcontextprotocol/ext-apps/app-with-deps", "__mcpApps"],
      ["/*__LOGIC__*/", new URL("../src/widget/choice.mjs", import.meta.url), "__widget"],
    ],
  },
  {
    name: "form",
    bundles: [
      ["/*__BUNDLE__*/", "@modelcontextprotocol/ext-apps/app-with-deps", "__mcpApps"],
      ["/*__LOGIC__*/", new URL("../src/widget/form.mjs", import.meta.url), "__widget"],
    ],
  },
  {
    name: "table",
    bundles: [
      ["/*__BUNDLE__*/", "@modelcontextprotocol/ext-apps/app-with-deps", "__mcpApps"],
      ["/*__LOGIC__*/", new URL("../src/widget/table.mjs", import.meta.url), "__widget"],
    ],
  },
  {
    name: "preview",
    bundles: [
      ["/*__BUNDLE__*/", "@modelcontextprotocol/ext-apps/app-with-deps", "__mcpApps"],
      ["/*__LOGIC__*/", new URL("../src/widget/preview.mjs", import.meta.url), "__widget"],
    ],
  },
];

/** Reads an ES module and rewrites its trailing `export{…}` into `globalThis.<name>={…}`. `source` is a package specifier or a file URL. */
async function inlineEsm(source, globalName) {
  const label = source instanceof URL ? source.pathname : source;
  const bundle = await readFile(source instanceof URL ? source : require.resolve(source), "utf8");
  // Minified bundles say `export{a as b}`, hand-written modules `export { a, b };`.
  const exportMatch = [...bundle.matchAll(/export\s*\{/g)].at(-1);
  const exportEnd = bundle.lastIndexOf("}");
  if (!exportMatch || exportEnd < exportMatch.index) throw new Error(`${label}: no trailing export{...} to rewrite`);
  const head = bundle.slice(0, exportMatch.index);
  const mapped = bundle
    .slice(exportMatch.index + exportMatch[0].length, exportEnd)
    .split(",")
    .map((entry) => {
      const [local, exported] = entry.trim().split(/\s+as\s+/);
      return `${exported ?? local}:${local}`;
    })
    .join(",");
  // A literal `</script` inside a bundle would close the inline script element.
  return `${head}globalThis.${globalName}={${mapped}};`.replaceAll("</script", "<\\/script");
}

async function buildWidget({ name, bundles }) {
  const template = await readFile(new URL(`../src/widget/${name}.template.html`, import.meta.url), "utf8");
  const outPath = new URL(`../src/assets/${name}.html`, import.meta.url);
  let html = template;
  for (const [marker, source, globalName] of bundles) {
    if (!html.includes(marker)) throw new Error(`${name} template is missing ${marker}`);
    const code = await inlineEsm(source, globalName);
    html = html.replace(marker, () => code);
  }
  // Hash what actually ships, bundles included, so the stamp changes when a
  // dependency bump changes the widget even though the template did not.
  const version = createHash("sha256").update(html).digest("hex").slice(0, 8);
  html = html.replaceAll("__WIDGET_VERSION__", version);

  await mkdir(new URL("./", outPath), { recursive: true });
  await writeFile(outPath, html);
  console.log(`built ${name} widget ${version}: ${Math.round(html.length / 1024)} kB -> src/assets/${name}.html`);
}

async function main() {
  for (const widget of WIDGETS) await buildWidget(widget);
}

await main();
