import type Anthropic from "@anthropic-ai/sdk";
import type { Case } from "../cases/types.js";
import type { Trace } from "./grade.js";
import type { Proposal } from "./postings.js";
import { answerChoice, answerForm } from "./user.js";

export const SYSTEM_PROMPT = "Du hjelper brukeren med regnskap i Fiken. Svar på norsk.";
export const WRITES_OFF = "Skriving er slått av i evalueringen.";
const MAX_TEXT = 2000;

export type ToolInfo = { name: string; description?: string; inputSchema: Record<string, unknown>; annotations?: { readOnlyHint?: boolean } };
export type ToolResult = { text: string; structured?: unknown; isError?: boolean };
export interface ToolHost {
  tools: ToolInfo[];
  instructions?: string;
  call(name: string, args: Record<string, unknown>): Promise<ToolResult>;
}
export interface ModelApi {
  create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
}
export type TranscriptEntry = { who: "bruker" | "modell" | "verktøy"; text: string };
export type RunResult = { trace: Trace; turns: number; usage: { input: number; output: number }; transcript: TranscriptEntry[] };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const short = (s: string): string => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)} …` : s);

/** Write args as the gateway accepts them: an object, or an object as a JSON string. */
export function argsObject(v: unknown): Record<string, unknown> {
  if (typeof v === "string") {
    try {
      const parsed: unknown = JSON.parse(v);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return isRecord(v) ? v : {};
}

function proposalOf(name: string, args: Record<string, unknown>, via: Proposal["via"]): Proposal {
  if (name === "fiken_write" || name === "preview_booking") return { operation: String(args.operation ?? ""), args: argsObject(args.args), via };
  return { operation: name, args, via };
}

/** What the simulated user answers to a preview: approve an ok one with its ref, else ask for a correction. */
function previewReply(structured: unknown): string {
  if (isRecord(structured) && structured.checks === "ok" && typeof structured.ref === "string") return `Ja, før dette (ref ${structured.ref}).`;
  return "Forhåndsvisningen viser feil. Kan du rette dem?";
}

/**
 * Plays one case. Read-only tools (annotations.readOnlyHint true) are forwarded to the server; every other tool call is
 * blocked, recorded as the proposal and ends the run, so nothing is ever written to Fiken.
 */
export async function runConversation(o: { host: ToolHost; model: ModelApi; modelId: string; c: Case; maxTurns?: number }): Promise<RunResult> {
  const maxTurns = o.maxTurns ?? 25;
  const tools = o.host.tools.map((t) => ({ name: t.name, description: t.description ?? "", input_schema: t.inputSchema as Anthropic.Tool.InputSchema }));
  const readOnly = new Set(o.host.tools.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name));
  const system = o.host.instructions ? `${SYSTEM_PROMPT}\n\n${o.host.instructions}` : SYSTEM_PROMPT;
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: o.c.prompt }];
  const trace: Trace = { calls: [] };
  const transcript: TranscriptEntry[] = [{ who: "bruker", text: o.c.prompt }];
  const usage = { input: 0, output: 0 };
  let turns = 0;
  let quiet = 0;

  try {
    while (turns < maxTurns) {
      turns++;
      const res = await o.model.create({ model: o.modelId, max_tokens: 4096, system, tools, messages });
      usage.input += res.usage.input_tokens;
      usage.output += res.usage.output_tokens;
      messages.push({ role: "assistant", content: res.content });
      for (const b of res.content) if (b.type === "text" && b.text.trim() !== "") transcript.push({ who: "modell", text: short(b.text) });

      const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (uses.length === 0) {
        quiet++;
        if (quiet >= 2) break;
        messages.push({ role: "user", content: o.c.replies.default });
        transcript.push({ who: "bruker", text: o.c.replies.default });
        continue;
      }
      quiet = 0;

      const results: Anthropic.ToolResultBlockParam[] = [];
      let reply: string | undefined;
      for (const u of uses) {
        const args = isRecord(u.input) ? u.input : {};
        transcript.push({ who: "modell", text: short(`${u.name} ${JSON.stringify(args)}`) });
        if (!readOnly.has(u.name)) {
          trace.calls.push({ name: u.name, args, blocked: true });
          trace.proposal = proposalOf(u.name, args, "write");
          transcript.push({ who: "verktøy", text: WRITES_OFF });
          return { trace, turns, usage, transcript };
        }
        trace.calls.push({ name: u.name, args });
        const r = await o.host.call(u.name, args);
        transcript.push({ who: "verktøy", text: short(r.text) });
        results.push({ type: "tool_result", tool_use_id: u.id, content: r.text, is_error: r.isError === true });
        if (u.name === "preview_booking") {
          trace.proposal = proposalOf(u.name, args, "preview");
          reply = previewReply(r.structured);
        }
        if (u.name === "ask_user_choice") reply = answerChoice(args, o.c.replies);
        if (u.name === "ask_user_form") reply = answerForm(args, o.c.replies);
      }
      const content: Array<Anthropic.ToolResultBlockParam | Anthropic.TextBlockParam> = [...results];
      if (reply !== undefined) {
        content.push({ type: "text", text: reply });
        transcript.push({ who: "bruker", text: reply });
      }
      messages.push({ role: "user", content });
    }
  } catch (err) {
    trace.error = err instanceof Error ? err.message : String(err);
  }
  return { trace, turns, usage, transcript };
}
