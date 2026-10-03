import * as iam from "aws-cdk-lib/aws-iam";
import { QUALIFIER } from "./synthesizer.js";

export const EXEC_POLICY_NAME = "fiken-mcp-cfn-exec";
export const ZONE_ID = "Z04810525CNVQNP7ALNV";
/** The API's hostname. The apex fiken-mcp.byjoba.com is kept free for a CloudFront site. */
export const DOMAIN = "api.fiken-mcp.byjoba.com";
export const ZONE_NAME = "byjoba.com";
/** The website on the apex, served by the fiken-mcp-web stack. */
export const SITE_DOMAIN = "fiken-mcp.byjoba.com";
/** The site bucket is named with this prefix plus the account id. */
export const SITE_BUCKET_PREFIX = "fiken-mcp-web-";
/** BucketDeployment's AWS CLI layer gets no name of its own; web-stack sets this one so the policy can pin it. */
export const SITE_LAYER_NAME = "fiken-mcp-web-awscli";

/**
 * The only bootstrap roles a deploy needs: deploy-role to run CloudFormation
 * and file-publishing-role to upload assets. The lookup role carries
 * account-wide ReadOnlyAccess and neither stack uses context lookups, so it
 * is deliberately not assumable.
 */
export function bootstrapRoleArns(account: string, region: string): string[] {
  return ["deploy", "file-publishing"].map((kind) => `arn:aws:iam::${account}:role/cdk-${QUALIFIER}-${kind}-role-${account}-${region}`);
}

/**
 * What CloudFormation may do when deploying fiken-mcp stacks, and the
 * permissions boundary on every role those stacks create. Everything is
 * pinned to the fiken-mcp-* name prefix, the byjoba.com zone, the
 * fikenmcp asset bucket and the /fiken_mcp/* parameters.
 */
export function execPolicyStatements(account: string, region: string): iam.PolicyStatement[] {
  const boundaryArn = `arn:aws:iam::${account}:policy/${EXEC_POLICY_NAME}`;
  return [
    new iam.PolicyStatement({
      sid: "Assets",
      actions: ["s3:GetObject", "s3:GetBucketLocation", "s3:ListBucket"],
      resources: [
        `arn:aws:s3:::cdk-fikenmcp-assets-${account}-${region}`,
        `arn:aws:s3:::cdk-fikenmcp-assets-${account}-${region}/*`,
      ],
    }),
    new iam.PolicyStatement({
      sid: "Lambda",
      actions: ["lambda:*"],
      resources: [`arn:aws:lambda:${region}:${account}:function:fiken-mcp-*`],
    }),
    new iam.PolicyStatement({
      sid: "Logs",
      actions: ["logs:*"],
      resources: [
        `arn:aws:logs:${region}:${account}:log-group:/aws/lambda/fiken-mcp-*`,
        `arn:aws:logs:${region}:${account}:log-group:/aws/apigateway/fiken-mcp-*`,
        `arn:aws:logs:${region}:${account}:log-group:/fiken-mcp/*`,
      ],
    }),
    new iam.PolicyStatement({
      // API Gateway delivers HTTP API access logs through CloudWatch Logs
      // "log delivery", which is account-level plumbing with no resource
      // scoping: the documented set below must be granted on "*". It creates
      // delivery subscriptions and the Logs resource policy that lets API
      // Gateway write; it cannot read or delete log events. DescribeLogGroups
      // is also how CloudFormation resolves a log group's Arn attribute.
      sid: "LogDelivery",
      actions: [
        "logs:CreateLogDelivery",
        "logs:GetLogDelivery",
        "logs:UpdateLogDelivery",
        "logs:DeleteLogDelivery",
        "logs:ListLogDeliveries",
        "logs:PutResourcePolicy",
        "logs:DescribeResourcePolicies",
        "logs:DescribeLogGroups",
      ],
      resources: ["*"],
    }),
    new iam.PolicyStatement({
      sid: "RolesWithBoundary",
      actions: ["iam:CreateRole", "iam:PutRolePolicy", "iam:AttachRolePolicy"],
      resources: [`arn:aws:iam::${account}:role/fiken-mcp-*`],
      conditions: { StringEquals: { "iam:PermissionsBoundary": boundaryArn } },
    }),
    // iam:UpdateRole (description, session duration) does not carry the
    // iam:PermissionsBoundary condition key, so it lives here unconditioned.
    new iam.PolicyStatement({
      sid: "RolesRead",
      actions: [
        "iam:GetRole",
        "iam:UpdateRole",
        "iam:DeleteRole",
        "iam:DeleteRolePolicy",
        "iam:DetachRolePolicy",
        "iam:GetRolePolicy",
        "iam:ListRolePolicies",
        "iam:ListAttachedRolePolicies",
        "iam:ListRoleTags",
        "iam:TagRole",
        "iam:UntagRole",
        "iam:UpdateAssumeRolePolicy",
      ],
      resources: [`arn:aws:iam::${account}:role/fiken-mcp-*`],
    }),
    new iam.PolicyStatement({
      sid: "DenyBoundaryRemoval",
      effect: iam.Effect.DENY,
      actions: ["iam:PutRolePermissionsBoundary", "iam:DeleteRolePermissionsBoundary"],
      resources: ["*"],
    }),
    new iam.PolicyStatement({
      sid: "PassRoleToLambda",
      actions: ["iam:PassRole"],
      resources: [`arn:aws:iam::${account}:role/fiken-mcp-*`],
      conditions: { StringEquals: { "iam:PassedToService": "lambda.amazonaws.com" } },
    }),
    new iam.PolicyStatement({
      sid: "Policies",
      actions: [
        "iam:CreatePolicy",
        "iam:DeletePolicy",
        "iam:GetPolicy",
        "iam:CreatePolicyVersion",
        "iam:DeletePolicyVersion",
        "iam:GetPolicyVersion",
        "iam:ListPolicyVersions",
        "iam:SetDefaultPolicyVersion",
        "iam:TagPolicy",
        "iam:UntagPolicy",
      ],
      resources: [`arn:aws:iam::${account}:policy/fiken-mcp-*`],
    }),
    new iam.PolicyStatement({
      sid: "GitHubOidcProvider",
      actions: [
        "iam:CreateOpenIDConnectProvider",
        "iam:DeleteOpenIDConnectProvider",
        "iam:GetOpenIDConnectProvider",
        "iam:UpdateOpenIDConnectProviderThumbprint",
        "iam:AddClientIDToOpenIDConnectProvider",
        "iam:RemoveClientIDFromOpenIDConnectProvider",
        "iam:TagOpenIDConnectProvider",
        "iam:UntagOpenIDConnectProvider",
      ],
      resources: [`arn:aws:iam::${account}:oidc-provider/token.actions.githubusercontent.com`],
    }),
    new iam.PolicyStatement({
      sid: "ApiGateway",
      actions: ["apigateway:*"],
      resources: [
        `arn:aws:apigateway:${region}::/apis`,
        `arn:aws:apigateway:${region}::/apis/*`,
        `arn:aws:apigateway:${region}::/domainnames`,
        `arn:aws:apigateway:${region}::/domainnames/*`,
        `arn:aws:apigateway:${region}::/tags/*`,
      ],
    }),
    new iam.PolicyStatement({
      // The certificate is requested once by hand (docs/setup.md) and imported
      // by ARN, so CloudFormation never requests, tags or deletes certificates.
      // Read-only, for the API Gateway custom domain that references it.
      sid: "CertificatesRead",
      actions: ["acm:DescribeCertificate", "acm:ListTagsForCertificate"],
      resources: ["*"],
    }),
    new iam.PolicyStatement({
      sid: "DnsZone",
      actions: ["route53:ChangeResourceRecordSets", "route53:ListResourceRecordSets", "route53:GetHostedZone"],
      resources: [`arn:aws:route53:::hostedzone/${ZONE_ID}`],
    }),
    new iam.PolicyStatement({
      sid: "DnsRead",
      actions: ["route53:GetChange", "route53:ListHostedZones", "route53:ListHostedZonesByName"],
      resources: ["*"],
    }),
    new iam.PolicyStatement({
      sid: "Dynamo",
      actions: ["dynamodb:*"],
      resources: [
        `arn:aws:dynamodb:${region}:${account}:table/fiken-mcp-*`,
        `arn:aws:dynamodb::${account}:global-table/fiken-mcp-*`,
      ],
    }),
    new iam.PolicyStatement({
      sid: "DynamoRead",
      actions: ["dynamodb:ListTables", "dynamodb:DescribeLimits"],
      resources: ["*"],
    }),
    new iam.PolicyStatement({
      sid: "Parameters",
      actions: ["ssm:GetParameter", "ssm:GetParameters", "ssm:DescribeParameters", "ssm:GetParameterHistory"],
      resources: [
        `arn:aws:ssm:${region}:${account}:parameter/fiken_mcp/*`,
        `arn:aws:ssm:${region}:${account}:parameter/cdk-bootstrap/${QUALIFIER}/*`,
      ],
    }),
    new iam.PolicyStatement({
      sid: "ParameterDecrypt",
      actions: ["kms:Decrypt"],
      resources: ["*"],
      conditions: { StringEquals: { "kms:ViaService": `ssm.${region}.amazonaws.com` } },
    }),
    new iam.PolicyStatement({
      sid: "AssumeBootstrapRoles",
      actions: ["sts:AssumeRole"],
      resources: bootstrapRoleArns(account, region),
    }),
    new iam.PolicyStatement({
      // The website bucket, and (as the boundary on the BucketDeployment
      // Lambda) the object writes that upload and prune the site.
      sid: "SiteBucket",
      actions: ["s3:*"],
      resources: [`arn:aws:s3:::${SITE_BUCKET_PREFIX}*`, `arn:aws:s3:::${SITE_BUCKET_PREFIX}*/*`],
    }),
    new iam.PolicyStatement({
      // CloudFront ARNs carry generated ids, so these are pinned to the
      // account and resource type. Also covers the deployment Lambda's
      // CreateInvalidation and GetInvalidation on the distribution.
      sid: "CloudFront",
      actions: ["cloudfront:*"],
      resources: ["distribution", "origin-access-control", "cache-policy", "response-headers-policy"].map(
        (type) => `arn:aws:cloudfront::${account}:${type}/*`,
      ),
    }),
    new iam.PolicyStatement({
      sid: "SiteLayer",
      actions: ["lambda:PublishLayerVersion", "lambda:GetLayerVersion", "lambda:DeleteLayerVersion"],
      resources: [
        `arn:aws:lambda:${region}:${account}:layer:${SITE_LAYER_NAME}`,
        `arn:aws:lambda:${region}:${account}:layer:${SITE_LAYER_NAME}:*`,
      ],
    }),
  ];
}
