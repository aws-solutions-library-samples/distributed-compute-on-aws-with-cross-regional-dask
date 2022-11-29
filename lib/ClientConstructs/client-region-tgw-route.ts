// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { Stack, App, StackProps } from "aws-cdk-lib";
import {
  CfnTransitGateway,
  CfnTransitGatewayRoute,
  Vpc,
} from "aws-cdk-lib/aws-ec2";
import { NagSuppressions } from "cdk-nag";

import { IWorker } from "../../bin/interface";
import { TransitGatewayRouteTable } from "../SdkConstructs/default-transit-route-table-id";
import { SSMParameterReader } from "../SdkConstructs/ssm-param-reader";

export interface ClientRegionProps extends StackProps {
  clientTgw: CfnTransitGateway;
  worker: IWorker;
}

/**
 * Pull all the relevant information for the client in order to add to it's default TGW route table
 * a routing of local traffic to the peer attachment
 */
export class ClientToWorkerTransitGatewayRoute extends Stack {
  vpc: Vpc;

  constructor(scope: App, id: string, props: ClientRegionProps) {
    super(scope, id, props);
    const { clientTgw, worker } = props;

    NagSuppressions.addStackSuppressions(this, [
      {
        id: "AwsSolutions-IAM4",
        reason:
          "Lambda execution policy for custom resources created by higher level CDK constructs",
        appliesTo: [
          "Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
        ],
      },
      {
        id: "AwsSolutions-L1",
        reason: "AWS CDK custom resources uses node 14.x environment",
      },
    ]);

    const transitGatewayConstruct = new TransitGatewayRouteTable(
      this,
      "Transit Gateway",
      {
        parameterName: clientTgw.ref,
        region: this.region,
      }
    );
    const transitGatewayRouteTableId =
      transitGatewayConstruct.getParameterValue();
    NagSuppressions.addResourceSuppressions(
      transitGatewayConstruct,
      [
        {
          id: "AwsSolutions-IAM5",
          reason: "By default the action specified supports all resource types",
        },
      ],
      true
    );

    const transitGatewayAttachmentId = new SSMParameterReader(
      this,
      `Transit Attachment ID - ${worker.region}`,
      {
        parameterName: `tgw-attachmentid-${worker.region}`,
        region: worker.region,
        account: this.account,
      }
    ).getParameterValue();

    // Append the route
    new CfnTransitGatewayRoute(this, `TGW Route - ${worker.region}`, {
      transitGatewayRouteTableId,
      destinationCidrBlock: worker.cidr,
      transitGatewayAttachmentId,
    });
  }
}
