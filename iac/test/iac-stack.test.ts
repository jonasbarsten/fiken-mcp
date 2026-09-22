import { App, Tags } from "aws-cdk-lib";
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
            Resource: [
              "arn:aws:iam::209479295726:role/cdk-fikenmcp-deploy-role-209479295726-eu-west-1",
              "arn:aws:iam::209479295726:role/cdk-fikenmcp-file-publishing-role-209479295726-eu-west-1",
            ],
          },
        ],
      },
    });
  });

  it("never allows assuming the lookup role or a wildcard of bootstrap roles", () => {
    const t = synth();
    const policies = { ...t.findResources("AWS::IAM::Policy"), ...t.findResources("AWS::IAM::ManagedPolicy") };
    expect(Object.keys(policies).length).toBeGreaterThan(1);
    let assumeStatements = 0;
    for (const policy of Object.values(policies)) {
      for (const statement of policy.Properties.PolicyDocument.Statement as Array<{ Effect: string; Action: string | string[]; Resource?: string | string[] }>) {
        const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
        if (statement.Effect !== "Allow" || !actions.includes("sts:AssumeRole")) continue;
        assumeStatements++;
        const resources = Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource];
        for (const resource of resources) {
          expect(resource).not.toContain("lookup-role");
          expect(resource).not.toMatch(/cdk-fikenmcp-\*/);
          expect(resource).toMatch(/^arn:aws:iam::209479295726:role\/cdk-fikenmcp-(deploy|file-publishing)-role-209479295726-eu-west-1$/);
        }
      }
    }
    expect(assumeStatements).toBe(2);
  });

  it("denies removing or replacing a permissions boundary", () => {
    synth().hasResourceProperties("AWS::IAM::ManagedPolicy", {
      ManagedPolicyName: "fiken-mcp-cfn-exec",
      PolicyDocument: {
        Statement: Match.arrayWith([
          {
            Sid: "DenyBoundaryRemoval",
            Effect: "Deny",
            Action: ["iam:PutRolePermissionsBoundary", "iam:DeleteRolePermissionsBoundary"],
            Resource: "*",
          },
        ]),
      },
    });
  });

  it("allows iam:UpdateRole without the boundary condition, which UpdateRole cannot satisfy", () => {
    const t = synth();
    const [policy] = Object.values(t.findResources("AWS::IAM::ManagedPolicy", { Properties: { ManagedPolicyName: "fiken-mcp-cfn-exec" } }));
    const statements = policy!.Properties.PolicyDocument.Statement as Array<{ Sid?: string; Action: string[]; Condition?: unknown }>;
    const withUpdateRole = statements.filter((s) => s.Action.includes("iam:UpdateRole"));
    expect(withUpdateRole).toHaveLength(1);
    expect(withUpdateRole[0]!.Sid).toBe("RolesRead");
    expect(withUpdateRole[0]!.Condition).toBeUndefined();
    const boundaryConditioned = statements.find((s) => s.Sid === "RolesWithBoundary");
    expect(boundaryConditioned!.Action).not.toContain("iam:UpdateRole");
  });

  it("lets the execution role read the bootstrap version parameter", () => {
    synth().hasResourceProperties("AWS::IAM::ManagedPolicy", {
      ManagedPolicyName: "fiken-mcp-cfn-exec",
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: "Parameters",
            Resource: Match.arrayWith([
              "arn:aws:ssm:eu-west-1:209479295726:parameter/fiken_mcp/*",
              "arn:aws:ssm:eu-west-1:209479295726:parameter/cdk-bootstrap/fikenmcp/*",
            ]),
          }),
        ]),
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

  it("tags every taggable resource with Project=fiken-mcp", () => {
    const app = new App();
    const stack = new IacStack(app, "fiken-mcp-iac", {
      env: { account: "209479295726", region: "eu-west-1" },
      synthesizer: synthesizer(),
    });
    Tags.of(app).add("Project", "fiken-mcp");
    const t = Template.fromStack(stack);

    // TableV2 synthesizes to AWS::DynamoDB::GlobalTable, which carries tags
    // per replica (Replicas[].Tags), not as a top-level Tags property.
    t.hasResourceProperties("AWS::DynamoDB::GlobalTable", {
      Replicas: Match.arrayWith([
        Match.objectLike({ Tags: Match.arrayWith([{ Key: "Project", Value: "fiken-mcp" }]) }),
      ]),
    });

    const roles = t.findResources("AWS::IAM::Role");
    expect(Object.keys(roles).length).toBeGreaterThan(0);
    for (const role of Object.values(roles)) {
      expect(role.Properties.Tags).toEqual(expect.arrayContaining([{ Key: "Project", Value: "fiken-mcp" }]));
    }
  });

  it("never grants an unconditioned wildcard resource except known read-only actions", () => {
    const t = synth();
    const policies = t.findResources("AWS::IAM::ManagedPolicy");
    expect(Object.keys(policies).length).toBeGreaterThan(0);
    for (const policy of Object.values(policies)) {
      const statements = policy.Properties.PolicyDocument.Statement as Array<{
        Sid?: string;
        Effect: string;
        Resource?: string | string[];
        Condition?: unknown;
      }>;
      for (const statement of statements) {
        if (statement.Effect === "Deny") continue;
        const resources = Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource];
        const hasWildcard = resources.includes("*");
        if (!hasWildcard) continue;
        const isKnownReadOnly = statement.Sid !== undefined && ["DnsRead", "DynamoRead"].includes(statement.Sid);
        expect(statement.Condition !== undefined || isKnownReadOnly).toBe(true);
      }
    }
  });
});
