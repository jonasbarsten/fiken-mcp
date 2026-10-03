import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import type { Construct } from "constructs";
import { fileURLToPath } from "node:url";
import { DOMAIN, EXEC_POLICY_NAME, SITE_BUCKET_PREFIX, SITE_DOMAIN, SITE_LAYER_NAME, ZONE_ID, ZONE_NAME } from "./exec-policy.js";

/** Requested once by hand in us-east-1 (CloudFront requires that region) and DNS-validated; see docs/setup.md. */
export const SITE_CERTIFICATE_ARN = "arn:aws:acm:us-east-1:209479295726:certificate/6814f406-e879-4458-9a45-739a1639ee30";

/** Everything the page loads is its own file; CSS and JS are never inline. */
export const CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const WEB_DIR = fileURLToPath(new URL("../../web", import.meta.url));
const ICON_DIR = fileURLToPath(new URL("../../api/src/assets", import.meta.url));

/**
 * The landing page at the apex: a private bucket behind CloudFront, /stats
 * forwarded to the API so the page reads it same-origin, and the /web
 * folder uploaded on every deploy. No access logs: the site collects nothing.
 */
export class WebStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    iam.PermissionsBoundary.of(this).apply(iam.ManagedPolicy.fromManagedPolicyName(this, "Boundary", EXEC_POLICY_NAME));

    const bucket = new s3.Bucket(this, "SiteBucket", {
      bucketName: `${SITE_BUCKET_PREFIX}${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // The content is rebuilt from git, so the bucket is kept on update and delete instead of
      // adding an auto-delete custom resource. Not plain RETAIN: that would also keep the bucket
      // when the first create rolls back, and every retry would fail with "bucket already exists".
      removalPolicy: RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE,
    });

    const headers = new cloudfront.ResponseHeadersPolicy(this, "SecurityHeaders", {
      securityHeadersBehavior: {
        contentSecurityPolicy: { contentSecurityPolicy: CONTENT_SECURITY_POLICY, override: true },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER, override: true },
        strictTransportSecurity: { accessControlMaxAge: Duration.days(365), includeSubdomains: true, override: true },
      },
    });

    // The API answers /stats with Cache-Control max-age=300; nothing varies it.
    const statsCache = new cloudfront.CachePolicy(this, "StatsCache", {
      defaultTtl: Duration.seconds(300),
      maxTtl: Duration.seconds(300),
      minTtl: Duration.seconds(0),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
    });

    const distribution = new cloudfront.Distribution(this, "Distribution", {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: headers,
      },
      additionalBehaviors: {
        // No origin request policy: the API sees its own host name.
        "/stats": {
          origin: new origins.HttpOrigin(DOMAIN, { protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: statsCache,
          responseHeadersPolicy: headers,
        },
      },
      domainNames: [SITE_DOMAIN],
      certificate: acm.Certificate.fromCertificateArn(this, "Certificate", SITE_CERTIFICATE_ARN),
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultRootObject: "index.html",
      errorResponses: [403, 404].map((httpStatus) => ({ httpStatus, responseHttpStatus: 404, responsePagePath: "/404.html" })),
    });

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", { hostedZoneId: ZONE_ID, zoneName: ZONE_NAME });
    const recordName = SITE_DOMAIN.slice(0, -(ZONE_NAME.length + 1));
    const target = route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution));
    new route53.ARecord(this, "AliasRecord", { zone, recordName, target });
    new route53.AaaaRecord(this, "AliasRecordIpv6", { zone, recordName, target });

    const content = new s3deploy.BucketDeployment(this, "Content", {
      sources: [
        s3deploy.Source.asset(WEB_DIR),
        // The icon lives once, with the API that also serves it; only icon.png is shipped.
        s3deploy.Source.asset(ICON_DIR, { exclude: ["*", "!icon.png"] }),
      ],
      destinationBucket: bucket,
      distribution,
      distributionPaths: ["/*"],
    });
    // BucketDeployment's AWS CLI layer gets a CloudFormation-generated name;
    // pin it so the execution policy can name it (SiteLayer statement).
    const layer = content.node.findChild("AwsCliLayer").node.defaultChild as lambda.CfnLayerVersion;
    layer.layerName = SITE_LAYER_NAME;

    new CfnOutput(this, "SiteBucketName", { value: bucket.bucketName });
    new CfnOutput(this, "DistributionId", { value: distribution.distributionId });
    new CfnOutput(this, "DistributionDomainName", { value: distribution.distributionDomainName });
  }
}
