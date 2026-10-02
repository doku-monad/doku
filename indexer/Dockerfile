# The DOKU indexer: REST API, live feed, and the log ingester.
#
# The build context is the repository root, because that is what Railway uploads for a monorepo —
# so every path here is written from there. `RAILWAY_DOCKERFILE_PATH` on the service points at
# this file.
FROM node:20-slim

WORKDIR /app

# Manifest first, so dependencies are only reinstalled when it changes.
COPY indexer/package.json indexer/package-lock.json* ./

# The Prisma schema has to be present before `prisma generate` runs, and `generate` has to run
# before the image is useful: `@prisma/client` ships as a stub that throws until a client is
# generated from a schema. Nothing about that failure is obvious from the outside — the container
# starts, the first query throws, and the log says the client was not initialised.
COPY indexer/prisma ./prisma
COPY indexer/prisma.config.ts ./

# The full dependency set, because `prisma` itself is a devDependency and `generate` needs it.
# Pruned back to production dependencies below, after the client exists.
RUN npm install --no-audit --no-fund

# `--no-engine` is deliberately *not* used: this client talks to the database through a driver
# adapter, and the generated client is what the adapter plugs into.
RUN npx prisma generate

# Drops the CLI and the rest of the dev tree. The generated client lives inside
# node_modules/@prisma/client and survives, which is why generate comes first.
# `--ignore-scripts` because the postinstall hook is `prisma generate`, and prune is the step
# that removes the prisma CLI. Without it a prune that happened to run lifecycle scripts would
# fail on the very tool it had just deleted.
RUN npm prune --omit=dev --ignore-scripts

COPY indexer/src ./src
COPY indexer/tsconfig.json ./

ENV NODE_ENV=production
# Railway assigns the port; binding 0.0.0.0 is what makes the container reachable.
ENV PORT=3000
EXPOSE 3000

# The service runs its TypeScript directly rather than from a build. `tsx` and PGlite are
# production dependencies for that reason.
CMD ["npx", "tsx", "src/index.ts"]
