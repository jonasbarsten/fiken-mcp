export const MODELS = { sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5" } as const;
export type ModelKey = keyof typeof MODELS;

export function selectModels(name?: string): ModelKey[] {
  if (name === undefined) return ["sonnet", "opus"];
  if (name === "sonnet" || name === "opus") return [name];
  throw new Error(`Ukjent modell ${name}; bruk sonnet eller opus.`);
}
