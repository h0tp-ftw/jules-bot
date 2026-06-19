# syntax=docker/dockerfile:1

# ---- Builder: install all deps (incl. better-sqlite3 native build) + compile TS ----
FROM node:22-bookworm-slim AS builder
WORKDIR /app

# Toolchain for better-sqlite3's native addon (node-gyp). Removed in the runtime
# stage — the compiled .node binary is carried over in node_modules.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npx prisma generate && npm run build

# ---- Runtime: built app + node_modules only (no build toolchain) ----
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# node_modules carries the prebuilt better-sqlite3 binary, the generated Prisma
# client, and the `prisma` CLI used for first-boot auto-provisioning.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/templates ./templates
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/package.json /app/prisma.config.ts ./

# DB lives under /app/data (a separate mount) so it never shadows the baked-in
# prisma/ schema + migrations. Override DATABASE_URL to match in compose/run.
ENV DATABASE_URL="file:/app/data/dev.db"

# Runs the same entrypoint as `npm start`. SIGTERM/SIGINT are handled in
# src/index.ts for a graceful shutdown (use `--init` / compose `init: true`).
CMD ["node", "dist/index.js"]
