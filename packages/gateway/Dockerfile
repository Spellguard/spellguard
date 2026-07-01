# Spellguard gateway — HTTP↔SLIM translation. Workers-facing HTTP entry
# point that the agents POST to in slim mode; bridges to the SLIM data
# plane on the verifier host via @agntcy/slim-bindings (a native UniFFI
# module that can't run in Workers directly).
#
# Build context expects the monorepo root, so the gateway package is
# referenced as packages/gateway/... The gateway has no workspace deps
# (only npm-published deps), so we install with npm — pnpm's workspace
# symlink graph does not survive `COPY --from=build` across stages and
# was causing tsx to be missing at runtime.

FROM node:22-slim
WORKDIR /app

COPY packages/gateway/package.json packages/gateway/tsconfig.json ./
COPY packages/gateway/src ./src

RUN npm install --no-audit --no-fund

ENV NODE_ENV=production
ENV SPELLGUARD_GATEWAY_PORT=46358
EXPOSE 46358

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+process.env.SPELLGUARD_GATEWAY_PORT+'/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "tsx", "src/index.ts"]
