# ── Stage 1: builder ──────────────────────────────────────────────────
# Install workspace dependencies, build local packages, and prune
# dev-only deps so the runtime image stays small.
FROM node:24-slim AS builder

# Reproducible builds (#1410): BuildKit stamps the image, and with
# `rewrite-timestamp=true` every layer's files, with this time instead of the
# build's. Pass the commit's: --build-arg SOURCE_DATE_EPOCH=$(git log -1 --format=%ct)
ARG SOURCE_DATE_EPOCH

# pnpm by version and hash: the root package.json's packageManager
# (tests/unit/infra/reproducible-images.test.ts keeps every copy equal).
# corepack turns on Node's compile cache, which leaves build-specific files in
# /tmp; the layer must hold only pnpm.
RUN export NODE_DISABLE_COMPILE_CACHE=1 && \
    corepack enable && corepack prepare pnpm@9.15.0+sha512.76e2379760a4328ec4415815bcd6628dee727af3779aaa4c914e3944156c4299921a89f976381ee107d41f12cfa4b66681ca9c718f0668fa0831ed4c6d8ba56c --activate

WORKDIR /app

# Copy workspace root files first (for pnpm workspace resolution + tsc extends)
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.json ./

# Copy the packages the Verifier depends on
COPY packages/verifier/package.json packages/verifier/
COPY packages/ctls/ts/package.json packages/ctls/ts/
COPY packages/amp/ts/package.json  packages/amp/ts/
COPY packages/gateway/package.json packages/gateway/

# Install only the Verifier and its workspace dependencies. With pnpm 9,
# peer deduplication otherwise expands a filtered install to the whole workspace.
# The root's private UI dependencies are not needed in this image.
RUN pnpm --filter @spellguard/verifier... install --frozen-lockfile --ignore-scripts --config.dedupe-peer-dependents=false

# Copy source for workspace packages
COPY packages/ctls/ts/ packages/ctls/ts/
COPY packages/amp/ts/  packages/amp/ts/
COPY packages/gateway/  packages/gateway/
COPY packages/verifier/  packages/verifier/

# Build library packages that Verifier depends on
RUN pnpm --filter @spellguard/ctls --filter @spellguard/amp run build

# Produce a standalone package with only runtime dependencies.
RUN pnpm --filter @spellguard/verifier deploy --prod --ignore-scripts /deploy
# pnpm stamps node_modules/.modules.yaml with the time it ran (`prunedAt`);
# use the build's SOURCE_DATE_EPOCH instead so the copy is byte-stable.
RUN sed -i "s/^prunedAt: .*/prunedAt: $(date -u -d "@${SOURCE_DATE_EPOCH:-0}" '+%a, %d %b %Y %H:%M:%S GMT')/" \
      /deploy/node_modules/.modules.yaml

# ── Stage 2: runtime ─────────────────────────────────────────────────
FROM node:24-slim

ARG SOURCE_DATE_EPOCH

# corepack turns on Node's compile cache, which leaves build-specific files in
# /tmp; the layer must hold only pnpm.
RUN export NODE_DISABLE_COMPILE_CACHE=1 && \
    corepack enable && corepack prepare pnpm@9.15.0+sha512.76e2379760a4328ec4415815bcd6628dee727af3779aaa4c914e3944156c4299921a89f976381ee107d41f12cfa4b66681ca9c718f0668fa0831ed4c6d8ba56c --activate

WORKDIR /app

# Copy the standalone package and the root compiler settings used by tsx.
COPY --from=builder /deploy/ ./
COPY tsconfig.json ./tsconfig.json

# Optionally bake an env file into the image.
# Used by the internal-mode deploy flow (scripts/deploy-internal.sh)
# which passes base64-encoded env file contents as a build arg.
# For flows that inject env vars at runtime (Phala), ENV_FILE_CONTENT
# is empty and there is no /app/.env; the entrypoint and dotenv skip it.
ARG ENV_FILE_CONTENT=""
RUN if [ -n "$ENV_FILE_CONTENT" ]; then \
      echo "$ENV_FILE_CONTENT" | base64 -d > /app/.env; \
    fi

# Entrypoint sources /app/.env (when non-empty) before starting the server.
COPY --chmod=0755 packages/verifier/docker-entrypoint.sh /app/docker-entrypoint.sh

EXPOSE 3000

ENV HOST=0.0.0.0
ENV PORT=3000

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["pnpm", "start"]
