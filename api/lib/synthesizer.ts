import { DefaultStackSynthesizer } from "aws-cdk-lib";

export const QUALIFIER = "fikenmcp";

export function synthesizer(): DefaultStackSynthesizer {
  return new DefaultStackSynthesizer({ qualifier: QUALIFIER });
}
