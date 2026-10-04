import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { PREVIEW_HTML } from "../../assets.js";
import { counted, type ToolContext } from "../context.js";
import type { Operation } from "../operations.js";
import { buildPreview, type Preview } from "../preview.js";
import { toolText } from "./common.js";

/** One stable URI for the widget, never versioned per build (see UPLOAD_RESOURCE_URI). */
export const PREVIEW_RESOURCE_URI = "ui://fiken-mcp/preview.html";

const PREVIEW_DESCRIPTION =
  "Show the user a proposed booking before anything is written: pass the write operation's name and the args you would send " +
  "(create_purchase, create_journal_entry, ...). Validates them as the write would and shows a summary, the lines in kroner and any " +
  "problems, with buttons «Før dette» and «Endre» (in clients that render widgets; others get the same as text). Nothing is written. " +
  "If the user answers «Ja, før dette.», make the real write with exactly these args.";

const inputSchema = z
  .object({
    operation: z.string().min(1).describe("The write operation to preview, e.g. create_journal_entry."),
    args: z.record(z.string(), z.unknown()).describe("The args you would pass to that operation."),
  })
  .strict();

const cellText = (s: string) => s.replaceAll("|", "\\|");

/** The text every client gets, also those that render no widget. */
export function previewMarkdown(p: Preview): string {
  const out: string[] = [`**${p.title}**`, ""];
  for (const { label, value } of p.summary) out.push(`- ${label}: ${value}`);
  if (p.lines) {
    out.push("", `| ${p.lines.columns.map(cellText).join(" | ")} |`, `| ${p.lines.columns.map(() => "---").join(" | ")} |`);
    for (const row of p.lines.rows) out.push(`| ${row.map(cellText).join(" | ")} |`);
  }
  if (p.totals) {
    out.push("");
    for (const { label, value } of p.totals) out.push(`- ${label}: ${value}`);
  }
  if (p.checks !== "ok") {
    out.push("", "Kan ikke føres slik:");
    for (const message of p.checks) out.push(`- ${message}`);
  }
  out.push("", "Ingenting er ført ennå.");
  return out.join("\n");
}

/** `visible` is what the connection may run, as for the gateway: anything else is an unknown operation. */
export function registerPreviewTool(server: McpServer, ctx: ToolContext, visible: readonly Operation[]): void {
  const byName = new Map(visible.map((op) => [op.name, op]));
  registerAppTool(
    server,
    "preview_booking",
    {
      title: "Preview a booking",
      description: PREVIEW_DESCRIPTION,
      inputSchema,
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: PREVIEW_RESOURCE_URI } },
    },
    counted(ctx, "preview_booking", async ({ operation, args }: z.output<typeof inputSchema>) => {
      const op = byName.get(operation);
      if (!op) return toolText(`Unknown operation "${operation}". Call fiken_explore to see what exists.`);
      if (op.kind !== "write") return toolText(`preview_booking only previews writes; ${op.name} is a read.`);
      const preview = buildPreview(op, args);
      return { content: [{ type: "text", text: previewMarkdown(preview) }], structuredContent: { ...preview } };
    }),
  );

  registerAppResource(
    server,
    "Booking preview widget",
    PREVIEW_RESOURCE_URI,
    { description: "A proposed booking with buttons to confirm or change it." },
    async () => ({
      contents: [{ uri: PREVIEW_RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: PREVIEW_HTML }],
    }),
  );
}
