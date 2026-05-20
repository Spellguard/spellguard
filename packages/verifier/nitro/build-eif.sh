#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0

# ═══════════════════════════════════════════════════════════════════
# build-eif.sh — Build Nitro Enclave Image Format (EIF) file
#
# Builds the Docker image from Dockerfile.nitro and converts it to
# an EIF using nitro-cli. Outputs PCR measurements for attestation.
#
# Prerequisites:
#   - Docker CLI
#   - nitro-cli (works on any Linux with Docker, no hardware needed)
#
# Usage:
#   ./packages/verifier/nitro/build-eif.sh [--tag <docker-tag>] [--output <eif-path>]
#
# Example:
#   ./packages/verifier/nitro/build-eif.sh --tag spellguard-verifier-nitro:latest \
#     --output /tmp/spellguard-verifier.eif
# ═══════════════════════════════════════════════════════════════════
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# Defaults
IMAGE_TAG="spellguard-verifier-nitro:latest"
EIF_OUTPUT="/tmp/spellguard-verifier.eif"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag)
      IMAGE_TAG="$2"
      shift 2
      ;;
    --output)
      EIF_OUTPUT="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1"
      exit 1
      ;;
  esac
done

echo "==> Building Docker image for Nitro Enclave..."
echo "    Tag: $IMAGE_TAG"
docker build \
  -t "$IMAGE_TAG" \
  -f "$REPO_ROOT/packages/verifier/Dockerfile.nitro" \
  "$REPO_ROOT"

echo ""
echo "==> Converting Docker image to EIF..."
echo "    Output: $EIF_OUTPUT"
nitro-cli build-enclave \
  --docker-uri "$IMAGE_TAG" \
  --output-file "$EIF_OUTPUT"

echo ""
echo "==> EIF build complete!"
echo "    File: $EIF_OUTPUT"
echo ""
echo "    Record the PCR0 value above as the enclave image hash for attestation."
echo "    Use it as VERIFIER_IMAGE_HASH and expected_image_hash in the database."
echo ""
echo "    To run the enclave (on Nitro-capable hardware):"
echo "    nitro-cli run-enclave \\"
echo "      --cpu-count 1 \\"
echo "      --memory 1536 \\"
echo "      --eif-path $EIF_OUTPUT \\"
echo "      --enclave-cid 16"
