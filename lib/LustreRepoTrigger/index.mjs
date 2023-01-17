import {
  FSxClient,
  CreateDataRepositoryTaskCommand,
} from "@aws-sdk/client-fsx";

const fsx = new FSxClient();

export const handler = async (event) => {
  const command = new CreateDataRepositoryTaskCommand({
    FileSystemId: process.env.FileSystemId,
    Type: "IMPORT_METADATA_FROM_REPOSITORY",
    Report: {
      Enabled: false,
    },
  });
  const response = await fsx.send(command);

  console.log(response);
  return;
};
