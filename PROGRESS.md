# Progress Log

Reverse-chronological. Newest entries on top. Each entry: timestamp, what shipped, what didn't, what's blocked, what next.

---

## 2026-05-17 — Run 3: matching algorithm v1

**Shipped**
- `src/matching/` module with a clean pure-vs-IO split:
  - `types.ts` — `CandidateProfile`, `CompatibilityScore`,
    `SelectorContext`, `SelectorConfig`, `SelectedMatch`,
    `PairHistoryEntry`, plus `DEFAULT_SELECTOR_CONFIG`
    (`rematchCooldownDays: 14`, `minScore: 0.3`).
  - `scoring.ts` — `scoreCompatibility(a, b)`. Pure. Hard gates: self-pair,
    mutual gender preference. Soft signals weighted: age 0.25, height 0.2,
    profession 0.2, typeDescriptor 0.35. Age/height fall off linearly within
    a ±3yr / ±10cm tolerance window. typeDescriptor uses a tokenised
    Jaccard overlap with a small stopword list — TODO seam left for the
    eventual LLM-scored variant.
  - `selector.ts` — `selectDailyMatches(today, ctx, config?)`. Iterates all
    unordered pairs, drops the ones already matched today / in cooldown /
    permanently blocked by a prior Discard / under `minScore`, sorts by
    score desc (deterministic tiebreaker on pair ids), then greedy
    max-weight matching (claim users as we go). Greedy chosen over
    Blossom for v1; documented inline. Also exports `pairKey`,
    `toDateKey`, `dayDiff` helpers.
  - `prisma-deps.ts` — `loadSelectorContext(prisma, today)` + 
    `persistDailyMatches(prisma, pairs, today)`. Both are typed against a
    narrow `MatchingPrisma` surface so tests can mock without pulling
    the full PrismaClient. Persist runs under
    `Prisma.TransactionIsolationLevel.Serializable` and upserts
    `RematchHistory` (creating with `matchCount=1` or
    `{ increment: 1 }`). Defensive re-ordering via `orderPair` even if a
    caller passes a non-canonical pair.
  - `index.ts` barrel exports.
- Tests (`tests/matching/`):
  - `scoring.test.ts` (15 tests) — every hard gate, every soft signal
    (in-range, soft penalty, out-of-tolerance, missing-data neutral),
    plus a "good pair scores meaningfully higher than a bad pair"
    end-to-end check with realistic profiles.
  - `selector.test.ts` (13 tests) — empty / single-candidate, single
    match, greedy ordering picks the highest-overlap pair first, no
    user is double-matched, today-already-matched exclusion, permanent
    Discard exclusion, cooldown window enforced, `minScore` honoured,
    gender-preference hard gate is honoured end-to-end, canonical
    A<B pair ordering, plus unit tests for `toDateKey` / `dayDiff` /
    `pairKey` helpers.
  - `persist.test.ts` (3 tests) — empty input short-circuits the
    transaction, paired writes happen inside a single `$transaction`
    with one `dailyMatch.create` + one `rematchHistory.upsert` per
    pair, `matchDate` is normalised to UTC midnight, non-canonical
    input is re-ordered before write. Uses a hand-rolled
    `MatchingPrisma` mock — no live DB required.

**Verified**
- `npm run build` — clean.
- `npm test` — 43/43 pass (up from 12/12).
- `npm run lint` — clean.
- `prisma format` + `prisma validate` — clean (schema untouched).

**Didn't try / deferred**
- Did not exercise `persistDailyMatches` against a real Postgres — no
  Docker available in this sandbox (`prisma migrate dev` blocked
  too). The unit-test mock covers the call shape; the next agent (or
  the user, locally) should be able to run it end-to-end once
  `db:up` works.
- Did not run `npm run typecheck`. Pre-existing config issue: root
  `tsconfig.json` has `rootDir: src` while `include` also covers
  `tests/`, so `tsc --noEmit` complains. The build path
  (`tsconfig.build.json`) excludes tests and works fine, and vitest
  type-checks tests at run time. Worth fixing in a small follow-up
  (e.g. drop `rootDir`, or split tests into their own tsconfig).

**Blocked on user** — nothing new. `USER_TODO.md` is still accurate.

**Next agent: pick this up**
- Task: **Milestone system**. Build `src/milestones/`:
  - `depth.ts`: pure scoring of a single message (length bucket,
    question-mark ratio, reciprocity vs. previous messages → 0..1
    `depthScore`). Wire this in so callers can pre-fill
    `Message.depthScore` before insert.
  - `unlock.ts`: pure rule that takes the current conversation
    (messages + already-unlocked milestones) and returns the next
    `MilestoneType` to unlock, if any. Suggested thresholds:
      - AGE: >=10 mutual messages with avg depthScore >= 0.3
      - PROFESSION: >=25 mutual messages with avg depthScore >= 0.4
      - HEIGHT: >=50 mutual messages with avg depthScore >= 0.5
      - FACE: only via end-of-day resolution, not here
    Both halves of the pair must contribute — gate on min messages
    per side. Document the numbers as tunable.
  - `prisma-deps.ts`: `recordMilestone(prisma, matchId, milestone)`
    inserting the `MilestoneProgress` row (idempotent via the
    `@@unique([matchId, milestone])`).
  - Tests for both pure functions in `tests/milestones/`.
- After that: iMessage relay layer is the next-biggest unblock.
- Update `GOAL.md` (check off) + `PROGRESS.md`.

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
