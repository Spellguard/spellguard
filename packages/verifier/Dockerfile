# ── Stage 1: builder ──────────────────────────────────────────────────
# Install workspace dependencies, build local packages, and prune
# dev-only deps so the runtime image stays small.
FROM node:24-alpine AS builder

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

WORKDIR /app

# Copy workspace root files first (for pnpm workspace resolution + tsc extends)
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.json .npmrc* ./

# Copy the packages the Verifier depends on
COPY packages/verifier/package.json packages/verifier/
COPY packages/ctls/ts/package.json packages/ctls/ts/
COPY packages/amp/ts/package.json  packages/amp/ts/

# Install all deps (skip postinstall scripts — node-llama-cpp, bufferutil, etc.
# are transitive deps the Verifier doesn't need and require git/cmake/python to build)
RUN pnpm install --frozen-lockfile --ignore-scripts

# Copy source for workspace packages
COPY packages/ctls/ts/ packages/ctls/ts/
COPY packages/amp/ts/  packages/amp/ts/
COPY packages/verifier/  packages/verifier/

# Build library packages that Verifier depends on
RUN pnpm --filter @spellguard/ctls --filter @spellguard/amp run build 2>/dev/null || true

# Prune dev dependencies
RUN pnpm prune --prod

# ── Stage 2: runtime ─────────────────────────────────────────────────
FROM node:24-alpine

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

WORKDIR /app

# Copy built workspace from builder
COPY --from=builder /app/ ./

# Optionally bake an env file into the image.
# Used by the internal-mode deploy flow (scripts/deploy-internal.sh)
# which passes base64-encoded env file contents as a build arg.
# For flows that inject env vars at runtime (Phala), ENV_FILE_CONTENT
# is empty and /app/.env is a zero-byte file that the entrypoint skips.
ARG ENV_FILE_CONTENT=""
RUN if [ -n "$ENV_FILE_CONTENT" ]; then \
      echo "$ENV_FILE_CONTENT" | base64 -d > /app/.env; \
    else \
      touch /app/.env; \
    fi

# Entrypoint sources /app/.env (when non-empty) before starting the server.
COPY packages/verifier/docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

EXPOSE 3000

ENV HOST=0.0.0.0
ENV PORT=3000

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["pnpm", "--filter", "@spellguard/verifier", "start"]
