// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { Stack, App, StackProps } from "aws-cdk-lib";
import {
  CfnTransitGateway,
  CfnTransitGatewayPeeringAttachment,
  CfnTransitGatewayRoute,
  Vpc,
} from "aws-cdk-lib/aws-ec2";
import { IClient } from "../../bin/interface";
import { TransitGatewayRouteTable } from "../SdkConstructs/default-transit-route-table-id";
import { NagSuppressions } from "cdk-nag";

export interface WorkerRegionTGWRouteProps extends StackProps {
  client: IClient;
  tgw: CfnTransitGateway;
  attachmentId: CfnTransitGatewayPeeringAttachment;
}

/**
 * This stack is purposefully seperate to the worker in that it must wait until the peer between the client
 * and worker regions has been established in order to the add a route from the region to the tgw attachment,
 * which points to the client
 */
export class WorkerRegionTransitGatewayRoute extends Stack {
  vpc: Vpc;

  constructor(scope: App, id: string, props: WorkerRegionTGWRouteProps) {
    super(scope, id, props);
    const { client, tgw, attachmentId } = props;

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

    // Load in the default route table associated to the tgw we wish to modify
    const transitConstruct = new TransitGatewayRouteTable(
      this,
      "Transit Gateway",
      {
        parameterName: tgw.ref,
        region: this.region,
      }
    );
    const transitGatewayRouteTableId = transitConstruct.getParameterValue();

    NagSuppressions.addResourceSuppressions(
      transitConstruct,
      [
        {
          id: "AwsSolutions-L1",
          reason:
            "This will be updated when the Construct for this lambda is updated https://github.com/aws/aws-cdk/blob/62d7bf83b4bfe6358e86ecf1c332e51a3909bd8a/packages/%40aws-cdk/custom-resources/lib/aws-custom-resource/aws-custom-resource.ts#L397",
        },
        {
          id: "AwsSolutions-IAM5",
          reason: "By default the action specified supports all resource types",
        },
      ],
      true
    );

    // Append the route
    new CfnTransitGatewayRoute(this, "TGW Route", {
      transitGatewayRouteTableId,
      destinationCidrBlock: client.cidr,
      transitGatewayAttachmentId: attachmentId.attrTransitGatewayAttachmentId,
    });
  }
}
