import { Aspects, CfnOutput, CfnResource, RemovalPolicy, Stack, type IAspect, type StackProps } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import type { Construct, IConstruct } from "constructs";
import { EXEC_POLICY_NAME, execPolicyStatements } from "./exec-policy.js";

const PROJECT_TAG = { Key: "Project", Value: "fiken-mcp" };

/**
 * Tags.of(app) only reaches constructs with a TagManager (generated L1s like
 * iam.CfnRole). The OpenIdConnectProvider's singleton custom-resource-provider
 * role is a raw, untyped CfnResource with no TagManager, so it never picks up
 * the Project tag that way. Force it on directly for any bare AWS::IAM::Role
 * CfnResource that isn't already a proper iam.CfnRole (which the standard
 * Tags aspect already covers).
 */
class TagUntaggableRoles implements IAspect {
  visit(node: IConstruct): void {
    if (
      CfnResource.isCfnResource(node) &&
      node.cfnResourceType === "AWS::IAM::Role" &&
      !(node instanceof iam.CfnRole)
    ) {
      node.addPropertyOverride("Tags", [PROJECT_TAG]);
    }
  }
}

const GITHUB_REPO = "jonasbarsten/fiken-mcp";
const GITHUB_ENVIRONMENT = "production";

export class IacStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    // Scoped CloudFormation execution policy, also the permissions boundary
    // on every role fiken-mcp stacks create (this stack included).
    const execPolicy = new iam.ManagedPolicy(this, "ExecPolicy", {
      managedPolicyName: EXEC_POLICY_NAME,
      description: "What CloudFormation may do for fiken-mcp stacks; boundary for their roles",
      statements: execPolicyStatements(this.account, this.region),
    });
    iam.PermissionsBoundary.of(this).apply(execPolicy);
    Aspects.of(this).add(new TagUntaggableRoles());

    const table = new dynamodb.TableV2(this, "UsageTable", {
      tableName: "fiken-mcp-usage",
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const githubProvider = new iam.OpenIdConnectProvider(this, "GitHubOidc", {
      url: "https://token.actions.githubusercontent.com",
      clientIds: ["sts.amazonaws.com"],
    });

    const deployRole = new iam.Role(this, "DeployRole", {
      roleName: "fiken-mcp-github-deploy",
      description: `Assumed by GitHub Actions in the ${GITHUB_ENVIRONMENT} environment of ${GITHUB_REPO}`,
      assumedBy: new iam.OpenIdConnectPrincipal(githubProvider, {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": `repo:${GITHUB_REPO}:environment:${GITHUB_ENVIRONMENT}`,
        },
      }),
    });
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["sts:AssumeRole"],
        resources: [`arn:aws:iam::${this.account}:role/cdk-fikenmcp-*-role-${this.account}-${this.region}`],
      }),
    );

    new CfnOutput(this, "UsageTableName", { value: table.tableName, exportName: "fiken-mcp-usage-table-name" });
    new CfnOutput(this, "UsageTableArn", { value: table.tableArn, exportName: "fiken-mcp-usage-table-arn" });
    new CfnOutput(this, "DeployRoleArn", { value: deployRole.roleArn });
    new CfnOutput(this, "ExecPolicyArn", { value: execPolicy.managedPolicyArn });
  }
}
