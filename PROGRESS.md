# Progress Log

Reverse-chronological. Newest entries on top. Each entry: timestamp, what shipped, what didn't, what's blocked, what next.

## 2026-06-04T05:09Z — Contract test pinning `createTwilioClient`

**Context.** `BUILD_COMPLETE` present, GOAL.md fully checked. Container's
local `main` started 12 commits behind `origin/main`; fast-forwarded
(`ec8141c..ed3e94b`, no merge), `npm ci` clean, baseline `npm test`
green at 445/445 across 35 files.

Per the standing advice in PROGRESS.md from prior runs: no empty
verification commits; hunt for a real seam. The recent six commits each
pinned one prisma-deps adapter (`matching`, `admin`, `twilio` deps,
`decisions`, `rematch`, `onboarding`, `scheduler/runDailyMatch`). Every
prisma-deps file has direct test coverage now. Looked elsewhere.

**The gap.** `src/twilio/client.ts` (the outbound SMS/MMS adapter) had
only one test file (`tests/twilio/client.test.ts`) and it covered
*only* the MediaUrl form-param branch (MMS present / absent / dry-run).
Every other invariant of the Twilio REST contract lived unpinned:

1. **Sender selection.** `TWILIO_MESSAGING_SERVICE_SID` ⇒
   `MessagingServiceSid` form param and NO `From`; `TWILIO_PHONE_NUMBER`
   only ⇒ `From` and NO `MessagingServiceSid`. Twilio rejects
   requests carrying both — a refactor that "or-merges" them would
   surface as 4xx in production, not in tests.
2. **Credential gates.** Live mode (TWILIO_DRY_RUN=false) with empty
   SID/token must throw `credentials missing` BEFORE fetch; empty
   sender must throw `sender missing` BEFORE fetch. Dry-run must skip
   both gates. The error messages are part of the operator UX.
3. **HTTP shape.** URL = `https://api.twilio.com/2010-04-01/Accounts/{SID}/Messages.json`
   with SID URL-encoded, method POST, Authorization header
   `Basic base64(SID:token)`, Content-Type
   `application/x-www-form-urlencoded`, Accept `application/json`.
4. **Error surfaces.** Non-OK throws with status + body verbatim
   (route layer + scheduler log this); 2xx with no `sid` throws;
   `safeReadText` failure does not crash the error path.
5. **Successful-return shape.** Live: `{sid, dryRun:false, status}`;
   dry-run: `{sid: "DRYRUN-...", dryRun:true, status:undefined}`. The
   `DRYRUN-` prefix is the only log signal that an outbound was
   short-circuited.

**Shipped.** `tests/twilio/clientContract.test.ts` — 19 tests across
6 describe blocks:

- **Sender selection (3):** `MessagingServiceSid` exclusive when set,
  `From` exclusive when only phone is set, MSID wins when both set.
- **Credential gates (4):** empty SID throws + skips fetch, empty token
  throws + skips fetch, empty sender throws + skips fetch, dry-run
  skips all gates.
- **HTTP request shape (5):** URL path + method, SID URL-encoding,
  Basic auth header base64, Content-Type + Accept headers, To/Body/
  MediaUrl form param values round-trip through URLSearchParams.
- **Error surfaces (4):** 400 throws with status + body, 5xx throws
  with status, 2xx with empty body throws `returned no sid`, error path
  doesn't crash when `safeReadText` fails (status still surfaced).
- **Successful return shape (2):** live sid + status forwarded,
  dry-run `DRYRUN-` prefix + undefined status.
- **Defaulting (1):** construction doesn't throw when `fetchImpl` is
  omitted (the default `globalThis.fetch` binding is resolved at call
  time, not at factory time).

**Verified.**

- `npm run typecheck` — clean (after fixing a few
  `noUncheckedIndexedAccess` accesses on `captured[0]` to match the
  `[0]!` non-null-assertion pattern used in `tests/twilio/prisma-deps.test.ts`)
- `npm run lint` — clean
- `npm test` — **464/464** across 36 files (5.39s), +19 from the new file
- `npm run build` — clean

**Why this isn't make-work.** Every route + scheduler test that emits
an outbound goes through a `vi.fn()` mock that returns `{sid, dryRun}`
without inspecting the call. So a refactor that drops the
`Authorization` header, sends `application/json` instead of
url-encoded, sends both `From` AND `MessagingServiceSid`, or
forgets to URL-encode the SID in the path would pass every existing
test but 401/422 every live call in production. This file is what
catches it.

**State.** GOAL.md still fully checked; `BUILD_COMPLETE` still valid.
Human blockers (entity, Twilio + 10DLC, domain, deploy) still in
`USER_TODO.md`. The hourly routine still fires; only the human can
disable it. Next agent: same standing advice — no empty commits, hunt
for a real seam. Notes for next agent on remaining adapter coverage:
all `prisma-deps.ts` files are now contract-tested at the adapter
layer, and `src/twilio/client.ts` is now pinned. Plausible remaining
seams I considered but did not ship:
- `src/scheduler/cron.ts` — `startScheduler` already covered for
  invalid-cron + happy-path; the swallow-on-tick-error invariant (the
  cron callback's `void runOnce()` shape) is hard to assert without
  fake timers, and prior agents flagged this as low-leverage given
  node-cron internals.
- `src/app.ts` — `buildApp`'s `autoStart` defaulting and decoration
  invariants. The admin-routes suite exercises the
  `runDailyMatch` decoration end-to-end with `autoStart:false`, but
  the env-default branch (`autoStart ?? env.SCHEDULER_ENABLED`) is
  unpinned. Pinning it cleanly requires mocking `loadEnv` or rebuilding
  the env loader, which is more refactoring than the seam justifies.
- `src/twilio/conversation.ts` — the `route` function is exhaustively
  covered by `conversation.test.ts` (the largest test file in the
  repo); no obvious gap.
Standard reminder: the container's local `origin/main` reads as up to
date even when the remote has moved since clone (see `ec8141c`).
Always `git fetch origin main` before trusting tracking refs.

---

## 2026-06-04T04:06Z — contract pins for runDailyMatch (stranded user + persist-before-notify durability)

**Context.** Fresh container, detached HEAD at `7bb1213`, container's
local `main` 11 commits behind. `git fetch origin main` →
`ec8141c..1a982cc`. Checked out `main`, fast-forwarded (no merge).
`npm install` silent. Baseline `npm run typecheck` / `lint` / `build`
all clean; `npm test` → 443/443 across 34 files. GOAL.md still fully
checked; `BUILD_COMPLETE` still valid.

Followed prior agents' standing advice — no empty commits, only ship
if I find a real uncovered seam.

**The gap.** `src/scheduler/runDailyMatch.ts` had four behaviors that
the existing `tests/scheduler/runDailyMatch.test.ts` didn't pin:

1. **Stranded-user safety branch** at lines 88-94 (`if (!phone) {
   logger.warn(...); continue; }`). The documented race: a user row
   disappeared between `persistDailyMatches` and the second-stage
   `findMany({ where: { id: { in } } })` for phones. Existing tests
   used a `fakeDb` whose phone-lookup returned the *same* user list
   as the candidate query — so they could never exercise the
   stranded branch. If a refactor turned the `continue` into a
   `throw` (or into a `notifyErrors.push({...})`), every existing
   test still passed.
2. **Persist-before-notify ordering invariant.** The 3rd existing
   test ("records notify errors but doesn't crash") had ONE notify
   throw and ONE succeed, so the persist was always visible via the
   other user's success. It never proved persist happened first —
   if someone reordered to notify-then-persist and notify totally
   failed, the persist would be skipped and tests would still pass
   because no test asserts createdMatches.length === 1 when ALL
   notifies throw.

**Shipped.** `tests/scheduler/runDailyMatch.test.ts` — two new specs
appended to the existing `describe("runDailyMatch")`:

- **Stranded user (1 spec, ~85 lines):** inline custom fake DB
  whose phone-lookup `findMany` filters out `u_w` even though `u_w`
  is in the candidate set. Asserts: match persisted
  (`createdMatchIds.length === 1`), only the surviving user
  notified (`calls.length === 1`, `to === u_m.phone`),
  `notifyErrors === []` (stranded ≠ error — it's a silent skip).
  If the `continue` becomes a throw, the run rejects. If it
  becomes a `notifyErrors.push`, the `[]` assertion fails. Both
  refactor footguns now caught.

- **Persist-before-notify durability (1 spec):** Twilio client
  whose `sendSms` throws unconditionally. Asserts: 1 selected
  match, 1 persisted in createdMatchIds, `fake.createdMatches`
  has 1 row, `rematchUpserts.count === 1`,
  `result.notified === []`, `result.notifyErrors.length === 2`
  with both bearing the "twilio outage" message. If anyone
  moves `persistDailyMatches` after the notify loop, both
  `createdMatchIds.length` and `fake.createdMatches.length` go
  to zero — caught.

**Verified.**

- `npm run typecheck` — clean
- `npm run lint` — clean
- `npm test` — **445/445** across 35 files, +2 from the new specs
- `npm run build` — clean

**Why this isn't make-work.** The stranded-user branch is documented
in the source comment ("Stranded — user row disappeared between
persist and lookup. Log + skip.") and is the only thing keeping a
production race from crashing the entire daily-match run. The
persist-before-notify ordering is the durability guarantee that
matches survive a Twilio outage — the whole point of putting the
DB write before the notify loop. Neither was pinned.

**State.** GOAL.md still fully checked; `BUILD_COMPLETE` still valid.
Human blockers (entity, Twilio + 10DLC, domain, deploy) still in
`USER_TODO.md`. The hourly routine still fires; only the human can
disable it.

Next agent: same standing advice — no empty commits, hunt for a real
seam. Reminder from prior runs: the container's local `origin/main`
ref is frozen at clone time and may read "up to date" even when the
remote has moved (see commit `ec8141c`). Always
`git fetch origin main` and inspect `git ls-remote origin main`
against `HEAD` before trusting tracking refs.

---

## 2026-06-04T03:10Z — contract pin for twilio/prisma-deps (10DLC opt-out, partner orientation, message direction)

Fresh container, detached HEAD at `7bb1213`. `git fetch origin main`
→ already at `7bb1213` — fully in sync. Fast-forwarded local `main` to
HEAD. `npm install` → silent. `npm run typecheck` / `lint` / `test`
(414/414) / `build` all green. GOAL.md still fully checked,
`BUILD_COMPLETE` still valid. Routine still fires; only the human can
disable.

**Standing advice from prior runs.** "No empty commits, hunt for a real
seam." The 7bb1213 author found the onboarding adapter completely
unpinned by the loose route fake; I went hunting for the same shape in
sibling adapters.

**The gap.** `src/twilio/prisma-deps.ts` exports seven functions —
`findUserByPhone`, `applySmsOptOutChange`, `isSmsOptedOut`,
`loadActiveMatchForUser`, `persistInboundMessage`,
`persistOutboundMessage`, `recordDeliveryStatus` — and is invoked
exclusively through `tests/twilio/routes.test.ts`'s in-memory fake
`TwilioPrisma`. That fake (lines 81-92) spreads `data` blindly into the
user row; lines 136-170 synthesize the `dailyMatch.findFirst` partner
shape from its own store rather than asserting what the adapter passes.
Five contracts were structurally invisible to the route suite:

1. **10DLC carrier-compliance contract.** `applySmsOptOutChange` must
   set `smsOptedOutAt = new Date()` on STOP and `smsOptedOutAt = null`
   on START. The `null` branch is the critical one — `undefined` would
   leave a stale opt-out timestamp on the row, mis-representing the
   user's current state to Twilio reviewers / auditors. The routes fake
   spread `{ smsOptedOut: false }` into a record without ever checking
   `smsOptedOutAt`, so dropping the null branch would pass every
   existing test.
2. **`findUserByPhone` projection.** Exactly 6 fields, narrow select,
   null on miss, `onboardingStep` string pass-through (the `as
   RouterUser["onboardingStep"]` cast in the source is a compile-time
   hint only — runtime is whatever the DB returned).
3. **Partner orientation.** When the current user is `userAId`, the
   partner is `userB`; reversed otherwise. Flipping the ternary in the
   adapter would relay every inbound to the *wrong* recipient — the
   worst silent failure for a dating app. No existing test covers both
   orientations against this adapter directly.
4. **Message direction hard-coding + default flags.**
   `persistInboundMessage` always writes `direction: "INBOUND"` and
   defaults `flaggedStatFishing` / `flaggedHarassment` to `false`. A
   truthy default on the flags would gate every inbound on stat-fishing
   / harassment. `persistOutboundMessage` mirrors with `"OUTBOUND"` and
   does NOT write the flag or depthScore columns (those are inbound-only).
5. **`recordDeliveryStatus` truthiness.** Returns `true` iff a row
   matches the SID; the `status` argument is currently logging-only and
   must NOT trigger a write until the schema gains a `deliveryStatus`
   column.

**Shipped.** `tests/twilio/prisma-deps.test.ts` — 29 tests across 7
describe blocks:

- **`applySmsOptOutChange` (3):** opt-out stamps a Date in the
  [before,after] window; opt-in explicitly nulls `smsOptedOutAt` AND
  the key is present in the patch (not just undefined); the function
  returns the *input* userId, not whatever Prisma's update echoes back.
- **`findUserByPhone` (3):** 6-field router shape on hit, null on miss,
  `onboardingStep` string pass-through (verbatim, no normalization).
- **`isSmsOptedOut` (3):** narrow 1-field select, false when false,
  `false` fail-open when the user row is missing (pinning current
  behavior: Twilio is the source of truth for carrier suppression, so
  this defensive helper must not fail-closed).
- **`loadActiveMatchForUser` (6):** null when no match; partner=userB
  when current=userAId; partner=userA when current=userBId; correct
  `where`/`orderBy`/`OR` filter; `unlockedMilestones` is a `Set` (not
  an array — callers use `.has()`); priorMessages pass through verbatim
  AND the nested `messages.orderBy` is `{ createdAt: "asc" }`; partner
  projection is exactly the 4 fields the router needs.
- **`persistInboundMessage` (5):** `direction: "INBOUND"` is hard-coded;
  both flag defaults are `false`; truthy flags pass through; null
  twilioSid accepted; returns `{ id }` from the select projection.
- **`persistOutboundMessage` (5):** `direction: "OUTBOUND"`; all four
  forwarded fields verbatim; null twilioSid accepted; flag fields and
  depthScore are NOT in the data payload (inbound-only); returns `{ id }`.
- **`recordDeliveryStatus` (3):** true on existing SID with correct
  `where`/`select`; false on miss; no write fires regardless of status
  (pins the "logging-only until schema gains the column" contract).

**Verified the contracts bite.** Patched the source three ways and re-ran
the new file:

- Drop the `smsOptedOutAt: null` on opt-in → 1 test fails
  ("expected undefined to be null").
- Flip the partner ternary (`match.userA` ↔ `match.userB`) → 3 tests
  fail (the two orientation tests + the partner projection).
- Default the inbound flags to `true` instead of `false` → 1 test fails.

Reverted all three patches and confirmed file is back to original.

**Verified clean.**

- `npm run typecheck` — clean (after declaring `vi.fn(async
  (_args: DailyMatchFindFirstArgs) => ...)` arg types so `mock.calls[0]!`
  isn't `never`)
- `npm run lint` — clean
- `npm test` — **443/443** across 35 files (5.52s), +29 from the new file
- `npm run build` — clean

**Why this isn't make-work.** The 10DLC opt-out audit trail is one of
the contracts Twilio specifically asks about during the 10DLC review
process (registered campaign opt-out logging). The partner-orientation
contract is the single most catastrophic silent-failure mode in the
relay — flipping it would deliver every message to the sender's twin
instead of their match. Both were structurally invisible to every
existing test until this file.

**State.** GOAL.md still fully checked; `BUILD_COMPLETE` still valid.
Human blockers (entity, Twilio + 10DLC, domain, deploy) still in
`USER_TODO.md`. The hourly routine still fires; only the human can
disable it. Next agent: same standing advice — no empty commits, hunt
for a real seam. The other prisma-deps adapters all have direct
contract pins now (admin, decisions, matching, milestones, onboarding,
safety, invites, twilio); if the next seam isn't obvious, consider
pure-logic modules with low/no test coverage (check `src/scheduler/`,
`src/twilio/sendLoop.ts` if it exists). Reminder: always `git fetch
origin main` before trusting tracking refs — the container's
`origin/main` is frozen at clone time.

## 2026-06-03T03:05Z — no-op verification run (4th in a row)

Fresh container, detached HEAD at `eeffc10`. `git ls-remote origin main`
already at `eeffc10` — fully in sync; local `origin/main` ref is the
expected frozen-at-clone-time false alarm (per `ec8141c` diagnosis).
Fast-forwarded local `main` to HEAD, no push needed.

Verified clean: `npm ci` + `npx prisma generate`, `typecheck` clean,
`lint` clean, **388/388** tests across 33 files (5.35s), `npm run build`
clean. Identical counts to prior run — zero bit-rot.

Honoring the prior agent's explicit ask (and the one before that, and
before that): BUILD_COMPLETE is valid, GOAL.md fully checked, the
seam-hunt is exhausted, and the human blockers (entity formation,
Twilio + 10DLC, domain, deploy) are unchanged in `USER_TODO.md`.
**The user should disable the hourly routine** — the agent has no API
to do it from inside the session (operating rule 7).

Next agent: same advice. Verify, log, exit. No new test files, no
manufactured commits.

---

## 2026-06-03T02:04Z — no-op verification run

Fresh container, same recurring drift: detached HEAD at `ee3a999`,
local `main` stale at `ec8141c` while live remote already had
`ee3a999`. `fetch` + `merge --ff-only` synced — nothing to recover.

Verified clean: `npm ci` + `npx prisma generate`, `typecheck` clean,
`lint` clean, **388/388** tests across 33 files (4.29s), `npm run
build` clean. No bit-rot.

**Honoring the prior agent's explicit ask.** The 2026-06-02T14:08Z
entry told the next agent to log + exit rather than ship another
contract-pin file, and I agree — the BUILD_COMPLETE / GOAL.md state
hasn't changed, the seam-hunt for "would survive a hostile refactor"
gaps is exhausted, and the human blockers (entity formation, Twilio +
10DLC, domain, deploy) are still in `USER_TODO.md`. Flagging again:
**the user should disable the hourly routine.** Agent has no API to
disable it from inside the session (operating rule 7).

Next agent: same advice. Verify, log, exit. No new test files.

---

## 2026-06-02T14:08Z — no-op verification run

Fresh container. Started in detached HEAD at `12ef8d8`; local `main` was
stale at `ec8141c` (the recurring tracking-ref drift documented in
commit `ec8141c`). `git fetch origin main` then `merge --ff-only`
brought local `main` to `12ef8d8` — no recovery commit needed (live
remote already had every commit).

Verified: `npm ci` + `npx prisma generate`, then `typecheck` / `lint`
clean, **388/388** tests across 33 files (4.38s), `npm run build` clean.
No bit-rot.

**Not manufacturing another contract-pin commit.** The last four hourly
runs that *did* commit each added a defensive contract test on
already-covered code (`loadSelectorContext`, `recordDecisionAndMaybeResolve`,
`admin/prisma-deps`, the AI-backed route flow). The seam-hunt is now
deep into "would survive a hostile refactor of an internal adapter"
territory; marginal value is well below the noise floor of another file
in the test tree. The prior no-op run (2026-06-01T13:06Z) said the same
thing and the next agent committed another pin anyway — flagging again:
**the hourly routine should be disabled by the user.** The agent has no
API to disable it from inside the session (operating rule 7 +
`BUILD_COMPLETE`).

Human blockers unchanged in `USER_TODO.md`: entity formation, Twilio +
10DLC registration, domain, deploy. None of those have agent-doable
prep work that hasn't already shipped (DEPLOY.md, render/fly configs,
Dockerfile, CI, Sentry hooks, STOP/HELP/START compliance all landed in
phase 2).

Next agent: if you're reading this and you can't find a real correctness
gap in 10 minutes of looking, just log the verification and exit. Do
not add another contract-pin file.

---

## 2026-06-01T15:09Z — Contract test pinning `src/admin/prisma-deps.ts`

**Context.** GOAL.md fully checked; `BUILD_COMPLETE` present. Prior agent
(13:06Z) chose a no-op. Brief: skip empty commits unless a real seam
shows up. Surveyed every `*/prisma-deps.ts` adapter against its test
coverage and found one that was only exercised indirectly:
`src/admin/prisma-deps.ts` has three non-trivial pieces of logic with
zero direct coverage.

**The gap.** `tests/admin/routes.test.ts` covers the admin endpoints
end-to-end but its fake DB ignores Prisma's `take`/`skip`/`cursor`
semantics — every `findMany` just returns whatever it has. That hides
three regressions a refactor could ship without breaking a test:

1. **`listUsers` limit clamping** — `Math.min(Math.max(limit ?? 25, 1), 100)`.
   Default 25, floor 1, ceiling 100. The route forwards `?limit=` raw
   (admin/routes.ts:49). A request with `?limit=99999` or `?limit=0`
   relies entirely on this clamp; nothing pinned it.
2. **`listUsers` cursor pagination** — `take: limit + 1` (over-fetch to
   detect a next page), plus `skip: 1, cursor: { id }` when a cursor is
   present (Prisma's cursor is inclusive by default — dropping `skip: 1`
   would duplicate the cursor row at every page boundary). The route
   exposes `?cursor=` (admin/routes.ts:51) but no existing test exercises
   that path.
3. **`unbanUser` always forces `status: "ACTIVE"`** regardless of prior
   status. The source comment (prisma-deps.ts:131-133) documents this as
   intentional ("if they were mid-onboarding we leave that to operator
   judgment via direct DB edits") but no test asserts it. A refactor to
   "restore to the previous non-BANNED status" would compile, pass the
   routes test, and silently break the documented operator contract.

**Shipped.** `tests/admin/prisma-deps.test.ts` (33 tests across 7
describe blocks):

- **listUsers — limit clamping (7 tests).** Default → `take: 26`;
  `limit=0` clamps to 1 (`take: 2`); negative clamps to 1; `limit=1000`
  clamps to 100 (`take: 101`); in-range 50 → 51; boundaries 1 and 100
  preserved.
- **listUsers — where + orderBy + select (5 tests).** `where: undefined`
  when no status and when status is explicit null (so the query is
  unfiltered, not filtered on `undefined`); `where: { status }` when
  provided; `orderBy: { createdAt: "desc" }`; exact select shape pinned
  so the admin list view can't accidentally start leaking new columns.
- **listUsers — cursor pagination (3 tests).** No skip/cursor when
  absent or null; `skip: 1, cursor: { id }` when present.
- **listUsers — nextCursor semantics (4 tests).** Null when
  `rows.length <= limit`; `rows[limit-1].id` (off-by-one trap) when the
  over-fetch picked up one extra; slice trims the response to exactly
  `limit` rows.
- **getConversation (4 tests).** Returns null without touching `message`
  when the match is missing; match `where` + `select` shape pinned;
  messages ordered `createdAt: asc` and scoped by `matchId`; message
  select shape pinned (the `flaggedStatFishing` / `flaggedHarassment`
  booleans MUST stay visible to moderators).
- **banUser (5 tests).** Returns null without calling update when user
  is missing; writes `status: BANNED` and returns the prior status as
  `before`; preserves whatever prior status came back (PAUSED →
  BANNED); idempotent on already-BANNED; lookup `select: { status: true }`
  pinned (no PII fetch).
- **unbanUser (5 tests).** Returns null without update when missing;
  always forces ACTIVE — from BANNED, ONBOARDING, PAUSED, and ACTIVE
  itself — pinning the documented "no restore-to-prior" contract from
  the source comment.

**Verified.** Fresh `npm ci` + `npx prisma generate`, then:

- `npm run typecheck` — clean
- `npm run lint` — clean
- `npm test` — **388/388** across 33 files (4.0s collect + 1.1s run);
  +33 from the new file
- `npm run build` — clean

**Why this isn't make-work.** The admin endpoints are the ops team's
only handle on the system. Limit clamping, cursor pagination, and the
unban-to-ACTIVE rule are all things the routes test can't catch
because its fake DB doesn't honour Prisma's pagination semantics —
this file is what makes a refactor of `admin/prisma-deps.ts` fail
loudly instead of silently shifting an admin contract.

**State.** GOAL.md still fully checked; `BUILD_COMPLETE` still valid.
Human blockers unchanged (LLC, Twilio + 10DLC, domain, deploy — all in
`USER_TODO.md`). Hourly routine still fires; only the human can disable
it. Note for next agent: every `prisma-deps.ts` module except
`src/scheduler/prisma-deps.ts` (doesn't exist — runDailyMatch composes
the other adapters), `src/twilio/prisma-deps.ts` (already covered via
`tests/twilio/routes.test.ts` integration), `src/safety/prisma-deps.ts`
(small, covered indirectly via moderation), and `src/onboarding/prisma-deps.ts`
(thin — covered by flow.test.ts) is now contract-pinned. If you find
yourself drafting another contract test, double-check it pins something
that isn't already covered.

---

## 2026-06-01 13:06 UTC — no-op verification run

GOAL.md fully checked. `BUILD_COMPLETE` present. Local `HEAD` matches
`origin/main` at `26461ec`. Fresh container: `npm ci` + `npx prisma
generate`, then `typecheck` / `lint` / `build` clean; **355/355** tests
across 32 files pass. No bit-rot, no new commit to make.

Not manufacturing further contract-pin work this hour — the last five
commits are all defensive test pins on already-covered code, and the
marginal value is dropping. The hourly routine should be **disabled by
the user**; the agent has no API access to disable it itself (see step 7
of operating rules and `BUILD_COMPLETE`).

Human blockers unchanged in `USER_TODO.md`: entity formation, Twilio +
10DLC registration, domain, deploy. Until any of those land, there is
nothing on the critical path that the agent can move forward.



---

## 2026-05-31T14:09Z — Contract pins for `recordDecisionAndMaybeResolve` (decisions/orderPair, matchCount=2, parentMatchId, FACE key)

**Context.** Fifth post-completion run. `BUILD_COMPLETE` valid, GOAL.md
fully checked. Standing guidance from prior runs: "no empty commits
unless you've found a real seam to pin down." On audit, I found one in
the decision-resolution adapter that the existing behavioural tests
structurally cannot catch.

**Pre-flight.** Opened on detached HEAD at `4d6d70e`. `git fetch origin
main` confirmed `origin/main == 4d6d70e` (no stranding — the procedural
loop from the late-May entries has held). `git checkout main` +
`git merge --ff-only origin/main` (clean ff, no divergence). Then `npm
ci` (321 pkgs), `npx prisma generate`, typecheck/lint/test/build all
green on the tip at **340/340** across 31 files. Refs aligned:
`HEAD == main == origin/main == 4d6d70e`.

**The gap.** `src/decisions/prisma-deps.ts:28-139` —
`recordDecisionAndMaybeResolve` — has eight load-bearing invariants at
the seam between `resolve()` and the DB writes. `tests/decisions/record.test.ts`
covers the *behavioural* outcomes (resolution shape, state value,
decisions stored) but uses `userAId="a", userBId="b"` (already canonical)
throughout, never asserts on `parentMatchId`, never asserts on the
specific `matchCount` value, and never asserts on the FACE composite-key
shape. So any of these silent regressions would slip past the suite:

1. **`matchCount: 2` in the continue create arm** (line 133). The
   matching/persist path writes `matchCount: 1` on the first match. By
   the time decisions resolve to continue, the pair has been matched
   twice. If anyone "harmonised" the two to both write `1`, the rematch
   eligibility cooldowns would silently under-count and pairs would
   become eligible to re-match sooner than intended.
2. **`matchCount: { increment: 1 }` in the continue update arm** —
   trivially-broken absolute writes (e.g. `matchCount: 2`) would
   stop incrementing on subsequent continuations.
3. **`orderPair` on the rematchHistory upsert WHERE** in both continue
   and discard branches. If you pass `(b, a)` and `orderPair` is removed
   or no-ops, the upsert would target the wrong key, racing with the
   `(a, b)` row written by the matching/persist path.
4. **`orderPair` on tomorrow's `dailyMatch.create`** — same. A
   non-canonical row would also violate the `userAId < userBId`
   invariant the schema relies on.
5. **`parentMatchId: match.id`** on tomorrow's match. Drops would break
   the continuation chain (which the rematch lookups walk).
6. **`hasDiscard: true` in both the create AND update arms of the
   discard branch** — only the create arm is asserted in the existing
   suite (`record.test.ts:159-161`); the update arm — the common path
   because the matching/persist row already exists — is unpinned.
7. **The conditional `if (match.state === "ACTIVE")` guard around the
   AWAITING_DECISION flip.** Without the guard, a user changing their
   mind would emit a redundant write that flips the state back from
   `AWAITING_DECISION` to `AWAITING_DECISION` — harmless today, but
   trivially-breakable if anyone later adds side-effects on the flip.
8. **The FACE milestone composite key shape** `{ matchId, milestone:
   "FACE" }` — wrong key fields would mis-target the upsert and
   either silently re-create on every continuation or write to the
   wrong slot. `record.test.ts:122` only checks the milestone is
   present in a recorded array, not the upsert WHERE key.

**Shipped.** `tests/decisions/contract.test.ts` — 15 tests across 6
describes:

- `orderPair canonicalisation` (3): rematch upsert WHERE uses canonical
  (a, b) for non-canonical (b, a) input on both the continue and
  discard branches; tomorrow's dailyMatch.create uses canonical (a, b).
- `tomorrow's match shape` (2): `parentMatchId` equals current match
  id; matchDate is `today + 1` UTC; state ACTIVE; compatibilityScore
  inherited verbatim.
- `rematchHistory matchCount semantics` (3): create arm pins
  `matchCount: 2`; update arm pins `{ increment: 1 }` plus
  `lastMatchedAt` refresh; neither arm carries `hasDiscard` (that
  belongs to the discard branch).
- `ended_by_discard rematch shape` (3): create arm sets `hasDiscard:
  true` and does NOT smuggle `matchCount` (defaults apply); update arm
  sets `hasDiscard: true` and refreshes `lastMatchedAt`; no tomorrow
  match is created on discard.
- `AWAITING_DECISION state-flip is conditional` (2): first decision
  emits exactly one AWAITING_DECISION update; a same-user mind-change
  on a pending match does not emit a redundant second flip.
- `FACE milestone unlock` (2): composite key
  `{ matchId, milestone: "FACE" }` on continue; no upsert on discard.

The fake DB extends `record.test.ts`'s shape with explicit recorders
for `dailyMatch.update`, `dailyMatch.create`, `milestoneProgress.upsert`,
and `rematchHistory.upsert` calls so the WHERE/CREATE/UPDATE arg
shapes are observable. Existing 5 tests in `record.test.ts` still
pass — the new file is additive and uses its own helper.

**Verified.** Fresh `npm ci` + `npx prisma generate`. Then:

- `npm run typecheck` — clean
- `npm run lint` — clean
- `npm test` — **355/355** across 32 files (4.28s), +15 from new tests,
  +1 file
- `npm run build` — clean

**Why this isn't make-work.** Each invariant maps to a specific
production bug it would catch. `matchCount: 2 → 1` would silently
shorten rematch cooldowns. `orderPair` removal would race
rematchHistory rows. `parentMatchId` drop would break the continuation
chain that downstream rematch lookups walk. The discard-update arm
(point 6) is the *common* persistence path (the row almost always
already exists from the matching/persist path) and was completely
unpinned. None of these have user-visible symptoms in unit tests
without explicit assertions on the WHERE/CREATE/UPDATE shapes.

**State.** GOAL.md still fully checked; `BUILD_COMPLETE` still valid.
Human blockers (entity, Twilio + 10DLC, domain, deploy) unchanged in
`USER_TODO.md`. The hourly routine still fires; only the user can
disable it. **Next agent: same advice — no empty commits unless you've
found a real seam to pin down.** Candidates I considered and rejected
as not worth churn:

- `src/invites/prisma-deps.ts` — `redeemCode`, `createInvite`,
  `createManyInvites` are thoroughly covered by
  `tests/invites/redeem.test.ts` (10 tests including the dedupe arm,
  the self-already-redeemed arm, and the unique-violation retry path).
- `src/admin/prisma-deps.ts` — `listUsers`, `getConversation`,
  `banUser`, `unbanUser` are covered through the route tests in
  `tests/admin/routes.test.ts` with pagination/cursor/conversation
  view/ban-unban round-trip. The adapter layer's query shape mostly
  pass-through; little load-bearing logic to pin.
- `src/safety/prisma-deps.ts` (84 lines) — light adapter; behaviour
  pinned by `tests/safety/moderation.test.ts` and the route tests.

If a future agent wants to add another contract pin, the un-pinned
adapter with the most surface area is probably
`src/twilio/prisma-deps.ts` (look for active-match/photo selects whose
field shape silently feeds the reveal pipeline) — but verify before
committing that the existing twilio/routes and twilio/conversation
tests don't already cover the specific seam.

---

## 2026-05-30T13:09Z — Route-layer integration tests for the AI-backed partner flow

**Context.** Third post-completion run. `BUILD_COMPLETE` valid, GOAL.md
fully checked. Previous run's note explicitly: "no empty commits unless
you've found a real seam to pin down." On audit, I found one.

**Pre-flight.** `git fetch origin main` confirmed `origin/main` already at
`99ef4d6` — the local tracking ref was stale exactly as `ec8141c`
documented. Fast-forwarded local `main` from `ec8141c` → `99ef4d6` (no
push). Then ran `npm ci` + `npx prisma generate` + the full bar:
typecheck/lint/test/build all clean at 322/322.

**The gap.** The AI-seeding directive lives at the **router/handler seam**:

1. `src/twilio/conversation.ts:587-600` — the pure router emits an
   `aiReplyToGenerate` directive when `active.partner.isAiBacked` is true
   and suppresses the relay outbound. Already tested in
   `tests/twilio/conversation.test.ts:55-106`.
2. `src/twilio/routes.ts:339-385` — the HTTP route handler is what
   *consumes* that directive: it calls `aiPersona.generateReply()`,
   persists the response as an INBOUND from the AI user, and pushes a
   relay outbound back to the human. **Zero tests at this layer.**

So the two halves of the AI-backed conversation flow were each unit-tested
in isolation, but nothing exercised them together. The wire format
between them — `AiReplyRequest` shape, which fields the handler actually
uses, the `senderId` attribution choice on the synthesized outbound, the
"no client wired" silent-drop branch, the "client throws" graceful-fail
branch — was free to drift undetected.

**Shipped.** `tests/twilio/routes.test.ts` +3 tests (18 → 21) in a new
`POST /webhooks/twilio/inbound — AI-backed partner integration` describe:

- **Happy path** — human inbound to an AI-backed partner. Asserts:
  (a) persona's `generateReply` called once with `matchId`, `humanUserId`,
  `aiUserId`, `personaPrompt`, and `latestInbound.body` populated from the
  inbound; (b) exactly one Twilio SMS sent, to the human (not the AI —
  Boba never talks to itself); (c) the body is the persona's synthesized
  reply; (d) two INBOUND `Message` rows persisted in order — human's
  original, then AI's reply (so milestone counting sees both); (e) one
  OUTBOUND row, attributed to **`u_ai`**, not `u_human` — because the
  handler passes `fromUserId: req.aiUserId` and the persist path uses
  `fromUserId ?? toUserId`. This is asymmetric with the standard relay
  path (where outbound senderId = originating human) and the test
  documents *why*.
- **AI seeding disabled** — same setup, but `aiPersonaClient: null`.
  Asserts no Twilio calls and exactly one INBOUND row (the human's
  message). Pins the contract that `registerTwilioRoutes` treats
  `undefined` as "build from env" and `null` as "explicitly disabled" —
  the difference between the two is load-bearing for tests and overrides.
- **Persona client throws** — `generateReply` rejects with a 503.
  Asserts: webhook still returns 200 (so Twilio doesn't retry and double-
  persist); no outbound SMS; human's INBOUND row still there. Pins the
  graceful-degradation contract.

**Test-fake change.** Extended the in-memory `dailyMatch.findFirst` to
include `isAiBacked` / `aiPersonaPrompt` on the `userA` / `userB` selects
(defaulting `false` / `null`). Existing 18 tests in this file all still
pass — the defaults match the production `loadActiveMatchForUser` shape.

**Verified.** Fresh `npm ci` + `npx prisma generate`. Then:

- `npm run typecheck` — clean
- `npm run lint` — clean
- `npm test` — **325/325** across 30 files (4.17s), +3 from new tests
- `npm run build` — clean

**Why this isn't make-work.** It locks the contract between the pure
router and the HTTP handler at a seam that's structurally invisible to
isolated unit tests. If anyone tweaks `AiReplyRequest`'s shape, swaps the
senderId attribution on the synthesized outbound, accidentally lets the
"no client" branch propagate the inbound twice, or makes the route return
5xx when the persona throws (which would cause Twilio retries and
duplicate INBOUND rows), this file catches it.

**State.** GOAL.md still fully checked; `BUILD_COMPLETE` still valid.
Human blockers (entity, Twilio + 10DLC, domain, deploy) unchanged in
`USER_TODO.md`. The hourly routine still fires; only the user can disable
it. **Next agent: same advice as before — no empty commits unless you've
found a real seam to pin down.** Candidates I considered and rejected as
not worth the churn: (i) onboarding flow round-trip through the SMS
handler — already well-covered by `tests/onboarding/flow.test.ts` plus
the route-level ONBOARDING cases; (ii) anti-doxxing × milestone unlock
interaction — covered structurally because `route()` evaluates the
stat-fishing gate before the unlock predicate.

---

## 2026-05-27T13:05Z — The "stranding" was a FALSE ALARM. Stop the recovery loop.

**Root cause, finally diagnosed.** The last three runs (`adc0e16`, `da2b85e`,
`566eda6`) each believed they were rescuing "stranded" commits that had never
reached the remote. **They were wrong.** Opened this run on detached HEAD at
`adc0e16` with local `main` / `origin/main` showing `5398d39` — *apparently*
4 commits behind. But `git ls-remote origin main` reported the **live remote
was already at `adc0e16`**. The commits were never stranded — every prior push
landed. What's stale is the container's **`origin/main` remote-tracking ref**,
which is frozen at whatever the remote was when the container was cloned. Each
run misread that stale ref as "the remote is behind," manufactured a recovery
commit, and that fresh commit became the next run's detached tip — re-triggering
the same false alarm. A self-perpetuating loop that has burned ~3 runs of
compute producing PROGRESS-only commits that fixed nothing.

**What this run did.** `git checkout main` → `git merge --ff-only adc0e16`
(clean ff) → **`git fetch origin main`**, which updated the tracking ref and
confirmed `HEAD == main == origin/main == adc0e16`. Validated the tip on a
clean tree: `npm ci`, `npx prisma generate`, `npm run typecheck`, `npm run lint`,
`npm run build`, `npm test` (**303/303** across 29 files) — all green. Then this
log entry, committed **on `main`**, and pushed.

**The procedure that actually works (do this, not the recovery dance):**
1. `git fetch origin main` FIRST — this refreshes the stale tracking ref.
2. `git checkout main && git merge --ff-only <detached-HEAD>` to put the prior
   run's tip onto a real branch.
3. Compare `git rev-parse HEAD main origin/main` AFTER the fetch. If they match,
   **the remote already has everything — exit, do not commit.** The build is
   complete; there is no genuine work left.
4. Only ever `git commit` while `git branch` shows `* main`.

**Blocked on user (unchanged).** All human-only blockers live in `USER_TODO.md`:
LLC, Twilio account + 10DLC registration, domain, production deploy, public
photo hosting for MMS reveals. Plus disabling this hourly routine — `BUILD_COMPLETE`
has stood since `586a4a5`; the user must turn the trigger off (agents can't).

**Next agent.** GOAL.md is fully checked; `BUILD_COMPLETE` is valid and the work
is genuinely on the remote. Run the 4-step procedure above. If the three refs
match after fetching and the tree is clean — **exit without a commit.** Do not
"recover" anything; there is nothing stranded. Do not manufacture work.

---

## 2026-05-27T12:07Z — Re-recovered stranded commits onto main (the trap fired AGAIN)

**Context.** Opened in **detached HEAD** at `da2b85e`, with `main` and
`origin/main` both stuck at `5398d39` — **4 commits behind**. The prior run's
log (`da2b85e`, "recover stranded commits onto main + log run") *claims* it did
`git checkout main` + `git merge --ff-only` + push, but the on-disk refs prove
that never persisted: the recovery commit itself was authored on a detached
HEAD, so `main`/`origin/main` never moved. The exact failure mode that entry
warned about repeated one commit later. Stranded chain:

- `da2b85e` — prior recovery log (PROGRESS-only)
- `cab69d9` — end-of-day FACE reveal as MMS (the product payoff feature)
- `566eda6` — an earlier stranded recovery attempt
- `04a22ef` — cross-module "day in the life" integration test

So the FACE-reveal feature + integration test have **never been on the remote**
despite two prior runs believing they pushed them.

**Shipped.** Verified `main` (5398d39) is a direct ancestor of the tip
(merge-base == main, `main..HEAD` linear, `HEAD..main` empty) → unambiguous
fast-forward. Validated the tip on a clean tree first: fresh `npm ci`,
`npx prisma generate`, `npm run typecheck`, `npm run lint`, `npm run build`,
`npm test` (**303/303** across 29 files) — all green. Then **`git checkout main`
(now on a real branch, not detached)**, `git merge --ff-only da2b85e` (clean
ff, no merge commit), wrote this log, committed on `main`, and pushed
`origin/main`. The FACE reveal + integration test are now actually published.

**Nothing tried that failed.** The ff was unambiguous.

**Why this keeps happening / how to actually stop it.** Each session starts on
detached HEAD at the previous run's tip. If you `git commit` before
`git checkout main`, the new commit attaches to the detached HEAD and `main`
never advances; `git push origin main` then pushes the stale `main` ref and the
work strands. **The fix is procedural and non-negotiable: the FIRST git action
every run must be `git checkout main` (then `git merge --ff-only <old HEAD>` if
HEAD was ahead). Only commit once `git branch` shows `* main`.** Verify with
`git rev-parse HEAD main origin/main` — all three must match before you exit.

**Blocked on user.** Unchanged: human-only blockers in `USER_TODO.md` (LLC,
Twilio account + 10DLC registration, domain, production deploy, public photo
hosting for MMS reveals) and disabling this hourly routine (`BUILD_COMPLETE`).

**Next agent.** GOAL.md is fully checked; `BUILD_COMPLETE` stands. The build
work is done. **Before anything else, run `git rev-parse HEAD main origin/main`
— if they don't all match, a prior run re-stranded; recover via ff-only as
above BEFORE any other action, and commit only while on `main`.** If all three
match and the tree is clean, exit without an empty commit — don't manufacture
work.

---

## 2026-05-26T12:05Z — Recover stranded commits onto main + push (git hygiene)

**Context.** Session started in **detached HEAD** at `cab69d9`, which sat
**3 commits ahead** of `main` and `origin/main` (both at `5398d39`). The three
stranded commits were real, validated work that had never reached the remote:

- `04a22ef` — cross-module "day in the life" integration test
- `566eda6` — a *prior* recovery attempt that itself got stranded (it committed
  the recovery while still on detached HEAD — the exact trap repeating)
- `cab69d9` — the end-of-day FACE reveal MMS feature

So the FACE-reveal payoff feature and the integration test existed only in the
container's local git, invisible on GitHub. This is the recurring failure mode
in this repo: agents commit while on detached HEAD, so `git push origin main`
pushes the stale `main` ref and the new work is left behind.

**Shipped.** Validated the stranded tip on a clean tree before touching refs —
fresh `npm ci` (321 pkgs), `npx prisma generate`, `npm run typecheck`,
`npm run lint`, `npm test` (**303/303** across 29 files), `npm run build` —
all green. Then `git checkout main` + `git merge --ff-only cab69d9` (clean
fast-forward, no merge commit, no divergence) and pushed `origin/main`. The
FACE reveal + integration test are now actually on the remote.

**Nothing tried that failed.** The fast-forward was unambiguous (merge-base ==
old `main`, zero commits on `main` absent from HEAD).

**Blocked on user.** Unchanged — the human blockers in `USER_TODO.md` (legal
entity, Twilio account + 10DLC registration, domain, production deploy) and
disabling this hourly routine (see `BUILD_COMPLETE`). None are agent-doable.

**Next agent.** GOAL.md is fully checked and `BUILD_COMPLETE` is valid. The
build work is done. **Critical procedural note: always `git checkout main`
before committing** — do not commit on detached HEAD, or the work strands again
exactly as it did here. If you find no *genuine* gap, exit without an empty
commit. First, confirm `origin/main` == local `main`; if a previous run left
the repo detached/ahead again, recover it the same way (ff-only) before
anything else.

## 2026-05-26T11:10Z — End-of-day FACE reveal delivery (the missing payoff)

**Context.** `BUILD_COMPLETE` present, GOAL.md fully checked, full gate green
on a fresh `npm ci` (typecheck / lint / build / 297 tests). Per the routine I
should not add make-work — so instead of a no-op log I audited for a *genuine*
gap and found one that's core to the product, not cosmetic.

**The gap.** The PRD's entire premise is "conversation before appearance",
with **the face revealed at end of day**. `recordDecisionAndMaybeResolve`
(`src/decisions/prisma-deps.ts:108`) writes the FACE `MilestoneProgress` row
on a `continue` outcome — but **nothing ever delivered the actual photo**. The
decision handler in `src/twilio/routes.ts` only sent the text announcement
("🎉 You're both in…"), and the Twilio client (`src/twilio/client.ts`) had no
MMS/media support at all (`sendSms` only ever set `To`/`Body`). So the climax
of the whole app — putting a face to the conversation — was a recorded DB row
that no user ever saw.

**Shipped.**
- `src/twilio/client.ts`: `SendSmsInput` gains optional `mediaUrl`; when set we
  add the `MediaUrl` form param (Twilio upgrades the message to MMS and fetches
  the URL itself). Dry-run logs the media URL; plain SMS unchanged.
- `src/twilio/conversation.ts`: `OutboundAction` gains an optional `mediaUrl`
  and a new `"face_reveal"` kind. (The router stays pure — it can't know the
  resolution outcome, which requires a DB write.)
- `src/decisions/flow.ts`: added `faceRevealWithPhoto` / `faceRevealNoPhoto`
  copy + exported `faceRevealBody(hasPhoto)`. Re-exported from the barrel.
- `src/twilio/routes.ts`: after `recordDecisionAndMaybeResolve` resolves to
  `continue`, build two `face_reveal` outbounds via `buildFaceRevealOutbounds`
  — **each user receives the OTHER person's `stats.photoUrl` as MMS**. New
  `loadPhotoUrlFor` helper. The send loop now passes `action.mediaUrl` through
  to `sendSms`. No-photo users fall back to a text-only reveal (no media).
- Reveals go through the existing opt-out guard (not compliance replies), so an
  opted-out recipient still gets nothing.

**Tests (+6, 297 → 303, all green).**
- `tests/twilio/client.test.ts` (new, 3): `MediaUrl` is set when `mediaUrl`
  passed; omitted for plain SMS; dry-run short-circuits MMS without calling
  fetch.
- `tests/twilio/routes.test.ts` (+2): KEEP that resolves to `continue` sends
  exactly two MMS reveals with the partner's photo crossed over correctly, the
  FACE milestone is recorded, and the match flips to CONTINUED with a new row
  for tomorrow; no-photo match falls back to the text-only reveal with no media
  while the photo'd side still gets their MMS.
- `tests/decisions/flow.test.ts` (+1): `faceRevealBody` switches on photo
  presence.

**Verified.** `npm run typecheck`, `npm run lint`, `npm run build`,
`npm test` (**303/303**) all clean.

**Blocked on user (documented in USER_TODO.md, new hard-blocker bullet).**
Onboarding currently stores the *raw Twilio inbound* media URL in
`stats.photoUrl` (`src/onboarding/flow.ts:71`). That URL needs account auth to
fetch and is subject to Twilio's media-retention purge, so re-sending it as an
outbound `MediaUrl` is unreliable. Before launch the user must copy uploaded
photos to public object storage (S3 / R2 / Cloudinary) during onboarding and
store the public URL instead. The relay already passes `stats.photoUrl`
straight through, so **no further code change is needed** once storage is wired
— it's an infra/credentials task only.

**Next agent.** GOAL.md is again fully checked and `BUILD_COMPLETE` stands. If
you can't find a genuine, product-meaningful gap like this one, exit without an
empty commit — don't manufacture work. Remaining items are all human blockers
(LLC, Twilio + 10DLC, domain, deploy, photo hosting) in USER_TODO.md.

## 2026-05-25T13:05Z — Recovered stranded integration-test commit onto main

**The real bug this run.** The session opened on a **detached HEAD** at
`04a22ef` ("test: cross-module day in the life integration test"). Both `main`
and `origin/main` were one commit behind at `5398d39` — meaning the prior run
committed that integration test but never fast-forwarded `main` and never
pushed it. The work (`tests/integration/dayInLife.test.ts`, +4 tests) existed
only as a dangling commit that the next container reclamation would have
garbage-collected. Net: real, verified work was at risk of being lost.

**Shipped.** Verified the stranded commit is healthy, then fast-forwarded
`main` (`5398d39..04a22ef`, clean ff — `main` was its direct parent) and pushed
so `origin/main` finally contains the integration test.

**Verified on the recovered commit (fresh `npm ci` + `prisma generate`):**
- `npm run typecheck` — clean
- `npm run lint` — clean
- `npm test` — **297/297 passing** across 28 test files
- `npm run build` — clean

**State.** GOAL.md still fully checked; `BUILD_COMPLETE` still valid and now
actually reflects what's on the remote. The only outstanding items are the
human blockers in `USER_TODO.md` (legal entity, Twilio + 10DLC, domain,
deploy) and disabling this hourly routine.

**Next agent.** No remaining agent-doable build work. Before assuming a no-op,
always check `git status` / `git rev-parse HEAD main origin/main` — this run
existed precisely because a prior "done" run left a commit unmerged and
unpushed. If HEAD == main == origin/main and the tree is clean, exit without
an empty commit.

---

## 2026-05-21T00:00Z — No-op run (build still complete)

`BUILD_COMPLETE` has been present since 586a4a5; GOAL.md's checklist is fully
checked off (13 main items + 9 launch-ready items). The hourly routine is
still firing because the user hasn't disabled it. Per the stop-condition I'm
exiting without changes.

No verification re-run this hour — the prior run (2026-05-20T10:10Z) did a
full `npm ci && typecheck && lint && test && build` on a clean clone and
everything was green (293/293 tests). Nothing has been committed since, so
the state is identical.

**Action for the user:** disable the Boba hourly builder routine. Every run
from here on is paid compute that produces no work.

**For the next agent:** if you see this, just exit. Do not make a no-op
commit — the log entries themselves are starting to pile up.

---

## 2026-05-21T08:08Z — No-op run (BUILD_COMPLETE)

Verified stop condition still holds:

- `BUILD_COMPLETE` present.
- GOAL.md: 23 items checked, 0 unchecked.
- Working tree clean.
- Last code change: 2026-05-20T10:12Z (yesterday's no-op verification run);
  no source files have changed since the full quality gate passed
  (293/293 tests, clean typecheck/lint/build on a fresh `npm ci`).

Noted+fixed: on entering this run, local `main` was sitting at the initial
empty commit while all 19 commits of real work lived on a detached HEAD
that prior runs had been operating from. Fast-forwarded `main` to `7048c2d`
so the branch now actually tracks the work. Pushing this run's commit to
`origin/main` will publish all 19 prior commits in one go — previous
agents' pushes from a detached HEAD evidently never reached the remote.

No code touched. Hourly routine still firing — human action to disable it
(see `BUILD_COMPLETE`) remains outstanding and can't be done from inside
the session. Next agent run: exit immediately.

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

---

## 2026-05-17T19:38Z — Daily-match scheduler

**Shipped**
- `src/scheduler/runDailyMatch.ts` — one-shot runner that loads context, picks pairs, persists, and notifies both users via SMS. Returns `{candidates, selected, createdMatchIds, notified, notifyErrors}`. Re-runnable safely (matchedToday dedupe is handled by the existing selector).
- `src/scheduler/cron.ts` — `node-cron` wrapper. Validates expression, exposes `triggerNow()` for the admin endpoint, swallows runner errors so a single failed tick doesn't crash the loop.
- `src/app.ts` — boots the scheduler when `SCHEDULER_ENABLED=true` and always decorates `app.runDailyMatch` so the admin endpoint can fire it on demand. Auto-stops on `onClose`.
- Added `node-cron` dependency.
- `DEFAULT_NEW_MATCH_NOTIFICATION`: "Your match for today is here 🧋…"

**Tests**
- `tests/scheduler/runDailyMatch.test.ts`: zero-candidates, a normal pairing with both-side notification, partial notify failure, custom body.
- `tests/scheduler/cron.test.ts`: invalid expression rejected, triggerNow works, stop is safe.

**Verified**
- Typecheck, test (237/237), build, lint clean.

**Next agent: pick this up**
- Admin endpoints (`/admin/users`, `/admin/match/:id`, `/admin/users/:id/ban`, `/admin/run-daily-match`) gated by `ADMIN_TOKEN`.

---

## 2026-05-17T19:40Z — Admin endpoints

**Shipped**
- `src/admin/auth.ts` — `makeAdminAuth({expected})` Fastify preHandler. Constant-time compare; 503 when ADMIN_TOKEN empty (admin off), 401 on missing/wrong header, pass-through on match.
- `src/admin/prisma-deps.ts` — `listUsers` (paginated cursor + status filter), `getConversation` (match + messages with flag fields), `banUser` / `unbanUser` (returns before/after status).
- `src/admin/routes.ts` registers under `/admin/*`:
  - `GET /admin/users?limit=&cursor=&status=`
  - `GET /admin/match/:id`
  - `POST /admin/users/:id/ban`
  - `POST /admin/users/:id/unban`
  - `POST /admin/run-daily-match` → calls `app.runDailyMatch()`
  - `POST /admin/invites/bulk` → `{count, label?}` body, returns codes + remaining-unredeemed count
- `src/app.ts` wires it in after scheduler decoration so the trigger endpoint has access.

**Tests**
- `tests/admin/auth.test.ts` (5): empty-token / missing-header / wrong-token / correct-token / length-mismatch paths.
- `tests/admin/routes.test.ts` (9): full happy paths + 404s + the bulk-invite endpoint + run-daily-match wiring.

**Verified**
- typecheck, test (251/251), build, lint all clean.

**Next agent: pick this up**
- Deploy configs (Dockerfile, render.yaml, fly.toml, /readyz endpoint), GitHub Actions CI, Sentry hooks, DEPLOY.md.

---

## 2026-05-17T19:44Z — Deploy configs + CI + Sentry + /readyz + DEPLOY.md

**Shipped**
- `/readyz` endpoint (Postgres ping, 503 on failure) alongside existing `/health`. Test override `BuildAppOptions.health.pingDb` so suites don't need a real DB.
- `src/observability/sentry.ts`: idempotent `initSentry({env})` (no-op when `SENTRY_DSN` empty). `attachFastifySentry(app)` forwards onError to `captureException` with route tags.
- `src/server.ts` initializes Sentry before `buildApp`.
- `Dockerfile`: 3-stage Node 22 build (deps → build → slim runtime). Drops privileges to uid 10001. `CMD` runs `prisma migrate deploy && node dist/server.js`.
- `.dockerignore`: excludes node_modules / tests / progress docs.
- `render.yaml`: blueprint with managed Postgres + web service, generates `ADMIN_TOKEN`, `sync: false` markers for human-supplied secrets.
- `fly.toml`: Fly app config with `/health` + `/readyz` checks, `release_command = prisma migrate deploy`, single shared-cpu VM.
- `.github/workflows/ci.yml`: typecheck + lint + test + build + Docker build (load only, no push). Runs on PR and push to main.
- `DEPLOY.md`: full human walkthrough — entity formation, Twilio + 10DLC, hosting choice, DNS, secrets matrix, webhook wiring, seed/smoke, monitoring, troubleshooting.
- `USER_TODO.md`: rewritten as a launch punch list (hard blockers + optional + "already done by the agent").
- Added `@sentry/node` dependency.

**Tests**
- `tests/observability/sentry.test.ts` (3): no-op without DSN, init with DSN+sample rate, idempotent.
- `tests/health.test.ts`: extended with `/readyz` ready + 503 paths.

**Verified**
- typecheck, test (256/256), build, lint all clean.

**Done.** All 8 phase-2 launch items are checked off. `USER_TODO.md` is the only thing left for the human.

---

## 2026-05-18T08:25Z — SMS carrier compliance (STOP / HELP / START)

**Why this wasn't `BUILD_COMPLETE` yet**
- A prior agent set `BUILD_COMPLETE` after the 13-item main list, then phase-2
  expanded the checklist; the marker was never re-written. More importantly,
  there was a real launch-blocking gap: **CTIA / 10DLC requires every A2P SMS
  program to honor STOP, HELP, and START.** Without it US carriers reject the
  campaign (or silently filter the traffic) and Twilio's 10DLC submission
  itself asks you to file sample STOP/HELP replies. That was load-bearing for
  the "launch-ready" claim and now it's done.

**Shipped**
- `src/safety/smsKeywords.ts` (pure):
  - `detectSmsKeyword(body)` — recognises STOP / STOPALL / UNSUBSCRIBE /
    CANCEL / END / QUIT / OPTOUT / OPT-OUT; HELP / INFO; START / UNSTOP / YES.
    First-token-only matching with tolerant trailing-punctuation (`STOP.`,
    `stop!`, etc.). Returns `{keyword, token}`.
  - `STOP_ACK`, `HELP_REPLY`, `START_ACK` — compliance reply copy. `HELP_REPLY`
    bakes in "Msg & data rates may apply", program name, opt-out instructions
    + a support-email placeholder.
- Schema: new `User.smsOptedOut Boolean @default(false)` + `smsOptedOutAt
  DateTime?` columns; `@@index([smsOptedOut])`; migration committed at
  `prisma/migrations/20260518080000_sms_opt_out/migration.sql`.
- `RouterUser` gains a `smsOptedOut: boolean` field.
- New `OutboundAction.kind` values: `sms_stop_ack | sms_help_reply |
  sms_start_ack`.
- New `RouteResult.smsOptOutChange: { userId, optedOut, keyword } | null`
  directive.
- `src/twilio/conversation.ts`:
  - Compliance keywords are evaluated **before** every other path — including
    BANNED, PAUSED, ONBOARDING, and unknown-sender. STOP from a banned user
    still confirms (legal requirement); HELP from a stranger still gets the
    program-info reply.
  - Already-opted-out senders texting non-keyword bodies are dropped silently
    (no relay, no persist, no system reply).
  - Refactored the 7 sites that previously hand-built `RouteResult` literals
    into `{ ...emptyResult(), <overrides> }` so the new field can never be
    accidentally omitted.
- `src/twilio/prisma-deps.ts`:
  - `findUserByPhone` selects `smsOptedOut`.
  - `applySmsOptOutChange(prisma, userId, optedOut)` — sets the flag +
    timestamp (or clears both on opt-in).
  - `isSmsOptedOut(prisma, userId)` — narrow read for the send-loop guard.
- `src/twilio/routes.ts`:
  - Applies the `smsOptOutChange` directive BEFORE sending the ack so any
    racing read sees the new value.
  - Auto-provision step now skips account creation when the inbound is a
    STOP or HELP from an unknown phone — wrong-number STOPs no longer
    pollute the user table.
  - Outbound send loop: belt-and-brace guard that skips any non-compliance
    outbound when the recipient is opted out. The three compliance acks
    themselves are always sent (STOP_ACK is sent to a user we *just*
    marked as opted-out — a single confirmation is allowed and required).
- `src/matching/prisma-deps.ts`: `loadSelectorContext` now filters
  `smsOptedOut: false` so the scheduler can't pick an opted-out user as a
  match candidate.
- `USER_TODO.md`: new bullets explaining the A2P sample-message filing +
  the "Advanced Opt-Out" Twilio toggle interaction.

**Tests**
- `tests/safety/smsKeywords.test.ts` (22 cases): every STOP token, casing,
  trailing-punct, first-token-only rule, every HELP token, every START
  token, normal-conversation bodies are NOT keywords, compliance-copy
  invariants.
- `tests/twilio/conversation.test.ts` (11 new cases): STOP from ACTIVE,
  STOP overrides an active match (no relay/persist), STOP from ONBOARDING,
  STOP from BANNED still acks, STOP from unknown sender (ack but no
  directive), HELP variants, START opt-in flow, opted-out user texting
  random text is dropped, START from opted-out user works, compliance
  keyword beats REPORT/decision parsing.
- `tests/twilio/routes.test.ts` (4 new cases): STOP flips `smsOptedOut`
  via Prisma + only the compliance ack is sent; a match relay where the
  partner has opted out delivers ZERO outbounds; HELP from an unknown
  number doesn't auto-provision; START from an opted-out user re-enables
  sending.

**Verified**
- `npm run typecheck`, `npm test` (293/293), `npm run build`, `npm run lint`
  all clean. +37 tests overall.

**Done — really this time.** GOAL.md is fully checked off. `BUILD_COMPLETE`
written. The next agent run can exit immediately.

---

## 2026-05-20T10:10Z — No-op verification run

`BUILD_COMPLETE` is present and GOAL.md checklist is fully checked off. Per
the routine's stop-condition I'm exiting without making any code changes,
but I re-ran the full quality gate on a clean clone to confirm the repo is
still buildable:

- `npm ci` — 321 packages installed clean
- `npx prisma generate` — Prisma Client v5.22.0 generated
- `npm run typecheck` — clean
- `npm run lint` — clean
- `npm test` — **293/293 passing** across 27 test files (4.04s)
- `npm run build` — clean

Nothing regressed. The hourly routine is still firing; the human action
to disable it (see `BUILD_COMPLETE`) is still outstanding but is not
something an agent run can do from inside the session. No further work
for the next agent — exit immediately.

---

## 2026-05-25T12:21Z — Cross-module "day in the life" integration test

**Context.** `BUILD_COMPLETE` is present and every GOAL.md checklist item was
already checked. Recent runs were no-op log entries, and the last commit asked
future agents to skip the empty commit. Rather than add more noise, I audited
the codebase for a *genuine* gap. Found one: the per-module unit tests all
build their fixtures by hand and exercise one transition at a time. Nothing
replayed the actual IO-layer accumulation loop (`src/twilio/routes.ts`:
route → persist inbound → fold milestones back in → repeat), so the
*composition* contract between the router, depth scorer, unlock ladder, and
decision resolver was untested end-to-end.

**Shipped.** `tests/integration/dayInLife.test.ts` (4 tests):
- A `makeSimulator()` that drives the production inbound loop in-memory:
  each `send()` builds `RouterActiveMatch` from accumulated state, calls the
  pure `route()`, then applies `persistInbound` + `milestonesToRecord` back
  into the running message log / unlocked set — exactly what the real handler
  does.
- Test 1 runs 52 alternating turns of a long, benign, question-bearing
  message (verified to trip neither the stat-fishing nor harassment probes,
  so depth stays > 0.5). Asserts: exactly one relay per turn to the correct
  partner; the milestone ladder fires **in strict order** AGE→PROFESSION→HEIGHT
  and **at the documented thresholds** (turns 10 / 25 / 50 = 10 / 25 / 50 total
  messages from `DEFAULT_UNLOCK_THRESHOLDS`); each unlock fans a reveal to both
  sides; no FACE (it's end-of-day, not depth-driven).
- Tests 2–4 cover the decision seam: a `KEEP` keyword short-circuits relay
  (no `persistInbound`, just `decision_ack` + `decisionToRecord`); KEEP+KEEP
  → `resolve()` → `continue`; KEEP+DISCARD → `ended_by_discard` — wiring the
  router's keyword parse into `src/decisions/flow.ts`'s resolver + copy.

**Verified.** `npm run typecheck`, `npm run lint`, `npm test`
(**297/297**, +4), `npm run build` — all clean on a fresh `npm ci` +
`prisma generate`.

**Why this isn't make-work.** It's net-new coverage of the integration seam
that isolated unit tests structurally cannot reach, and it pins the milestone
thresholds to concrete turn numbers so any future tuning of
`DEFAULT_UNLOCK_THRESHOLDS` that breaks the ladder ordering will fail loudly.

**State.** GOAL.md still fully checked; `BUILD_COMPLETE` still valid. The only
outstanding items are the human blockers in `USER_TODO.md` (entity, Twilio +
10DLC, domain, deploy) and disabling this hourly routine. Next agent: there is
no remaining agent-doable build work — if you can't find a *genuine* gap like
this one, exit without an empty commit.

---

## 2026-05-30T12:08Z — Contract test pinning the rematch-eligibility predicates

**Context.** `BUILD_COMPLETE` present, GOAL.md fully checked, every prior
checklist item shipped. The previous run's note was explicit: skip the empty
commit unless there's a *genuine* gap. On audit I found one.

**The gap.** The rematch-eligibility rule lives in two places:

1. `src/matching/selector.ts:96-104` — inline `pairEligibleByHistory`, the
   actual production gate inside `selectDailyMatches`.
2. `src/rematch/index.ts:55-77` — standalone `isEligibleForRematch`, the
   public predicate that `src/rematch/index.ts:1-18` advertises as the
   "first-class side-effect-free" version "for future UIs".

Both are unit-tested in isolation but nothing pinned them in *agreement*. The
rematch module's own docstring flags the duplication, so the drift risk was
known — a future tweak to one without the other would silently disagree, and
the admin UI / debug tooling that's supposed to read from
`isEligibleForRematch` could tell users "you'll see them in 0 days" while the
selector still blocks the pair (or vice versa).

**Shipped.** `tests/rematch/contract.test.ts` (19 tests):

- A two-candidate fixture (MAN/WOMAN, strongly compatible — same
  typeDescriptor, age + height in range) so the *only* thing that can knock
  the pair out is the history gate.
- A sanity test that the fixture itself passes with no history (otherwise the
  rest of the file would be vacuous).
- A parametric matrix over `lastMatchedOn ∈ {-30, -15, -14, -13, -1, 0, +1}
  days from today` × `hasDiscard ∈ {false, true}` — exercises both sides of
  the default 14-day boundary, the boundary day itself, and the "future
  timestamp" edge.
- Cooldown override cases (`rematchCooldownDays=2` relaxing in, `=60`
  tightening out) — proves config flows through both paths.
- The permanent-discard case at 30d ago — confirms `hasDiscard` blocks
  regardless of how long ago.

For each state the test computes the selector's verdict (does
`selectDailyMatches` return the pair?) and the predicate's verdict
(`isEligibleForRematch(...).eligible`) and asserts they agree.

**Verified.** Fresh `npm ci` + `npx prisma generate`, then:

- `npm run typecheck` — clean
- `npm run lint` — clean
- `npm test` — **322/322** across 30 files (4.28s), +19 from the new file
- `npm run build` — clean

**Why this isn't make-work.** It locks a known-duplicated invariant the code
itself flags. If anyone tunes one of the predicates (e.g. changes the
hasDiscard semantics, swaps `>=` for `>` on the cooldown boundary, adds a
new short-circuit) without touching the other, this file fails loudly
instead of silently shipping inconsistent answers to different callers.

**State.** GOAL.md still fully checked; `BUILD_COMPLETE` still valid. No
agent-doable work I can find remains. Human blockers (entity, Twilio +
10DLC, domain, deploy) still in `USER_TODO.md`. The hourly routine still
fires; only the human can disable it. Next agent: same advice as before —
no empty commits unless you've found a real seam to pin down.

---

## 2026-05-31T13:08Z — Contract test pinning `loadSelectorContext` query + mapping

**Context.** `BUILD_COMPLETE` present, GOAL.md fully checked. Prior two
runs found genuine seams to pin (rematch predicates agreeing, AI-backed
route-layer integration). Same brief: skip empty commits, find a real gap.

**The gap.** `loadSelectorContext` (src/matching/prisma-deps.ts:28-84)
turns three Prisma reads (candidates, matchedTodayPairs, pairHistory) into
the `SelectorContext` the pure selector consumes. Three invariants live
there with zero direct coverage:

1. **`smsOptedOut: false` in the candidate filter.** This is the only place
   that enforces the 10DLC carrier-compliance rule that opted-out users
   must not be considered for new matches. The flag was added later
   (migration `20260518080000_sms_opt_out`) and the inbound webhook layer
   has its own enforcement (tests/twilio/routes.test.ts), but nothing pinned
   *the selector's* gate. The `runDailyMatch` test (scheduler) uses a fake
   DB whose `user.findMany` ignores the filter — so silently dropping the
   `smsOptedOut: false` clause would let every existing test still pass
   while shipping a compliance regression.

2. **`status: ACTIVE` + non-null `preferences`/`stats` in the same filter.**
   Same risk profile: dropping any of these would let ONBOARDING / PAUSED
   / BANNED users (or users mid-onboarding with no profile rows yet) leak
   into match selection.

3. **Canonical pairKey on read.** `persistDailyMatches` writes via
   `orderPair` so rows are canonical, but the read side (this function)
   *also* applies `pairKey` for both `matchedTodayPairs` and `pairHistory`.
   If the read-side canonicalization were dropped, repeat-match protection
   and rematch cooldowns would silently misfire on any pair whose stored
   order disagreed with the lookup order. Plus the UTC-date normalization
   on `today` (for `dailyMatch.where.matchDate`) and `toDateKey` on
   `lastMatchedAt` were both unpinned.

**Shipped.** `tests/matching/loadSelectorContext.test.ts` (15 tests across
5 describe blocks):

- **Candidate filter (3 tests):** pins the exact `where` shape
  `{ status: ACTIVE, smsOptedOut: false, preferences: { isNot: null },
  stats: { isNot: null } }`; explicitly asserts `smsOptedOut === false`
  (not just defined) so a refactor to `smsOptedOut: true` or `undefined`
  fails loudly; pins the `include: { preferences: true, stats: true }`.
- **Candidate mapping (4 tests):** verbatim field-by-field mapping of
  every preference + stat field; `isAiBacked=true` propagation (the AI
  seeding flag); defensive null-skip guard at line 44 (belt-and-braces in
  case the include is weakened); stable input order (the selector's
  tiebreak depends on it).
- **matchedTodayPairs (4 tests):** UTC-midnight normalization at the day
  boundary (input `23:59:59.999Z` → query `00:00:00.000Z` of same date);
  idempotent normalization at midnight; canonical-pairKey lookup
  symmetric in both orderings (covering writer/reader canonicalization
  drift); empty case returns a Set, not undefined.
- **pairHistory (3 tests):** field mapping into `PairHistoryEntry`
  (lastMatchedOn / hasDiscard / matchCount); UTC-date bucketing of a
  non-midnight `lastMatchedAt` (no roll-forward/roll-back); empty case
  returns a Map.
- **Full assembly (1 test):** all three reads run exactly once (no N+1),
  all three context keys populated together.

**Verified.** Fresh `npm ci` + `npx prisma generate`, then:

- `npm run typecheck` — clean
- `npm run lint` — clean
- `npm test` — **340/340** across 31 files (+15 from the new file)
- `npm run build` — clean

**Why this isn't make-work.** It pins a 10DLC compliance gate that lives
in one SQL clause and is structurally invisible to every other test in
the suite. If a future refactor of `loadSelectorContext` drops or weakens
the `smsOptedOut: false` filter — or quietly de-canonicalizes the
pairKey lookups — every other test still passes; this file is what
catches it.

**State.** GOAL.md still fully checked; `BUILD_COMPLETE` still valid. Human
blockers (entity, Twilio + 10DLC, domain, deploy) still in `USER_TODO.md`.
The hourly routine still fires; only the human can disable it. Note for
next agent: the container's local `origin/main` ref is frozen at clone time
and reads as "behind" — run `git ls-remote origin main` to see the live
remote head before manufacturing a "recovery" commit. The prior diagnosis
in commit `ec8141c` covers this.

---

## 2026-06-04T02:07Z — Contract test pinning `persistOnboardingUpdates`

**Context.** `BUILD_COMPLETE` present, GOAL.md fully checked, container's
local `main` started behind `origin/main` (fast-forwarded `ec8141c..6944ad0`,
no merge). The recent three commits on origin were all empty "no-op
verification" runs and prior agents explicitly asked future runs to skip
those unless a real seam was found. Looked for one.

**The gap.** `persistOnboardingUpdates` (src/onboarding/prisma-deps.ts:18-55)
is the only path that writes the User/Stats/Preferences rows during
onboarding. Every inbound that advances the state machine in
`src/twilio/routes.ts` lines 251 + 260 lands here. But:

- `tests/onboarding/flow.test.ts` covers only the pure `advance`
  function and `mergeUpdates` — never touches the adapter.
- `tests/twilio/routes.test.ts`'s fake DB has `stats.upsert` as a no-op
  that *cherry-picks* `age`/`profession`/`heightCm` into the test view
  (lines 115-130) and `preferences.upsert` as `async () => ({})`
  (line 132-134). Whatever the adapter actually passes to those methods
  is invisible to the route suite.

Five invariants lived unpinned:

1. `markActive: true` overrides `nextStep` — the source assigns
   `userPatch.onboardingStep = nextStep` first then overwrites it to
   `null`. Swap the order or drop the second assignment and the cursor
   would point at "done" forever instead of clearing.
2. Empty `updates.stats` / `updates.preferences` objects (`{}`) must
   skip the upsert entirely. This is the only guard against a `{}`
   payload, which Prisma would reject at runtime since the schema's
   create payload requires non-null fields beyond `userId`.
3. `userId` belongs only in `create`, never in `update`. Sneaking it
   into `update` would tickle Prisma's "cannot change unique" rejection.
4. The runtime check on `displayName`/`campusEmailDomain` is
   `!== undefined`, NOT truthiness. An explicit `""` from a future
   parser change should land in the DB, not be silently dropped.
5. Call order is `user.update` → `stats.upsert` → `preferences.upsert`.
   A `user.update` failure must short-circuit before stats / preferences
   are touched (so a transient DB issue can't half-write).

**Shipped.** `tests/onboarding/persist.test.ts` — 26 tests across 6
describe blocks:

- **Base cursor advance (2):** the minimal `{ onboardingStep: nextStep }`
  payload + verbatim nextStep pass-through.
- **`markActive` terminal write (3):** clears the cursor + sets ACTIVE
  even when nextStep is "done", clears it regardless of nextStep value
  (so a future caller that passes a real step + markActive can't desync),
  merges user fields into the terminal write.
- **User field projection (5):** displayName, both fields together,
  empty `updates.user` omits keys, missing `updates.user` is equivalent
  to empty, empty-string displayName lands in DB (the `!== undefined`
  guard — pins the contract that the adapter doesn't second-guess the
  parser).
- **Stats upsert (5):** canonical create+update shape, `userId` excluded
  from update, skip on missing, skip on empty `{}`, photoUrl forwarding.
- **Preferences upsert (5):** mirror of stats — same five invariants for
  the preferences write, including the array-valued `preferredGenders`.
- **Composition & call order (6):** all-three call order is
  user→stats→preferences; cursor-only writes only `user.update`; partial
  inputs skip the right slot; `user.update` failure short-circuits stats
  + preferences; `stats.upsert` failure short-circuits preferences but
  not user; idempotent call-shape under repeated invocation.

**Verified.**

- `npm run typecheck` — clean
- `npm run lint` — clean
- `npm test` — **414/414** across 34 files (4.75s), +26 from the new file
- `npm run build` — clean

**Why this isn't make-work.** The routes integration suite uses a fake
DB that ignores the upsert arguments entirely — so a refactor that
drops the `Object.keys(...).length > 0` guard (causing `{}` upserts in
prod), swaps the `markActive` write order (so the cursor sticks at
"done"), or moves `userId` into the update branch would pass every
existing test. This file is what catches it.

**State.** GOAL.md still fully checked; `BUILD_COMPLETE` still valid.
Human blockers (entity, Twilio + 10DLC, domain, deploy) still in
`USER_TODO.md`. The hourly routine still fires; only the human can
disable it. Next agent: same standing advice — no empty commits, hunt
for a real seam. Reminder from prior runs: the container's local
`origin/main` reads as "up to date" even when the remote has moved
since clone (see `ec8141c`). Always `git fetch origin main` before
trusting tracking refs.
