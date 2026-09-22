import { App, Tags } from "aws-cdk-lib";
import { ApiStack } from "../lib/api-stack.js";
import { synthesizer } from "../lib/synthesizer.js";

const app = new App();
Tags.of(app).add("Project", "fiken-mcp");
new ApiStack(app, "fiken-mcp-api", { env: { account: "209479295726", region: "eu-west-1" }, synthesizer: synthesizer() });
