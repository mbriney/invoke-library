#!/usr/bin/env bash
# Deploy invoke-library on Unraid Array.
# From Mac on LAN:
#   ssh root@192.168.1.12 'bash -s' < deploy/unraid-docker-run.sh
# Or on Unraid with a local tar:
#   IMAGE_TAR=/path/to/invoke-library-image.tar bash deploy/unraid-docker-run.sh
set -euo pipefail

NAME=invoke-library
HOST_PORT=8091
IMAGE="${IMAGE:-ghcr.io/mbriney/invoke-library:latest}"
RELEASE_TAG="${RELEASE_TAG:-unraid-image}"
REPO="${REPO:-mbriney/invoke-library}"

mkdir -p /mnt/user/appdata/invoke-library

load_ok=0
if [[ -n "${IMAGE_TAR:-}" && -f "${IMAGE_TAR}" ]]; then
  echo "Loading image from ${IMAGE_TAR}"
  docker load -i "${IMAGE_TAR}"
  load_ok=1
elif docker image inspect "${IMAGE}" >/dev/null 2>&1; then
  echo "Using existing local image ${IMAGE}"
  load_ok=1
else
  TMP=$(mktemp /tmp/invoke-library-XXXXXX.tar)
  URL="https://github.com/${REPO}/releases/download/${RELEASE_TAG}/invoke-library-image.tar"
  echo "Downloading ${URL}"
  if curl -fsSL -o "${TMP}" "${URL}"; then
    docker load -i "${TMP}"
    load_ok=1
  fi
  rm -f "${TMP}"
fi

if [[ "${load_ok}" -ne 1 ]]; then
  echo "ERROR: could not load image. Set IMAGE_TAR or publish release asset." >&2
  exit 1
fi

# Prefer the tag embedded in the tar
if docker image inspect "ghcr.io/mbriney/invoke-library:latest" >/dev/null 2>&1; then
  IMAGE=ghcr.io/mbriney/invoke-library:latest
fi

if docker ps -a --format '{{.Names}}' | grep -qx "${NAME}"; then
  docker stop "${NAME}" || true
  docker rm "${NAME}" || true
fi

docker run -d \
  --name "${NAME}" \
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
  "${IMAGE}"

sleep 3
echo "Health:"
curl -fsS "http://127.0.0.1:${HOST_PORT}/health" || curl -fsS "http://192.168.1.12:${HOST_PORT}/health" || true
echo
docker ps --filter "name=^/${NAME}$" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
