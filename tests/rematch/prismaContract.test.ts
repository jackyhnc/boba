// Contract pins for the Prisma helpers in src/rematch/index.ts.
//
// The existing eligibility.test.ts uses a fake DB whose `findMany`
// ignores its `where`/`select` arguments and whose `findUnique` does
// the lookup by iterating an array. That's fine for round-trip
// behaviour but it leaves the *query shape* unpinned — and the query
// shape is the contract that matters in prod.
//
// In particular the module's docstring calls out the intentional
// design choice: `loadPairHistoryFor` issues ONE bulk `findMany` over
// `OR(userAId IN ids, userBId IN ids)` rather than per-pair lookups,
// to avoid an N+1 against `RematchHistory`. Nothing currently fails if
// a refactor reverts to per-pair `findUnique` calls, over-fetches the
// User relation in `select`, or drops the empty-input short-circuit.
//
// Similarly `loadHistoryForPair` uses `findUnique` against the
// compound `userAId_userBId` unique index — switching to `findFirst`
// would silently bypass the index and full-scan the table at prod
// scale. And both helpers MUST canonicalize via `orderPair` before
// touching the DB (the unique constraint enforces A < B); a regression
// that skipped canonicalization would miss rows for the (B, A) caller
// ordering.
//
// All five claims pinned below.

import { describe, it, expect, vi } from "vitest";
import {
  loadHistoryForPair,
  loadPairHistoryFor,
  type RematchPrisma,
} from "../../src/rematch/index.js";
import { pairKey } from "../../src/matching/selector.js";

interface HistoryRow {
  userAId: string;
  userBId: string;
  lastMatchedAt: Date;
  matchCount: number;
  hasDiscard: boolean;
}

// Spies type their args as `unknown` deliberately: every test downcasts
// `mock.calls[i]?.[0]` via `unknown` to whatever shape it's asserting on,
// which lets the same spy be inspected for `where` in one test and
// `select` in another without per-method strong typing.
function spyDb(rows: HistoryRow[]) {
  const findMany = vi.fn(async (_args: unknown): Promise<HistoryRow[]> => rows);
  const findUnique = vi.fn(
    async (args: unknown): Promise<HistoryRow | null> => {
      const where = (args as { where: { userAId_userBId: { userAId: string; userBId: string } } }).where;
      const r = rows.find(
        (x) =>
          x.userAId === where.userAId_userBId.userAId &&
          x.userBId === where.userAId_userBId.userBId,
      );
      return r ?? null;
    },
  );
  const db = {
    rematchHistory: { findMany, findUnique },
  } as unknown as RematchPrisma;
  return { db, findMany, findUnique };
}

describe("loadPairHistoryFor — Prisma query contract", () => {
  it("short-circuits on empty input WITHOUT touching the DB", async () => {
    // Pinned because the early return is the only thing protecting us
    // from issuing a `findMany` with `where: { OR: [{ userAId: { in: [] } }, ...] }`
    // — which Postgres treats as match-nothing but is still a wasted
    // round-trip. The current test only asserts the returned map is
    // empty, not that the DB was untouched.
    const { db, findMany, findUnique } = spyDb([]);
    const result = await loadPairHistoryFor(db, []);
    expect(result).toEqual(new Map());
    expect(findMany).not.toHaveBeenCalled();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("issues exactly ONE bulk findMany, never per-pair findUnique (no N+1)", async () => {
    // This is the module's stated design choice. If a refactor reverts
    // to per-pair lookups — even just for a single 5-user cohort —
    // findUnique would be called 10 times (C(5,2)) and findMany zero
    // times. Pinning the call counts catches that loudly.
    const { db, findMany, findUnique } = spyDb([]);
    await loadPairHistoryFor(db, ["u1", "u2", "u3", "u4", "u5"]);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("WHERE is `OR(userAId IN ids, userBId IN ids)` — both sides covered", async () => {
    // Asymmetry trap: using `where: { userAId: { in: ids } }` alone
    // would miss every row where the cohort member is stored on the B
    // side (which is half of them, given the canonical A<B ordering
    // has no relation to "did this caller pass them first"). The OR
    // form is load-bearing; pin its exact shape.
    const { db, findMany } = spyDb([]);
    await loadPairHistoryFor(db, ["u1", "u2", "u3"]);
    const args = findMany.mock.calls[0]?.[0] as unknown as {
      where: unknown;
    };
    expect(args.where).toEqual({
      OR: [
        { userAId: { in: ["u1", "u2", "u3"] } },
        { userBId: { in: ["u1", "u2", "u3"] } },
      ],
    });
  });

  it("SELECT projects EXACTLY the 5 fields the caller consumes", async () => {
    // No over-fetch: pulling the `User` relation, or `createdAt`/`id`,
    // would bloat the result set unnecessarily. The five fields here
    // are the closure of what `PairHistoryEntry` needs (lastMatchedAt,
    // matchCount, hasDiscard) plus the pair-identity columns
    // (userAId, userBId) the loop needs to key the map.
    const { db, findMany } = spyDb([]);
    await loadPairHistoryFor(db, ["u1"]);
    const args = findMany.mock.calls[0]?.[0] as unknown as {
      select: Record<string, unknown>;
    };
    expect(args.select).toEqual({
      userAId: true,
      userBId: true,
      lastMatchedAt: true,
      matchCount: true,
      hasDiscard: true,
    });
    // And nothing else — guard against silent additions.
    expect(Object.keys(args.select).sort()).toEqual([
      "hasDiscard",
      "lastMatchedAt",
      "matchCount",
      "userAId",
      "userBId",
    ]);
  });

  it("canonicalizes map keys via orderPair even if a row arrives denormalized", async () => {
    // The DB schema enforces A < B via the unique constraint, so in
    // prod we should never see a denormalized row. But the function
    // calls `orderPair` on every row defensively, and that defence is
    // what keeps callers from having to guess the storage ordering.
    // Pin it: a row stored as (B, A) still produces the canonical key.
    const { db } = spyDb([
      {
        userAId: "u2",
        userBId: "u1", // denormalized
        lastMatchedAt: new Date("2026-05-14T00:00:00Z"),
        matchCount: 1,
        hasDiscard: false,
      },
    ]);
    const map = await loadPairHistoryFor(db, ["u1", "u2"]);
    expect(map.size).toBe(1);
    expect(map.get(pairKey("u1", "u2"))).toBeDefined();
    expect(map.get("u2|u1")).toBeUndefined();
  });

  it("normalizes the id list to a plain array (ReadonlyArray input is safe)", async () => {
    // The function declares `userIds: ReadonlyArray<string>` and does
    // `const ids = [...userIds]` before passing to Prisma. The copy
    // matters because the `in: ids` clause must not alias a frozen
    // caller array (would throw if Prisma ever attempted a mutating
    // sort). Pin by passing a frozen array — no throw, expected shape.
    const { db, findMany } = spyDb([]);
    const frozen = Object.freeze(["u1", "u2"]) as ReadonlyArray<string>;
    await loadPairHistoryFor(db, frozen);
    const args = findMany.mock.calls[0]?.[0] as unknown as {
      where: { OR: Array<{ userAId?: { in: string[] }; userBId?: { in: string[] } }> };
    };
    const aIn = args.where.OR[0]?.userAId?.in;
    expect(Object.isFrozen(aIn)).toBe(false);
  });
});

describe("loadHistoryForPair — Prisma query contract", () => {
  it("uses findUnique on the compound userAId_userBId index, not findFirst", async () => {
    // `findFirst` would full-scan the table; `findUnique` hits the
    // compound unique index. The performance gap matters at the cohort
    // sizes we'll grow into. Pin the call signature.
    const { db, findMany, findUnique } = spyDb([]);
    await loadHistoryForPair(db, "u1", "u2");
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(findMany).not.toHaveBeenCalled();
    const args = findUnique.mock.calls[0]?.[0] as unknown as {
      where: { userAId_userBId: { userAId: string; userBId: string } };
    };
    expect(args.where).toEqual({
      userAId_userBId: { userAId: "u1", userBId: "u2" },
    });
  });

  it("canonicalizes via orderPair BEFORE the DB lookup (unordered input)", async () => {
    // The existing test verifies the returned value is correct for
    // unordered input, but only because the fake DB iterates an array
    // and finds the row regardless. In prod, an un-canonicalized
    // findUnique against (u2, u1) would miss the row stored as
    // (u1, u2). Pin the args that hit Prisma, not just the return.
    const { db, findUnique } = spyDb([
      {
        userAId: "u1",
        userBId: "u2",
        lastMatchedAt: new Date("2026-05-14T00:00:00Z"),
        matchCount: 1,
        hasDiscard: false,
      },
    ]);
    await loadHistoryForPair(db, "u2", "u1"); // caller-side reversed
    const args = findUnique.mock.calls[0]?.[0] as unknown as {
      where: { userAId_userBId: { userAId: string; userBId: string } };
    };
    expect(args.where.userAId_userBId.userAId).toBe("u1");
    expect(args.where.userAId_userBId.userBId).toBe("u2");
  });

  it("SELECT projects EXACTLY the 3 PairHistoryEntry fields — no echo of pair ids", async () => {
    // Notably absent: userAId/userBId. They're inputs, not outputs;
    // re-projecting them would be over-fetch. The return shape is the
    // closure of `PairHistoryEntry` (lastMatchedOn derived from
    // lastMatchedAt, plus matchCount, hasDiscard).
    const { db, findUnique } = spyDb([]);
    await loadHistoryForPair(db, "u1", "u2");
    const args = findUnique.mock.calls[0]?.[0] as unknown as {
      select: Record<string, unknown>;
    };
    expect(args.select).toEqual({
      lastMatchedAt: true,
      matchCount: true,
      hasDiscard: true,
    });
    expect(Object.keys(args.select).sort()).toEqual([
      "hasDiscard",
      "lastMatchedAt",
      "matchCount",
    ]);
  });

  it("propagates lastMatchedAt → lastMatchedOn via toDateKey (not raw Date)", async () => {
    // `PairHistoryEntry.lastMatchedOn` is a date *key* string
    // ("YYYY-MM-DD"), not a Date. Pin that the function converts —
    // any refactor that handed the raw Date through would surface here
    // because the entry type would also need to change.
    const { db } = spyDb([
      {
        userAId: "u1",
        userBId: "u2",
        // A late-evening UTC timestamp — exercises the date-key
        // truncation. If a regression sent the raw Date instead, the
        // type assertion below would still hold but the value would
        // be a Date string like "2026-05-14T22:30:00.000Z", not
        // "2026-05-14".
        lastMatchedAt: new Date("2026-05-14T22:30:00Z"),
        matchCount: 3,
        hasDiscard: false,
      },
    ]);
    const entry = await loadHistoryForPair(db, "u1", "u2");
    expect(entry).not.toBeNull();
    expect(entry?.lastMatchedOn).toBe("2026-05-14");
    expect(typeof entry?.lastMatchedOn).toBe("string");
  });
});
