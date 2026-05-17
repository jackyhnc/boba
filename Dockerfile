# Multi-stage Dockerfile for Boba.
#
# Stage 1 (deps) — install full deps to run Prisma + build.
# Stage 2 (build) — compile TS → dist/.
# Stage 3 (runner) — slim image with only what we need to run.
#
# Build:  docker build -t boba .
# Run:    docker run --rm -p 3000:3000 --env-file .env boba

# ─── Stage 1: deps ───────────────────────────────────────────────────────────
FROM node:22-slim AS deps

# OpenSSL is required by Prisma's runtime engine.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --no-audit --no-fund

# ─── Stage 2: build ──────────────────────────────────────────────────────────
FROM deps AS build
WORKDIR /app

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY prisma ./prisma
RUN npx prisma generate \
 && npm run build

# ─── Stage 3: runtime ────────────────────────────────────────────────────────
FROM node:22-slim AS runner

RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Copy production deps + generated Prisma client + compiled output.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY package.json ./

# Drop privileges.
RUN useradd -r -u 10001 -g nogroup boba && chown -R boba:nogroup /app
USER boba

EXPOSE 3000

# Apply pending migrations on boot, then start the server.
# (Use prisma migrate deploy — non-interactive, safe for prod.)
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
