// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import { AwsCustomResource, AwsSdkCall } from "aws-cdk-lib/custom-resources";

interface SSMParameterReaderProps {
  parameterName: string;
  region: string;
  account: string;
}

/**
 * Generic parameter stack which calls the sdk to retrieve parameters interregionally
 */
export class SSMParameterReader extends AwsCustomResource {
  constructor(scope: Construct, name: string, props: SSMParameterReaderProps) {
    const { parameterName, region, account } = props;

    const ssmAwsSdkCall: AwsSdkCall = {
      service: "SSM",
      action: "getParameter",
      parameters: {
        Name: parameterName,
      },
      region,
      physicalResourceId: { id: "getParameter" }, // Update physical id to always fetch the latest version
    };

    super(scope, name, {
      onUpdate: ssmAwsSdkCall,
      policy: {
        statements: [
          new PolicyStatement({
            resources: [
              `arn:aws:ssm:${region}:${account}:parameter/${parameterName}`,
            ],
            actions: ["ssm:GetParameter"],
          }),
        ],
      },
    });
  }

  public getParameterValue(): string {
    return this.getResponseField("Parameter.Value").toString();
  }
}
