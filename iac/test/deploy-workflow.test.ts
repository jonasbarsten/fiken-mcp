import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(new URL("../../.github/workflows/deploy.yml", import.meta.url), "utf8");

describe("deploy.yml", () => {
  it("gates each deploy step on its own flag, in the order iac, web, content, api", () => {
    const steps = [
      ...workflow.matchAll(/- if: needs\.changes\.outputs\.(\w+) == 'true'\s*\n\s*(?:shell: bash\s*\n\s*)?run: (npx cdk deploy (fiken-mcp-\w+) |\|)/g),
    ].map((m) => [m[1], m[3] ?? "content"]);
    expect(steps).toEqual([
      ["iac", "fiken-mcp-iac"],
      ["web", "fiken-mcp-web"],
      ["content", "content"],
      ["api", "fiken-mcp-api"],
    ]);
  });

  it("ships the site content with a pruning sync, the icon and a full invalidation, outside CloudFormation", () => {
    expect(workflow).toContain('aws s3 sync web/ "s3://$bucket" --delete --exclude icon.png');
    expect(workflow).toContain('aws s3 cp api/src/assets/icon.png "s3://$bucket/icon.png"');
    expect(workflow).toContain("aws cloudfront create-invalidation --distribution-id \"$distribution\" --paths '/*'");
    expect(workflow).toContain("Outputs[?OutputKey=='DistributionId'].OutputValue");
  });

  it("gives every uploaded file a short browser cache", () => {
    expect(workflow).toContain('cache="public, max-age=300"');
    expect(workflow).toContain('--delete --exclude icon.png --cache-control "$cache"');
    expect(workflow).toContain('"s3://$bucket/icon.png" --cache-control "$cache"');
  });

  it("sets all four flags when there is no successful deploy to compare with", () => {
    expect(workflow).toContain("printf 'iac=true\\nweb=true\\ncontent=true\\napi=true\\n'");
    expect(workflow).toContain("content: ${{ steps.targets.outputs.content }}");
  });

  it("asks for production approval only when something will deploy", () => {
    expect(workflow).toContain(
      "if: needs.changes.outputs.iac == 'true' || needs.changes.outputs.web == 'true' || needs.changes.outputs.content == 'true' || needs.changes.outputs.api == 'true'",
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
