#!/usr/bin/env bash
# Remove o cluster kind (e os PVCs junto) e o container do cloud-provider-kind.
set -euo pipefail
kind delete cluster --name 4life
docker rm -f 4life-cloud-provider-kind 2>/dev/null || true
