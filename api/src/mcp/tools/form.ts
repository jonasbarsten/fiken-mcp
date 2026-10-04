import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { FORM_HTML } from "../../assets.js";
import { counted, type ToolContext } from "../context.js";

/** One stable URI for the widget, never versioned per build (see UPLOAD_RESOURCE_URI). */
export const FORM_RESOURCE_URI = "ui://fiken-mcp/form.html";

const FORM_DESCRIPTION =
  "Show the user a short form (1–12 fields: text, number, amount in kroner, date, select, checkbox) with suggested " +
  "values; the filled-in answers come back as the user's next chat message. Use it when you need several details at " +
  "once, e.g. a new customer, hours to log, or invoice details. Number and amount answers come back as typed, " +
  "possibly with a decimal comma (e.g. \"7,5\" or \"1 250,50\"), so convert them yourself: an amount field is kroner " +
  "as the user typed it, not øre.";

const option = z
  .object({
    label: z.string().min(1).max(80),
    value: z.string().min(1).max(200),
  })
  .strict();

const field = z
  .object({
    name: z.string().regex(/^[a-z0-9_]{1,40}$/, "Use a-z, 0-9 and _ only, 1–40 characters."),
    label: z.string().min(1).max(80),
    type: z.enum(["text", "number", "amount", "date", "select", "checkbox"]),
    value: z.string().max(200).optional().describe("A suggested value. Dates as YYYY-MM-DD, checkboxes as \"true\"."),
    options: z.array(option).min(1).max(20).optional().describe("The choices of a select field, and only there."),
    required: z.boolean().default(false),
    help: z.string().max(160).optional().describe("A short hint under the field."),
  })
  .strict()
  .superRefine((f, ctx) => {
    if (f.type === "select" && !f.options) ctx.addIssue({ code: "custom", message: "A select field needs options." });
    if (f.type === "checkbox" && f.required) ctx.addIssue({ code: "custom", message: "A checkbox always has a value, so it cannot be required." });
    if (f.type !== "select" && f.options) ctx.addIssue({ code: "custom", message: "Only a select field takes options." });
    if (f.options && new Set(f.options.map((o) => o.value)).size !== f.options.length) {
      ctx.addIssue({ code: "custom", message: "Option values must be unique." });
    }
  });

const inputSchema = z
  .object({
    title: z.string().min(1).max(120),
    fields: z
      .array(field)
      .min(1)
      .max(12)
      .superRefine((fields, ctx) => {
        if (new Set(fields.map((f) => f.name)).size !== fields.length) ctx.addIssue({ code: "custom", message: "Field names must be unique." });
      }),
    submitLabel: z.string().min(1).max(40).default("Send"),
  })
  .strict();

type FormInput = z.infer<typeof inputSchema>;

/** The text every client gets, also those that render no widget. */
export function formFallback({ title, fields }: Pick<FormInput, "title" | "fields">): string {
  const lines = fields.map((f, i) => {
    const parts: string[] = [f.type];
    if (f.value) parts.push(`forslag: ${f.value}`);
    if (f.options) parts.push(`valg: ${f.options.map((o) => o.label).join(" / ")}`);
    return `${i + 1}. ${f.label} (${parts.join(", ")})`;
  });
  return [`Spurte brukeren (skjema): ${title}`, ...lines, "Vent på svaret i chatten."].join("\n");
}

export function registerFormTool(server: McpServer, ctx: ToolContext): void {
  registerAppTool(
    server,
    "ask_user_form",
    {
      title: "Ask the user to fill in a form",
      description: FORM_DESCRIPTION,
      inputSchema,
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: FORM_RESOURCE_URI } },
    },
    counted(ctx, "ask_user_form", async (args: FormInput) => ({
      content: [{ type: "text", text: formFallback(args) }],
      structuredContent: { title: args.title, fields: args.fields, submitLabel: args.submitLabel },
    })),
  );

  registerAppResource(
    server,
    "Form widget",
    FORM_RESOURCE_URI,
    { description: "A short form for collecting several details from the user at once." },
    async () => ({
      contents: [{ uri: FORM_RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: FORM_HTML }],
    }),
  );
}
