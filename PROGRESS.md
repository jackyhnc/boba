# Progress Log

Reverse-chronological. Newest entries on top. Each entry: timestamp, what shipped, what didn't, what's blocked, what next.

---

## 2026-05-17 — Run 2: data model

**Shipped**
- Replaced sentinel `SchemaMarker` with the full Boba domain model in
  `prisma/schema.prisma`:
  - Enums: `UserStatus`, `Gender`, `MatchState`, `MilestoneType`, `Decision`,
    `MessageDirection`.
  - Models: `User`, `Preferences` (1:1), `Stats` (1:1), `DailyMatch`,
    `Message`, `MilestoneProgress`, `EndOfDayDecision`, `RematchHistory`,
    `Report`.
  - `DailyMatch` and `RematchHistory` carry the `userAId < userBId`
    invariant (documented; enforced in app layer) so the
    `@@unique([userAId, userBId, matchDate])` constraint is well-defined.
  - `DailyMatch.parentMatchId` self-relation tracks day-to-day continuation
    when both users pick Keep/Maybe.
  - `Message.direction`, `Message.twilioSid` (unique, nullable), `depthScore`,
    and pre-wired moderation flags (`flaggedStatFishing`, `flaggedHarassment`).
  - `Report` model for the moderation flow that lands later.
  - AI-seeding fields on `User`: `isAiBacked`, `aiPersonaPrompt` (disabled by
    default — no runtime routing yet).
- Generated the initial SQL migration without needing a live Postgres via
  `prisma migrate diff --from-empty --to-schema-datamodel ... --script`:
  - `prisma/migrations/20260517071335_init/migration.sql`
  - `prisma/migrations/migration_lock.toml` (`provider = "postgresql"`).
- `src/lib/prisma.ts` rewritten:
  - Still exports the shared `prisma` singleton + `disconnectPrisma`.
  - Re-exports model types and enum values from `@prisma/client` so the rest
    of the codebase has a single import surface.
- New `src/lib/pair.ts`:
  - `orderPair(a, b)` returns `{ userAId, userBId }` with A < B and throws on
    self-pairing.
  - `isOrderedPair(a, b)` predicate.
- New `tests/prisma.test.ts` (7 tests) — covers Prisma client construction,
  domain-model namespaces, runtime enum values, and `pair.ts` helpers.

**Verified**
- `prisma format` + `prisma validate` clean (DATABASE_URL inlined for
  validation; runtime defaults sensibly via `src/config/env.ts`).
- `prisma generate` succeeds.
- `npm run build` succeeds.
- `npm test` — 12/12 pass (was 5/5).
- `npm run lint` clean.

**Didn't try / deferred**
- Still no `prisma migrate dev` execution — Docker daemon is unavailable in
  this sandbox (`/var/run/docker.sock` missing), so Postgres can't be spun
  up here. The migration SQL is committed and will apply cleanly the first
  time the user runs `npm run db:up && npm run prisma:migrate` locally.
- No seed script yet — belongs in the "local dev script" checklist item.

**Blocked on user** — nothing new. `USER_TODO.md` is still accurate.

**Next agent: pick this up**
- Task: **Matching algorithm v1**. Create `src/matching/` with:
  - `scoreCompatibility(userA, userB)`: pure function over `Preferences` +
    `Stats` returning a 0..1 score. Weight type-fit attrs (gender, age,
    height, profession overlap) and `Preferences.typeDescriptor` (leave a
    TODO seam for LLM scoring; default to a simple text-overlap fallback).
  - `selectDailyMatches(today)`: pulls all `ACTIVE` users with completed
    onboarding, excludes pairs already matched today, applies rematch
    cooldown using `RematchHistory.lastMatchedAt` and `hasDiscard`, and
    returns a list of `OrderedPair`s. Greedy max-weight matching is fine
    for v1; document the choice.
  - `persistDailyMatches(pairs, today)`: writes `DailyMatch` rows
    transactionally and updates/creates `RematchHistory`.
  - Use `orderPair` from `src/lib/pair.ts` everywhere.
- Unit-test scoring with synthetic users and the selector with an in-memory
  fixture (mock Prisma or use a small handcrafted dataset).
- Update `GOAL.md` (check off) + `PROGRESS.md`.

**Shipped**
- Seed docs: `GOAL.md` (full checklist, stack decisions, PRD digest), `PROGRESS.md`, `USER_TODO.md`.
- TypeScript + Node 22 + Fastify 5 scaffold:
  - `package.json` with scripts: `dev`, `build`, `start`, `test`, `typecheck`, `lint`, `format`, `prisma:*`, `db:up`/`db:down`.
  - Strict `tsconfig.json` (+ `tsconfig.build.json` excluding tests).
  - ESLint flat config + Prettier.
  - `vitest.config.ts`.
- Fastify app factory (`src/app.ts`) + entrypoint with graceful shutdown (`src/server.ts`).
- Routes: `GET /health`, `GET /`, plus `POST /webhooks/twilio/{inbound,status}` stubs that return 501 until the Twilio task lands.
- Zod-validated env loader (`src/config/env.ts`) — defaults everything sensibly so dev works without a `.env`.
- Pino logger module + shared Prisma client.
- Prisma initialised with a sentinel `SchemaMarker` model so `prisma generate` produces a valid client. The real domain model lands next run.
- `docker-compose.yml` for local Postgres 16.
- `.env.example`, `.gitignore`, `.prettierrc`, `.prettierignore`.
- Tests: env loader (2) + Fastify health/twilio-stub via `app.inject` (3). All 5 pass.
- README rewritten with stack, getting-started, and layout.

**Verified**
- `npm install` clean (259 packages).
- `npx prisma generate` succeeds.
- `npm run build` succeeds (strict TS).
- `npm test` — 5/5 pass.
- `npm run lint` clean.

**Didn't try / deferred**
- Did not run `prisma migrate` — no Postgres running and no real models yet. Belongs in the next task.
- Did not actually start the dev server end-to-end; smoke covered by `app.inject` in tests.

**Blocked on user** — nothing yet. All blockers live in `USER_TODO.md` and don't gate the next several tasks.

**Next agent: pick this up**
- Task: **Data model** — flesh out `prisma/schema.prisma` with:
  - `User` (phone, displayName, campusEmailDomain, status, createdAt)
  - `Preferences` (one-to-one with User; type-fit attrs)
  - `Stats` (one-to-one; age, profession, heightCm, photoUrl)
  - `DailyMatch` (userAId, userBId, date, state)
  - `Message` (matchId, senderId, body, twilioSid, createdAt, depthScore)
  - `MilestoneProgress` (matchId, milestone enum, unlockedAt)
  - `EndOfDayDecision` (matchId, userId, decision enum, decidedAt)
  - `RematchHistory` (userAId, userBId, lastMatchedAt, rematchCount)
- Replace the sentinel `SchemaMarker` model.
- Generate the first migration (`npm run prisma:migrate -- --name init` — requires Docker Postgres up, which the next agent can spin up).
- Update `src/lib/prisma.ts` if anything changes.
- Add a small smoke test that imports `PrismaClient` and constructs it.
