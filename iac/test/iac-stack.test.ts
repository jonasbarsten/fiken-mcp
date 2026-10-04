import { App, Tags } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { CERTIFICATE_ARN, IacStack } from "../lib/iac-stack.js";
import { synthesizer } from "../lib/synthesizer.js";

// The first synth in a file is the slow one; on a loaded machine or CI runner it exceeds vitest's 5 s default.
const STACK_TEST_TIMEOUT_MS = 60_000;

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
                "token.actions.githubusercontent.com:sub": "repo:jonasbarsten@6729295/fiken-mcp@1381698499:environment:production",
              },
            },
          },
        ],
      },
    });
    t.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          {
            Action: "sts:AssumeRole",
            Effect: "Allow",
            Resource: [
              "arn:aws:iam::209479295726:role/cdk-fikenmcp-deploy-role-209479295726-eu-west-1",
              "arn:aws:iam::209479295726:role/cdk-fikenmcp-file-publishing-role-209479295726-eu-west-1",
            ],
          },
        ]),
      },
    });
  });

  it("lets the deploy role ship the site content directly: sync the bucket, invalidate CloudFront, read the web stack's outputs", () => {
    const t = synth();
    const [policy] = Object.values(t.findResources("AWS::IAM::Policy"));
    const statements = policy!.Properties.PolicyDocument.Statement as Array<{ Effect: string; Action: string | string[]; Resource: unknown }>;
    const others = statements.filter((s) => s.Action !== "sts:AssumeRole");
    expect(others).toEqual([
      { Effect: "Allow", Action: "s3:ListBucket", Resource: "arn:aws:s3:::fiken-mcp-web-209479295726" },
      { Effect: "Allow", Action: ["s3:PutObject", "s3:DeleteObject"], Resource: "arn:aws:s3:::fiken-mcp-web-209479295726/*" },
      {
        Effect: "Allow",
        Action: ["cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"],
        Resource: {
          "Fn::Join": ["", ["arn:aws:cloudfront::209479295726:distribution/", { "Fn::ImportValue": "fiken-mcp-web-distribution-id" }]],
        },
      },
      { Effect: "Allow", Action: "cloudformation:DescribeStacks", Resource: "arn:aws:cloudformation:eu-west-1:209479295726:stack/fiken-mcp-web/*" },
    ]);
  });

  it("lets the execution policy, which bounds the deploy role, read stack outputs", () => {
    synth().hasResourceProperties("AWS::IAM::ManagedPolicy", {
      ManagedPolicyName: "fiken-mcp-cfn-exec",
      PolicyDocument: {
        Statement: Match.arrayWith([
          {
            Sid: "StackOutputsRead",
            Effect: "Allow",
            Action: "cloudformation:DescribeStacks",
            Resource: "arn:aws:cloudformation:eu-west-1:209479295726:stack/fiken-mcp-*/*",
          },
        ]),
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

  it("owns the custom domain and the alias record for api.fiken-mcp.byjoba.com, imports the hand-made certificate, and exports the domain", () => {
    const t = synth();
    t.resourceCountIs("AWS::CertificateManager::Certificate", 0);
    expect(CERTIFICATE_ARN).toMatch(/^arn:aws:acm:eu-west-1:209479295726:certificate\/[0-9a-f-]{36}$/);
    t.hasResourceProperties("AWS::ApiGatewayV2::DomainName", {
      DomainName: "api.fiken-mcp.byjoba.com",
      DomainNameConfigurations: [Match.objectLike({ CertificateArn: CERTIFICATE_ARN })],
    });
    t.hasResourceProperties("AWS::Route53::RecordSet", {
      Name: "api.fiken-mcp.byjoba.com.",
      Type: "A",
      HostedZoneId: "Z04810525CNVQNP7ALNV",
    });
    t.hasOutput("ApiDomainName", { Export: { Name: "fiken-mcp-api-domain-name" } });
    t.hasOutput("ApiDomainRegionalDomainName", { Export: { Name: "fiken-mcp-api-domain-regional-domain-name" } });
    t.hasOutput("ApiDomainRegionalHostedZoneId", { Export: { Name: "fiken-mcp-api-domain-regional-hosted-zone-id" } });
  });

  it("owns the A and AAAA alias records for the apex site, aliasing the distribution imported from the web stack", () => {
    const t = synth();
    for (const type of ["A", "AAAA"]) {
      t.hasResourceProperties("AWS::Route53::RecordSet", {
        Name: "fiken-mcp.byjoba.com.",
        Type: type,
        HostedZoneId: "Z04810525CNVQNP7ALNV",
        AliasTarget: Match.objectLike({ DNSName: { "Fn::ImportValue": "fiken-mcp-web-distribution-domain-name" }, HostedZoneId: { "Fn::FindInMap": ["AWSCloudFrontPartitionHostedZoneIdMap", { Ref: "AWS::Partition" }, "zoneId"] } }),
      });
    }
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
        // LogDelivery is not read-only, but CloudWatch Logs delivery has no resource scoping at all.
        // CloudFrontCreate is create-only: CloudFront's create actions have no resource-level permissions.
        const isKnownReadOnly = statement.Sid !== undefined && ["DnsRead", "DynamoRead", "CertificatesRead", "LogDelivery", "CloudFrontCreate"].includes(statement.Sid);
        expect(statement.Condition !== undefined || isKnownReadOnly).toBe(true);
      }
    }
  });

  it("grants exactly the CloudWatch Logs delivery set API Gateway access logging needs, and nothing that reads log events", () => {
    const t = synth();
    const policy = Object.values(t.findResources("AWS::IAM::ManagedPolicy"))[0]!;
    const statements = policy.Properties.PolicyDocument.Statement as Array<{ Sid?: string; Action: string | string[]; Resource: string | string[] }>;
    const delivery = statements.find((s) => s.Sid === "LogDelivery")!;
    expect(delivery.Resource).toBe("*");
    expect([...(delivery.Action as string[])].sort()).toEqual([
      "logs:CreateLogDelivery",
      "logs:DeleteLogDelivery",
      "logs:DescribeLogGroups",
      "logs:DescribeResourcePolicies",
      "logs:GetLogDelivery",
      "logs:ListLogDeliveries",
      "logs:PutResourcePolicy",
      "logs:UpdateLogDelivery",
    ]);
    // Log events stay readable only through the fiken-mcp log-group ARNs in the Logs statement.
    const wildcardLogActions = statements
      .filter((s) => s.Sid !== "LogDelivery" && (Array.isArray(s.Resource) ? s.Resource : [s.Resource]).includes("*"))
      .flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]))
      .filter((a) => a.startsWith("logs:"));
    expect(wildcardLogActions).toEqual([]);
  });

  it("grants CloudFormation only read access to certificates: the certificate is made by hand and imported", () => {
    const t = synth();
    const policy = Object.values(t.findResources("AWS::IAM::ManagedPolicy"))[0]!;
    const statements = policy.Properties.PolicyDocument.Statement as Array<{ Sid?: string; Effect: string; Action: string | string[] }>;
    const acmActions = statements
      .filter((s) => s.Effect === "Allow")
      .flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]))
      .filter((a) => a.startsWith("acm:"));
    expect(acmActions.sort()).toEqual(["acm:DescribeCertificate", "acm:ListTagsForCertificate"]);
  }, STACK_TEST_TIMEOUT_MS);

  it("lets CloudFormation manage the site bucket, CloudFront resources, scoped by name", () => {
    const t = synth();
    const policy = Object.values(t.findResources("AWS::IAM::ManagedPolicy"))[0]!;
    const statements = policy.Properties.PolicyDocument.Statement as Array<{ Sid?: string; Action: string | string[]; Resource: string | string[] }>;
    const bySid = (sid: string) => statements.find((s) => s.Sid === sid)!;

    expect(bySid("SiteBucket").Action).toBe("s3:*");
    expect(bySid("SiteBucket").Resource).toEqual(["arn:aws:s3:::fiken-mcp-web-*", "arn:aws:s3:::fiken-mcp-web-*/*"]);

    expect(bySid("CloudFront").Action).toBe("cloudfront:*");
    expect(bySid("CloudFront").Resource).toEqual([
      "arn:aws:cloudfront::209479295726:distribution/*",
      "arn:aws:cloudfront::209479295726:origin-access-control/*",
      "arn:aws:cloudfront::209479295726:cache-policy/*",
      "arn:aws:cloudfront::209479295726:response-headers-policy/*",
    ]);

    expect(bySid("CloudFrontCreate").Action).toEqual([
      "cloudfront:CreateDistribution",
      "cloudfront:CreateOriginAccessControl",
      "cloudfront:CreateCachePolicy",
      "cloudfront:CreateResponseHeadersPolicy",
    ]);
    expect(bySid("CloudFrontCreate").Resource).toBe("*");

    expect(statements.find((s) => s.Sid === "SiteLayer")).toBeUndefined();
  }, STACK_TEST_TIMEOUT_MS);
}, STACK_TEST_TIMEOUT_MS);
