#!/usr/bin/env bash
# Deploy invoke-library on Unraid (Array). Run from a LAN machine with SSH to Unraid:
#   ssh root@192.168.1.12 'bash -s' < deploy/unraid-docker-run.sh
# Or copy to Unraid and: bash unraid-docker-run.sh
set -euo pipefail

IMAGE="${IMAGE:-ghcr.io/mbriney/invoke-library:latest}"
NAME=invoke-library
HOST_PORT=8091

mkdir -p /mnt/user/appdata/invoke-library

docker pull "$IMAGE"

# Do not remove InvokeAI; only recreate this app container if present
if docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
  docker stop "$NAME" || true
  docker rm "$NAME" || true
fi

docker run -d \
  --name "$NAME" \
  --restart unless-stopped \
  -p "${HOST_PORT}:8080" \
  -e INVOKE_BASE_URL="${INVOKE_BASE_URL:-http://192.168.1.12:9091}" \
  -e INVOKE_API_TOKEN="${INVOKE_API_TOKEN:-}" \
  -e KEEP_DIR=/data/keepers \
  -e KEEP_LABEL=Friends \
  -e APP_TITLE="Invoke Library" \
  -e INVOKE_OUTPUTS_DIR=/data/invoke-outputs \
  -e CONFIG_DIR=/data/config \
  -e IMAGE_SUBDIR=images \
  -v /mnt/user/appdata/invokeai/outputs:/data/invoke-outputs:ro \
  -v /mnt/user/Friends:/data/keepers \
  -v /mnt/user/appdata/invoke-library:/data/config \
  "$IMAGE"

sleep 2
curl -fsS "http://127.0.0.1:${HOST_PORT}/health" || curl -fsS "http://192.168.1.12:${HOST_PORT}/health" || true
docker ps --filter "name=^/${NAME}$" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
