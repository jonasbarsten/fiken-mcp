import { App, Tags } from "aws-cdk-lib";
import { IacStack } from "../lib/iac-stack.js";
import { synthesizer } from "../lib/synthesizer.js";

const app = new App();
Tags.of(app).add("Project", "fiken-mcp");
new IacStack(app, "fiken-mcp-iac", {
  env: { account: "209479295726", region: "eu-west-1" },
  synthesizer: synthesizer(),
});
