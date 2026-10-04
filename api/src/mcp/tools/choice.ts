import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { CHOICE_HTML } from "../../assets.js";
import { counted, type ToolContext } from "../context.js";

/** One stable URI for the widget, never versioned per build (see UPLOAD_RESOURCE_URI). */
export const CHOICE_RESOURCE_URI = "ui://fiken-mcp/choice.html";

const CHOICE_DESCRIPTION =
  "Show the user a question with 2–12 options as buttons (in clients that render widgets; others get a numbered list). " +
  "The answer comes back as the user's next chat message. Use it whenever the user must choose: which company, which " +
  "customer or supplier, which account, or between alternatives you propose. Fill options from the read operations " +
  "(e.g. list_companies, search_contacts, list_accounts).";

const option = z
  .object({
    label: z.string().min(1).max(80).describe("What the button shows."),
    value: z.string().min(1).max(200).describe("The identifier that comes back with the answer, e.g. a companySlug."),
    description: z.string().max(200).optional().describe("A short second line under the label."),
  })
  .strict();

const inputSchema = z
  .object({
    question: z.string().min(1).max(300),
    options: z
      .array(option)
      .min(2)
      .max(12)
      .superRefine((opts, ctx) => {
        if (new Set(opts.map((o) => o.value)).size !== opts.length) ctx.addIssue({ code: "custom", message: "Option values must be unique." });
      }),
    allowOther: z.boolean().optional().describe("Also offer a free-text field."),
  })
  .strict();

type ChoiceInput = z.infer<typeof inputSchema>;

/** The text every client gets, also those that render no widget. */
export function choiceFallback({ question, options }: Pick<ChoiceInput, "question" | "options">): string {
  const lines = options.map((o, i) => `${i + 1}. ${o.label}${o.description ? ` – ${o.description}` : ""}`);
  return [`Spurte brukeren: ${question}`, ...lines, "Vent på svaret i chatten."].join("\n");
}

export function registerChoiceTool(server: McpServer, ctx: ToolContext): void {
  registerAppTool(
    server,
    "ask_user_choice",
    {
      title: "Ask the user to choose",
      description: CHOICE_DESCRIPTION,
      inputSchema,
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: CHOICE_RESOURCE_URI } },
    },
    counted(ctx, "ask_user_choice", async (args: ChoiceInput) => ({
      content: [{ type: "text", text: choiceFallback(args) }],
      structuredContent: { question: args.question, options: args.options, allowOther: args.allowOther ?? false },
    })),
  );

  registerAppResource(
    server,
    "Choice widget",
    CHOICE_RESOURCE_URI,
    { description: "Buttons for answering a multiple-choice question from the assistant." },
    async () => ({
      contents: [{ uri: CHOICE_RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: CHOICE_HTML }],
    }),
  );
}
