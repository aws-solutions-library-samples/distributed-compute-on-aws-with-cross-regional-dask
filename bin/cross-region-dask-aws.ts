// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { App, Aspects } from "aws-cdk-lib";
import { ClientRegion } from "../lib/ClientConstructs/client-region-stack";
import { ClientToWorkerTransitGatewayRoute } from "../lib/ClientConstructs/client-region-tgw-route";
import { InterRegionTransitGatewayRoute } from "../lib/WorkerConstructs/interregion-worker-tgw-route";
import { WorkerRegion } from "../lib/WorkerConstructs/worker-region-stack";
import { WorkerRegionTransitGatewayRoute } from "../lib/WorkerConstructs/worker-region-tgw-route";
import { WorkerToWorkerTGW } from "../lib/WorkerConstructs/worker-to-worker-tgw";
import { AwsSolutionsChecks } from "cdk-nag";
import { client, workers } from "./variables";
import { SyncLustreToOpenSearch } from "../lib/WorkerConstructs/sync-lustre-to-opensearch";

const app = new App();
// The clients configuration which includes the region and cidr range to which the notebook and scheduler will sit

/**
 * Create the clients region where the notebook and scheduler will be located
 */
const clientStack = new ClientRegion(app, "Client-Region", {
  env: {
    region: client.region,
  },
  clientCidr: client.cidr,
  workers,
  description: "Reference for distributed compute on AWS with cross regional DASK ('uksb-1tsflhnc4')",
});

// This array will contain the contruct classes of workers which allow us to interconnect them later dynamically
const WorkerStacks: WorkerRegion[] = [];
// Load through each worker connecting each
for (const worker of workers) {
  // Create the base infrastucture for workers, not yet connecting them
  const Worker = new WorkerRegion(app, `Worker-Region-${worker.region}`, {
    env: {
      region: worker.region,
    },
    client,
    worker,
  });
  Worker.addDependency(clientStack);
  // Wait until the peer to the client region has been established and then add to the tgw route table
  // a route from the worker region to the tgw
  new WorkerRegionTransitGatewayRoute(
    app,
    `Worker-Region-TGW-Route-${worker.region}`,
    {
      env: {
        region: worker.region,
      },
      client,
      tgw: Worker.tgw,
      attachmentId: Worker.attachmentID,
    }
  ).addDependency(Worker);
  // Subsequently we must now add on the client side the same route to their TGW route table, same process
  new ClientToWorkerTransitGatewayRoute(
    app,
    `Client-Region-TGW-Route-${worker.region}`,
    {
      env: {
        region: client.region,
      },
      clientTgw: clientStack.clientTGW,
      worker,
    }
  ).addDependency(Worker);
  WorkerStacks.push(Worker);
}

// Connect each worker to each other in a dynamic format
const index = [...Array(workers.length).keys()];
// Loop each worker by each worker in a form where each worker's connection is visited only once
for (const x in workers) {
  const StackWait: WorkerToWorkerTGW[] = [];
  for (const y of index.slice(parseInt(x) + 1, index.length)) {
    // First we create the neccessary peer connection adding what we can at this early point in time
    const W2WTransitGateway = new WorkerToWorkerTGW(
      app,
      `TGW-Peer-Region-${workers[x].region}-to-${workers[y].region}`,
      {
        env: {
          region: workers[x].region,
        },
        peerWorker: workers[y],
        vpc: WorkerStacks[x].vpc,
      }
    );
    StackWait.push(W2WTransitGateway);

    // We then want to add from worker to worker the transit gateway route
    const WRTGWRoute = new WorkerRegionTransitGatewayRoute(
      app,
      `Worker-Region-TGW-Route-${workers[x].region}-to-${workers[y].region}`,
      {
        env: {
          region: workers[x].region,
        },
        client: workers[y],
        tgw: WorkerStacks[x].tgw,
        attachmentId: W2WTransitGateway.attachmentID,
      }
    ).addDependency(W2WTransitGateway);

    // And finally the inverse of what's done above
    new InterRegionTransitGatewayRoute(
      app,
      `Inter-Region-TGW-Route-${workers[y].region}-to-${workers[x].region}`,
      {
        env: {
          region: workers[y].region,
        },
        peerWorker: workers[x],
        tgw: WorkerStacks[y].tgw,
        vpc: WorkerStacks[y].vpc,
      }
    ).addDependency(W2WTransitGateway);
  }
  // Give as much time as possible for lustre to sync to public s3, and then launch the autoscaling
  // instance to publish the results to opensearch
  const lustreToOS = new SyncLustreToOpenSearch(
    app,
    `ZyncLustreToOpenSearch-${workers[x].region}`,
    {
      env: {
        region: workers[x].region,
      },
      client: client,
      worker: workers[x],
      vpc: WorkerStacks[x].vpc,
      lustre: WorkerStacks[x].lustre,
    }
  );
}
// CDK nag reports are outputted into the dist folder as csv files
Aspects.of(app).add(new AwsSolutionsChecks({ reports: true }));
