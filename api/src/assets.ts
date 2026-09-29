import { readFileSync } from "node:fs";

/**
 * The single place that reads a static asset from disk.
 *
 * esbuild flattens the whole api into one `index.mjs` at the bundle root, and
 * the stack copies `src/assets` next to it. A relative asset URL therefore only
 * resolves in both source and bundle when the module reading it sits at the
 * `src/` root: `new URL("./assets/x", import.meta.url)` is `src/assets/x` in
 * source and `<bundle>/assets/x` in the Lambda. From any deeper module the same
 * URL resolves outside the bundle and the read throws at cold start, taking
 * every request with it. So no other module may read an asset by relative URL;
 * `test/assets.test.ts` enforces that.
 */

/** The built upload widget. Produced by scripts/build-widget.mjs; gitignored. */
export const WIDGET_HTML = readFileSync(new URL("./assets/upload.html", import.meta.url), "utf8");

/** The connector icon that serverInfo.icons points at. */
export const ICON_PNG = new Uint8Array(readFileSync(new URL("./assets/icon.png", import.meta.url)));
