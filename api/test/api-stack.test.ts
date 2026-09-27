import { App, Tags } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ApiStack } from "../lib/api-stack.js";
import { synthesizer } from "../lib/synthesizer.js";

// The first synth bundles the Lambda with esbuild; on a loaded machine or CI runner it exceeds vitest's 5 s default.
const STACK_TEST_TIMEOUT_MS = 60_000;

function synth() {
  const app = new App();
  const stack = new ApiStack(app, "fiken-mcp-api", { env: { account: "209479295726", region: "eu-west-1" }, synthesizer: synthesizer() });
  return Template.fromStack(stack);
}

describe("ApiStack", () => {
  it("creates the function with reserved concurrency 1 on Node 24 arm64 and a 30-day log group", () => {
    const t = synth();
    t.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "fiken-mcp-api",
      Runtime: "nodejs24.x",
      Architectures: ["arm64"],
      ReservedConcurrentExecutions: 1,
      Environment: { Variables: { PUBLIC_URL: "https://api.fiken-mcp.byjoba.com", PARAM_PREFIX: "/fiken_mcp" } },
    });
    t.hasResourceProperties("AWS::Logs::LogGroup", { LogGroupName: "/aws/lambda/fiken-mcp-api", RetentionInDays: 30 });
    t.hasResourceProperties("AWS::Logs::LogGroup", { LogGroupName: "/aws/apigateway/fiken-mcp-api", RetentionInDays: 30 });
  });

  it("applies the permissions boundary to every role", () => {
    const roles = synth().findResources("AWS::IAM::Role");
    expect(Object.keys(roles).length).toBeGreaterThan(0);
    for (const role of Object.values(roles)) expect(role.Properties.PermissionsBoundary).toBeDefined();
  });

  // CDK (without the @aws-cdk/aws-iam:minimizePolicies context flag, which
  // iac/cdk.json also does not set) does not merge same-action grants into
  // one statement with a resource array; it emits one single-resource
  // statement per grantRead() call. So we assert four statements whose
  // resource suffixes are exactly the four /fiken_mcp/* parameter ARNs,
  // rather than the brief's single merged-array shape.
  it("grants read on exactly the four parameters", () => {
    const policies = synth().findResources("AWS::IAM::Policy");
    expect(Object.keys(policies)).toHaveLength(1);
    const statements = Object.values(policies)[0]!.Properties.PolicyDocument.Statement as Array<{
      Action: string[];
      Effect: string;
      Resource: { "Fn::Join": [string, unknown[]] };
    }>;
    expect(statements).toHaveLength(4);
    for (const statement of statements) {
      expect(statement.Action).toEqual(["ssm:DescribeParameters", "ssm:GetParameters", "ssm:GetParameter", "ssm:GetParameterHistory"]);
      expect(statement.Effect).toBe("Allow");
    }
    const resourceSuffixes = statements
      .map((s) => s.Resource["Fn::Join"][1] as string[])
      .map((parts) => parts[parts.length - 1]);
    expect(resourceSuffixes.sort()).toEqual(
      [
        ":ssm:eu-west-1:209479295726:parameter/fiken_mcp/client_id",
        ":ssm:eu-west-1:209479295726:parameter/fiken_mcp/client_secret",
        ":ssm:eu-west-1:209479295726:parameter/fiken_mcp/signing_key",
        ":ssm:eu-west-1:209479295726:parameter/fiken_mcp/user_salt",
      ].sort(),
    );
  });

  it("throttles the stage and writes access logs without headers", () => {
    const t = synth();
    t.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
      StageName: "$default",
      DefaultRouteSettings: { ThrottlingRateLimit: 20, ThrottlingBurstLimit: 40 },
      AccessLogSettings: { Format: Match.stringLikeRegexp("requestId") },
    });
    const stage = Object.values(t.findResources("AWS::ApiGatewayV2::Stage"))[0]!;
    expect(String(stage.Properties.AccessLogSettings.Format)).not.toMatch(/authorization|header/i);
  });

  it("maps the api onto the domain exported by the iac stack and owns no certificate or DNS", () => {
    const t = synth();
    t.hasResourceProperties("AWS::ApiGatewayV2::ApiMapping", {
      DomainName: { "Fn::ImportValue": "fiken-mcp-api-domain-name" },
      Stage: "$default",
    });
    t.resourceCountIs("AWS::ApiGatewayV2::DomainName", 0);
    t.resourceCountIs("AWS::CertificateManager::Certificate", 0);
    t.resourceCountIs("AWS::Route53::RecordSet", 0);
    t.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "ANY /{proxy+}" });
    t.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "ANY /" });
    t.hasResourceProperties("AWS::ApiGatewayV2::Api", { DisableExecuteApiEndpoint: true });
    expect(Object.keys(t.findOutputs("ApiUrl")).length).toBe(1);
  });

  it("tags the function with Project=fiken-mcp", () => {
    const app = new App();
    const stack = new ApiStack(app, "fiken-mcp-api", { env: { account: "209479295726", region: "eu-west-1" }, synthesizer: synthesizer() });
    Tags.of(app).add("Project", "fiken-mcp");
    const t = Template.fromStack(stack);

    t.hasResourceProperties("AWS::Lambda::Function", {
      Tags: Match.arrayWith([{ Key: "Project", Value: "fiken-mcp" }]),
    });
  });
}, STACK_TEST_TIMEOUT_MS);
