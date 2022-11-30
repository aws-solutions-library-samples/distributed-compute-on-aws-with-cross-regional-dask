// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { Stack, App, StackProps } from "aws-cdk-lib";
import {
  CfnRoute,
  CfnTransitGateway,
  CfnTransitGatewayRoute,
  Vpc,
} from "aws-cdk-lib/aws-ec2";
import { NagSuppressions } from "cdk-nag";
import { IWorker } from "../../bin/interface";
import { SSMParameterReader } from "../SdkConstructs/ssm-param-reader";
import { TransitGatewayRouteTable } from "../SdkConstructs/default-transit-route-table-id";

export interface ClientRegionProps extends StackProps {
  peerWorker: IWorker;
  tgw: CfnTransitGateway;
  vpc: Vpc;
}

/**
 * Add the relevant route to the route table on a subnet level but also on a tgw level
 */
export class InterRegionTransitGatewayRoute extends Stack {
  constructor(scope: App, id: string, props: ClientRegionProps) {
    super(scope, id, props);
    const { peerWorker, tgw, vpc } = props;

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

    // Pull the default associated route table for the tgw
    const transitGatewayConstruct = new TransitGatewayRouteTable(
      this,
      "Transit Gateway",
      {
        parameterName: tgw.ref,
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

    // Pull the attachment ID of the peering connection
    const transitGatewayAttachmentId = new SSMParameterReader(
      this,
      `Transit Attachment ID - ${this.region}`,
      {
        parameterName: `tgw-attachmentid-${peerWorker.region}-${this.region}`,
        region: peerWorker.region,
        account: this.account,
      }
    ).getParameterValue();

    // Append the route to the transit gateway route table
    new CfnTransitGatewayRoute(this, `TGW Route`, {
      transitGatewayRouteTableId,
      destinationCidrBlock: peerWorker.cidr,
      transitGatewayAttachmentId,
    });

    // Loop through and add the routes to the private subnets
    for (let i = 0; i < vpc.privateSubnets.length; i++) {
      new CfnRoute(this, `Subnet to TGW - ${vpc.privateSubnets[i]}`, {
        routeTableId: vpc.privateSubnets[i].routeTable.routeTableId,
        destinationCidrBlock: peerWorker.cidr,
        transitGatewayId: tgw.ref,
      });
    }
  }
}
