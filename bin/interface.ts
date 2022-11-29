// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

export interface IClient {
  region: string;
  cidr: string;
}

export interface IWorker {
  region: string;
  cidr: string;
  dataset: string;
  lustreFileSystemPath: string;
}
