#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0

#
# dev-agents.sh — Start Dockerized test agents + Cloudflare tunnel for Slack webhooks.
#
# Prerequisites:
#   - Docker and Docker Compose installed
#   - .env.agents file with bot credentials (copy from your secret store)
#   - cloudflared installed (brew install cloudflared / apt install cloudflared)
#   - Verifier + Management server running (pnpm run dev:all in another terminal)
#
# Usage:
#   pnpm run dev:agents              # start all Docker agents + tunnel
#   pnpm run dev:agents --no-tunnel  # start agents without tunnel
#
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
DIM='\033[2m'
RESET='\033[0m'

SKIP_TUNNEL=false
for arg in "$@"; do
  case "$arg" in
    --no-tunnel) SKIP_TUNNEL=true ;;
  esac
done

PIDS=()
cleanup() {
  echo ""
  echo -e "${YELLOW}Shutting down agents and tunnel...${RESET}"
  # Bash 3.2 (macOS) errors on "${PIDS[@]}" when the array is empty
  # under `set -u`; guard with the ${var+…} expansion.
  for pid in ${PIDS[@]+"${PIDS[@]}"}; do
    kill "$pid" 2>/dev/null || true
  done
  docker compose -f docker-compose.agents.yml --env-file .env.agents down 2>/dev/null || true
  wait 2>/dev/null
  echo -e "${GREEN}All agents stopped.${RESET}"
}
trap cleanup EXIT INT TERM

log() { echo -e "${CYAN}[dev-agents]${RESET} $*"; }
ok()  { echo -e "${CYAN}[dev-agents]${RESET} ${GREEN}✓${RESET} $*"; }
fail() { echo -e "${CYAN}[dev-agents]${RESET} ${RED}✗ $*${RESET}"; exit 1; }

# ─── Preflight checks ────────────────────────────────────────────────

# 1. Check .env.agents exists
if [ ! -f .env.agents ]; then
  echo ""
  echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo -e "${RED}  ERROR: .env.agents file not found${RESET}"
  echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo ""
  echo -e "  Each developer has their own set of Slack bot credentials and"
  echo -e "  Cloudflare tunnel token. Get yours from your secret store:"
  echo ""
  echo -e "  1. Open your secret store → find the shared Spellguard bot-credentials item"
  echo -e "  2. Find your environment's entry"
  echo -e "  3. Copy the contents and save to ${CYAN}.env.agents${RESET} in the repo root"
  echo ""
  echo -e "  ${DIM}Do NOT share credentials between developers — each set is unique.${RESET}"
  echo ""
  exit 1
fi

# 2. Check Docker
if ! command -v docker &>/dev/null; then
  fail "Docker not installed. Install Docker Desktop or Docker Engine first."
fi

# 3. Load env vars and validate required credentials
set -a
source .env.agents
set +a

MISSING=()
[ -z "${SLACK_CHANNEL_ID:-}" ] && MISSING+=("SLACK_CHANNEL_ID")
[ -z "${CLOUDFLARE_TUNNEL_TOKEN:-}" ] && MISSING+=("CLOUDFLARE_TUNNEL_TOKEN")

# Check for at least one bot token (first bot in the file)
HAS_BOT_TOKEN=false
for var in $(env | grep '_BOT_TOKEN=' | head -1); do
  HAS_BOT_TOKEN=true
done
[ "$HAS_BOT_TOKEN" = false ] && MISSING+=("*_BOT_TOKEN (no bot tokens found)")

if [ ${#MISSING[@]} -gt 0 ]; then
  echo ""
  echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo -e "${RED}  ERROR: .env.agents is missing required credentials${RESET}"
  echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo ""
  echo -e "  Missing values:"
  for m in "${MISSING[@]}"; do
    echo -e "    ${RED}✗${RESET} $m"
  done
  echo ""
  echo -e "  Your .env.agents should contain your developer-specific credentials"
  echo -e "  from your secret store. Each developer has a unique set — do not copy from"
  echo -e "  another developer's file."
  echo ""
  echo ""
  exit 1
fi

# 4. Check cloudflared
if [ "$SKIP_TUNNEL" = false ] && ! command -v cloudflared &>/dev/null; then
  echo ""
  echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo -e "${RED}  ERROR: cloudflared is not installed${RESET}"
  echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo ""
  echo -e "  cloudflared is required to set up the Cloudflare Tunnel that routes"
  echo -e "  Slack webhook events to your local machine for the OpenClaw HTTP"
  echo -e "  Events integration."
  echo ""
  echo -e "  Install it first:"
  echo -e "    ${CYAN}Mac:${RESET}    brew install cloudflared"
  echo -e "    ${CYAN}Linux:${RESET}  curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o /tmp/cloudflared.deb && sudo dpkg -i /tmp/cloudflared.deb"
  echo ""
  echo -e "  ${DIM}No login or account setup needed — your tunnel token is in .env.agents.${RESET}"
  echo -e "  ${DIM}To skip the tunnel (Socket Mode only): pnpm run dev:agents -- --no-tunnel${RESET}"
  echo ""
  exit 1
fi

# ─── Cloudflare Tunnel ───────────────────────────────────────────────

if [ "$SKIP_TUNNEL" = false ]; then
  if [ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]; then
    log "Starting Cloudflare tunnel..."
    # Tunnel ingress is remotely managed (configured via Cloudflare API).
    # Routes /slack/events → localhost:4010 (openclaw-http) and
    # everything else → localhost:3001 (management server).
    cloudflared tunnel run --token "$CLOUDFLARE_TUNNEL_TOKEN" 2>&1 | sed "s/^/${DIM}[tunnel]${RESET} /" &
    TUNNEL_PID=$!
    PIDS+=($TUNNEL_PID)
    sleep 3
    if kill -0 "$TUNNEL_PID" 2>/dev/null; then
      ok "Cloudflare tunnel started ${DIM}(${CLOUDFLARE_TUNNEL_URL:-tunnel URL not set})${RESET}"
    else
      log "${YELLOW}Tunnel failed to start — continuing without it${RESET}"
    fi
  fi
fi

# ─── Seed agent records + apply default policies ───────────────────
# The management seed (run by dev:all) creates standard test agents but
# not the OpenClaw Docker agents.  This block:
#   1. Creates OpenClaw agent records with properly hashed secrets
#   2. Creates the platform_connection for the HTTP Events bot (signing secret)
#   3. Applies default policy bindings from the catalog to the agents' org
# All operations are idempotent (ON CONFLICT DO NOTHING / skip if exists).

SUPABASE_DB_PORT=${SUPABASE_DB_PORT:-54322}
DB_CONTAINER="supabase_db_$(basename "$PWD")"

if bash -c "echo >/dev/tcp/127.0.0.1/$SUPABASE_DB_PORT" 2>/dev/null; then
  log "Seeding OpenClaw agent records..."

  OPENCLAW_AGENT_ID="${SPELLGUARD_OPENCLAW_AGENT_ID:-openclaw-socket}"
  HTTP_AGENT_ID="${SPELLGUARD_HTTP_AGENT_ID:-openclaw-http}"

  # Hash secrets with bcrypt so the Verifier can verify agent auth
  OPENCLAW_HASH="dev-placeholder"
  HTTP_HASH="dev-placeholder"
  if [ -n "${SPELLGUARD_OPENCLAW_SECRET:-}" ]; then
    OPENCLAW_HASH=$(node -e "require('bcryptjs').hash('${SPELLGUARD_OPENCLAW_SECRET}',12).then(h=>console.log(h))" 2>/dev/null) || OPENCLAW_HASH="dev-placeholder"
  fi
  if [ -n "${SPELLGUARD_HTTP_SECRET:-}" ]; then
    HTTP_HASH=$(node -e "require('bcryptjs').hash('${SPELLGUARD_HTTP_SECRET}',12).then(h=>console.log(h))" 2>/dev/null) || HTTP_HASH="dev-placeholder"
  fi

  docker exec "$DB_CONTAINER" psql -U postgres -d postgres -q -c "
    DO \$\$
    DECLARE
      _owner_id uuid;
      _org_id   uuid;
    BEGIN
      SELECT id INTO _owner_id FROM auth.users LIMIT 1;
      SELECT id INTO _org_id   FROM organizations LIMIT 1;

      IF _owner_id IS NULL OR _org_id IS NULL THEN
        RAISE NOTICE 'No seed data found — run pnpm run dev:all first';
        RETURN;
      END IF;

      -- Upsert Socket Mode agent (Bot A + B)
      INSERT INTO agents (agent_id, name, status, auth_mode, owner_id, organization_id, hashed_secret)
      VALUES ('$OPENCLAW_AGENT_ID', 'OpenClaw Socket Mode', 'active', 'secret', _owner_id, _org_id, '$OPENCLAW_HASH')
      ON CONFLICT (agent_id) DO UPDATE SET hashed_secret = EXCLUDED.hashed_secret;

      -- Upsert HTTP Events agent (Bot C)
      INSERT INTO agents (agent_id, name, status, auth_mode, owner_id, organization_id, hashed_secret)
      VALUES ('$HTTP_AGENT_ID', 'OpenClaw HTTP Events', 'active', 'secret', _owner_id, _org_id, '$HTTP_HASH')
      ON CONFLICT (agent_id) DO UPDATE SET hashed_secret = EXCLUDED.hashed_secret;

      -- Upsert platform connection with Slack signing secret for HTTP bot.
      -- Delete + re-insert (no unique constraint on agent_id+platform) to
      -- handle developer credential switches cleanly.
      IF '${BOT_C_SIGNING_SECRET:-}' <> '' THEN
        DELETE FROM platform_connections
        WHERE agent_id = (SELECT id FROM agents WHERE agent_id = '$HTTP_AGENT_ID')
          AND platform = 'slack';

        INSERT INTO platform_connections (agent_id, platform, upstream_type, slack_signing_secret, status)
        VALUES (
          (SELECT id FROM agents WHERE agent_id = '$HTTP_AGENT_ID'),
          'slack', 'http', '${BOT_C_SIGNING_SECRET}', 'connected'
        );
      END IF;

      -- Teams Bot A → socket-mode agent; Teams Bot B → HTTP agent.  The
      -- teams-events webhook route verifies the inbound JWT's aud claim
      -- against bot_framework_app_id, so each msteams connection must be
      -- seeded with the Azure App ID the bot registered with.
      IF '${TEAMS_BOT_A_ID:-}' <> '' THEN
        DELETE FROM platform_connections
        WHERE agent_id = (SELECT id FROM agents WHERE agent_id = '$OPENCLAW_AGENT_ID')
          AND platform = 'msteams';

        INSERT INTO platform_connections (agent_id, platform, upstream_type, bot_framework_app_id, status)
        VALUES (
          (SELECT id FROM agents WHERE agent_id = '$OPENCLAW_AGENT_ID'),
          'msteams', 'webhook', '${TEAMS_BOT_A_ID}', 'active'
        );
      END IF;

      IF '${TEAMS_BOT_B_ID:-}' <> '' THEN
        DELETE FROM platform_connections
        WHERE agent_id = (SELECT id FROM agents WHERE agent_id = '$HTTP_AGENT_ID')
          AND platform = 'msteams';

        INSERT INTO platform_connections (agent_id, platform, upstream_type, bot_framework_app_id, status)
        VALUES (
          (SELECT id FROM agents WHERE agent_id = '$HTTP_AGENT_ID'),
          'msteams', 'webhook', '${TEAMS_BOT_B_ID}', 'active'
        );
      END IF;
    END \$\$;
  " 2>&1 | grep -v '^$' || true

  ok "Agent records seeded"

  # Apply default policy bindings from the catalog to the agents' org.
  # Extracts defaultBinding from each system policy's dsl_source and creates
  # org-level bindings so the Verifier can evaluate traffic against real policies.
  log "Applying default policy bindings..."

  docker exec "$DB_CONTAINER" psql -U postgres -d postgres -q -c "
    DO \$\$
    DECLARE
      _org_id   uuid;
      _pol      RECORD;
      _raw      text;
      _dsl      jsonb;
      _dir      text;
      _effect   text;
      _priority int;
      _created  int := 0;
    BEGIN
      -- Use the org that owns the OpenClaw agents
      SELECT organization_id INTO _org_id
      FROM agents WHERE agent_id = '$OPENCLAW_AGENT_ID';
      IF _org_id IS NULL THEN RETURN; END IF;

      FOR _pol IN
        SELECT id, slug, dsl_source
        FROM policies
        WHERE level = 'system' AND dsl_source IS NOT NULL
      LOOP
        -- dsl_source is stored as double-encoded JSON text; unwrap it
        _raw := _pol.dsl_source;
        IF left(_raw, 1) = '\"' THEN
          _raw := substr(_raw, 2, length(_raw) - 2);
          _raw := replace(_raw, '\\\\\"', '\"');
          _raw := replace(_raw, '\\\"', '\"');
        END IF;

        BEGIN _dsl := _raw::jsonb;
        EXCEPTION WHEN OTHERS THEN CONTINUE;
        END;

        IF _dsl->'defaultBinding' IS NULL THEN CONTINUE; END IF;

        _dir     := COALESCE(_dsl->'defaultBinding'->>'direction', 'both');
        _effect  := COALESCE(_dsl->'defaultBinding'->>'effect', 'block');
        _priority := COALESCE((_dsl->'defaultBinding'->>'priority')::int, 50);

        INSERT INTO policy_bindings
          (scope_type, scope_id, policy_id, direction, effect, priority, fail_behavior)
        VALUES ('org', _org_id, _pol.id, _dir, _effect, _priority, 'block')
        ON CONFLICT DO NOTHING;

        IF FOUND THEN _created := _created + 1; END IF;
      END LOOP;

      RAISE NOTICE 'Applied % default policy bindings to org %', _created, _org_id;

      -- Fallback: if no DSL-based bindings were found, copy from the seed org
      -- (the first org that has bindings). This handles fresh installs where the
      -- db:seed script created bindings in a different org.
      IF _created = 0 THEN
        INSERT INTO policy_bindings (scope_type, scope_id, policy_id, direction, effect, config, fail_behavior, priority)
        SELECT pb.scope_type, _org_id, pb.policy_id, pb.direction, pb.effect, pb.config, pb.fail_behavior, pb.priority
        FROM policy_bindings pb
        WHERE pb.scope_id != _org_id
          AND pb.scope_id = (
            SELECT scope_id FROM policy_bindings WHERE scope_id != _org_id LIMIT 1
          )
        ON CONFLICT DO NOTHING;
        GET DIAGNOSTICS _created = ROW_COUNT;
        IF _created > 0 THEN
          RAISE NOTICE 'Copied % policy bindings from seed org to %', _created, _org_id;
        END IF;
      END IF;
    END \$\$;
  " 2>&1 | grep -v '^$' || true

  ok "Default policies applied"
else
  log "${YELLOW}Supabase not reachable on port $SUPABASE_DB_PORT — skipping agent seed${RESET}"
  log "${YELLOW}Make sure 'pnpm run dev:all' is running in another terminal${RESET}"
fi

# ─── Docker Agents ───────────────────────────────────────────────────

log "Building and starting Docker agents..."
docker compose -f docker-compose.agents.yml --env-file .env.agents up --build -d 2>&1 | tail -5

# Wait for health — poll up to HEALTH_TIMEOUT seconds.
# openclaw gateways load plugins before binding /health, so their first
# healthcheck at StartPeriod=20s usually fails and Docker waits another
# 30s (Interval) to retry.  A one-shot check at ~15s will always miss them.
HEALTH_TIMEOUT="${AGENTS_HEALTH_TIMEOUT:-120}"
log "Waiting for agents to start (up to ${HEALTH_TIMEOUT}s)..."

SERVICES=(agent-pa agent-pb agent-pc agent-pd openclaw openclaw-http)
TOTAL=${#SERVICES[@]}
# Bash 3.2 (macOS default) has no associative arrays — track healthy
# services as a space-delimited string with boundary markers.
HEALTHY_SET=" "

# Resolve the published host port for a service.  `docker compose port`
# requires the container port as a second arg, so we hard-code the known
# internal port per service.
published_port() {
  local service="$1" container_port
  case "$service" in
    agent-pa) container_port=8801 ;;
    agent-pb) container_port=8802 ;;
    agent-pc) container_port=8803 ;;
    agent-pd) container_port=8804 ;;
    openclaw|openclaw-http) container_port=4000 ;;
    *) return 1 ;;
  esac
  docker compose -f docker-compose.agents.yml --env-file .env.agents \
    port "$service" "$container_port" 2>/dev/null | cut -d: -f2
}

check_service() {
  local service="$1"
  local port
  port=$(published_port "$service")
  [ -n "$port" ] && curl -sf "http://localhost:$port/health" >/dev/null 2>&1
}

elapsed=0
HEALTHY=0
while [ "$elapsed" -lt "$HEALTH_TIMEOUT" ]; do
  for service in "${SERVICES[@]}"; do
    case "$HEALTHY_SET" in *" $service "*) continue ;; esac
    if check_service "$service"; then
      HEALTHY_SET="$HEALTHY_SET$service "
      HEALTHY=$((HEALTHY + 1))
      ok "$service healthy ${DIM}(port $(published_port "$service"), ${elapsed}s)${RESET}"
    fi
  done
  [ "$HEALTHY" -eq "$TOTAL" ] && break
  sleep 2
  elapsed=$((elapsed + 2))
done

for service in "${SERVICES[@]}"; do
  case "$HEALTHY_SET" in *" $service "*) ;; *)
    log "${YELLOW}$service not healthy after ${HEALTH_TIMEOUT}s${RESET}" ;;
  esac
done

# ─── Ready ───────────────────────────────────────────────────────────

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${GREEN}  Docker agents running ($HEALTHY/$TOTAL healthy)${RESET}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""
echo -e "  ${DIM}Python agents${RESET}"
echo -e "  agent-pa      ${CYAN}http://localhost:8801${RESET}  ${DIM}(OpenAI SDK)${RESET}"
echo -e "  agent-pb      ${CYAN}http://localhost:8802${RESET}  ${DIM}(OpenAI SDK)${RESET}"
echo -e "  agent-pc      ${CYAN}http://localhost:8803${RESET}  ${DIM}(CrewAI)${RESET}"
echo -e "  agent-pd      ${CYAN}http://localhost:8804${RESET}  ${DIM}(LangChain)${RESET}"
echo ""
echo -e "  ${DIM}OpenClaw (Slack)${RESET}"
echo -e "  openclaw      ${CYAN}http://localhost:4000${RESET}  ${DIM}(Dog+Cat Socket Mode)${RESET}"
echo -e "  openclaw-http ${CYAN}http://localhost:4010${RESET}  ${DIM}(Bot C HTTP Events)${RESET}"
if [ -n "${CLOUDFLARE_TUNNEL_URL:-}" ] && [ "$SKIP_TUNNEL" = false ]; then
echo ""
echo -e "  ${DIM}Tunnel${RESET}"
echo -e "  Webhook URL   ${CYAN}${CLOUDFLARE_TUNNEL_URL}${RESET}"
fi
echo ""
echo -e "  ${DIM}Logs:    docker compose -f docker-compose.agents.yml logs -f <service>${RESET}"
echo -e "  ${DIM}E2E:     pnpm run test:e2e:docker${RESET}"
echo -e "  ${DIM}Press Ctrl+C to stop all agents${RESET}"
echo ""

# Keep running until Ctrl+C — follow Docker logs
docker compose -f docker-compose.agents.yml --env-file .env.agents logs -f 2>&1 | sed "s/^/${DIM}/" &
PIDS+=($!)
wait
