import { describe, expect, it } from "vitest";
import { STACK_KEYS, deployTargets, stacksFor } from "../lib/deploy-targets.js";

describe("stacksFor", () => {
  it.each([
    ["web/index.html", ["content"]],
    ["web/site.js", ["content"]],
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
    ["api/src/assets/icon.png", ["content", "api"]],
    ["package.json", ["iac", "web", "content", "api"]],
    ["package-lock.json", ["iac", "web", "content", "api"]],
    ["tsconfig.base.json", ["iac", "web", "content", "api"]],
    [".github/workflows/deploy.yml", ["iac", "web", "content", "api"]],
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
  const none = { iac: false, web: false, content: false, api: false };

  it("lists the four stack keys in deploy order", () => {
    expect(STACK_KEYS).toEqual(["iac", "web", "content", "api"]);
  });

  it("deploys nothing for no changes", () => {
    expect(deployTargets([])).toEqual(none);
  });

  it("deploys only the content for a web-only change", () => {
    expect(deployTargets(["web/index.html", "web/style.css"])).toEqual({ ...none, content: true });
  });

  it("deploys only the api for an api change plus docs", () => {
    expect(deployTargets(["api/src/app.ts", "docs/setup.md", "README.md"])).toEqual({ ...none, api: true });
  });

  it("combines flags across paths", () => {
    expect(deployTargets(["iac/lib/iac-stack.ts", "web/index.html"])).toEqual({ ...none, iac: true, content: true });
  });

  it("ignores blank lines and surrounding whitespace", () => {
    expect(deployTargets(["", "  web/index.html  ", " "])).toEqual({ ...none, content: true });
  });
});
