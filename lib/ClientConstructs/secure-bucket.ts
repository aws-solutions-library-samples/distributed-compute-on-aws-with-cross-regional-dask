// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { Stack } from "aws-cdk-lib";
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
} from "aws-cdk-lib/aws-s3";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { NagSuppressions } from "cdk-nag";

// Bucket is for launching a secure bucket for logging access to
export const secureBucket = (
  stack: Stack,
  bucketId: string,
  accessLogsBucket?: Bucket,
  resourcePolicy?: PolicyStatement
) => {
  const bucket = new Bucket(stack, bucketId, {
    blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
    encryption: BucketEncryption.S3_MANAGED,
    enforceSSL: true,
    serverAccessLogsBucket: accessLogsBucket,
  });
  if (!accessLogsBucket) {
    NagSuppressions.addResourceSuppressions(
      bucket,
      [{ id: "AwsSolutions-S1", reason: "Access logs bucket" }],
      true
    );
  }
  if (resourcePolicy) {
    resourcePolicy.addResources(bucket.bucketArn, `${bucket.bucketArn}/*`);
    bucket.addToResourcePolicy(resourcePolicy);
  }
  return bucket;
};
