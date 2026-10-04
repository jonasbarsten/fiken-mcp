import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { CONTENT_SECURITY_POLICY, SITE_CERTIFICATE_ARN, WebStack } from "../lib/web-stack.js";
import { synthesizer } from "../lib/synthesizer.js";

const STACK_TEST_TIMEOUT_MS = 60_000;

function synth() {
  const app = new App();
  const stack = new WebStack(app, "fiken-mcp-web", {
    env: { account: "209479295726", region: "eu-west-1" },
    synthesizer: synthesizer(),
  });
  return Template.fromStack(stack);
}

describe("WebStack", () => {
  it("creates a private, SSL-only bucket, retained except on a failed create, named for the account", () => {
    const t = synth();
    t.hasResource("AWS::S3::Bucket", {
      DeletionPolicy: "RetainExceptOnCreate",
      UpdateReplacePolicy: "Retain",
      Properties: Match.objectLike({
        BucketName: "fiken-mcp-web-209479295726",
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      }),
    });
    t.hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Effect: "Deny", Condition: { Bool: { "aws:SecureTransport": "false" } } }),
        ]),
      },
    });
  }, STACK_TEST_TIMEOUT_MS);

  it("serves the apex over HTTPS with the us-east-1 certificate, no logging, and a 404 page", () => {
    const t = synth();
    expect(SITE_CERTIFICATE_ARN).toBe("arn:aws:acm:us-east-1:209479295726:certificate/6814f406-e879-4458-9a45-739a1639ee30");
    const dist = Object.values(t.findResources("AWS::CloudFront::Distribution"))[0]!.Properties.DistributionConfig;
    expect(dist.Aliases).toEqual(["fiken-mcp.byjoba.com"]);
    expect(dist.ViewerCertificate).toEqual({
      AcmCertificateArn: SITE_CERTIFICATE_ARN,
      MinimumProtocolVersion: "TLSv1.2_2021",
      SslSupportMethod: "sni-only",
    });
    expect(dist.Logging).toBeUndefined();
    expect(dist.DefaultRootObject).toBe("index.html");
    expect(dist.HttpVersion).toBe("http2and3");
    expect(dist.PriceClass).toBe("PriceClass_100");
    expect(dist.DefaultCacheBehavior.ViewerProtocolPolicy).toBe("redirect-to-https");
    expect(dist.CustomErrorResponses).toEqual([
      { ErrorCode: 403, ResponseCode: 404, ResponsePagePath: "/404.html" },
      { ErrorCode: 404, ResponseCode: 404, ResponsePagePath: "/404.html" },
    ]);
    t.resourceCountIs("AWS::CloudFront::OriginAccessControl", 1);
  }, STACK_TEST_TIMEOUT_MS);

  it("forwards /stats to the API with a 300 s cache that keys on nothing", () => {
    const t = synth();
    const dist = Object.values(t.findResources("AWS::CloudFront::Distribution"))[0]!.Properties.DistributionConfig;
    const api = dist.Origins.find((o: { DomainName: unknown }) => o.DomainName === "api.fiken-mcp.byjoba.com");
    expect(api.CustomOriginConfig.OriginProtocolPolicy).toBe("https-only");
    expect(dist.CacheBehaviors).toHaveLength(1);
    const stats = dist.CacheBehaviors[0];
    expect(stats.PathPattern).toBe("/stats");
    expect(stats.TargetOriginId).toBe(api.Id);
    expect(stats.ViewerProtocolPolicy).toBe("redirect-to-https");
    expect(stats.OriginRequestPolicyId).toBeUndefined();
    t.hasResourceProperties("AWS::CloudFront::CachePolicy", {
      CachePolicyConfig: Match.objectLike({
        DefaultTTL: 300,
        MaxTTL: 300,
        MinTTL: 0,
        ParametersInCacheKeyAndForwardedToOrigin: Match.objectLike({
          CookiesConfig: { CookieBehavior: "none" },
          HeadersConfig: { HeaderBehavior: "none" },
          QueryStringsConfig: { QueryStringBehavior: "none" },
        }),
      }),
    });
  }, STACK_TEST_TIMEOUT_MS);

  it("sends the security headers and the exact CSP on both behaviors", () => {
    const t = synth();
    expect(CONTENT_SECURITY_POLICY).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    t.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: {
          ContentSecurityPolicy: { ContentSecurityPolicy: CONTENT_SECURITY_POLICY, Override: true },
          ContentTypeOptions: { Override: true },
          FrameOptions: { FrameOption: "DENY", Override: true },
          ReferrerPolicy: { ReferrerPolicy: "no-referrer", Override: true },
          StrictTransportSecurity: { AccessControlMaxAgeSec: 31536000, IncludeSubdomains: true, Override: true },
        },
      }),
    });
    const [policyId] = Object.keys(t.findResources("AWS::CloudFront::ResponseHeadersPolicy"));
    const dist = Object.values(t.findResources("AWS::CloudFront::Distribution"))[0]!.Properties.DistributionConfig;
    expect(dist.DefaultCacheBehavior.ResponseHeadersPolicyId).toEqual({ Ref: policyId });
    expect(dist.CacheBehaviors[0].ResponseHeadersPolicyId).toEqual({ Ref: policyId });
  }, STACK_TEST_TIMEOUT_MS);

  it("holds no content deployment, layer, DNS records or roles: content ships from the workflow, the records live in the iac stack", () => {
    const t = synth();
    t.resourceCountIs("Custom::CDKBucketDeployment", 0);
    t.resourceCountIs("AWS::Lambda::LayerVersion", 0);
    t.resourceCountIs("AWS::Route53::RecordSet", 0);
    t.resourceCountIs("AWS::IAM::Role", 0);
  }, STACK_TEST_TIMEOUT_MS);

  it("outputs the bucket and exports the distribution id and its domain for the iac stack", () => {
    const t = synth();
    t.hasOutput("SiteBucketName", {});
    t.hasOutput("DistributionId", { Export: { Name: "fiken-mcp-web-distribution-id" } });
    t.hasOutput("DistributionDomainName", { Export: { Name: "fiken-mcp-web-distribution-domain-name" } });
  }, STACK_TEST_TIMEOUT_MS);
});
