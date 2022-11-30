// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { IClient, IWorker } from "./interface";

export const client: IClient = { region: "eu-west-2", cidr: "10.0.0.0/16" };
// The worker regions you wish to deploy to, which the respective datasets you want to connect to
// NOTE: Between the client and workers these cidr ranges cannot overlap

export const workers: IWorker[] = [
  {
    region: "us-east-1",
    cidr: "10.1.0.0/16",
    dataset: "s3://era5-pds",
    // The public s3 dataset on https://registry.opendata.aws/ you wish to connect to
    lustreFileSystemPath: "era5-pds",
  },
  {
    region: "us-west-2",
    cidr: "10.2.0.0/16",
    dataset: "s3://cmip6-pds/CMIP6/ScenarioMIP/MOHC",
    // The mapping you wish to have set up on the worker.
    // E.g. this mapping will be saved as /fsx/us-west-2/CMIP6/ScenarioMIP/MOHC
    lustreFileSystemPath: "CMIP6/ScenarioMIP/MOHC",
  },
];
