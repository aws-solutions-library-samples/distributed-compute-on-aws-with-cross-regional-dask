import { App, Stack, StackProps } from "aws-cdk-lib";
import { AutoScalingGroup } from "aws-cdk-lib/aws-autoscaling";
import {
  AmazonLinuxGeneration,
  AmazonLinuxImage,
  InstanceType,
  Vpc,
} from "aws-cdk-lib/aws-ec2";
import { LustreFileSystem } from "aws-cdk-lib/aws-fsx";
import { ManagedPolicy, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Key } from "aws-cdk-lib/aws-kms";
import { Topic } from "aws-cdk-lib/aws-sns";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import { NagSuppressions } from "cdk-nag";
import { readFileSync } from "fs";
import path = require("path");
import { IClient, IWorker } from "../../bin/interface";
import { SSMParameterReader } from "../SdkConstructs/ssm-param-reader";

interface SyncLustreToOpenSearchProps extends StackProps {
  client: IClient;
  worker: IWorker;
  vpc: Vpc;
  lustre: LustreFileSystem;
}

export class SyncLustreToOpenSearch extends Stack {
  constructor(scope: App, id: string, props: SyncLustreToOpenSearchProps) {
    super(scope, id, props);
    const { client, worker, vpc, lustre } = props;

    this.setupOpenSearchUpdates(client, worker, vpc, lustre);

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
  /** Setup The Open Search for updates
   *
   * @param client - Object of the client containing pieces such as client region and cidr
   * @param worker - Object of the worker containing pieces such as worker region, cidr and data
   */
  setupOpenSearchUpdates(
    client: IClient,
    worker: IWorker,
    vpc: Vpc,
    lustre: LustreFileSystem
  ) {
    // Creating a topic for best practise purposes which you could make use of downstream
    const snsTopicForUpdates = new Topic(this, "SNS Updates Autoscaling", {
      masterKey: new Key(this, "ASG Updates Key", {
        enableKeyRotation: true,
      }),
    });

    // This autoscaling group creates just one instance which will perform the updates to opensearch
    // Can be autoscaled to go up and down in the future
    const autoScalingGroup = new AutoScalingGroup(this, "AutoScaling Group", {
      vpc,
      machineImage: new AmazonLinuxImage({
        generation: AmazonLinuxGeneration.AMAZON_LINUX_2,
      }),
      instanceType: new InstanceType("m5d.large"),
      notifications: [
        {
          topic: snsTopicForUpdates,
        },
      ],
    });
    autoScalingGroup.addToRolePolicy(
      new PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [
          `arn:aws:ssm:${client.region}:${this.account}:parameter/client-opensearch-domain-${client.region}`,
        ],
      })
    );

    // The arn is loaded in for the client region opensearch domain
    const OpenSearchARN = new SSMParameterReader(this, "OpenSearchARN", {
      parameterName: `client-opensearch-arn-${client.region}`,
      region: client.region,
      account: this.account,
    }).getParameterValue();
    autoScalingGroup.addToRolePolicy(
      new PolicyStatement({
        resources: [OpenSearchARN, `${OpenSearchARN}/*`],
        actions: ["es:ESHttpPut", "es:ESHttpPost", "es:ESHttpDelete"],
      })
    );

    autoScalingGroup.role.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore")
    );
    NagSuppressions.addResourceSuppressions(autoScalingGroup.role, [
      {
        id: "AwsSolutions-IAM4",
        reason: "Debug access",
      },
    ]);

    NagSuppressions.addResourceSuppressions(
      autoScalingGroup,
      [
        {
          id: "AwsSolutions-IAM5",
          reason: "Instance needs access to push to all indicies",
        },
      ],
      true
    );

    // The two scripts below are loaded onto the ec2 instance and triggered each day to push to opensearch
    // Currently it's doing a complete sync each time, but can be optimised into the future
    // And does not note deletions
    const trigger = readFileSync(
      path.join(__dirname, "..", "ScriptsToUpdateOpenSearch/triggerScan.sh"),
      { encoding: "utf8", flag: "r" }
    );
    const script = readFileSync(
      path.join(
        __dirname,
        "..",
        "ScriptsToUpdateOpenSearch/updateOpenSearch.py"
      ),
      { encoding: "utf8", flag: "r" }
    );

    new StringParameter(this, "ClientRegionForEC2", {
      parameterName: `client-region-for-dask-worker-${this.region}`,
      stringValue: client.region,
    }).grantRead(autoScalingGroup);
    new StringParameter(this, "WorkerDataProjectForEC2", {
      parameterName: `worker-region-data-bucket-for-dask-worker-${this.region}`,
      stringValue: worker.dataset.split("/")[2],
    }).grantRead(autoScalingGroup);

    // The userdata for this instance installs libraries, mounts lustre, and setups the sync job to
    // opensearch to trigger daily at 1am which should give enough time for the eventrule triggered at
    // midnight to finish
    autoScalingGroup.addUserData(
      "amazon-linux-extras install -y lustre",
      "pip3 install opensearch-py boto3",
      "mkdir -p /fsx",
      `mount -t lustre ${lustre.dnsName}@tcp:/${lustre.mountName} /fsx -o flock`,
      `echo ${lustre.dnsName}@tcp:/${lustre.mountName} /fsx lustre defaults,flock,_netdev,x-systemd.automount,x-systemd.requires=network.service 0 0 >> /etc/fstab`,
      "echo mountDone",
      `echo "${trigger}" > /triggerScan.sh`,
      `echo "${script}" > /updateOpenSearch.py`,
      'crontab -l | { cat; echo "0 1 * * * bash /triggerScan.sh"; } | crontab -',
      "echo runningSync",
      "bash /triggerScan.sh",
      "echo syncDone"
    );
  }
}
