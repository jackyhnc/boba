# Progress Log

Reverse-chronological. Newest entries on top. Each entry: timestamp, what shipped, what didn't, what's blocked, what next.

---

## 2026-05-17 — Run 5: iMessage relay layer (Twilio)

**Shipped**
- `src/twilio/` module — full inbound/outbound SMS relay built around a
  pure router, with Twilio's signature scheme implemented from scratch.
  - `signature.ts` — `computeTwilioSignature(authToken, url, params)`
    and `verifyTwilioSignature(...)`. Implements v1 (HMAC-SHA1 over
    `url + concat(sorted(key+value))`, base64). Sorts param keys
    lexicographically; accepts `string | string[]` values so duplicate
    form keys (rare, but legal) are handled correctly.
    `timingSafeEqual` for the compare. Pure / no IO.
  - `client.ts` — `createTwilioClient({ env, logger, fetchImpl? })`.
    Raw `fetch` against `api.twilio.com/2010-04-01` — no SDK
    dependency. Basic auth from `TWILIO_ACCOUNT_SID:TWILIO_AUTH_TOKEN`.
    Honours `TWILIO_DRY_RUN` (defaults to `true` in dev): logs +
    returns a synthetic `DRYRUN-…` sid instead of hitting the API,
    so every send path is exercisable without credentials.
    `MessagingServiceSid` takes precedence over `TWILIO_PHONE_NUMBER`
    when both are configured.
  - `conversation.ts` — pure `route(input)` state machine that branches
    on `UserStatus` and returns a `RouteResult` of `{outbounds[],
    persistInbound?, milestonesToRecord[]}`. Cases:
    - **unknown sender** → `unknown_sender_intro` SMS (no persist;
      onboarding owns user creation).
    - **BANNED** → silent drop (no outbound at all).
    - **PAUSED** → "your account is paused" reply.
    - **ONBOARDING** → holding reply via `routeOnboarding` seam (the
      full onboarding SM ships in the next task).
    - **ACTIVE + no match** → "your next match drops at 5pm" holding
      pattern.
    - **ACTIVE + match** → relay body to partner, score depth inline,
      run `nextMilestoneToUnlock` against the priors+in-flight
      conversation, and (if a milestone tipped) emit reveal SMSes
      to BOTH sides. Reveals carry `{{age}}/{{profession}}/{{heightCm}}`
      placeholders; the route layer substitutes them after loading
      partner Stats.
    - `renderRevealBody(milestone, stats)` exposed for the substitution
      step.
    - `COPY` constant centralises message copy.
  - `prisma-deps.ts` — narrow `TwilioPrisma` surface
    (`user | dailyMatch | message | milestoneProgress`).
    `findUserByPhone`, `loadActiveMatchForUser` (returns the trimmed
    `RouterActiveMatch` shape the router needs, including prior
    messages + unlocked milestone set), `persistInboundMessage`,
    `persistOutboundMessage`, `recordDeliveryStatus`. `loadActiveMatch`
    defensively picks the most recent ACTIVE match if more than one
    is found (shouldn't happen but the data invariant isn't enforced
    in schema).
  - `routes.ts` — `registerTwilioRoutes(app, { deps? })`. Accepts an
    injected `{ prisma, twilio }` for tests. Handlers:
    - `POST /webhooks/twilio/inbound`: parses form body via
      `@fastify/formbody`, verifies signature, runs the router,
      persists the inbound `Message` row (with the inbound `MessageSid`
      as `twilioSid`), upserts any milestone unlocks, then sends each
      outbound through the client and persists the matching outbound
      `Message` row (filled in with the returned sid). Returns empty
      TwiML `<Response></Response>` so Twilio doesn't auto-reply.
      Signature verification: when `TWILIO_AUTH_TOKEN` is empty we
      log a warning and allow (dev / stubbed creds), unless
      `TWILIO_REQUIRE_SIGNATURE=true`. Once a token is configured
      we *always* require a valid signature (closes the
      "wait, I set the token but forgot the flag" gap). URL the
      signature is verified against is reconstructed from
      `PUBLIC_WEBHOOK_BASE_URL + req.url` so it matches what Twilio
      hashed (Fastify's view of the URL behind a proxy can differ).
    - `POST /webhooks/twilio/status`: same signature gate, looks up
      message by `MessageSid`, returns 204. Adding a richer
      `deliveryStatus` column to `Message` is queued for a follow-up
      schema change — for now we just log.
  - `index.ts` barrel exports.
- `src/app.ts` registers `@fastify/formbody` (Twilio sends
  `application/x-www-form-urlencoded`) and forwards an optional
  `twilio.deps` to the route registrar so tests can inject mocks.
- `src/config/env.ts` extended with `TWILIO_DRY_RUN` (default `true`)
  and `TWILIO_REQUIRE_SIGNATURE` (default `false`). Both string-typed
  in the env, coerced to bool. `.env.example` updated to match.
- `USER_TODO.md` extended with Twilio console-setup steps and the new
  env vars.
- Deleted `src/routes/twilio.ts` stub — replaced by the real module.

**Tests** (all green, 112/112, up from 79/79)
- `tests/twilio/signature.test.ts` (11) — algorithm conformance vs.
  a hand-built reference signature; sort stability; sensitivity to
  body / URL / auth-token tampering; array-valued params;
  `verifyTwilioSignature` accepts the canonical signature and rejects
  every mutation (wrong body, wrong token, missing header, missing
  auth token, garbage header).
- `tests/twilio/conversation.test.ts` (15) — every router branch:
  unknown sender returns the intro; BANNED drops silently;
  PAUSED/ONBOARDING/no-match return their respective system replies;
  ACTIVE relay carries body+ids+metadata; depthScore is computed
  in-line and short messages score lower than long-question ones;
  AGE unlock emits reveals to BOTH sides at the threshold boundary;
  below-threshold doesn't emit a reveal; already-unlocked milestones
  cause the ladder to pause without skipping. `renderRevealBody`
  substitutes age/profession/height (and em-dash for null stats).
- `tests/twilio/routes.test.ts` (8) — uses `app.inject` with a
  hand-rolled fake `TwilioPrisma` and a vi.fn Twilio client. Covers
  unknown phone, full ACTIVE relay (asserts ordered inbound+outbound
  persist with correct `twilioSid`), ONBOARDING short-circuits,
  400 on missing From/Body, 403 on missing signature when token is
  set, 200 on properly-signed request (signature computed via the
  same `computeTwilioSignature` the server uses), and 204/400 on
  status callback paths.

**Verified**
- `npm run build` — clean.
- `npm run typecheck` — clean.
- `npm run lint` — clean.
- `npm test` — 112/112 pass.
- `npx prisma generate` — clean (schema untouched this run).

**Didn't try / deferred**
- No live Twilio call — `TWILIO_DRY_RUN` is on by default and creds
  are stubbed. The dry-run path is unit-tested; real-network behaviour
  comes online when the user finishes provisioning.
- Did not add a `deliveryStatus` column to `Message`. The status
  callback handler looks up by `twilioSid` and acks; persisting the
  actual state (queued/sent/delivered/failed) needs a schema change
  and probably a small enum. Leaving it for a follow-up so this run
  stays focused.
- `routeOnboarding` is a one-liner stub by design — the full SMS-driven
  onboarding state machine is the next checklist item.
- Outbound persistence currently attributes system replies (paused /
  no-match / unknown-sender intro) by *not* persisting them — they
  return `matchId: null` so the loop skips the insert. That's
  intentional: those messages don't belong to any match. Worth
  revisiting if/when we add a `SystemMessage` model for retention.

**Blocked on user** — nothing new. `USER_TODO.md` still accurate;
expanded the Twilio-console section so they have a clear checklist.

**Next agent: pick this up**
- Task: **Onboarding state machine** (next box in GOAL.md). Build
  `src/onboarding/`:
  - `state.ts`: pure `Step` enum + `StepHandler` interface. Steps:
    `WELCOME` → `PHONE_VERIFY` (skip if Twilio supplies it) →
    `NAME` → `CAMPUS_EMAIL` → `AGE` → `GENDER` →
    `PREFERRED_GENDERS` → `MIN_AGE/MAX_AGE` →
    `MIN_HEIGHT/MAX_HEIGHT` → `OWN_HEIGHT` → `PROFESSION` →
    `TYPE_DESCRIPTOR` (free-text "what's your type?") →
    `PHOTO_URL` (defer — accept "skip" for now) → `DONE`.
  - `parser.ts`: per-step input parsing + validation (e.g. age is
    18–80, height is cm in a sane range, gender maps to enum,
    "skip" handled where allowed). Pure.
  - `next.ts`: `(user, currentStep, input) → { reply, nextStep,
    persistChanges }`. Pure, returns a writeable plan; the IO layer
    applies it.
  - `prisma-deps.ts`: adapters that load/save the onboarding state
    onto User/Stats/Preferences. Suggest adding a small
    `OnboardingState { userId, step, updatedAt }` model (a single
    field on User would also work — pick one and document).
  - Wire into `routeOnboarding` in `src/twilio/conversation.ts`:
    replace the stub with a call into the onboarding step machine,
    return its reply as the outbound. Persist changes inside the
    inbound route handler.
- Tests: `parser.test.ts`, `next.test.ts` (each step transition),
  and an end-to-end test that drives a fake user from WELCOME to
  DONE via `app.inject` posting form-bodies, asserting the user
  ends up ACTIVE with Stats + Preferences populated.
- Update `GOAL.md` + `PROGRESS.md` + (if anything new) `USER_TODO.md`.

---

## 2026-05-17 — Run 4: milestone system

**Shipped**
- `src/milestones/` module with the same pure-vs-IO split the matching
  layer uses:
  - `types.ts` — `MessageForDepth`, `MessageForUnlock`,
    `UnlockThreshold`, `ConversationDepthStats`, plus
    `DEFAULT_UNLOCK_THRESHOLDS`:
      - AGE: total >=10, per-side >=4, avgDepth >=0.3
      - PROFESSION: total >=25, per-side >=10, avgDepth >=0.4
      - HEIGHT: total >=50, per-side >=20, avgDepth >=0.5
    FACE is intentionally absent — it's owned by the end-of-day
    resolution flow that lands later.
  - `depth.ts` — `scoreMessageDepth(input)`. Pure. Weighted sum of:
    length (saturating `1 - e^(-len/100)`, weight 0.5), meaningful
    question (`?` plus at least one alnum char, weight 0.25), and
    reciprocity (response of >=20 chars to the most-recent OTHER-sender
    question, weight 0.25). Whitespace/empty bodies score 0. Also
    exports `averageDepthScore` helper. TODO seam left for the
    LLM-augmented variant — shape stays 0..1.
  - `unlock.ts` — `nextMilestoneToUnlock(input, thresholds?)`. Pure.
    Strict ladder: walks `DEFAULT_UNLOCK_THRESHOLDS` in order, returns
    the first not-yet-unlocked rung whose threshold is met, else `null`.
    Refuses to skip past an unmet rung (so PROFESSION can't unlock
    before AGE even if depth is high). `summarize` exposed for callers
    that want the aggregate stats without the decision.
  - `prisma-deps.ts` — `recordMilestone(prisma, matchId, milestone)`
    upserts the `MilestoneProgress` row with an empty `update` branch,
    so `unlockedAt` is captured on first write and never bumped on
    repeat calls. `loadUnlockedMilestones(prisma, matchId)` returns the
    `Set<MilestoneType>` callers feed into the rule. Typed against a
    narrow `MilestonePrisma` surface so tests can mock without pulling
    the full client.
  - `index.ts` barrel exports.
- Tests (`tests/milestones/`):
  - `depth.test.ts` (15 tests) — empty/whitespace zeros out; length
    saturation curve (short < medium < long, short→medium jump bigger
    than medium→long); lone `?` and `?????` don't earn the question
    bonus; reciprocity only fires when the most-recent OTHER-sender
    message contained a meaningful question AND the reply is >=20
    chars; reciprocity walks past same-sender prior messages; clamps
    to [0,1]; realistic "substantive reply to a where-you-from?"
    scores in the 0.5+ range; plus the `averageDepthScore` helper.
  - `unlock.test.ts` (16 tests) — `summarize` per-side counts +
    average + ignores outside-pair senders; empty conversation; below
    AGE on volume, on per-side floor, on depth; AGE unlock at the
    boundary; ladder doesn't skip ahead; PROFESSION unlock once AGE
    is in `unlocked`; HEIGHT unlock once AGE+PROFESSION are in;
    all-unlocked → null; FACE never returned by the ladder
    (and not in `DEFAULT_UNLOCK_THRESHOLDS` to begin with); custom
    thresholds respected; stats emitted alongside the decision.
  - `record.test.ts` (5 tests) — hand-rolled `MilestonePrisma` mock
    backed by a `Map`. Covers first-write creation, idempotent repeat
    call (same row, no `unlockedAt` bump), per-matchId scoping, and
    the `loadUnlockedMilestones` reader.
- Fixed the pre-existing typecheck issue flagged in run 3: moved
  `rootDir: "src"` out of base `tsconfig.json` into
  `tsconfig.build.json` so `tsc --noEmit` covers the test tree without
  complaint. Build path is unchanged.

**Verified**
- `npm run typecheck` — clean (was failing before this run).
- `npm run build` — clean.
- `npm run lint` — clean.
- `npm test` — 79/79 pass (was 43/43; +36 new tests).
- `prisma format` + `prisma validate` — clean (schema untouched).

**Didn't try / deferred**
- No live DB exercise of `recordMilestone` — still no Docker in this
  sandbox. Unit-test mock covers the call shape.
- No callsite wiring yet. The next agent will hook this in when the
  Twilio inbound webhook lands: on each persisted `Message` (with a
  pre-computed `depthScore` from `scoreMessageDepth`), call
  `nextMilestoneToUnlock` and, when it returns non-null, persist via
  `recordMilestone` and emit the reveal outbound message. Deliberately
  not wired here because the relay layer doesn't exist yet.

**Blocked on user** — nothing new. `USER_TODO.md` is still accurate.

**Next agent: pick this up**
- Task: **iMessage relay layer** (Twilio webhooks). Build
  `src/twilio/`:
  - `signature.ts`: HMAC-SHA1 X-Twilio-Signature verification per
    Twilio spec. Pure(ish) — takes `authToken`, `url`, sorted form
    params, signature header. Unit-testable with a known vector.
  - `client.ts`: thin outbound wrapper (no SDK dep yet; raw `fetch`
    to `https://api.twilio.com/...`). Honour `TWILIO_DRY_RUN=true`
    (default in dev) — log instead of sending. Read creds from
    `env.ts` (extend the Zod schema; everything optional so the app
    still boots without Twilio).
  - `routes.ts` (replaces the current `src/routes/twilio.ts` stub):
      - `POST /webhooks/twilio/inbound`: verify signature (skip in
        dev if creds missing — log a warning), look up sender by
        `From` phone, route through the conversation state machine
        (next bullet), reply with empty TwiML.
      - `POST /webhooks/twilio/status`: persist delivery state
        against `Message.twilioSid`; 204.
  - `conversation.ts`: pure state machine — given `(user, body,
    activeMatch?)`, return `{ outboundsToSend: OutboundAction[],
    persist: Message }`. ONBOARDING users go through the onboarding
    SM; ACTIVE users with an open match get message-relayed to the
    partner (with depth scored + milestone-unlock check inline);
    no-active-match users get a friendly "your match drops at 5pm"
    style reply.
  - Wire `src/app.ts` to mount the new routes.
- Tests: signature vector(s); `conversation.ts` for each branch
  (onboarding stub, ACTIVE relay, no-match holding pattern).
- Update `GOAL.md` (check off) + `PROGRESS.md`.

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

---

## 2026-05-17T11:55Z — Onboarding state machine

**Shipped**
- `src/onboarding/{types,flow,prisma-deps,index}.ts` — pure linear state machine driven by `User.onboardingStep`.
- 11 steps: welcome → ask_display_name → age → gender → profession → height_cm → preferred_genders → min_age → max_age → type_descriptor → campus_email_domain → done.
- Per-step parsers validate input and return either updates + next-step or a clarifying retry reply (e.g. "Age must be 18–99").
- `mergeUpdates` helper for accumulating multi-step changes.
- Wired into `routeOnboarding` in `src/twilio/conversation.ts`. `RouterUser` gained `onboardingStep`; `RouteResult` gained `onboardingAdvance` so the route handler can apply updates atomically.
- `persistOnboardingUpdates` upserts Stats + Preferences and flips `status → ACTIVE` (clearing `onboardingStep`) on the final step.
- Migration: `prisma/migrations/<ts>_onboarding_step/migration.sql` adds `User.onboardingStep TEXT NULL`.
- Tests: new `tests/onboarding/flow.test.ts` (25 cases). Existing conversation + routes suites extended to cover the new ONBOARDING flow + fake-db now supports `user.update`, `stats.upsert`, `preferences.upsert`.

**Verified**
- `npm run typecheck` clean.
- `npm test` — 137/137 pass (was 112).
- `npm run build` clean.

**Didn't try / deferred**
- Did not run `prisma migrate dev` — Docker unavailable; SQL committed and will apply on first local `npm run db:up && npm run prisma:migrate`.

**Next agent: pick this up**
- Task: **End-of-day Keep/Maybe/Discard flow + resolution logic**.

---

## 2026-05-17T12:15Z — End-of-day Keep/Maybe/Discard

**Shipped**
- `src/decisions/` — pure parser + resolver + Prisma adapter.
  - `parseDecisionKeyword`: matches `KEEP|K|MAYBE|M|DISCARD|D|PASS|NOPE` as exact tokens (multi-word messages stay as chat).
  - `resolve(a, b)`: any DISCARD → ended_by_discard; both decided otherwise → continue; else pending.
  - `recordDecisionAndMaybeResolve`: idempotent upsert, flips state ACTIVE→AWAITING_DECISION on first decision; on resolution flips to CONTINUED (FACE milestone unlocked, tomorrow's DailyMatch created with parentMatchId, RematchHistory incremented) or ENDED_BY_DISCARD (RematchHistory.hasDiscard = true). All in a single transaction.
- Router intercept: a decision keyword in an ACTIVE match short-circuits the relay path, emits `decision_ack` to the deciding user and returns a `decisionToRecord` directive.
- Route handler: applies the directive, emits `decision_announcement` to the partner (pending nudge or resolution) and — when final — to the deciding user too.
- New OutboundAction kinds: `decision_ack`, `decision_announcement`.
- `TwilioPrisma` extended with `endOfDayDecision`, `rematchHistory`, `$transaction`.

**Tests**
- `tests/decisions/flow.test.ts` (12 cases): keyword parsing edge cases + full resolution truth table.
- `tests/decisions/record.test.ts` (5 cases): in-memory Prisma double exercising KEEP+KEEP → continue + FACE + next-day match + rematch; DISCARD → ended + rematch.hasDiscard; MAYBE+MAYBE continue; idempotent overwrite.
- `tests/twilio/routes.test.ts`: new DISCARD-keyword route test verifies 3 outbounds (ack + both announcements) and state transition.

**Verified**
- `npm run typecheck`, `npm run build`, `npm run lint` clean.
- `npm test` — 152/152 pass (was 137).

**Next agent: pick this up**
- Task: **Rematch eligibility logic** — query helper that, given a candidate pair and today's date, returns whether they may be rematched. Honors RematchHistory.hasDiscard (never), respects a cooldown window (e.g. 14 days), and excludes pairs already matched today. Use from the matching selector.

---

## 2026-05-17T12:19Z — Rematch eligibility

**Shipped**
- `src/rematch/index.ts` — first-class eligibility predicate + Prisma helpers.
  - `isEligibleForRematch({history, today, config})` returns `{eligible, reason, cooldownRemainingDays}`.
  - Rules: `hasDiscard` permanently blocks; otherwise eligible iff `dayDiff(lastMatchedOn, today) >= rematchCooldownDays` (default 14).
  - `loadPairHistoryFor(prisma, userIds)` — bulk-loads `RematchHistory` rows and keys them by canonical pair-key for `SelectorContext.pairHistory`.
  - `loadHistoryForPair(prisma, a, b)` — single-pair convenience.
- The selector still inlines the same rule via `pairEligibleByHistory`; the new module is a public surface for any future caller (UIs, debugging, scheduled jobs) and is the canonical place to evolve the rule.

**Tests**
- `tests/rematch/eligibility.test.ts` (10 cases): never matched, discard, within/after cooldown, config override, exact-boundary, bulk load, normalized pair-order.

**Verified**
- `npm run typecheck`, `npm test` clean. 162/162 pass.

**Next agent: pick this up**
- Task: **Anti-doxxing filter** — content filter that flags inbound messages asking for identifying info (name, school, instagram, photo) before reveals unlock. Set `Message.flaggedStatFishing = true` and (optionally) replace the relayed body with a softened version or block reveal progress for that message.

---

## 2026-05-17T12:21Z — Anti-doxxing (stat-fishing) filter

**Shipped**
- `src/safety/statFishing.ts` — pure regex-driven detector.
  - 6 categories: name, school, social, photo, phone, location.
  - 18 probes (PROBES array) covering explicit "what's your X?", handle mentions, digit blobs, etc.
  - `confidence`: 0.4 per distinct category, capped at 1.
  - `shouldGateBy(category, unlockedMilestones)`: photo asks stop gating after FACE; the rest stay gated.
- Wired into `routeActive`:
  - On a hard flag (any *gated* category hit), `Message.flaggedStatFishing = true`, `depthScore = 0` (so stat-fishing can't accelerate reveals), and the relayed body gets a one-line warning prepended (e.g. `⚠ Heads up: this asks about name before the reveal — that's against Boba's flow.`) before being delivered to the partner. Speech isn't censored; the partner still sees what was sent.
- `PersistInbound` extended with `flaggedStatFishing`; `persistInboundMessage` writes it to the row.

**Tests**
- `tests/safety/statFishing.test.ts` (14 cases): every category, benign cases, confidence ladder, gating override on FACE-unlocked.
- `tests/twilio/conversation.test.ts`: 3 new cases — hard flag zeroes depth + warns partner; FACE-unlocked photo ask passes through; benign chat untouched.

**Verified**
- `npm run typecheck`, `npm test` clean. 176/176 pass.

**Next agent: pick this up**
- Task: **Moderation hooks** — profanity/harassment regex + `Report` row flow (e.g. REPORT keyword from an SMS opens a report, increments `User.reportCount`).

---

## 2026-05-17T12:44Z — Moderation hooks

**Shipped**
- `src/safety/moderation.ts` (pure):
  - `detectHarassment(body)` — 4 categories (slur/threat/sexual_coercion/profanity), with a `severe` flag for the first three.
  - `parseReportCommand(body)` — accepts `REPORT`, `REPORT <reason>`, `REPORT <reason>: <details>`.
- `src/safety/prisma-deps.ts`:
  - `recordReport`: transactional — creates `Report`, increments `User.reportCount`, auto-bans (`status=BANNED`) on threshold (default 3, configurable).
  - `incrementReportCount`: silent bump (system auto-flags).
- Router wiring:
  - `REPORT <…>` from a user with an active match → emits `report_ack` outbound + `moderation.kind="user_report"` directive; route handler calls `recordReport`.
  - A harassment hit on a relayed message marks `Message.flaggedHarassment = true` and (if severe) bumps the sender's report count via `moderation.kind="auto_flag"`.
- New OutboundAction kind `report_ack`. `TwilioPrisma` extended with `report`.

**Tests**
- `tests/safety/moderation.test.ts` (16 cases): detector edge cases + report-command parsing + Prisma adapter (auto-ban at threshold, custom threshold, silent increment).
- `tests/twilio/routes.test.ts`: REPORT-keyword flow — ack body matches, partner's report count bumps.

**Verified**
- `npm run typecheck`, `npm test`, `npm run build`, `npm run lint` clean. 191/191 pass.

**Next agent: pick this up**
- Task: **AI-seeding plumbing** — when an inbound's *partner* is `isAiBacked=true`, route the relay through an LLM persona reply instead of sending the body verbatim back to the human. Disabled by default by an env flag; expose a stub `aiClient` interface so tests can inject.

---

## 2026-05-17T12:50Z — AI-seeding plumbing

**Shipped**
- `src/ai/persona.ts`:
  - `AiPersonaClient` interface (one method: `generateReply(req)`).
  - `StubAiPersonaClient` — deterministic, echoes a slice of the inbound with a rotating opener and a "What about you?" tail. Used in tests + dev fallback.
  - `AnthropicAiPersonaClient` — thin `fetch`-based client targeting Anthropic's messages API. Defaults to `claude-haiku-4-5`. Builds a Boba-specific system prompt that bakes in the persona, SMS style, and the anti-doxx posture.
- `src/ai/factory.ts` → `createAiPersonaClient({env, client?})` returns:
  - `null` when `AI_SEEDING_ENABLED=false` (default),
  - `AnthropicAiPersonaClient` when enabled + `ANTHROPIC_API_KEY` set,
  - `StubAiPersonaClient` when enabled + no key (dev/test),
  - throws in production with no key.
- Router wiring:
  - `RouterPartner` extended with `isAiBacked` + `aiPersonaPrompt`.
  - When partner is AI-backed, relay outbound is suppressed and a new `aiReplyToGenerate` directive is emitted with the latest inbound + `priorTurns` (mapped to `fromAi` flags).
- Route handler:
  - Calls the persona client when both directive and client are present.
  - Persists the AI's reply as an INBOUND from the AI partner (so milestone/depth flows stay symmetric) and sends it over SMS to the human user.
  - Logs and drops the directive when AI seeding is disabled.
  - `RegisterOptions.deps.aiPersonaClient` accepts test overrides (including explicit `null`).

**Tests**
- `tests/ai/persona.test.ts` (13 cases):
  - Stub: echoes inbound + opener rotation across turns.
  - Anthropic client: rejects empty key; assembles system+messages payload (verifies headers, system prompt content, role mapping); throws on non-2xx and empty content.
  - Factory: null when disabled, Anthropic when key, stub fallback in dev, refusal in prod, override.
- `tests/twilio/conversation.test.ts`: 2 new cases — relay suppression + correct directive shape; prior-turn `fromAi` mapping.

**Verified**
- `npm run typecheck`, `npm test`, `npm run build`, `npm run lint` clean. 204/204 pass.

**Next agent: pick this up**
- Task: **Tests audit** + **seed script** (Postgres docker + fake-user generator) + write `BUILD_COMPLETE` once the checklist clears.

---

## 2026-05-17T12:53Z — Seed script + completion

**Shipped**
- `prisma/seed.ts`: 7 idempotent fake users (6 humans + 1 AI-backed `Robin`), each with Stats + Preferences. Upsert by phone.
- `npm run seed` and Prisma `seed` config in `package.json`.
- `tsconfig.json` now includes `prisma/*.ts` so the seed script is type-checked.
- README refreshed: getting-started includes prisma:migrate + seed; layout matches reality.
- All GOAL.md items checked off; `BUILD_COMPLETE` written.

**Verified**
- `npm run typecheck`, `npm test` (204/204), `npm run build`, `npm run lint` (0 warnings).

---

## 2026-05-17T19:31Z — Launch-ready, phase 1: invites + photo + auto-create

**Shipped**
- Schema: new `InviteCode` model (one-to-one with redeeming `User`); migration committed.
- `src/invites/`: code helpers (`generateCode`, `normalizeCode`, `isWellFormed`, `formatForDisplay`) + Prisma adapter (`redeemCode`, `createInvite`, `createManyInvites`, `countUnredeemed`).
- Onboarding state machine extended:
  - Two new steps inserted: `ask_invite_code` (front of flow, gated by `INVITES_REQUIRED` env) and `ask_photo` (after height).
  - `InboundMedia` threaded through `advance({media, config})`; photo step accepts an `image/*` MMS or `SKIP`.
  - `OnboardingUpdates.inviteCodeToRedeem` directive — route handler atomically redeems before persisting the step.
- Route handler:
  - Reads Twilio's `NumMedia`/`MediaUrl0`/`MediaContentType0` into `RouteInput.media`.
  - Auto-provisions a fresh `ONBOARDING` user when an unknown phone texts in (no more "unknown sender intro" dead-end).
  - On invite advance, calls `redeemCode`; on failure swaps the outbound for a clarifying reply ("don't recognize that code" / "already used") and leaves the cursor on `ask_invite_code`.
- Env: `INVITES_REQUIRED` (default true), plus reserved knobs for later (`ADMIN_TOKEN`, `SCHEDULER_ENABLED`, `SCHEDULER_CRON`, `SENTRY_DSN`, `SENTRY_TRACES_SAMPLE_RATE`).
- Seed script: 5 fixed dev invite codes (`DEV12345`, `DEV2ABCD`, …) added.

**Tests**
- `tests/invites/code.test.ts` (5), `tests/invites/redeem.test.ts` (10): full coverage of code helpers + redemption transitions (fresh, normalized input, unknown, taken-by-other, taken-by-self, idempotent re-redeem, collision retry, exhaustion).
- `tests/onboarding/flow.test.ts`: invite-step parser, photo-step parser (SKIP / image / non-image), env-flag pass-through.
- `tests/twilio/conversation.test.ts`: invites-required vs invites-disabled entry behavior.
- `tests/twilio/routes.test.ts`: auto-provision flow, successful redemption, malformed/unknown rejection.

**Verified**
- `npm run typecheck`, `npm test` (230/230), `npm run build`, `npm run lint` all clean.

**Next agent: pick this up**
- Daily-match scheduler (in-process cron + manual admin trigger), then admin endpoints (list users / view conversation / ban) gated by `ADMIN_TOKEN`.
