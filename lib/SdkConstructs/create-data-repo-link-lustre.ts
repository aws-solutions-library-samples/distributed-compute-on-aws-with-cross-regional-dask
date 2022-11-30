// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
  AwsSdkCall,
} from "aws-cdk-lib/custom-resources";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

interface ParameterProps {
  DataRepositoryPath: string;
  FileSystemId: string;
  FileSystemPath: string;
  region: string;
  account: string;
}

/**
 * An SDK call to create a data link to a public s3 bucket from lustre
 */
export class CreateDataLinkRepoClient extends AwsCustomResource {
  constructor(scope: Construct, name: string, props: ParameterProps) {
    const {
      DataRepositoryPath,
      FileSystemId,
      FileSystemPath,
      region,
      account,
    } = props;

    const ssmAwsSdkCall: AwsSdkCall = {
      service: "FSx",
      action: "createDataRepositoryAssociation",
      parameters: {
        DataRepositoryPath,
        FileSystemId,
        FileSystemPath,
      },
      physicalResourceId: { id: "createDataRepositoryAssociation" },
    };

    super(scope, name, {
      onUpdate: ssmAwsSdkCall,
      policy: AwsCustomResourcePolicy.fromStatements([
        new PolicyStatement({
          actions: ["fsx:CreateDataRepositoryAssociation"],
          resources: [
            `arn:aws:fsx:${region}:${account}:association/${FileSystemId}/*`,
            `arn:aws:fsx:${region}:${account}:file-system/${FileSystemId}`,
          ],
        }),
        new PolicyStatement({
          actions: [
            "s3:Get*",
            "s3:List*",
            "s3:PutObject",
            "iam:CreateServiceLinkedRole",
            "iam:AttachRolePolicy",
            "iam:PutRolePolicy",
          ],
          resources: AwsCustomResourcePolicy.ANY_RESOURCE,
        }),
      ]),
    });
  }
}
