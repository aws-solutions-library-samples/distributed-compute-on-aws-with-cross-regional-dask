// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { Construct } from "constructs";
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
  AwsSdkCall,
} from "aws-cdk-lib/custom-resources";

interface TGWRouteTableProps {
  parameterName: string;
  region: string;
}

/**
 * Make the relevant SDK to pull the default route table ID from the created TGW
 */
export class TransitGatewayRouteTable extends AwsCustomResource {
  constructor(scope: Construct, name: string, props: TGWRouteTableProps) {
    const { parameterName, region } = props;

    const ssmAwsSdkCall: AwsSdkCall = {
      service: "EC2",
      action: "describeTransitGateways",
      parameters: {
        TransitGatewayIds: [parameterName],
      },
      region,
      physicalResourceId: {
        id: "TransitGateways-AssociationDefaultRouteTableId",
      },
    };

    super(scope, name, {
      onUpdate: ssmAwsSdkCall,
      policy: AwsCustomResourcePolicy.fromSdkCalls({
        resources: AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
    });
  }

  public getParameterValue(): string {
    return this.getResponseField(
      "TransitGateways.0.Options.AssociationDefaultRouteTableId"
    ).toString();
  }
}
