import { App, Tags } from "aws-cdk-lib";
import { SITE_STACK_NAME } from "../lib/exec-policy.js";
import { IacStack } from "../lib/iac-stack.js";
import { synthesizer } from "../lib/synthesizer.js";
import { WebStack } from "../lib/web-stack.js";

const app = new App();
Tags.of(app).add("Project", "fiken-mcp");
const env = { account: "209479295726", region: "eu-west-1" };
new IacStack(app, "fiken-mcp-iac", { env, synthesizer: synthesizer() });
new WebStack(app, SITE_STACK_NAME, { env, synthesizer: synthesizer() });
