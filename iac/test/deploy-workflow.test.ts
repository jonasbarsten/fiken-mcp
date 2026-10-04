import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(new URL("../../.github/workflows/deploy.yml", import.meta.url), "utf8");

describe("deploy.yml", () => {
  it("gates each stack's deploy step on its own flag, in the order iac, web, api", () => {
    const steps = [...workflow.matchAll(/if: needs\.changes\.outputs\.(\w+) == 'true'\s*\n\s*run: npx cdk deploy (fiken-mcp-\w+) /g)].map(
      (m) => [m[1], m[2]],
    );
    expect(steps).toEqual([
      ["iac", "fiken-mcp-iac"],
      ["web", "fiken-mcp-web"],
      ["api", "fiken-mcp-api"],
    ]);
  });

  it("asks for production approval only when something will deploy", () => {
    expect(workflow).toContain(
      "if: needs.changes.outputs.iac == 'true' || needs.changes.outputs.web == 'true' || needs.changes.outputs.api == 'true'",
    );
    expect(workflow).toMatch(/environment: production/);
  });

  it("diffs against the last successful deploy, not the previous commit", () => {
    expect(workflow).toContain("--status success");
    expect(workflow).toContain("fetch-depth: 0");
    expect(workflow).toContain("node iac/lib/deploy-targets.ts");
    expect(workflow).not.toContain("HEAD~1");
  });

  it("fails the change detection step when any piped command fails", () => {
    expect(workflow).toMatch(/- id: targets\s*\n\s*shell: bash\n/);
  });
});
