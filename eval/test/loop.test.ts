import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import type { Case } from "../cases/types.js";
import { argsObject, runConversation, WRITES_OFF, type ModelApi, type ToolHost } from "../src/loop.js";

const c: Case = {
  id: "t", area: "utlegg", prompt: "Før et utlegg.", source: "x", reviewed: false,
  replies: { company: "demo", default: "Ja." },
  expect: { operations: ["create_journal_entry"], postings: [] },
};

type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
/** A model that answers with the given turns in order and records each request. */
function fakeModel(turns: Block[][]): ModelApi & { requests: Anthropic.MessageCreateParamsNonStreaming[] } {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  let i = 0;
  return {
    requests,
    async create(params) {
      requests.push(structuredClone(params));
      const content = turns[i++] ?? [{ type: "text", text: "Ferdig." }];
      return { content, usage: { input_tokens: 10, output_tokens: 5 } } as unknown as Anthropic.Message;
    },
  };
}
function fakeHost(results: Record<string, { text: string; structured?: unknown; isError?: boolean }> = {}): ToolHost & { called: string[] } {
  const called: string[] = [];
  return {
    called,
    instructions: "Server instructions.",
    tools: [
      { name: "fiken_read", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
      { name: "preview_booking", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
      { name: "ask_user_choice", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
      { name: "fiken_write", inputSchema: { type: "object" }, annotations: { readOnlyHint: false } },
      { name: "create_purchase", inputSchema: { type: "object" } },
    ],
    async call(name) {
      called.push(name);
      return results[name] ?? { text: "ok" };
    },
  };
}
const use = (id: string, name: string, input: Record<string, unknown>): Block => ({ type: "tool_use", id, name, input });
const jeArgs = { companySlug: "demo", lines: [{ amount: 100, debitAccount: "6800", creditAccount: "1920:10001" }] };

describe("runConversation", () => {
  it("passes the server instructions after the system prompt", async () => {
    const model = fakeModel([]);
    await runConversation({ host: fakeHost(), model, modelId: "m", c });
    expect(model.requests[0]!.system).toBe("Du hjelper brukeren med regnskap i Fiken. Svar på norsk.\n\nServer instructions.");
  });

  it("never forwards a write: fiken_write is blocked, recorded as the proposal, and ends the run", async () => {
    const host = fakeHost();
    const r = await runConversation({ host, model: fakeModel([[use("1", "fiken_write", { operation: "create_journal_entry", args: jeArgs })]]), modelId: "m", c });
    expect(host.called).toEqual([]);
    expect(r.trace.proposal).toEqual({ operation: "create_journal_entry", args: jeArgs, via: "write" });
    expect(r.trace.calls).toEqual([{ name: "fiken_write", args: { operation: "create_journal_entry", args: jeArgs }, blocked: true }]);
    expect(r.transcript.at(-1)).toEqual({ who: "verktøy", text: WRITES_OFF });
  });

  it("blocks a direct write tool without annotations", async () => {
    const host = fakeHost();
    const r = await runConversation({ host, model: fakeModel([[use("1", "create_purchase", { kind: "supplier" })]]), modelId: "m", c });
    expect(host.called).toEqual([]);
    expect(r.trace.proposal).toEqual({ operation: "create_purchase", args: { kind: "supplier" }, via: "write" });
  });

  it("parses args sent as a JSON string", async () => {
    const r = await runConversation({ host: fakeHost(), model: fakeModel([[use("1", "fiken_write", { operation: "create_journal_entry", args: JSON.stringify(jeArgs) })]]), modelId: "m", c });
    expect(r.trace.proposal!.args).toEqual(jeArgs);
  });

  it("forwards a read in the same turn as a write, then blocks the write", async () => {
    const host = fakeHost();
    const r = await runConversation({ host, model: fakeModel([[use("1", "fiken_read", { operation: "list_accounts" }), use("2", "fiken_write", { operation: "create_journal_entry", args: jeArgs })]]), modelId: "m", c });
    expect(host.called).toEqual(["fiken_read"]);
    expect(r.trace.calls.map((x) => x.name)).toEqual(["fiken_read", "fiken_write"]);
  });

  it("approves an ok preview with its ref, and the next write ends the run", async () => {
    const host = fakeHost({ preview_booking: { text: "Forhåndsvisning", structured: { checks: "ok", ref: "abc123" } } });
    const model = fakeModel([[use("1", "preview_booking", { operation: "create_journal_entry", args: jeArgs })], [use("2", "fiken_write", { operation: "create_journal_entry", args: jeArgs })]]);
    const r = await runConversation({ host, model, modelId: "m", c });
    const second = model.requests[1]!.messages.at(-1)!;
    expect(second.content).toEqual([
      { type: "tool_result", tool_use_id: "1", content: "Forhåndsvisning", is_error: false },
      { type: "text", text: "Ja, før dette (ref abc123)." },
    ]);
    expect(r.trace.proposal!.via).toBe("write");
  });

  it("asks for a correction when the preview's checks fail, and keeps the preview as the proposal", async () => {
    const host = fakeHost({ preview_booking: { text: "Feil", structured: { checks: ["Går ikke i balanse"], ref: "x" } } });
    const model = fakeModel([[use("1", "preview_booking", { operation: "create_journal_entry", args: jeArgs })]]);
    const r = await runConversation({ host, model, modelId: "m", c });
    expect(model.requests[1]!.messages.at(-1)!.content).toContainEqual({ type: "text", text: "Forhåndsvisningen viser feil. Kan du rette dem?" });
    expect(r.trace.proposal).toEqual({ operation: "create_journal_entry", args: jeArgs, via: "preview" });
  });

  it("answers ask_user_choice with the company", async () => {
    const model = fakeModel([[use("1", "ask_user_choice", { question: "Hvilket foretak?", options: [{ label: "Demo", value: "demo" }, { label: "B", value: "b" }] })]]);
    await runConversation({ host: fakeHost(), model, modelId: "m", c });
    expect(model.requests[1]!.messages.at(-1)!.content).toContainEqual({ type: "text", text: "Demo (demo)" });
  });

  it("gives the default reply once, then ends after a second turn without tools", async () => {
    const model = fakeModel([[{ type: "text", text: "Hva gjelder det?" }], [{ type: "text", text: "Ok." }], [use("9", "fiken_read", {})]]);
    const r = await runConversation({ host: fakeHost(), model, modelId: "m", c });
    expect(model.requests).toHaveLength(2);
    expect(model.requests[1]!.messages.at(-1)).toEqual({ role: "user", content: "Ja." });
    expect(r.trace.proposal).toBeUndefined();
  });

  it("stops after maxTurns", async () => {
    const turns = Array.from({ length: 30 }, (_, i) => [use(String(i), "fiken_read", {})]);
    const r = await runConversation({ host: fakeHost(), model: fakeModel(turns), modelId: "m", c, maxTurns: 3 });
    expect(r.turns).toBe(3);
  });

  it("records a thrown error and adds up usage", async () => {
    const host = fakeHost();
    host.call = async () => {
      throw new Error("nede");
    };
    const r = await runConversation({ host, model: fakeModel([[use("1", "fiken_read", {})]]), modelId: "m", c });
    expect(r.trace.error).toBe("nede");
    expect(r.usage).toEqual({ input: 10, output: 5 });
  });
});

describe("argsObject", () => {
  it("accepts an object or a JSON string, else {}", () => {
    expect(argsObject({ a: 1 })).toEqual({ a: 1 });
    expect(argsObject('{"a":1}')).toEqual({ a: 1 });
    expect(argsObject("nei")).toEqual({});
    expect(argsObject(undefined)).toEqual({});
  });
});
