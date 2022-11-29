import { Stack, App, StackProps } from "aws-cdk-lib";
import {
  CfnRoute,
  CfnTransitGatewayPeeringAttachment,
  Vpc,
} from "aws-cdk-lib/aws-ec2";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import { NagSuppressions } from "cdk-nag";
import { IWorker } from "../../bin/interface";
import { AcceptTGWRequestClient } from "../SdkConstructs/accept-tgw-request-client";
import { SSMParameterReader } from "../SdkConstructs/ssm-param-reader";

export interface WorkerToWorkerTGWProps extends StackProps {
  peerWorker: IWorker;
  vpc: Vpc;
}

/**
 * This class creates the peer connection between the regions, accepts the request
 * and adds the relevant routes to the private subnets
 */
export class WorkerToWorkerTGW extends Stack {
  public attachmentID: CfnTransitGatewayPeeringAttachment;
  public transitGatewayId: string;

  constructor(scope: App, id: string, props: WorkerToWorkerTGWProps) {
    super(scope, id, props);
    const { peerWorker, vpc } = props;

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

    // Pull the exisitng TGW from the peer region we wish to connect to
    const peerTransitGatewayId = new SSMParameterReader(
      this,
      `TGW Param - ${peerWorker.region}`,
      {
        parameterName: `tgw-param-${peerWorker.region}`,
        region: peerWorker.region,
        account: this.account,
      }
    ).getParameterValue();
    // Pull the local TGW
    const transitGatewayId = new SSMParameterReader(
      this,
      `TGW Param - ${this.region}`,
      {
        parameterName: `tgw-param-${this.region}`,
        region: this.region,
        account: this.account,
      }
    ).getParameterValue();
    // Create the peering attachment
    this.attachmentID = new CfnTransitGatewayPeeringAttachment(
      this,
      "Peering Connection",
      {
        peerAccountId: this.account,
        peerRegion: peerWorker.region,
        peerTransitGatewayId,
        transitGatewayId,
      }
    );
    // This attachment ID will be required by the peer region for the TGW route table
    new StringParameter(this, `Peering ID - ${peerWorker.region}`, {
      parameterName: `tgw-attachmentid-${this.region}-${peerWorker.region}`,
      stringValue: this.attachmentID.attrTransitGatewayAttachmentId,
    });
    // Accept the request to peer from the peer region
    this.acceptRequest(peerWorker.region);

    // Loop the private subnets adding the route for worker region cidrs to the TGW
    for (let i = 0; i < vpc.privateSubnets.length; i++) {
      new CfnRoute(this, `Subnet to TGW - ${vpc.privateSubnets[i]}`, {
        routeTableId: vpc.privateSubnets[i].routeTable.routeTableId,
        destinationCidrBlock: peerWorker.cidr,
        transitGatewayId,
      }).addDependsOn(this.attachmentID);
    }
  }

  /**
   * Accept from the peer region the request to peer
   *
   * @param peerRegion - The peering region. e.g. us-west-2
   */
  acceptRequest(peerRegion: string) {
    new AcceptTGWRequestClient(this, "Accept Request", {
      attachmentId: this.attachmentID.attrTransitGatewayAttachmentId,
      region: peerRegion,
      account: this.account,
    });
  }
}
