import { Aspects, CfnOutput, CfnResource, RemovalPolicy, Stack, type IAspect, type StackProps } from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import type { Construct, IConstruct } from "constructs";
import { DOMAIN, EXEC_POLICY_NAME, SITE_BUCKET_PREFIX, SITE_STACK_NAME, ZONE_ID, ZONE_NAME, bootstrapRoleArns, execPolicyStatements } from "./exec-policy.js";

/** Requested once by hand and DNS-validated; see docs/setup.md. Auto-renews while the validation CNAME exists. */
export const CERTIFICATE_ARN = "arn:aws:acm:eu-west-1:209479295726:certificate/bd57a6d8-38c1-4876-bfa8-238d64d1c057";

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
// GitHub's immutable subject claim: owner and repo carry their numeric ids,
// so a rename or a re-created repo with the same name cannot assume the role.
// Read from `gh api repos/jonasbarsten/fiken-mcp/actions/oidc/customization/sub`.
const GITHUB_SUBJECT_PREFIX = "repo:jonasbarsten@6729295/fiken-mcp@1381698499";
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
          "token.actions.githubusercontent.com:sub": `${GITHUB_SUBJECT_PREFIX}:environment:${GITHUB_ENVIRONMENT}`,
        },
      }),
    });
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["sts:AssumeRole"],
        resources: bootstrapRoleArns(this.account, this.region),
      }),
    );

    // The only rights beyond sts:AssumeRole: the site's content deploy ships
    // files directly (s3 sync, invalidation) instead of through CloudFormation,
    // and reads the web stack's DistributionId output. The execution policy,
    // which bounds this role, allows each of these.
    const siteBucketArn = `arn:aws:s3:::${SITE_BUCKET_PREFIX}${this.account}`;
    deployRole.addToPolicy(new iam.PolicyStatement({ actions: ["s3:ListBucket"], resources: [siteBucketArn] }));
    deployRole.addToPolicy(new iam.PolicyStatement({ actions: ["s3:PutObject", "s3:DeleteObject"], resources: [`${siteBucketArn}/*`] }));
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"],
        // The follow-up narrows this to the distribution id imported from the web stack.
        resources: [`arn:aws:cloudfront::${this.account}:distribution/*`],
      }),
    );
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["cloudformation:DescribeStacks"],
        resources: [`arn:aws:cloudformation:${this.region}:${this.account}:stack/${SITE_STACK_NAME}/*`],
      }),
    );

    // The public name is static infrastructure: the hand-requested certificate,
    // the API Gateway custom domain and the alias record. The api stack only
    // maps its HTTP API onto the domain.
    const zone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", { hostedZoneId: ZONE_ID, zoneName: ZONE_NAME });
    const certificate = acm.Certificate.fromCertificateArn(this, "Certificate", CERTIFICATE_ARN);
    const domainName = new apigwv2.DomainName(this, "Domain", { domainName: DOMAIN, certificate });
    // CloudFormation creates independent resources in parallel; make the domain
    // wait for the execution-policy update in the same deploy so a new
    // permission it relies on is in place before it is used.
    domainName.node.addDependency(execPolicy);
    new route53.ARecord(this, "AliasRecord", {
      zone,
      recordName: DOMAIN.slice(0, -(ZONE_NAME.length + 1)),
      target: route53.RecordTarget.fromAlias(new targets.ApiGatewayv2DomainProperties(domainName.regionalDomainName, domainName.regionalHostedZoneId)),
    });

    new CfnOutput(this, "UsageTableName", { value: table.tableName, exportName: "fiken-mcp-usage-table-name" });
    new CfnOutput(this, "UsageTableArn", { value: table.tableArn, exportName: "fiken-mcp-usage-table-arn" });
    new CfnOutput(this, "ApiDomainName", { value: domainName.name, exportName: "fiken-mcp-api-domain-name" });
    new CfnOutput(this, "ApiDomainRegionalDomainName", { value: domainName.regionalDomainName, exportName: "fiken-mcp-api-domain-regional-domain-name" });
    new CfnOutput(this, "ApiDomainRegionalHostedZoneId", { value: domainName.regionalHostedZoneId, exportName: "fiken-mcp-api-domain-regional-hosted-zone-id" });
    new CfnOutput(this, "DeployRoleArn", { value: deployRole.roleArn });
    new CfnOutput(this, "ExecPolicyArn", { value: execPolicy.managedPolicyArn });
  }
}
