echo 'Start lfs' > /tmp/triggerScan.log
date +%s >> /tmp/triggerScan.log
lfs find /fsx -type f >> fileToWriteToOpenSearch.txt
echo 'lfs Done, start indexing to OpenSearch' >> /tmp/triggerScan.log
python3 updateOpenSearch.py
date +%s >> /tmp/triggerScan.log
echo 'Done triggerScan.sh' >> /tmp/triggerScan.log