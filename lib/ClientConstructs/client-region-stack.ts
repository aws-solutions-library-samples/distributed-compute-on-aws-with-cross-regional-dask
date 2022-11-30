// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { Stack, App, StackProps, RemovalPolicy } from "aws-cdk-lib";
import { Code, Repository } from "aws-cdk-lib/aws-codecommit";
import {
  CfnRoute,
  CfnTransitGateway,
  CfnTransitGatewayAttachment,
  FlowLogDestination,
  FlowLogTrafficType,
  IpAddresses,
  Peer,
  Port,
  SecurityGroup,
  SubnetType,
  Vpc,
} from "aws-cdk-lib/aws-ec2";
import {
  Cluster,
  ContainerImage,
  FargateTaskDefinition,
  LogDriver,
} from "aws-cdk-lib/aws-ecs";
import { ApplicationLoadBalancedFargateService } from "aws-cdk-lib/aws-ecs-patterns";
import {
  CfnServiceLinkedRole,
  ManagedPolicy,
  PolicyDocument,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import { Key } from "aws-cdk-lib/aws-kms";
import { LogGroup } from "aws-cdk-lib/aws-logs";
import { Domain, EngineVersion } from "aws-cdk-lib/aws-opensearchservice";
import {
  CfnNotebookInstance,
  CfnNotebookInstanceLifecycleConfig,
} from "aws-cdk-lib/aws-sagemaker";
import { PrivateDnsNamespace, Service } from "aws-cdk-lib/aws-servicediscovery";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import { ApplicationLoadBalancer } from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { NagSuppressions } from "cdk-nag";
import { secureBucket } from "./secure-bucket";
import { DockerImageAsset, Platform } from "aws-cdk-lib/aws-ecr-assets";
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
} from "aws-cdk-lib/custom-resources";
import { readFileSync } from "fs";
import { IWorker } from "../../bin/interface";
import path = require("path");

export interface ClientRegionProps extends StackProps {
  clientCidr: string;
  workers: IWorker[];
}

/**
 * The Client Region's primary function is in setting up all the relevant resources in the region
 * besides connecting each of the regions (We must wait until the other regions are up to do so)
 */
export class ClientRegion extends Stack {
  public clientTGW: CfnTransitGateway;
  vpc: Vpc;
  cluster: Cluster;
  schedulerDisovery: Service;
  openSearchDomain: StringParameter;
  openSearchArn: StringParameter;

  constructor(scope: App, id: string, props: ClientRegionProps) {
    super(scope, id, props);
    const { clientCidr, workers } = props;

    this.setupEnvironment(clientCidr, workers);
    this.setupDaskScheduler(clientCidr, workers);
    this.setupOpenSearch(workers);
    this.setupSagemaker();
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

  /** Environment Setup
   *
   * The function sets up the VPC, along with transit gateway, attachments, cfn routes
   * PrivateNamespace to publish the schedulers IP and empty cluster in which the scheduler will sit
   *
   * @param clientCidr - The cidr range of client where the notebook sits
   * @param workers - An array of worker regions
   */
  setupEnvironment(clientCidr: string, workers: IWorker[]) {
    // Client VPC
    this.vpc = new Vpc(this, "Scheduler VPC", {
      ipAddresses: IpAddresses.cidr(clientCidr),
      flowLogs: {
        cloudwatch: {
          destination: FlowLogDestination.toCloudWatchLogs(
            new LogGroup(this, "SchedulerVpcFlowLogs")
          ),
          trafficType: FlowLogTrafficType.ALL,
        },
      },
    });

    // Transit Gateway
    this.clientTGW = new CfnTransitGateway(this, "TGW");
    // We will need this parameter in other regions to connect to
    new StringParameter(this, "TGW Param", {
      parameterName: `tgw-param-${this.region}`,
      stringValue: this.clientTGW.ref,
    });
    // Base attachment for connecting the local VPC to TGW
    const attach = new CfnTransitGatewayAttachment(this, "tgw-attachment", {
      subnetIds: this.vpc.privateSubnets.map(({ subnetId }) => subnetId),
      transitGatewayId: this.clientTGW.ref,
      vpcId: this.vpc.vpcId,
    });
    attach.addDependsOn(this.clientTGW);

    // At this early point we can add the routes to the private subnets indiciating that for
    // worker region cidrs they should use the TGW
    for (const worker of workers) {
      for (let i = 0; i < this.vpc.privateSubnets.length; i++) {
        new CfnRoute(
          this,
          `Subnet to TGW - ${this.vpc.privateSubnets[i]} - ${worker.region}`,
          {
            routeTableId: this.vpc.privateSubnets[i].routeTable.routeTableId,
            destinationCidrBlock: worker.cidr,
            transitGatewayId: this.clientTGW.ref,
          }
        ).addDependsOn(attach);
      }
    }

    /**
     * Below we initialise a private namespace which will keep track of the changing schedulers IP
     * The workers will need this IP to connect to, so instead of tracking it statically, they can
     * simply reference the DNS which will resolve to the IP everytime
     */
    const PrivateNP = new PrivateDnsNamespace(this, "local-dask", {
      name: "local-dask",
      vpc: this.vpc,
    });
    // Other regions will have to associate-vpc-with-hosted-zone to access this namespace
    new StringParameter(this, "PrivateNP Param", {
      parameterName: `privatenp-hostedid-param-${this.region}`,
      stringValue: PrivateNP.namespaceHostedZoneId,
    });
    this.schedulerDisovery = new Service(this, "Scheduler Discovery", {
      name: "Dask-Scheduler",
      namespace: PrivateNP,
    });

    // Scheduler Cluster initialised as empty for later
    this.cluster = new Cluster(this, "Scheduler Cluster", {
      clusterName: "DaskScheduler",
      containerInsights: true,
      vpc: this.vpc,
    });
  }

  /** Dask Scheduler
   *
   * This function focuses on the setup of the Dask Scheduler. The scheduler is setup as a fargate task
   * operating on high cpu and memory given it's critical purpose in orchestrating the dask.
   * We manually publish the dashboard to 8787 which will be viewable from within the VPC. E.g. load from
   * a browser from cloud9 that sits inside the VPC
   *
   * @param workers - An array of the worker regions
   */
  setupDaskScheduler(clientCidr: string, workers: IWorker[]) {
    // Fargate Definition
    const schedulerDefinition = new FargateTaskDefinition(
      this,
      "Scheduler Definition",
      { family: "Dask-Scheduler", memoryLimitMiB: 32768, cpu: 16384 }
    );
    // Container loads in from a versioned dask image on a fixed 8787 dashboard address
    schedulerDefinition.addContainer("Container", {
      containerName: "Dask",
      image: ContainerImage.fromDockerImageAsset(
        new DockerImageAsset(this, "Scheduler Image Repo", {
          directory: path.join(__dirname, "..", "DaskImage"),
          platform: Platform.LINUX_AMD64,
        })
      ),
      command: [
        "dask",
        "scheduler",
        "--dashboard",
        "--dashboard-address",
        "8787",
      ],
      essential: true,
      logging: LogDriver.awsLogs({
        streamPrefix: "ecs",
        logGroup: new LogGroup(this, "Scheduler Log Group"),
      }),
      portMappings: [{ containerPort: 8787 }, { containerPort: 8786 }],
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

    // Only worker region cidr ranges should be allowed to connect on port 8786
    const SchedulerSecurityGroup = new SecurityGroup(
      this,
      "Scheduler Security Group",
      { vpc: this.vpc }
    );
    SchedulerSecurityGroup.addIngressRule(
      Peer.ipv4(clientCidr),
      Port.tcp(8786),
      `Allow the home VPC to connect ${clientCidr} to the scheduler`
    );
    for (const worker of workers) {
      SchedulerSecurityGroup.addIngressRule(
        Peer.ipv4(worker.cidr),
        Port.tcp(8786),
        `Workers in ${worker.cidr} connect to Scheduler on this port`
      );
    }

    // Configuring the ALB for our fargate service, we get added control this way
    const albSecurityGroup = new SecurityGroup(this, "Scheduler ALB SG", {
      vpc: this.vpc,
    });
    // Restricting it so that only those within the VPC have access
    albSecurityGroup.addIngressRule(
      Peer.ipv4(this.vpc.vpcCidrBlock),
      Port.tcp(80),
      "Scheduler dashboard access"
    );
    // Offered construct that launches and manages the connectivity of an ALB to Fargate
    const DaskService = new ApplicationLoadBalancedFargateService(
      this,
      "Scheduler with Load Balancer",
      {
        serviceName: "Dask-Scheduler",
        taskDefinition: schedulerDefinition,
        cluster: this.cluster,
        enableExecuteCommand: true,
        taskSubnets: {
          subnetType: SubnetType.PRIVATE_WITH_EGRESS,
        },
        loadBalancer: new ApplicationLoadBalancer(this, "Dask-Scheduler-ALB", {
          vpc: this.vpc,
          securityGroup: albSecurityGroup,
          internetFacing: true,
        }),
        securityGroups: [SchedulerSecurityGroup],
      }
    );
    DaskService.targetGroup.configureHealthCheck({
      path: "/status",
    });
    DaskService.service.associateCloudMapService({
      service: this.schedulerDisovery,
    });
    DaskService.loadBalancer.logAccessLogs(
      secureBucket(this, "Dask-Scheduler-ALB-Access-Logs")
    );
    NagSuppressions.addResourceSuppressions(
      schedulerDefinition,
      [
        {
          id: "AwsSolutions-IAM5",
          reason:
            "Task role created by CDK has specific cloudwatch and ssm messages actions",
        },
      ],
      true
    );
  }

  /** OpenSearch
   *
   * OpenSearch will index the metadata of datasource we are connecting to from each region. We expose them
   * to the client region and worker regions over HTTPS only.
   *
   * @param workers - An array of the worker regions
   */
  setupOpenSearch(workers: IWorker[]) {
    // The security group is restricted to only allow HTTPS connectivity to the index
    const openSearchSecurityGroup = new SecurityGroup(
      this,
      "Open search Security Group",
      { vpc: this.vpc }
    );
    openSearchSecurityGroup.addIngressRule(
      Peer.ipv4(this.vpc.vpcCidrBlock),
      Port.tcp(443),
      "Allow access from client"
    );
    for (const worker of workers) {
      openSearchSecurityGroup.addIngressRule(
        Peer.ipv4(worker.cidr),
        Port.tcp(443),
        "Allow updates from worker/regional instances"
      );
    }

    // OpenSearch requires a service linked role, if you experience errors here, it may be that
    // you already have a service linked role for opensearch, so you can comment and redpeloy below
    const serviceLinkedRole = new CfnServiceLinkedRole(this, "OpenSearch SLR", {
      awsServiceName: "opensearchservice.amazonaws.com",
    });
    const openSearchDomain = new Domain(this, "OpenSearch Domain", {
      version: EngineVersion.OPENSEARCH_1_3,
      removalPolicy: RemovalPolicy.DESTROY,
      enableVersionUpgrade: true,
      nodeToNodeEncryption: true,
      capacity: {
        masterNodes: 3,
        dataNodes: 2,
      },
      zoneAwareness: {
        availabilityZoneCount: 2,
      },
      encryptionAtRest: {
        enabled: true,
      },
      logging: {
        slowSearchLogEnabled: true,
        slowIndexLogEnabled: true,
      },
      enforceHttps: true,
      vpc: this.vpc,
      useUnsignedBasicAuth: false,
      securityGroups: [openSearchSecurityGroup],
    });
    openSearchDomain.node.addDependency(serviceLinkedRole);

    NagSuppressions.addResourceSuppressions(
      openSearchDomain,
      [
        {
          id: "AwsSolutions-IAM5",
          reason: "CloudWatch logging role with specific actions",
        },
        {
          id: "AwsSolutions-OS3",
          reason:
            "Domain is within a VPC, and uses security groups for allow-listing an IP block",
        },
        {
          id: "AwsSolutions-OS5",
          reason:
            "Domain is within a VPC, and uses security groups for allow-listing an IP block",
        },
      ],
      true
    );

    this.openSearchDomain = new StringParameter(this, "OpenSearch HostName", {
      parameterName: `client-opensearch-domain-${this.region}`,
      stringValue: openSearchDomain.domainEndpoint,
    });
    this.openSearchArn = new StringParameter(this, "OpenSearch ARN", {
      parameterName: `client-opensearch-arn-${this.region}`,
      stringValue: openSearchDomain.domainArn,
    });
  }

  /** Jupyter Notebook
   *
   * The notebook acts as the interfacing body from the user to the scheduler. Below loads in the relevant
   * installations for the notebook to connect with the relevant permissions
   */
  setupSagemaker() {
    // The notebook requires access to not only access full access but specific access to the opensearch to post requests
    const role = new Role(this, "Sagemaker Role", {
      assumedBy: new ServicePrincipal("sagemaker.amazonaws.com"),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName("AmazonSageMakerFullAccess"),
        ManagedPolicy.fromAwsManagedPolicyName("AmazonECS_FullAccess"),
      ],
      inlinePolicies: {
        RetrieveOpenSearchDomain: new PolicyDocument({
          statements: [
            new PolicyStatement({
              resources: [
                this.openSearchArn.stringValue,
                `${this.openSearchArn.stringValue}/*`,
              ],
              actions: ["es:ESHttpPost", "es:ESHttpPut"],
            }),
          ],
        }),
      },
    });
    this.openSearchDomain.grantRead(role);

    NagSuppressions.addResourceSuppressions(role, [
      {
        id: "AwsSolutions-IAM4",
        reason:
          "Sagemaker Notebook policies need to be broad to allow access to ",
      },
      {
        id: "AwsSolutions-IAM5",
        reason: "Role requires access to all indicies",
      },
    ]);

    const SagemakerSec = new SecurityGroup(this, "Sagemaker security group", {
      vpc: this.vpc,
    });

    // Life Cycles allow us to install all the neccessary libraries so that when the noteook starts
    // the user need not worry about installing the required packages at the correct version
    const lifecycle = new CfnNotebookInstanceLifecycleConfig(
      this,
      "Life Cycle Config",
      {
        notebookInstanceLifecycleConfigName: "LibraryforDaskNotebook",
        onStart: [
          {
            content: readFileSync(
              path.join(__dirname, "..", "NotebookRequirements.txt")
            ).toString("base64"),
          },
        ],
      }
    );

    // Preloaded code brought into the notebook at launch
    const repo = new Repository(this, "Sagemaker Code", {
      repositoryName: "Sagemaker_Dask",
      code: Code.fromDirectory(path.join(__dirname, "..", "SagemakerCode")),
    });
    repo.grantRead(role);

    NagSuppressions.addResourceSuppressions(
      role,
      [
        {
          id: "AwsSolutions-IAM5",
          reason: "Permissions added by grant read on CodeCommit repo",
          appliesTo: [
            "Action::codecommit:Describe*",
            "Action::codecommit:Get*",
          ],
        },
      ],
      true
    );

    // Adding encryption is a best practise on the notebook
    const nbKey = new Key(this, "Notebook Key", {
      enableKeyRotation: true,
    });

    // The Sagemaker Notebook
    new CfnNotebookInstance(this, "Dask Notebook", {
      notebookInstanceName: "Dask-Notebook",
      rootAccess: "Disabled",
      directInternetAccess: "Disabled",
      defaultCodeRepository: repo.repositoryCloneUrlHttp,
      instanceType: "ml.t3.2xlarge",
      roleArn: role.roleArn,
      subnetId: this.vpc.privateSubnets[0].subnetId,
      securityGroupIds: [SagemakerSec.securityGroupId],
      lifecycleConfigName: lifecycle.notebookInstanceLifecycleConfigName,
      kmsKeyId: nbKey.keyId,
      platformIdentifier: "notebook-al2-v1",
      volumeSizeInGb: 50,
    });
  }
}
