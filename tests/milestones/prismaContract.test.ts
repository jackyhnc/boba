// Contract pins for the Prisma helpers in src/milestones/prisma-deps.ts.
//
// `tests/milestones/record.test.ts` already covers behavioural outcomes
// (idempotency, scoping by matchId, returned shape) but it ignores the
// query-shape contract that matters in prod:
//
//   1. `recordMilestone` MUST use `upsert` against the compound
//      `matchId_milestone` unique index. A regression that switched to
//      `findFirst` + `create` (or even `findUnique` + `create`) would still
//      pass record.test.ts because the fake DB iterates an in-memory store
//      regardless of the key shape — but in prod it would race under
//      concurrent inbound messages and produce a unique-constraint violation
//      from the inevitable double-insert. Pin the call surface.
//
//   2. `recordMilestone`'s `update` branch MUST be exactly `{}`. The
//      empty update is what guarantees `unlockedAt` is captured on first
//      write and never overwritten — the module docstring calls this out
//      explicitly. record.test.ts pins this (`update: {}`), so we lock it
//      again here as part of the wire-format contract: any extra field
//      (e.g. `updatedAt: new Date()`) would silently mutate previously
//      unlocked milestones every time a later inbound message re-asserts
//      the same milestone.
//
//   3. `recordMilestone`'s `create` payload MUST be EXACTLY
//      `{ matchId, milestone }`. Adding `unlockedAt: new Date()` to the
//      create would override the Prisma `@default(now())` and lose the
//      authoritative DB timestamp — the existing test would not catch
//      this because the fake assigns its own `new Date()` inside
//      `upsert`.
//
//   4. `create` payload values MUST match the `where` key — a cross-wired
//      typo (e.g. `create: { matchId: <some other>, milestone }`) would
//      slip past behavioural tests because they only inspect the
//      returned row, which the fake constructs from the create payload
//      directly. In prod this would write the milestone against the
//      wrong match.
//
//   5. `loadUnlockedMilestones` MUST issue a `findMany` with `select:
//      { milestone: true }` — narrow projection, no over-fetch of the
//      whole `MilestoneProgress` row (which carries `id`, `unlockedAt`,
//      and an implicit relation). Loading whole rows here would scale
//      poorly once every match has 3-5 milestones and the relay
//      re-reads them on every inbound message.
//
//   6. `loadUnlockedMilestones` MUST scope by `where: { matchId }`
//      directly — no `findFirst`, no relational where, no extra filters.
//      A regression that added `{ matchId, unlockedAt: { lte: now } }`
//      would silently hide future-dated rows in test fixtures.
//
//   7. `loadUnlockedMilestones` MUST return a `Set<MilestoneType>` — the
//      caller in `src/milestones/index.ts` uses `.has(...)` to gate the
//      unlock ladder. A refactor that returned `Array<MilestoneType>`
//      would compile (TypeScript allows `.has` only on Set, but a `Set`
//      vs `Array` swap with the same shape would break callers in
//      JavaScript-land at runtime — and at the contract-test level we
//      pin the shape so the regression surfaces here, not in inbound
//      message handling).
//
//   8. `loadUnlockedMilestones` MUST de-duplicate via Set construction
//      — though the DB unique constraint enforces uniqueness, we pin
//      that the return is a Set rather than the raw row count, so a
//      caller never has to think about deduplication.

import { describe, it, expect, vi } from "vitest";
import type { MilestoneType } from "@prisma/client";
import {
  loadUnlockedMilestones,
  recordMilestone,
  type MilestonePrisma,
} from "../../src/milestones/prisma-deps.js";

// Spy DB: vi.fn returns whatever the test stuffs into it. Args typed as
// `unknown` so a single spy can be inspected for `where` in one test and
// `select` in another without per-method strong typing.
function spyDb(rows: Array<{ id: string; matchId: string; milestone: MilestoneType; unlockedAt: Date }> = []) {
  const upsert = vi.fn(async (_args: unknown) => rows[0] ?? { id: "mp-new", matchId: "", milestone: "AGE" as MilestoneType, unlockedAt: new Date() });
  const findMany = vi.fn(async (_args: unknown): Promise<Array<{ milestone: MilestoneType }>> =>
    rows.map((r) => ({ milestone: r.milestone })),
  );
  const db = {
    milestoneProgress: { upsert, findMany },
  } as unknown as MilestonePrisma;
  return { db, upsert, findMany };
}

// ─── 1. recordMilestone uses upsert on the compound unique index ───────────

describe("recordMilestone — Prisma query contract", () => {
  it("issues exactly ONE upsert call, never a findFirst+create combo", async () => {
    // The compound `@@unique([matchId, milestone])` constraint is what
    // makes this race-safe under concurrent inbound messages. A refactor
    // that "checks first, then inserts" loses that race and produces a
    // unique-constraint violation in prod. Pin the call count.
    const { db, upsert } = spyDb();
    await recordMilestone(db, "match-1", "AGE");
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("WHERE keys on the compound `matchId_milestone` index, not on id/matchId alone", async () => {
    // Switching to `where: { matchId }` would compile (matchId is a
    // string field) but would not hit the unique index in Prisma — the
    // upsert would fail at the schema level. Switching to `where:
    // { id: ... }` would require synthesising an id. Both are silent
    // regressions until prod traffic exercises the constraint.
    const { db, upsert } = spyDb();
    await recordMilestone(db, "match-1", "AGE");
    const args = upsert.mock.calls[0]?.[0] as unknown as {
      where: { matchId_milestone: { matchId: string; milestone: MilestoneType } };
    };
    expect(args.where).toEqual({
      matchId_milestone: { matchId: "match-1", milestone: "AGE" },
    });
  });

  it("UPDATE branch is EXACTLY {} (empty) — pinned wire format, no extra fields", async () => {
    // The module docstring says: "the upsert update branch is
    // intentionally empty so `unlockedAt` is captured on first write
    // and never overwritten." Any drift (e.g. `update: { unlockedAt:
    // new Date() }` added "for freshness") would silently re-stamp
    // the unlock timestamp every time a later inbound message
    // re-asserts the same milestone — breaking the "first reveal"
    // semantics that the milestone ladder hinges on.
    const { db, upsert } = spyDb();
    await recordMilestone(db, "match-1", "AGE");
    const args = upsert.mock.calls[0]?.[0] as unknown as {
      update: Record<string, unknown>;
    };
    expect(args.update).toEqual({});
    // And nothing else — guard against silent additions:
    expect(Object.keys(args.update)).toHaveLength(0);
  });

  it("CREATE branch is EXACTLY { matchId, milestone } — no caller-supplied unlockedAt", async () => {
    // Adding `unlockedAt: new Date()` to create would override the
    // Prisma `@default(now())` and pin the timestamp to wall-clock at
    // the Node process — not the DB. Subtle but consequential for
    // audit/forensics. Lock the create payload to the two key fields.
    const { db, upsert } = spyDb();
    await recordMilestone(db, "match-1", "AGE");
    const args = upsert.mock.calls[0]?.[0] as unknown as {
      create: Record<string, unknown>;
    };
    expect(args.create).toEqual({ matchId: "match-1", milestone: "AGE" });
    expect(Object.keys(args.create).sort()).toEqual(["matchId", "milestone"]);
  });

  it("CREATE values mirror the WHERE keys (cross-wiring trap)", async () => {
    // If the create payload ever drifted to use different matchId or
    // milestone values than the where lookup (e.g. via a refactor that
    // pulled them from different sources), the upsert would still
    // succeed in the fake DB because the test only inspects the
    // returned row. In prod the row would be written against the
    // wrong match. Pin the symmetry across BOTH AGE and HEIGHT to
    // catch a one-field cross-wire.
    const { db, upsert } = spyDb();
    await recordMilestone(db, "match-X", "HEIGHT");
    const args = upsert.mock.calls[0]?.[0] as unknown as {
      where: { matchId_milestone: { matchId: string; milestone: MilestoneType } };
      create: { matchId: string; milestone: MilestoneType };
    };
    expect(args.create.matchId).toBe(args.where.matchId_milestone.matchId);
    expect(args.create.milestone).toBe(args.where.matchId_milestone.milestone);
    expect(args.create.matchId).toBe("match-X");
    expect(args.create.milestone).toBe("HEIGHT");
  });

  it("does NOT issue findMany (no read-then-write probe)", async () => {
    // Defensive: if a refactor ever inserted a "check existing first"
    // findMany before the upsert (e.g. to log a metric), it would
    // double the DB round-trips. Catch it.
    const { db, findMany } = spyDb();
    await recordMilestone(db, "match-1", "AGE");
    expect(findMany).not.toHaveBeenCalled();
  });
});

// ─── 5-8. loadUnlockedMilestones contract ──────────────────────────────────

describe("loadUnlockedMilestones — Prisma query contract", () => {
  it("issues exactly ONE findMany, never per-milestone findUnique", async () => {
    const { db, findMany } = spyDb();
    await loadUnlockedMilestones(db, "match-1");
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("WHERE is EXACTLY `{ matchId }` — no relational filter, no temporal filter", async () => {
    // A refactor that added `unlockedAt: { lte: now }` (e.g. "future-
    // dated rows are not yet visible") would silently hide rows in
    // test fixtures where unlockedAt was set far in the future. The
    // module's contract is "all unlocked milestones for this match,
    // no temporal qualification."
    const { db, findMany } = spyDb();
    await loadUnlockedMilestones(db, "match-1");
    const args = findMany.mock.calls[0]?.[0] as unknown as {
      where: Record<string, unknown>;
    };
    expect(args.where).toEqual({ matchId: "match-1" });
    expect(Object.keys(args.where)).toEqual(["matchId"]);
  });

  it("SELECT projects EXACTLY `{ milestone: true }` — narrow, no over-fetch", async () => {
    // The caller only uses the milestone field to build a Set. Loading
    // the whole `MilestoneProgress` row pulls in `id` + `unlockedAt`
    // (plus the relation pointer to `dailyMatch`) — wasted bandwidth
    // at every inbound message. Pin the narrow projection.
    const { db, findMany } = spyDb();
    await loadUnlockedMilestones(db, "match-1");
    const args = findMany.mock.calls[0]?.[0] as unknown as {
      select: Record<string, unknown>;
    };
    expect(args.select).toEqual({ milestone: true });
    expect(Object.keys(args.select)).toEqual(["milestone"]);
  });

  it("returns a Set, NOT an Array — caller relies on .has(...) on the unlock ladder", async () => {
    // src/milestones/index.ts gates the next-milestone unlock via
    // `unlocked.has(...)`. A refactor returning Array would still
    // compile in plenty of TS contexts (or fail there, depending on
    // call sites) but in a structural-typing slip we'd find the
    // call-site `.has` undefined at runtime. Pin the constructor.
    const { db } = spyDb([
      { id: "mp-1", matchId: "match-1", milestone: "AGE", unlockedAt: new Date() },
    ]);
    const got = await loadUnlockedMilestones(db, "match-1");
    expect(got).toBeInstanceOf(Set);
    expect(Array.isArray(got)).toBe(false);
  });

  it("returns an empty Set when no rows match (not undefined, not null)", async () => {
    // The unlock-ladder caller dereferences `.has()` immediately; a
    // null return would NPE. Pin the empty-result return type.
    const { db } = spyDb([]);
    const got = await loadUnlockedMilestones(db, "match-none");
    expect(got).toBeInstanceOf(Set);
    expect(got.size).toBe(0);
  });

  it("de-duplicates via Set construction (defence-in-depth — DB constraint already prevents dupes)", async () => {
    // The `@@unique([matchId, milestone])` constraint prevents dupes
    // at the DB level, so this pin is belt-and-braces. But if a
    // future migration ever relaxed the constraint (e.g. to record
    // re-unlocks for analytics), the Set construction here is what
    // keeps callers from seeing duplicate milestone tokens. The Set
    // wrapper is the contract; pin it independently of the constraint.
    const { db, findMany } = spyDb();
    // Override findMany to return a duplicate row, simulating a
    // hypothetical relaxed-constraint world.
    findMany.mockResolvedValueOnce([
      { milestone: "AGE" as MilestoneType },
      { milestone: "AGE" as MilestoneType },
      { milestone: "PROFESSION" as MilestoneType },
    ]);
    const got = await loadUnlockedMilestones(db, "match-1");
    expect(got.size).toBe(2);
    expect(got.has("AGE")).toBe(true);
    expect(got.has("PROFESSION")).toBe(true);
  });

  it("does NOT issue upsert (read-only path)", async () => {
    // Defensive: catch a refactor that ever side-effected a write
    // from inside the read path (e.g. "record an audit row when read").
    const { db, upsert } = spyDb();
    await loadUnlockedMilestones(db, "match-1");
    expect(upsert).not.toHaveBeenCalled();
  });
});
