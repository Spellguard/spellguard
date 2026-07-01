#!/bin/sh
# SPDX-License-Identifier: Apache-2.0

# ═══════════════════════════════════════════════════════════════════
# Enclave entrypoint for Spellguard Verifier on AWS Nitro Enclaves.
#
# This script runs INSIDE the enclave (no network access by default).
# It loads environment config, sets up a socat bridge to the host's
# outbound proxy, and then starts the Verifier server.
# ═══════════════════════════════════════════════════════════════════
set -eu

# ── Load environment config ──────────────────────────────────────
# The .env file is baked into the image at build time from a GitHub Actions
# environment variable. It contains all env vars the
# Verifier server needs (MANAGEMENT_URL, VERIFIER_ID, MANAGEMENT_PUBLIC_KEY, etc.).
# ── Bring up loopback interface ─────────────────────────────────
# Nitro Enclaves have no networking by default — not even loopback.
# Without this, 127.0.0.1 is unreachable and the server can't bind.
ifconfig lo 127.0.0.1 up 2>/dev/null || ip link set lo up 2>/dev/null || true
echo "[enclave-init] Loopback interface up"

if [ -f /app/.env ]; then
  echo "[enclave-init] Loading environment from /app/.env"
  # Strip \r from env file — GitHub variables may have Windows line endings
  sed -i 's/\r$//' /app/.env
  set -a
  . /app/.env
  set +a
else
  echo "[enclave-init] WARNING: /app/.env not found — running with defaults"
fi

# ── Inbound traffic bridge (ALB → Enclave) ────────────────────
# The host's vsock-inbound socat sends ALB traffic to vsock CID:16 port 3000.
# Bridge that to the Verifier server's TCP port 3000 inside the enclave.
echo "[enclave-init] Starting inbound vsock bridge..."
socat VSOCK-LISTEN:3000,fork,reuseaddr TCP:127.0.0.1:3000 &
echo "[enclave-init] Inbound bridge started (vsock:3000 → tcp:3000)"

# ── Outbound proxy bridge ────────────────────────────────────────
echo "[enclave-init] Starting outbound proxy bridge..."

# Bridge vsock CID:3 (host) port 4443 to localhost:4443 inside the enclave.
# This allows the Verifier server to reach the internet via the host's CONNECT proxy.
socat TCP-LISTEN:4443,fork,reuseaddr VSOCK-CONNECT:3:4443 &
SOCAT_PID=$!

echo "[enclave-init] Outbound proxy bridge started (PID: $SOCAT_PID)"

# Configure the HTTP(S) proxy for outbound connections.
# Node 24's fetch (undici) is configured via ProxyAgent in server.ts,
# but other tools/libs may use these env vars.
export HTTPS_PROXY="http://127.0.0.1:4443"
export HTTP_PROXY="http://127.0.0.1:4443"

# ── Start Verifier server ─────────────────────────────────────────────
echo "[enclave-init] Starting Verifier server..."
echo "[enclave-init]   VERIFIER_ID=${VERIFIER_ID:-<not set>}"
echo "[enclave-init]   VERIFIER_PLATFORM=${VERIFIER_PLATFORM:-<not set>}"
echo "[enclave-init]   MANAGEMENT_URL=${MANAGEMENT_URL:-<not set>}"
echo "[enclave-init]   VERIFIER_EXTERNAL_URL=${VERIFIER_EXTERNAL_URL:-<not set>}"
echo "[enclave-init]   DYNAMODB_NONCE_TABLE=${DYNAMODB_NONCE_TABLE:-<not set>}"
echo "[enclave-init]   MANAGEMENT_PUBLIC_KEY=${MANAGEMENT_PUBLIC_KEY:+set (${#MANAGEMENT_PUBLIC_KEY} chars)}"

# Run the esbuild bundle — all internal imports (ctls, amp, local files)
# are resolved at build time. No tsx, no ESM resolution issues.
cd /app
exec node dist/server.mjs
