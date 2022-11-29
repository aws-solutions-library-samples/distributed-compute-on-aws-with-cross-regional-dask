// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
  AwsSdkCall,
} from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";

interface AcceptTGWRequestClientProps {
  attachmentId: string;
  region: string;
  account: string;
}

/**
 * Make an SDK call from the peer region to accept the peering connection
 */
export class AcceptTGWRequestClient extends AwsCustomResource {
  constructor(
    scope: Construct,
    name: string,
    props: AcceptTGWRequestClientProps
  ) {
    const { attachmentId, region, account } = props;

    const ssmAwsSdkCall: AwsSdkCall = {
      service: "EC2",
      action: "acceptTransitGatewayPeeringAttachment",
      parameters: {
        TransitGatewayAttachmentId: attachmentId,
      },
      region,
      physicalResourceId: { id: "acceptTransitGatewayPeeringAttachment" },
    };

    super(scope, name, {
      onUpdate: ssmAwsSdkCall,
      policy: AwsCustomResourcePolicy.fromSdkCalls({
        resources: [
          `arn:aws:ec2:${region}:${account}:transit-gateway-attachment/${attachmentId}`,
        ],
      }),
    });
  }
}
