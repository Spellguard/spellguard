#!/bin/sh
# SPDX-License-Identifier: Apache-2.0

# ═══════════════════════════════════════════════════════════════════
# docker-entrypoint.sh — Source /app/.env (if non-empty) before
# starting the Verifier server.
#
# Used by deploys that bake the env file into the image
# (scripts/deploy-internal.sh via the ENV_FILE_CONTENT build arg).
# For deploys that inject env vars at runtime (Phala), /app/.env is
# an empty file left over from the build — sourcing it is a no-op.
# ═══════════════════════════════════════════════════════════════════
set -e

if [ -s /app/.env ]; then
  sed -i 's/\r$//' /app/.env
  set -a
  . /app/.env
  set +a
fi

exec "$@"
