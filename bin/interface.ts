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
