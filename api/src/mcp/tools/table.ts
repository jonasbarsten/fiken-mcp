import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { TABLE_HTML } from "../../assets.js";
import { counted, type ToolContext } from "../context.js";
import { formatKroner } from "../preview.js";

/** One stable URI for the widget, never versioned per build (see UPLOAD_RESOURCE_URI). */
export const TABLE_RESOURCE_URI = "ui://fiken-mcp/table.html";

const TABLE_DESCRIPTION =
  "Show rows you fetched (invoices, inbox documents, balances, …) as a table, optionally with up to 3 action buttons " +
  "per row; a click sends the action's message as the user's next chat message (e.g. «Registrer betaling på faktura " +
  "10521»). amount columns take øre.";

const column = z
  .object({
    key: z.string().min(1).max(40).describe("The key the rows' cells use."),
    label: z.string().min(1).max(80).describe("The column header."),
    kind: z.enum(["text", "amount", "date"]).optional().describe("amount: the cells are øre, shown as kroner."),
  })
  .strict();

const action = z
  .object({
    label: z.string().min(1).max(40).describe("What the button shows."),
    message: z.string().min(1).max(200).describe("Sent as the user's next chat message when the button is clicked."),
  })
  .strict();

const row = z
  .object({
    cells: z.record(z.string(), z.union([z.string().max(200), z.number()])).describe("Values by column key (text at most 200 characters); leave out what the row lacks."),
    actions: z.array(action).min(1).max(3).optional(),
  })
  .strict();

const inputSchema = z
  .object({
    title: z.string().min(1).max(120),
    columns: z
      .array(column)
      .min(1)
      .max(8)
      .superRefine((cols, ctx) => {
        if (new Set(cols.map((c) => c.key)).size !== cols.length) ctx.addIssue({ code: "custom", message: "Column keys must be unique." });
      }),
    rows: z.array(row).min(1).max(50),
    note: z.string().max(200).optional(),
  })
  .strict()
  .superRefine((t, ctx) => {
    const keys = new Set(t.columns.map((c) => c.key));
    t.rows.forEach((r, i) => {
      for (const key of Object.keys(r.cells)) {
        if (!keys.has(key)) ctx.addIssue({ code: "custom", path: ["rows", i, "cells", key], message: `No column has the key "${key}".` });
      }
    });
  });

type TableInput = z.infer<typeof inputSchema>;

/** A Markdown table cell on one line, with pipes escaped. */
const mdCell = (text: string) => text.replace(/\r?\n/g, " ").replaceAll("|", "\\|");

function cellText(kind: TableInput["columns"][number]["kind"], value: string | number | undefined): string {
  if (value === undefined) return "";
  if (kind !== "amount") return String(value);
  const ore = typeof value === "number" ? value : value.trim() === "" ? Number.NaN : Number(value);
  return Number.isFinite(ore) ? formatKroner(ore) : String(value);
}

/** The text every client gets, also those that render no widget. */
export function tableFallback({ title, columns, rows, note }: Pick<TableInput, "title" | "columns" | "rows" | "note">): string {
  const line = (cells: string[]) => `| ${cells.map(mdCell).join(" | ")} |`;
  const table = [
    line(columns.map((c) => c.label)),
    line(columns.map(() => "---")),
    ...rows.map((r) => line(columns.map((c) => cellText(c.kind, r.cells[c.key])))),
  ];
  const actions = rows.flatMap((r, i) => (r.actions ? [`Handlinger rad ${i + 1}: ${r.actions.map((a) => a.label).join(" / ")}`] : []));
  return [title, "", ...table, ...(note ? ["", note] : []), ...(actions.length ? ["", ...actions] : [])].join("\n");
}

export function registerTableTool(server: McpServer, ctx: ToolContext): void {
  registerAppTool(
    server,
    "show_table",
    {
      title: "Show a table",
      description: TABLE_DESCRIPTION,
      inputSchema,
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: TABLE_RESOURCE_URI } },
    },
    counted(ctx, "show_table", async (args: TableInput) => ({
      content: [{ type: "text", text: tableFallback(args) }],
      structuredContent: { title: args.title, columns: args.columns, rows: args.rows, ...(args.note ? { note: args.note } : {}) },
    })),
  );

  registerAppResource(
    server,
    "Table widget",
    TABLE_RESOURCE_URI,
    { description: "A table of rows with optional action buttons from the assistant." },
    async () => ({
      contents: [{ uri: TABLE_RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: TABLE_HTML }],
    }),
  );
}
