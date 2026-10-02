# The image for the Next frontend.
#
# The build context is the repository root, because that is what Railway uploads for a monorepo —
# so every path here is written from there. `RAILWAY_DOCKERFILE_PATH` on the service points at this
# file.
#
# Nixpacks could not produce a build plan for this pnpm workspace — three deploys failed with no
# build log at all — so the image is defined explicitly. Corepack also pins pnpm to the version in
# `packageManager`, which Nixpacks was otherwise guessing at.
# Node 22, and both bounds are real.
#
# Lower bound: `sharp`, which the image-upload route uses to re-encode what a launcher uploads,
# refuses to load below Node 20.9 — the build dies on `/api/uploads/image` with "Found 18.20.8,
# requires >=20.9.0".
#
# Upper bound is not a bound but an avoidance: on Node **20** exactly, Next 14's edge-runtime
# sandbox throws `TypeError: Cannot redefine property: __import_unsupported` when it evaluates
# middleware, so every request through middleware 500s while the container reports itself healthy.
# Verified on this machine: the same production build serves `/explore` and `/launch` as 200 under
# Node 22 with no such error.
FROM node:22-slim

RUN corepack enable

WORKDIR /app

# Manifests first, so dependencies are only reinstalled when a manifest actually changes.
COPY src/typescript/package.json src/typescript/pnpm-lock.yaml \
     src/typescript/pnpm-workspace.yaml src/typescript/turbo.json ./
COPY src/typescript/sdk/package.json ./sdk/
COPY src/typescript/frontend/package.json ./frontend/

RUN pnpm install --no-frozen-lockfile

# Next inlines every NEXT_PUBLIC_* value at *build* time, and `lib/chain/wagmi` throws on a missing
# contract address while Next is collecting page data — which is exactly how an earlier build
# failed. Railway passes service variables to the build, but a Dockerfile has to declare each one
# it needs as a build arg and promote it to an environment variable.
ARG NEXT_PUBLIC_MONAD_RPC_URL
# Which Monad, and what wraps its native token. Both are required with no default: mainnet and
# testnet are indistinguishable from inside the app, and defaulting either would mean a deployment
# that forgot the variable silently points at the network where being wrong costs money.
#
# Every `NEXT_PUBLIC_` value has to be declared here as well as set on the service. Next inlines
# them at build time, and a Docker build sees only the args the Dockerfile names — so a variable
# set on the service and missing from this list is simply absent when it matters.
ARG NEXT_PUBLIC_MONAD_CHAIN_ID
ARG NEXT_PUBLIC_DOKU_FACTORY
ARG NEXT_PUBLIC_DOKU_GRADUATION
ARG NEXT_PUBLIC_DOKU_REGISTRY
# The hook. Needed at BUILD time like the rest, because it is a field of every PoolKey.
ARG NEXT_PUBLIC_DOKU_HOOK
# Uniswap's v4 singletons. `NEXT_PUBLIC_WMON_ADDRESS`, `_DOKU_ROUTER`, `_DOKU_QUOTER` and
# `_DOKU_POSITION_MANAGER` were the V3 set and are gone with it.
ARG NEXT_PUBLIC_V4_POOL_MANAGER
ARG NEXT_PUBLIC_V4_POSITION_MANAGER
ARG NEXT_PUBLIC_V4_QUOTER
ARG NEXT_PUBLIC_V4_STATE_VIEW
ARG NEXT_PUBLIC_UNIVERSAL_ROUTER
ARG NEXT_PUBLIC_PERMIT2
# The zap router: periphery, and the ONLY thing that makes the pay-with-MON control exist. The
# frontend treats an unset value as "no router" and renders nothing, which is the correct behaviour
# on a deployment without one and an invisible outage on a deployment that has one and forgot this
# line.
ARG NEXT_PUBLIC_ZAP_ROUTER
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_LIQUIDITY_ENABLED
ARG NEXT_PUBLIC_DOKU_LIVE_URL
ARG NEXT_PUBLIC_PREVIEW_MODE
ARG NEXT_PUBLIC_CDN_URL
ARG NEXT_PUBLIC_LINKS
ARG NEXT_PUBLIC_IS_ALLOWLIST_ENABLED
ARG NEXT_PUBLIC_DISCORD_METADATA_REQUEST_CHANNEL
ARG DOKU_INDEXER_URL
ARG MON_USD_PRICE_URL
ARG MON_USD_PRICE_PATH
ARG HASH_SEED
ARG GEOBLOCKED
ARG RATE_LIMITING_ENABLED
ARG ALLOWLISTER3K_URL
ARG KV_REST_API_URL
ARG KV_REST_API_TOKEN
ENV NEXT_PUBLIC_MONAD_RPC_URL=$NEXT_PUBLIC_MONAD_RPC_URL
ENV NEXT_PUBLIC_MONAD_CHAIN_ID=$NEXT_PUBLIC_MONAD_CHAIN_ID
ENV NEXT_PUBLIC_DOKU_FACTORY=$NEXT_PUBLIC_DOKU_FACTORY
ENV NEXT_PUBLIC_DOKU_GRADUATION=$NEXT_PUBLIC_DOKU_GRADUATION
ENV NEXT_PUBLIC_DOKU_REGISTRY=$NEXT_PUBLIC_DOKU_REGISTRY
ENV NEXT_PUBLIC_DOKU_HOOK=$NEXT_PUBLIC_DOKU_HOOK
ENV NEXT_PUBLIC_V4_POOL_MANAGER=$NEXT_PUBLIC_V4_POOL_MANAGER
ENV NEXT_PUBLIC_V4_POSITION_MANAGER=$NEXT_PUBLIC_V4_POSITION_MANAGER
ENV NEXT_PUBLIC_V4_QUOTER=$NEXT_PUBLIC_V4_QUOTER
ENV NEXT_PUBLIC_V4_STATE_VIEW=$NEXT_PUBLIC_V4_STATE_VIEW
ENV NEXT_PUBLIC_UNIVERSAL_ROUTER=$NEXT_PUBLIC_UNIVERSAL_ROUTER
ENV NEXT_PUBLIC_PERMIT2=$NEXT_PUBLIC_PERMIT2
ENV NEXT_PUBLIC_ZAP_ROUTER=$NEXT_PUBLIC_ZAP_ROUTER
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL
ENV NEXT_PUBLIC_LIQUIDITY_ENABLED=$NEXT_PUBLIC_LIQUIDITY_ENABLED
ENV NEXT_PUBLIC_DOKU_LIVE_URL=$NEXT_PUBLIC_DOKU_LIVE_URL
ENV NEXT_PUBLIC_PREVIEW_MODE=$NEXT_PUBLIC_PREVIEW_MODE
ENV NEXT_PUBLIC_CDN_URL=$NEXT_PUBLIC_CDN_URL
ENV NEXT_PUBLIC_LINKS=$NEXT_PUBLIC_LINKS
ENV NEXT_PUBLIC_IS_ALLOWLIST_ENABLED=$NEXT_PUBLIC_IS_ALLOWLIST_ENABLED
ENV NEXT_PUBLIC_DISCORD_METADATA_REQUEST_CHANNEL=$NEXT_PUBLIC_DISCORD_METADATA_REQUEST_CHANNEL
ENV DOKU_INDEXER_URL=$DOKU_INDEXER_URL
ENV MON_USD_PRICE_URL=$MON_USD_PRICE_URL
ENV MON_USD_PRICE_PATH=$MON_USD_PRICE_PATH
ENV HASH_SEED=$HASH_SEED
ENV GEOBLOCKED=$GEOBLOCKED
ENV RATE_LIMITING_ENABLED=$RATE_LIMITING_ENABLED
ENV ALLOWLISTER3K_URL=$ALLOWLISTER3K_URL
ENV KV_REST_API_URL=$KV_REST_API_URL
ENV KV_REST_API_TOKEN=$KV_REST_API_TOKEN

COPY src/typescript/ ./

# The allowlist merkle tree, read at request time by `/api/allowlist`. Pointed at absolutely rather
# than resolved from the working directory, because `pnpm --filter ... exec` sets that to the
# package directory and a relative path would depend on how the process happened to start.
ENV DOKU_ALLOWLIST_PATH=/app/frontend/data/allowlist.json

# EVERY `NEXT_PUBLIC_*` the app reads must be declared above as both ARG and ENV.
#
# They are inlined at build time, and `lib/chain/addresses.ts` validates them at MODULE LOAD — so
# one that is missing does not degrade anything at runtime, it THROWS while Next is evaluating
# route modules, and the build fails. Five deploys failed this way after the v4 migration added
# new variables that were set on the Railway service and never declared here. The service's
# variables are what Railway passes in; this list is what the build is willing to receive.
#
# Next type-checks the whole project in one process, and on a constrained builder that dies
# without printing anything — the build simply stops after "Linting and checking validity of
# types". Raising the heap is the difference between a failed deploy and a finished one.
ENV NODE_OPTIONS=--max-old-space-size=4096

RUN pnpm --filter @doku/frontend run build \
 && test -d frontend/.next || (echo 'frontend build produced no .next output' && exit 1)

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Declared, not just defaulted.
#
# Railway reads `EXPOSE` to learn which port to route a domain at. Without it the domain is created
# with no target port and every request answers `Application not found` — while the container logs
# a healthy "Ready in 227ms", because the app is fine and nothing is reaching it. The indexer's
# image has always declared its port, which is why that service worked first time and this one did
# not.
ENV PORT=3001
EXPOSE 3001

# The port is assigned at runtime; binding 0.0.0.0 is what makes the container reachable.
CMD ["sh", "-c", "pnpm --filter @doku/frontend exec next start --port ${PORT:-3001} --hostname 0.0.0.0"]
