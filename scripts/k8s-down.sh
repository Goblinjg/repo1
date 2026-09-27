#!/usr/bin/env bash
# Remove o cluster kind (e os PVCs junto), o cloud-provider-kind e os containers de
# LoadBalancer/Ingress que ele cria fora do cluster (kindccm-*). Sem isso, um cluster
# novo herdaria um Envoy apontando para pods que não existem mais.
set -euo pipefail
kind delete cluster --name 4life
docker rm -f 4life-cloud-provider-kind 2>/dev/null || true
docker ps -aq --filter name=^kindccm- | xargs -r docker rm -f > /dev/null
echo "ambiente K8s removido"
