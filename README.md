# Boba

Conversation-first dating, relayed over SMS. Anti-swipe, anti-superficial, pro-conversation. One match per day. Identity reveals gradually as the conversation deepens; the photo comes last.

> **Status:** Early scaffolding. See [GOAL.md](./GOAL.md) for the roadmap and [PROGRESS.md](./PROGRESS.md) for what's been built. Things only the human can do live in [USER_TODO.md](./USER_TODO.md).

## Stack
- TypeScript (strict) on Node 22+
- Fastify HTTP server
- PostgreSQL via Prisma
- Twilio for SMS relay
- Vitest for tests

## Getting started

```bash
# 1. Install
npm install

# 2. Spin up Postgres locally (Docker required)
npm run db:up

# 3. Copy env and edit if you have credentials
cp .env.example .env

# 4. Generate the Prisma client + apply migrations
npm run prisma:generate
npm run prisma:migrate

# 5. Seed a handful of fake users for local dev
npm run seed

# 6. Run the dev server
npm run dev
```

The server listens on `PORT` (default `3000`). Hit `http://localhost:3000/health` to check it's alive.

## Scripts
- `npm run dev` — Fastify with watch mode via tsx
- `npm run build` — Type-check + emit to `dist/`
- `npm start` — Run the compiled server
- `npm test` — Run Vitest suite
- `npm run typecheck` — `tsc --noEmit`
- `npm run lint` — ESLint over `src/` and `tests/`
- `npm run format` — Prettier write
- `npm run db:up` / `npm run db:down` — Docker Postgres on/off
- `npm run prisma:generate` — Regenerate the Prisma client
- `npm run prisma:migrate` — Create/apply a dev migration
- `npm run seed` — Insert fake users (idempotent; safe to re-run)

## Layout

```
src/
  app.ts            Fastify factory (no listen)
  server.ts         Process entrypoint, signal handling
  config/env.ts     Zod-validated env loader
  lib/
    logger.ts       Pino instance
    prisma.ts       Shared Prisma client
    pair.ts         Ordered-pair helper
  routes/
    health.ts       GET /health, GET /
  matching/         Compatibility scoring + daily-match selector
  milestones/       Depth scoring + reveal-unlock ladder
  onboarding/       SMS-driven state machine for first-run setup
  decisions/        End-of-day Keep/Maybe/Discard + resolution
  rematch/          First-class rematch-eligibility predicate
  safety/           Anti-doxx stat-fishing filter + harassment + report flow
  ai/               AI-seeding persona client (stub + Anthropic)
  twilio/           Inbound webhook, signature verification, conversation router
prisma/
  schema.prisma     Database schema
  migrations/       Generated migrations
  seed.ts           Local dev seed (run via `npm run seed`)
tests/              Vitest specs mirroring src/
docker-compose.yml  Local Postgres
```

## Contributing

Each commit must leave the repo in a buildable state (`npm install && npm run build` succeeds). Add tests for non-trivial logic. No `any` without a justifying comment.
