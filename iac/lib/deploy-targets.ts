import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Which stacks a change to each path needs deployed. deploy.yml pipes the
 * files changed since the last successful deploy into this script, which
 * runs under Node's built-in type stripping (no install needed), so keep it
 * free of imports beyond node:* and of non-erasable TypeScript syntax.
 */
export type StackKey = "iac" | "web" | "api";
export const STACK_KEYS: StackKey[] = ["iac", "web", "api"];

const SHARED = new Set(["package.json", "package-lock.json", "tsconfig.base.json", ".github/workflows/deploy.yml"]);

export function stacksFor(path: string): StackKey[] {
  if (SHARED.has(path)) return ["iac", "web", "api"];
  if (path.startsWith("iac/test/") || path.startsWith("api/test/") || path === "iac/lib/deploy-targets.ts") return [];
  if (path.startsWith("web/") || path === "iac/lib/web-stack.ts") return ["web"];
  if (path === "iac/lib/iac-stack.ts") return ["iac"];
  // exec-policy.ts holds the site constants too, so it feeds both stacks.
  if (path.startsWith("iac/")) return ["iac", "web"];
  if (path.startsWith("api/")) return ["api"];
  return [];
}

export function deployTargets(paths: string[]): Record<StackKey, boolean> {
  const targets: Record<StackKey, boolean> = { iac: false, web: false, api: false };
  for (const raw of paths) {
    const path = raw.trim();
    if (path === "") continue;
    for (const key of stacksFor(path)) targets[key] = true;
  }
  return targets;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const targets = deployTargets(readFileSync(0, "utf8").split("\n"));
  for (const key of STACK_KEYS) console.log(`${key}=${targets[key]}`);
}
