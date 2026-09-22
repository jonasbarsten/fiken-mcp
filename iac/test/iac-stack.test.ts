import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { IacStack } from "../lib/iac-stack.js";
import { synthesizer } from "../lib/synthesizer.js";

function synth() {
  const app = new App();
  const stack = new IacStack(app, "fiken-mcp-iac", {
    env: { account: "209479295726", region: "eu-west-1" },
    synthesizer: synthesizer(),
  });
  return Template.fromStack(stack);
}

describe("IacStack", () => {
  it("creates the usage table with PK/SK, on-demand billing and retain", () => {
    const t = synth();
    t.hasResourceProperties("AWS::DynamoDB::GlobalTable", {
      TableName: "fiken-mcp-usage",
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [
        { AttributeName: "PK", KeyType: "HASH" },
        { AttributeName: "SK", KeyType: "RANGE" },
      ],
    });
    t.hasResource("AWS::DynamoDB::GlobalTable", { DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain" });
  });

  it("creates the GitHub OIDC provider", () => {
    synth().hasResourceProperties("Custom::AWSCDKOpenIdConnectProvider", {
      Url: "https://token.actions.githubusercontent.com",
      ClientIDList: ["sts.amazonaws.com"],
    });
  });

  it("pins the deploy role to the repo's production environment and the fikenmcp bootstrap roles", () => {
    const t = synth();
    t.hasResourceProperties("AWS::IAM::Role", {
      RoleName: "fiken-mcp-github-deploy",
      AssumeRolePolicyDocument: {
        Statement: [
          {
            Action: "sts:AssumeRoleWithWebIdentity",
            Effect: "Allow",
            Condition: {
              StringEquals: {
                "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
                "token.actions.githubusercontent.com:sub": "repo:jonasbarsten/fiken-mcp:environment:production",
              },
            },
          },
        ],
      },
    });
    t.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: [
          {
            Action: "sts:AssumeRole",
            Effect: "Allow",
            Resource: "arn:aws:iam::209479295726:role/cdk-fikenmcp-*-role-209479295726-eu-west-1",
          },
        ],
      },
    });
  });

  it("creates the scoped execution policy and uses it as the boundary on every role", () => {
    const t = synth();
    t.hasResourceProperties("AWS::IAM::ManagedPolicy", {
      ManagedPolicyName: "fiken-mcp-cfn-exec",
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(["iam:CreateRole", "iam:PutRolePolicy"]),
            Condition: {
              StringEquals: {
                "iam:PermissionsBoundary": "arn:aws:iam::209479295726:policy/fiken-mcp-cfn-exec",
              },
            },
          }),
        ]),
      },
    });
    const roles = t.findResources("AWS::IAM::Role");
    expect(Object.keys(roles).length).toBeGreaterThan(0);
    for (const role of Object.values(roles)) {
      expect(role.Properties.PermissionsBoundary).toBeDefined();
    }
  });

  it("exports the table and outputs the arns", () => {
    const t = synth();
    t.hasOutput("UsageTableName", { Export: { Name: "fiken-mcp-usage-table-name" } });
    t.hasOutput("UsageTableArn", { Export: { Name: "fiken-mcp-usage-table-arn" } });
    t.hasOutput("DeployRoleArn", {});
    t.hasOutput("ExecPolicyArn", {});
  });
});
