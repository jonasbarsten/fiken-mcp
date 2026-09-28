import { CfnOutput, Duration, Fn, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { AccessLogFormat } from "aws-cdk-lib/aws-apigateway";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as ssm from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import { fileURLToPath } from "node:url";

// The certificate, the API Gateway custom domain and the DNS record are
// static and live in the iac stack; this stack only maps its API onto them.
const DOMAIN = "api.fiken-mcp.byjoba.com";
const DOMAIN_EXPORTS = {
  name: "fiken-mcp-api-domain-name",
  regionalDomainName: "fiken-mcp-api-domain-regional-domain-name",
  regionalHostedZoneId: "fiken-mcp-api-domain-regional-hosted-zone-id",
};
const PARAM_PREFIX = "/fiken_mcp";
const PARAM_NAMES = ["client_id", "client_secret", "signing_key", "user_salt"];
const FUNCTION_NAME = "fiken-mcp-api";
const BOUNDARY_POLICY_NAME = "fiken-mcp-cfn-exec";

export class ApiStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    iam.PermissionsBoundary.of(this).apply(
      iam.ManagedPolicy.fromManagedPolicyName(this, "Boundary", BOUNDARY_POLICY_NAME),
    );

    const logGroup = new logs.LogGroup(this, "FunctionLogs", {
      logGroupName: `/aws/lambda/${FUNCTION_NAME}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const fn = new NodejsFunction(this, "Handler", {
      functionName: FUNCTION_NAME,
      entry: fileURLToPath(new URL("../src/lambda.ts", import.meta.url)),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(30),
      // One container at a time: Fiken allows one concurrent request, and this
      // is the abuse ceiling (spec section 7). Needs the account's Lambda
      // concurrency quota above the default 10.
      reservedConcurrentExecutions: 1,
      logGroup,
      environment: { PUBLIC_URL: `https://${DOMAIN}`, PARAM_PREFIX },
      bundling: {
        format: OutputFormat.ESM,
        target: "node24",
        minify: false,
        sourceMap: true,
        banner: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
        // src/icon.ts reads ./assets/icon.png relative to itself; put the folder next to the bundle.
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (inputDir, outputDir) => [`cp -r ${inputDir}/api/src/assets ${outputDir}/assets`],
        },
      },
    });

    for (const name of PARAM_NAMES) {
      ssm.StringParameter.fromSecureStringParameterAttributes(this, `Param-${name}`, { parameterName: `${PARAM_PREFIX}/${name}` }).grantRead(fn);
    }

    const domainName = apigwv2.DomainName.fromDomainNameAttributes(this, "Domain", {
      name: Fn.importValue(DOMAIN_EXPORTS.name),
      regionalDomainName: Fn.importValue(DOMAIN_EXPORTS.regionalDomainName),
      regionalHostedZoneId: Fn.importValue(DOMAIN_EXPORTS.regionalHostedZoneId),
    });

    const api = new apigwv2.HttpApi(this, "HttpApi", {
      apiName: "fiken-mcp",
      createDefaultStage: false,
      disableExecuteApiEndpoint: true,
    });
    const integration = new HttpLambdaIntegration("LambdaIntegration", fn);
    api.addRoutes({ path: "/", methods: [apigwv2.HttpMethod.ANY], integration });
    api.addRoutes({ path: "/{proxy+}", methods: [apigwv2.HttpMethod.ANY], integration });

    const accessLogs = new logs.LogGroup(this, "AccessLogs", {
      logGroupName: `/aws/apigateway/${FUNCTION_NAME}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    // Deliberately no headers and no query string: nothing here can carry a token.
    const accessLogFormat = AccessLogFormat.custom(
      JSON.stringify({
        requestId: "$context.requestId",
        ip: "$context.identity.sourceIp",
        requestTime: "$context.requestTime",
        method: "$context.httpMethod",
        path: "$context.path",
        status: "$context.status",
        responseLength: "$context.responseLength",
        integrationError: "$context.integrationErrorMessage",
      }),
    );
    new apigwv2.HttpStage(this, "Stage", {
      httpApi: api,
      stageName: "$default",
      autoDeploy: true,
      domainMapping: { domainName },
      throttle: { rateLimit: 20, burstLimit: 40 },
      accessLogSettings: { destination: new apigwv2.LogGroupLogDestination(accessLogs), format: accessLogFormat },
    });

    new CfnOutput(this, "ApiUrl", { value: `https://${DOMAIN}` });
  }
}
