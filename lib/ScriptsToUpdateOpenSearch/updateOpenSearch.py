#  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
#  SPDX-License-Identifier: MIT-0

from opensearchpy import OpenSearch, RequestsHttpConnection, AWSV4SignerAuth
from opensearchpy.helpers import bulk
import requests
import boto3

local_region = requests.get('http://169.254.169.254/latest/meta-data/placement/region').text

worker_region_ssm = boto3.client('ssm', region_name=local_region)
client_region = worker_region_ssm.get_parameter(
    Name='client-region-for-dask-worker-' + local_region
)['Parameter']['Value']
bucket = worker_region_ssm.get_parameter(
    Name='worker-region-data-bucket-for-dask-worker-' + local_region
)['Parameter']['Value']

client_region_ssm = boto3.client('ssm', region_name=client_region)
host = client_region_ssm.get_parameter(
    Name='client-opensearch-domain-' + client_region
    )['Parameter']['Value']

credentials = boto3.Session().get_credentials()
auth = AWSV4SignerAuth(credentials, client_region)

client = OpenSearch(
    hosts = [{'host': host, 'port': 443}],
    http_auth = auth,
    use_ssl = True,
    verify_certs = True,
    connection_class = RequestsHttpConnection
)

file1 = open('fileToWriteToOpenSearch.txt', 'r')
Lines = file1.readlines()

# Strips the newline character
bulk_data = []
for line in Lines:
    filePath = line.strip()

    bulk_data.append({
        '_index': bucket,
        '_id': line.strip(),
        '_source': {
            'fileName': filePath,
            'bucket': bucket,
            'region': local_region,
            'dask_pool': local_region,
            'project': bucket
        },
    })
try:
    client.indices.delete(index=bucket)
except:
    print('Index does not currently exist')
print('Starting Bulk Upload to OpenSearch')
bulk(client, bulk_data)
print('Bulk Done')