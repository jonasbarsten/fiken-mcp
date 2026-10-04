import { describe, expect, it } from "vitest";
import { deployTargets, stacksFor } from "../lib/deploy-targets.js";

describe("stacksFor", () => {
  it.each([
    ["web/index.html", ["web"]],
    ["web/site.js", ["web"]],
    ["iac/lib/web-stack.ts", ["web"]],
    ["iac/lib/iac-stack.ts", ["iac"]],
    ["iac/lib/exec-policy.ts", ["iac", "web"]],
    ["iac/bin/iac.ts", ["iac", "web"]],
    ["iac/lib/synthesizer.ts", ["iac", "web"]],
    ["iac/package.json", ["iac", "web"]],
    ["iac/cdk.json", ["iac", "web"]],
    ["api/src/mcp/context.ts", ["api"]],
    ["api/lib/api-stack.ts", ["api"]],
    ["api/package.json", ["api"]],
    ["api/src/assets/icon.png", ["web", "api"]],
    ["package.json", ["iac", "web", "api"]],
    ["package-lock.json", ["iac", "web", "api"]],
    ["tsconfig.base.json", ["iac", "web", "api"]],
    [".github/workflows/deploy.yml", ["iac", "web", "api"]],
    ["iac/test/web-stack.test.ts", []],
    ["api/test/mcp/tools.test.ts", []],
    ["iac/lib/deploy-targets.ts", []],
    ["docs/setup.md", []],
    ["README.md", []],
    ["LICENSE", []],
    ["CLAUDE.md", []],
    [".github/workflows/ci.yml", []],
    ["webby.txt", []],
  ])("%s -> %j", (path, expected) => {
    expect(stacksFor(path)).toEqual(expected);
  });
});

describe("deployTargets", () => {
  it("deploys nothing for no changes", () => {
    expect(deployTargets([])).toEqual({ iac: false, web: false, api: false });
  });

  it("deploys only the web stack for a web-only change", () => {
    expect(deployTargets(["web/index.html", "web/style.css"])).toEqual({ iac: false, web: true, api: false });
  });

  it("deploys only the api for an api change plus docs", () => {
    expect(deployTargets(["api/src/app.ts", "docs/setup.md", "README.md"])).toEqual({ iac: false, web: false, api: true });
  });

  it("combines flags across paths", () => {
    expect(deployTargets(["iac/lib/iac-stack.ts", "web/index.html"])).toEqual({ iac: true, web: true, api: false });
  });

  it("ignores blank lines and surrounding whitespace", () => {
    expect(deployTargets(["", "  web/index.html  ", " "])).toEqual({ iac: false, web: true, api: false });
  });
});
