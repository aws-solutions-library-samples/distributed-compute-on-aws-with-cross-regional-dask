// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { Stack, App, StackProps, RemovalPolicy, Duration } from "aws-cdk-lib";
import {
  CfnRoute,
  CfnTransitGateway,
  CfnTransitGatewayAttachment,
  CfnTransitGatewayPeeringAttachment,
  FlowLogDestination,
  FlowLogTrafficType,
  InstanceType,
  IpAddresses,
  Peer,
  Port,
  SecurityGroup,
  SubnetType,
  Vpc,
} from "aws-cdk-lib/aws-ec2";
import { DockerImageAsset, Platform } from "aws-cdk-lib/aws-ecr-assets";
import {
  AsgCapacityProvider,
  Cluster,
  ContainerImage,
  Ec2Service,
  Ec2TaskDefinition,
  LogDriver,
  NetworkMode,
} from "aws-cdk-lib/aws-ecs";
import { Rule, Schedule } from "aws-cdk-lib/aws-events";
import { LambdaFunction } from "aws-cdk-lib/aws-events-targets";
import { LustreDeploymentType, LustreFileSystem } from "aws-cdk-lib/aws-fsx";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Code, Function, Runtime } from "aws-cdk-lib/aws-lambda";
import { LogGroup } from "aws-cdk-lib/aws-logs";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
} from "aws-cdk-lib/custom-resources";
import { NagSuppressions } from "cdk-nag";
import { IClient, IWorker } from "../../bin/interface";
import { AcceptTGWRequestClient } from "../SdkConstructs/accept-tgw-request-client";
import { CreateDataLinkRepoClient } from "../SdkConstructs/create-data-repo-link-lustre";
import { SSMParameterReader } from "../SdkConstructs/ssm-param-reader";
import path = require("path");

export interface WorkerRegionProps extends StackProps {
  client: IClient;
  worker: IWorker;
}

/**
 * The worker region stack creates all the relevant infrastructure needs to launch a worker pool that
 * connect to the client region scheduler
 */
export class WorkerRegion extends Stack {
  public vpc: Vpc;
  public tgw: CfnTransitGateway;
  public attachmentID: CfnTransitGatewayPeeringAttachment;
  public lustre: LustreFileSystem;
  lustreBucket: Bucket;
  RepoFn: Function;
  dataLink: CreateDataLinkRepoClient;

  constructor(scope: App, id: string, props: WorkerRegionProps) {
    super(scope, id, props);
    const { client, worker } = props;

    this.setupEnvironment(client, worker);
    this.setupRegionalLustre(worker);
    this.setupDaskWorkers(client);

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
  }

  /** Setup Environment
   *
   * Setup for the worker a tgw, vpc, peering of the local vpc, accept the peer, add a route and
   * associate the vpc to the hosted zone
   *
   * @param client - Object of the client containing pieces such as client region and cidr
   * @param worker - Object of the worker containing pieces such as worker region, cidr and data
   */
  setupEnvironment(client: IClient, worker: IWorker) {
    // Create the tgw and save param
    this.tgw = new CfnTransitGateway(this, "TGW", {});
    new StringParameter(this, `TGW Param - ${this.region}`, {
      parameterName: `tgw-param-${this.region}`,
      stringValue: this.tgw.ref,
    });

    // Pull the id for peering
    const peerTransitGatewayId = new SSMParameterReader(this, "TGW Param", {
      parameterName: `tgw-param-${client.region}`,
      region: client.region,
      account: this.account,
    }).getParameterValue();
    // Establish a peering connection
    this.attachmentID = new CfnTransitGatewayPeeringAttachment(
      this,
      "Peering Connection",
      {
        peerAccountId: this.account,
        peerRegion: client.region,
        peerTransitGatewayId,
        transitGatewayId: this.tgw.ref,
      }
    );
    this.attachmentID.addDependsOn(this.tgw);
    // Accept once established the peering
    this.acceptRequest(client);

    // Create the Worker VPC
    this.vpc = new Vpc(this, "Worker VPC", {
      ipAddresses: IpAddresses.cidr(worker.cidr),
      flowLogs: {
        cloudwatch: {
          destination: FlowLogDestination.toCloudWatchLogs(
            new LogGroup(this, "WorkerVpcFlowLogs")
          ),
          trafficType: FlowLogTrafficType.ALL,
        },
      },
    });

    // Create an attachment of the local VPC to the TGW
    new CfnTransitGatewayAttachment(this, "tgw-attachment", {
      subnetIds: this.vpc.privateSubnets.map(({ subnetId }) => subnetId),
      transitGatewayId: this.tgw.ref,
      vpcId: this.vpc.vpcId,
    }).addDependsOn(this.tgw);

    // Save this param as other regions will need it
    new StringParameter(this, "TGW Attach Param", {
      parameterName: `tgw-attachmentid-${this.region}`,
      stringValue: this.attachmentID.attrTransitGatewayAttachmentId,
    });

    // And add to each private subnet the routing of client traffic to the client region via tgw
    for (let i = 0; i < this.vpc.privateSubnets.length; i++) {
      new CfnRoute(this, `Subnet to TGW - ${this.vpc.privateSubnets[i]}`, {
        routeTableId: this.vpc.privateSubnets[i].routeTable.routeTableId,
        destinationCidrBlock: client.cidr,
        transitGatewayId: this.tgw.ref,
      }).addDependsOn(this.attachmentID);
    }

    // Pull the namespace created in the client region
    const HostedZoneId = new SSMParameterReader(this, "PrivateNP Param", {
      parameterName: `privatenp-hostedid-param-${client.region}`,
      region: client.region,
      account: this.account,
    }).getParameterValue();
    // and make an sdk call to gain access to resolve that DNS in this space
    const associateVPC = new AwsCustomResource(
      this,
      "AssociateVPCWithHostedZone",
      {
        onCreate: {
          service: "Route53",
          action: "associateVPCWithHostedZone",
          parameters: {
            HostedZoneId,
            VPC: { VPCId: this.vpc.vpcId, VPCRegion: this.region },
          },
          physicalResourceId: { id: "associateVPCWithHostedZone" },
        },
        policy: AwsCustomResourcePolicy.fromStatements([
          new PolicyStatement({
            actions: ["route53:AssociateVPCWithHostedZone"],
            resources: [`arn:aws:route53:::hostedzone/${HostedZoneId}`],
          }),
          new PolicyStatement({
            actions: ["ec2:DescribeVpcs"],
            resources: AwsCustomResourcePolicy.ANY_RESOURCE,
          }),
        ]),
      }
    );
    NagSuppressions.addResourceSuppressions(
      associateVPC,
      [
        {
          id: "AwsSolutions-IAM5",
          reason: "Call needs access to all resources",
        },
      ],
      true
    );
  }

  /** Accept Request
   *
   * Make an sdk call that will accept the peering connection
   *
   * @param client - Object of the client containing pieces such as client region and cidr
   */
  acceptRequest(client: IClient) {
    new AcceptTGWRequestClient(this, "Accept Request", {
      attachmentId: this.attachmentID.attrTransitGatewayAttachmentId,
      region: client.region,
      account: this.account,
    });
  }

  /** Setup the Regional Lustre
   *
   * Lustre is the middleware we use for rapid access to public s3 data. Lustre connects to the public
   * s3 data, loading it into the region so that the workers can work with the data as if it were a
   * local filesystem
   *
   * @param worker - Object of the worker containing pieces such as worker region, cidr and data
   */
  setupRegionalLustre(worker: IWorker) {
    // The lustre security group allows certain ports to mount to the ec2 instance
    const secGroup = new SecurityGroup(this, "Lustre Security Group", {
      vpc: this.vpc,
    });
    secGroup.addIngressRule(Peer.ipv4(this.vpc.vpcCidrBlock), Port.tcp(988));
    secGroup.addIngressRule(
      Peer.ipv4(this.vpc.vpcCidrBlock),
      Port.tcpRange(1021, 1023)
    );

    // Using persistent 2 we must create the data link to the repo after it's created
    this.lustre = new LustreFileSystem(this, "Lustre File System", {
      lustreConfiguration: {
        deploymentType: LustreDeploymentType.PERSISTENT_2,
        perUnitStorageThroughput: 1000,
      },
      storageCapacityGiB: 1200,
      vpc: this.vpc,
      vpcSubnet: this.vpc.privateSubnets[0],
      securityGroup: secGroup,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    // An SDK to have the data link create after the lustre filesystem has been called to be created
    this.dataLink = new CreateDataLinkRepoClient(this, "DataRepoLustre", {
      DataRepositoryPath: worker.dataset,
      FileSystemId: this.lustre.fileSystemId,
      FileSystemPath: `/${this.region}/${worker.lustreFileSystemPath}`,
      region: this.region,
      account: this.account,
    });

    NagSuppressions.addResourceSuppressions(
      this.dataLink,
      [
        {
          id: "AwsSolutions-IAM5",
          reason: "Needs a * on association Id",
        },
      ],
      true
    );
    // We then create a function which when triggered on a scheduled basis will sync lustre to s3
    this.RepoFn = new Function(this, "Scheduled Lustre Repo Refresh", {
      runtime: Runtime.NODEJS_18_X,
      handler: "index.handler",
      code: Code.fromAsset(path.join(__dirname, "..", "LustreRepoTrigger")),
      environment: {
        FileSystemId: this.lustre.fileSystemId,
      },
      initialPolicy: [
        new PolicyStatement({
          resources: [
            `arn:aws:fsx:${this.region}:${this.account}:file-system/${this.lustre.fileSystemId}`,
            `arn:aws:fsx:${this.region}:${this.account}:task/*`,
          ],
          actions: ["fsx:CreateDataRepositoryTask"],
        }),
      ],
    });
    NagSuppressions.addResourceSuppressions(
      this.RepoFn,
      [
        {
          id: "AwsSolutions-IAM5",
          reason:
            "Function needs access to all task ids as they are dynamically created with uuid",
        },
      ],
      true
    );
    // After launch the rule below will prompt lustre to sync with the s3 bucket every day at midnight
    new Rule(this, "Schedule Rule", {
      schedule: Schedule.cron({ minute: "0", hour: "0" }),
      targets: [new LambdaFunction(this.RepoFn)],
    });
  }

  /** Setup the Dask Workers
   *
   * Lastly we setup and run the workers which should connect in to the scheduler. Note that if you
   * deploy all the workers, it will not be able to connect until the later stacks that connect the tgw
   * have completed.
   * Also if you see unexpected errors in workers disconnecting to the to the client, first check the logs
   * and then check versioning between the notebook, scheduler and workers by running
   *
   * Run the below in the jupyter notebook
   * client.get_versions(check=True)
   * Sometimes version mismatch can cause unexpected issues
   *
   * @param client - Object of the client containing pieces such as client region and cidr
   */
  setupDaskWorkers(client: IClient) {
    // Spin up the worker cluster. May need to increase your accounts quota for instances
    // beyond the account max
    const cluster = new Cluster(this, "Worker Cluster", {
      clusterName: "Dask-Workers",
      containerInsights: true,
      vpc: this.vpc,
      capacity: {
        instanceType: new InstanceType("m5d.4xlarge"),
        minCapacity: 0,
        maxCapacity: 12,
        vpcSubnets: {
          subnetType: SubnetType.PRIVATE_WITH_EGRESS,
        },
      },
    });
    NagSuppressions.addResourceSuppressions(
      cluster.autoscalingGroup!,
      [
        {
          id: "AwsSolutions-SNS2",
          reason:
            "SNS is a default asset created to which is not exposed publicly",
        },
        {
          id: "AwsSolutions-SNS3",
          reason:
            "SNS is a default asset created to which is not exposed publicly",
        },
        {
          id: "AwsSolutions-AS3",
          reason:
            "SNS is a default asset created to which is not exposed publicly",
        },
        {
          id: "AwsSolutions-IAM5",
          reason:
            "Internally created service role generate by the cluster construct to drain instances of this cluster",
        },
      ],
      true
    );

    // User data will install lustre and mount it
    cluster.autoscalingGroup!.addUserData(
      "amazon-linux-extras install -y lustre",
      "mkdir -p /fsx",
      `mount -t lustre ${this.lustre.dnsName}@tcp:/${this.lustre.mountName} /fsx -o noatime,flock`,
      `echo ${this.lustre.dnsName}@tcp:/${this.lustre.mountName} /fsx lustre defaults,flock,_netdev,x-systemd.automount,x-systemd.requires=network.service 0 0 >> /etc/fstab`,
      "echo mountDone"
    );

    // We are using an autoscaling capacity provider which will manage the scaling of instances. We
    // just need to worry about task scaling
    const capacityProvider = new AsgCapacityProvider(
      this,
      "AsgCapacityProvider",
      {
        autoScalingGroup: cluster.autoscalingGroup!,
        targetCapacityPercent: 80,
      }
    );
    cluster.addAsgCapacityProvider(capacityProvider);

    // Definition created for the workers
    const taskDefinition = new Ec2TaskDefinition(this, "Worker Definition", {
      family: "Dask-Worker",
      networkMode: NetworkMode.AWS_VPC,
      volumes: [
        {
          name: "Lustre",
          host: {
            sourcePath: "/fsx",
          },
        },
      ],
    });

    // Setup the worker to run multiple workers with multiple threads
    // Feel free to adjust these figures to optimise on your workload
    const NWORKERS = 10;
    const THREADS = 3;
    const container = taskDefinition.addContainer("Container", {
      containerName: "Dask",
      memoryReservationMiB: 25000,
      image: ContainerImage.fromDockerImageAsset(
        new DockerImageAsset(this, "Worker Image Repo", {
          directory: path.join(__dirname, "..", "DaskImage"),
          platform: Platform.LINUX_AMD64,
        })
      ),
      command: [
        "bin/sh",
        "-c",
        `pip3 install --upgrade xarray[complete] intake_esm s3fs eccodes git+https://github.com/gjoseph92/dask-worker-pools.git@main && dask worker Dask-Scheduler.local-dask:8786 --worker-port 9000:${
          9000 + NWORKERS - 1
        } --nanny-port ${9000 + NWORKERS}:${
          9000 + NWORKERS * 2 - 1
        } --resources pool-${
          this.region
        }=1 --nworkers ${NWORKERS} --nthreads ${THREADS} --no-dashboard`,
      ],
      essential: true,
      logging: LogDriver.awsLogs({
        streamPrefix: "ecs",
        logGroup: new LogGroup(this, "Dask Worker Log Group"),
      }),
      portMappings: [...Array(NWORKERS * 2).keys()].map((x) => {
        return { containerPort: 9000 + x };
      }),
    });
    container.addMountPoints({
      sourceVolume: "Lustre",
      containerPath: "/fsx",
      readOnly: false,
    });
    NagSuppressions.addResourceSuppressions(
      new AwsCustomResource(this, "Enable Scanning on Repo", {
        onCreate: {
          service: "ECR",
          action: "putRegistryScanningConfiguration",
          physicalResourceId: { id: "putRegistryScanningConfiguration" },
          parameters: {
            scanType: "ENHANCED",
          },
        },
        policy: AwsCustomResourcePolicy.fromStatements([
          new PolicyStatement({
            actions: [
              "iam:CreateServiceLinkedRole",
              "inspector2:Enable",
              "ecr:PutRegistryScanningConfiguration",
            ],
            resources: AwsCustomResourcePolicy.ANY_RESOURCE,
          }),
        ]),
      }),
      [
        {
          id: "AwsSolutions-IAM5",
          reason: "Call needs access to all resources",
        },
      ],
      true
    );

    // Security group will open up to multiple ports based on how many workers you have set
    const WorkerSecurityGroup = new SecurityGroup(
      this,
      "Worker Security Group",
      { vpc: this.vpc }
    );
    WorkerSecurityGroup.addIngressRule(
      Peer.ipv4(client.cidr),
      Port.tcpRange(9000, 9000 + NWORKERS * 2 - 1),
      "Allow Scheduler connect to Workers"
    );
    WorkerSecurityGroup.addIngressRule(
      Peer.ipv4(this.vpc.vpcCidrBlock),
      Port.tcpRange(9000, 9000 + NWORKERS * 2 - 1),
      "Allow Workers in this region to talk to themselves"
    );

    // Spin up the below service on ECS
    const ec2s = new Ec2Service(this, "Workers", {
      serviceName: "Dask-Workers-ecs",
      enableExecuteCommand: true,
      taskDefinition,
      cluster,
      securityGroups: [WorkerSecurityGroup],
    });
    // We configure the autoscaling activies below. Note that test two tasks can work on a single instance
    const autoScalingGroup = ec2s.autoScaleTaskCount({
      minCapacity: 1,
      maxCapacity: 16,
    });
    // Scaling on CPU when it's above 40%, you can vary cooling periods as you see fit
    // The below will scale up when 3 consecutive data points is above 40%
    // And scale down when 15 datapoints are below ~37%
    autoScalingGroup.scaleOnCpuUtilization("CPUScaling", {
      targetUtilizationPercent: 40,
      scaleOutCooldown: Duration.minutes(5),
      scaleInCooldown: Duration.minutes(5),
    });

    NagSuppressions.addResourceSuppressions(
      taskDefinition,
      [
        {
          id: "AwsSolutions-IAM5",
          reason:
            "Basic role created to which allows ECS to publish dynamic logs and ssm messages",
        },
      ],
      true
    );

    // On the first launch of this CDK we would like to trigger the job immediately to sync.
    // It's positioning at the bottom is to give the data association enough time to link before triggering
    new AwsCustomResource(this, "Trigger Sync Job Now", {
      onCreate: {
        service: "Lambda",
        action: "invoke",
        physicalResourceId: { id: "invokeLustreDataRepoSyncTask" },
        parameters: {
          FunctionName: this.RepoFn.functionName,
        },
      },
      policy: AwsCustomResourcePolicy.fromStatements([
        new PolicyStatement({
          actions: ["lambda:InvokeFunction"],
          resources: [
            `arn:aws:lambda:${this.region}:${this.account}:function:${this.RepoFn.functionName}`,
          ],
        }),
      ]),
    }).node.addDependency(this.dataLink, this.RepoFn, this.lustre, ec2s);
  }
}
