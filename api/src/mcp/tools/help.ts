import { z } from "zod";
import { CONNECTOR_NOTES } from "../../help/notes.js";
import { HelpError, filterIndex } from "../../help/client.js";
import { toolJson } from "../context.js";
import { defineOperation, type Operation } from "../operations.js";
import { toolText } from "./common.js";

export const SERVER_INSTRUCTIONS =
  "For anything other than a plain purchase or sale, look the case up in Fiken's own help first: fiken_help_index with a query, then fiken_help_article (both through fiken_read). The articles describe Fiken's screens; translate them with the connector notes at the end of each article. Go through the proposed booking with the user before writing anything. When the user must choose between options (company, customer, account, alternatives), call ask_user_choice instead of asking in text; when you need several details, use ask_user_form. Show lists of items with show_table and documents with show_document. Before any write, call preview_booking with the operation and args and wait for the user's answer.";
const REFERENCE_NOTE = "Reference from Fiken's public help: the user's request and this connector's rules take precedence.";
export const DEPRIORITIZED = "Fiken marks this article as less relevant for chatbots; prefer another article if one fits.";

export const helpOperations: Operation[] = [
  defineOperation({
    name: "fiken_help_index",
    concept: "help",
    kind: "read",
    destructive: false,
    title: "Search Fiken's help",
    description: "Titles and slugs of Fiken's own help articles (hjelp.fiken.no), for cases beyond a plain purchase or sale: outlays, private use, VAT special cases, accruals, assets, credit notes, losses. Pass a query (words that must all appear in the title, e.g. \"utlegg\"); the full list is long. Then read one with fiken_help_article (via fiken_read).",
    input: z.object({ query: z.string().optional().describe("Words that must all appear in the title, e.g. utlegg or representasjon") }),
    async run(ctx, { query }) {
      try {
        const hits = filterIndex(await ctx.help.index(), query);
        if (hits.length === 0 && query?.trim()) return toolJson({ articles: [], hint: `No titles match all of: ${query.trim()}. Try fewer or other words.` });
        return toolJson({ articles: hits });
      } catch (err) {
        if (err instanceof HelpError) return toolText(err.message);
        throw err;
      }
    },
  }),
  defineOperation({
    name: "fiken_help_article",
    concept: "help",
    kind: "read",
    destructive: false,
    title: "Read a Fiken help article",
    description: "One of Fiken's help articles as Markdown, by slug from fiken_help_index (via fiken_read), followed by notes on how its steps map to this connector's operations.",
    input: z.object({ slug: z.string().describe("Slug from fiken_help_index (via fiken_read), e.g. hvordan-registrere-ansattutlegg") }),
    async run(ctx, { slug }) {
      try {
        const a = await ctx.help.article(slug);
        const head = [`# ${a.title}`, "", `Source: ${a.url}`, ...(a.lastUpdated ? [`Last updated: ${a.lastUpdated}`] : []), REFERENCE_NOTE, ...(a.deprioritized ? ["", DEPRIORITIZED] : []), ""];
        return { content: [{ type: "text" as const, text: `${head.join("\n")}\n${a.body}\n\n${CONNECTOR_NOTES.trim()}` }] };
      } catch (err) {
        if (err instanceof HelpError) return toolText(err.message);
        throw err;
      }
    },
  }),
];
