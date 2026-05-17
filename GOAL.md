# Boba — Goal & Roadmap

Boba is a dating app built around conversation before appearance. Anti-swipe, anti-superficial, pro-conversation. One match per day relayed through iMessage.

## Stack (decided)
- **Language:** TypeScript (strict mode)
- **Runtime:** Node.js 22+
- **Server:** Fastify
- **Database:** PostgreSQL via Prisma ORM
- **SMS relay:** Twilio (credentials supplied later by user)
- **Tests:** Vitest
- **Local dev:** docker-compose for Postgres

## Core mechanics (PRD digest)
- Onboarding collects user prefs + own stats (age, profession, height, photos).
- System matches on "type" fit. Neither party sees the other's stats initially.
- One match per day. No swiping, no browsing.
- **Progressive milestone reveals** triggered by message count + depth signals: age → profession → height → (extensible slots) → face (revealed at end of day).
- **End-of-day decision:** Keep / Maybe / Discard. Any Discard ends it; Keep+Keep, Keep+Maybe, Maybe+Maybe → continue tomorrow.
- **Rematching:** previous matches may resurface later.
- **UI:** iMessage. Users text one phone number; backend relays between matched pairs.

## Target market
- Phase 1: one university campus (density).
- Phase 2: other universities.

## Open design questions (default sensibly, document, don't block)
- Anti-doxxing: friction layer to prevent identification before reveal.
- Early exit valve mid-day if no chemistry.
- Moderation: harassment / inappropriate content / catfishing.
- AI seeding for cold-start (build the hooks; don't enable by default).
- Retention loop.

## Launch-ready checklist (phase 2)
- [x] Invite-code system (schema + redemption flow)
- [x] Daily-match scheduler (cron + admin trigger)
- [x] MMS photo upload during onboarding
- [x] Admin endpoints (list / view / ban / run-match / bulk invites)
- [x] Deploy configs (Dockerfile, render.yaml, fly.toml, /readyz)
- [x] GitHub Actions CI
- [x] Sentry hooks
- [x] DEPLOY.md + refreshed USER_TODO.md

## Build checklist

- [x] Scaffold the repo: TypeScript + Node + Fastify + Prisma, folder structure, README, package.json, tsconfig, lint, gitignore, vitest, docker-compose
- [x] Data model: users, preferences, stats, daily_matches, messages, milestone_progress, end_of_day_decisions, rematch_history. Prisma schema + initial migration.
- [x] Matching algorithm v1: type-fit scoring, daily match selection, no-repeats (except rematch logic), basic compatibility scoring
- [x] Milestone system: message-count + simple depth signals (length, question ratio) → unlock thresholds for age/profession/height/face
- [x] iMessage relay layer (Twilio webhook handlers — full inbound/outbound routing logic, signature verification, conversation state machine; credentials stubbed)
- [x] Onboarding state machine driven by SMS
- [x] End-of-day Keep/Maybe/Discard flow + resolution logic
- [x] Rematch eligibility logic
- [x] Anti-doxxing: content filter for stat-fishing questions (name/school/instagram/photo asks) before reveals unlock
- [x] Moderation hooks: profanity/harassment detection stubs, report flow
- [x] AI-seeding plumbing: ability to mark a user as AI-backed, message routing through an LLM persona (disabled by default flag)
- [x] Tests: unit tests for matching, milestone unlocks, end-of-day resolution, rematch eligibility
- [x] Local dev script: docker-compose for Postgres, seed script with fake users
- [x] USER_TODO.md kept up-to-date with everything the user must do (Twilio signup, env vars, etc.)

The checklist is living — add subtasks as they emerge.

## Quality bar
- Real code, not stubs. If a function exists, it works.
- Tests for any non-trivial logic.
- Type-safe. No `any` unless genuinely unavoidable + comment why.
- Each commit leaves the repo in a buildable state (`npm install && npm run build` succeeds).
