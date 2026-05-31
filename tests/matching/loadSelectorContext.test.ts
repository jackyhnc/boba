// Contract test for `loadSelectorContext` — the Prisma adapter that builds
// the `SelectorContext` the pure selector consumes.
//
// Why this file exists. Three invariants live inside the query and mapping
// in `src/matching/prisma-deps.ts:28-84` that nothing else pins:
//
//   1. `smsOptedOut: false` is part of the candidate filter. This is a US
//      10DLC carrier-compliance requirement — an opted-out user MUST NOT be
//      considered for new matches. The flag was added later (migration
//      20260518080000_sms_opt_out) and the only enforcement is this SQL
//      filter clause; if a refactor drops it, the `runDailyMatch` unit test
//      can't catch it because that test's fake DB doesn't replicate the
//      filter.
//
//   2. The candidate filter also gates on `status: ACTIVE` plus non-null
//      preferences and stats. Same risk profile — silently dropping any of
//      these would let ONBOARDING / PAUSED / BANNED users (or users without
//      profile rows) leak into match selection.
//
//   3. `matchedTodayPairs` and `pairHistory` are keyed via the canonical
//      `pairKey()` so the selector's lookups always agree with the writer
//      (`persistDailyMatches`, which calls `orderPair` before writing). If
//      the canonicalization were lost on either read or write, repeat-match
//      protection and rematch cooldowns would silently misfire.
//
// We mock just the Prisma surface `loadSelectorContext` touches, record the
// exact arguments it called each method with, and assert both the query
// shape AND the output `SelectorContext` shape.

import { describe, it, expect, vi } from "vitest";
import { UserStatus } from "@prisma/client";
import { loadSelectorContext } from "../../src/matching/prisma-deps.js";
import type { MatchingPrisma } from "../../src/matching/prisma-deps.js";
import { pairKey } from "../../src/matching/selector.js";

interface UserFindManyArgs {
  where: Record<string, unknown>;
  include?: Record<string, unknown>;
}

interface DailyMatchFindManyArgs {
  where: { matchDate: Date };
  select: { userAId: true; userBId: true };
}

interface UserRow {
  id: string;
  isAiBacked: boolean;
  preferences: {
    minAge: number | null;
    maxAge: number | null;
    preferredGenders: Array<"WOMAN" | "MAN" | "NONBINARY" | "OTHER">;
    minHeightCm: number | null;
    maxHeightCm: number | null;
    preferredProfessions: string[];
    typeDescriptor: string | null;
  } | null;
  stats: {
    age: number | null;
    gender: "WOMAN" | "MAN" | "NONBINARY" | "OTHER" | null;
    profession: string | null;
    heightCm: number | null;
  } | null;
}

interface DailyMatchRow {
  userAId: string;
  userBId: string;
}

interface RematchHistoryRow {
  userAId: string;
  userBId: string;
  lastMatchedAt: Date;
  hasDiscard: boolean;
  matchCount: number;
}

interface Mock {
  prisma: MatchingPrisma;
  calls: {
    userFindMany: UserFindManyArgs[];
    dailyMatchFindMany: DailyMatchFindManyArgs[];
    rematchHistoryFindMany: unknown[];
  };
}

function makeMockPrisma(opts: {
  users?: UserRow[];
  todays?: DailyMatchRow[];
  histories?: RematchHistoryRow[];
}): Mock {
  const calls: Mock["calls"] = {
    userFindMany: [],
    dailyMatchFindMany: [],
    rematchHistoryFindMany: [],
  };

  const prisma = {
    user: {
      findMany: vi.fn(async (args: UserFindManyArgs) => {
        calls.userFindMany.push(args);
        return opts.users ?? [];
      }),
    },
    dailyMatch: {
      findMany: vi.fn(async (args: DailyMatchFindManyArgs) => {
        calls.dailyMatchFindMany.push(args);
        return opts.todays ?? [];
      }),
    },
    rematchHistory: {
      findMany: vi.fn(async (args: unknown) => {
        calls.rematchHistoryFindMany.push(args);
        return opts.histories ?? [];
      }),
    },
    $transaction: vi.fn(),
  } as unknown as MatchingPrisma;

  return { prisma, calls };
}

describe("loadSelectorContext — candidate filter", () => {
  it("pins the exact where clause: ACTIVE, not opted-out, prefs+stats not null", async () => {
    const m = makeMockPrisma({});
    await loadSelectorContext(m.prisma, new Date("2026-05-17T12:00:00Z"));

    expect(m.calls.userFindMany).toHaveLength(1);
    const args = m.calls.userFindMany[0]!;
    expect(args.where).toEqual({
      status: UserStatus.ACTIVE,
      smsOptedOut: false,
      preferences: { isNot: null },
      stats: { isNot: null },
    });
  });

  it("smsOptedOut: false is required — anything else is a 10DLC compliance regression", async () => {
    const m = makeMockPrisma({});
    await loadSelectorContext(m.prisma, new Date("2026-05-17T12:00:00Z"));
    const args = m.calls.userFindMany[0]!;
    expect(args.where.smsOptedOut).toBe(false);
    expect(args.where.smsOptedOut).not.toBeUndefined();
  });

  it("includes preferences and stats relations so the mapper has data to read", async () => {
    const m = makeMockPrisma({});
    await loadSelectorContext(m.prisma, new Date("2026-05-17T12:00:00Z"));
    const args = m.calls.userFindMany[0]!;
    expect(args.include).toEqual({ preferences: true, stats: true });
  });
});

describe("loadSelectorContext — candidate mapping", () => {
  const baseUser: UserRow = {
    id: "u_aaa",
    isAiBacked: false,
    preferences: {
      minAge: 21,
      maxAge: 29,
      preferredGenders: ["MAN"],
      minHeightCm: 170,
      maxHeightCm: 195,
      preferredProfessions: ["engineer"],
      typeDescriptor: "thoughtful introvert",
    },
    stats: {
      age: 24,
      gender: "WOMAN",
      profession: "designer",
      heightCm: 168,
    },
  };

  it("maps every preference and stat field through verbatim", async () => {
    const m = makeMockPrisma({ users: [baseUser] });
    const ctx = await loadSelectorContext(m.prisma, new Date("2026-05-17T12:00:00Z"));

    expect(ctx.candidates).toHaveLength(1);
    expect(ctx.candidates[0]).toEqual({
      userId: "u_aaa",
      isAiBacked: false,
      preferences: {
        minAge: 21,
        maxAge: 29,
        preferredGenders: ["MAN"],
        minHeightCm: 170,
        maxHeightCm: 195,
        preferredProfessions: ["engineer"],
        typeDescriptor: "thoughtful introvert",
      },
      stats: { age: 24, gender: "WOMAN", profession: "designer", heightCm: 168 },
    });
  });

  it("propagates isAiBacked=true (the AI seeding flag must reach the selector)", async () => {
    const m = makeMockPrisma({ users: [{ ...baseUser, isAiBacked: true }] });
    const ctx = await loadSelectorContext(m.prisma, new Date("2026-05-17T12:00:00Z"));
    expect(ctx.candidates[0]!.isAiBacked).toBe(true);
  });

  it("defensively skips rows whose prefs/stats came back null despite the SQL filter", async () => {
    // The where-clause `isNot: null` should already exclude these, but the
    // mapper has a belt-and-braces guard at src/matching/prisma-deps.ts:44.
    // If the include is ever weakened or the schema makes the relation
    // nullable, this guard is what stops a TypeError downstream.
    const noPrefs: UserRow = { ...baseUser, id: "u_no_prefs", preferences: null };
    const noStats: UserRow = { ...baseUser, id: "u_no_stats", stats: null };
    const m = makeMockPrisma({ users: [baseUser, noPrefs, noStats] });
    const ctx = await loadSelectorContext(m.prisma, new Date("2026-05-17T12:00:00Z"));

    expect(ctx.candidates.map((c) => c.userId)).toEqual(["u_aaa"]);
  });

  it("preserves selector order — the matcher's tiebreak relies on stable input order", async () => {
    const users = [
      { ...baseUser, id: "u_3" },
      { ...baseUser, id: "u_1" },
      { ...baseUser, id: "u_2" },
    ];
    const m = makeMockPrisma({ users });
    const ctx = await loadSelectorContext(m.prisma, new Date("2026-05-17T12:00:00Z"));
    expect(ctx.candidates.map((c) => c.userId)).toEqual(["u_3", "u_1", "u_2"]);
  });
});

describe("loadSelectorContext — matchedTodayPairs", () => {
  it("normalizes `today` to UTC midnight before querying DailyMatch", async () => {
    const m = makeMockPrisma({});
    await loadSelectorContext(m.prisma, new Date("2026-05-17T23:59:59.999Z"));
    expect(m.calls.dailyMatchFindMany).toHaveLength(1);
    const args = m.calls.dailyMatchFindMany[0]!;
    expect(args.where.matchDate.toISOString()).toBe("2026-05-17T00:00:00.000Z");
    expect(args.select).toEqual({ userAId: true, userBId: true });
  });

  it("midnight-UTC input stays at midnight (idempotent normalization)", async () => {
    const m = makeMockPrisma({});
    await loadSelectorContext(m.prisma, new Date("2026-05-17T00:00:00.000Z"));
    expect(m.calls.dailyMatchFindMany[0]!.where.matchDate.toISOString()).toBe(
      "2026-05-17T00:00:00.000Z",
    );
  });

  it("returns matchedTodayPairs keyed via canonical pairKey, regardless of stored order", async () => {
    // Persisted rows are already canonical (userAId < userBId) per
    // persistDailyMatches' orderPair guard. But the read side must apply
    // pairKey unconditionally — otherwise a hypothetical drift between
    // writer and reader canonicalization would silently disable the
    // "already matched today" check. We feed in BOTH orderings to confirm
    // the result set is keyed canonically either way.
    const m = makeMockPrisma({
      todays: [
        { userAId: "aaa", userBId: "zzz" }, // already canonical
        { userAId: "yyy", userBId: "bbb" }, // reversed
      ],
    });
    const ctx = await loadSelectorContext(m.prisma, new Date("2026-05-17T12:00:00Z"));

    expect(ctx.matchedTodayPairs.size).toBe(2);
    expect(ctx.matchedTodayPairs.has(pairKey("aaa", "zzz"))).toBe(true);
    expect(ctx.matchedTodayPairs.has(pairKey("zzz", "aaa"))).toBe(true); // pairKey is symmetric
    expect(ctx.matchedTodayPairs.has(pairKey("bbb", "yyy"))).toBe(true);
    expect(ctx.matchedTodayPairs.has(pairKey("yyy", "bbb"))).toBe(true);
  });

  it("empty matches today → empty set, not undefined", async () => {
    const m = makeMockPrisma({});
    const ctx = await loadSelectorContext(m.prisma, new Date("2026-05-17T12:00:00Z"));
    expect(ctx.matchedTodayPairs).toBeInstanceOf(Set);
    expect(ctx.matchedTodayPairs.size).toBe(0);
  });
});

describe("loadSelectorContext — pairHistory", () => {
  it("maps each RematchHistory row to a canonical pairKey, with lastMatchedOn as YYYY-MM-DD", async () => {
    const m = makeMockPrisma({
      histories: [
        {
          userAId: "aaa",
          userBId: "zzz",
          lastMatchedAt: new Date("2026-05-03T00:00:00.000Z"),
          hasDiscard: false,
          matchCount: 1,
        },
        {
          userAId: "bbb",
          userBId: "ccc",
          lastMatchedAt: new Date("2026-04-15T00:00:00.000Z"),
          hasDiscard: true,
          matchCount: 2,
        },
      ],
    });
    const ctx = await loadSelectorContext(m.prisma, new Date("2026-05-17T12:00:00Z"));

    expect(ctx.pairHistory.size).toBe(2);

    const first = ctx.pairHistory.get(pairKey("aaa", "zzz"));
    expect(first).toEqual({
      lastMatchedOn: "2026-05-03",
      hasDiscard: false,
      matchCount: 1,
    });

    const second = ctx.pairHistory.get(pairKey("bbb", "ccc"));
    expect(second).toEqual({
      lastMatchedOn: "2026-04-15",
      hasDiscard: true,
      matchCount: 2,
    });
  });

  it("a non-midnight lastMatchedAt is bucketed to the UTC date it falls in", async () => {
    // If a RematchHistory.lastMatchedAt accidentally lands at a non-midnight
    // timestamp (legacy data, manual fixup, timezone slip), the date key
    // must still be the UTC calendar date — never roll forward or back.
    const m = makeMockPrisma({
      histories: [
        {
          userAId: "aaa",
          userBId: "bbb",
          lastMatchedAt: new Date("2026-05-03T23:59:59.999Z"),
          hasDiscard: false,
          matchCount: 1,
        },
      ],
    });
    const ctx = await loadSelectorContext(m.prisma, new Date("2026-05-17T12:00:00Z"));
    expect(ctx.pairHistory.get(pairKey("aaa", "bbb"))!.lastMatchedOn).toBe("2026-05-03");
  });

  it("empty histories → empty Map, not undefined", async () => {
    const m = makeMockPrisma({});
    const ctx = await loadSelectorContext(m.prisma, new Date("2026-05-17T12:00:00Z"));
    expect(ctx.pairHistory).toBeInstanceOf(Map);
    expect(ctx.pairHistory.size).toBe(0);
  });
});

describe("loadSelectorContext — full assembly", () => {
  it("returns a SelectorContext with all three keys populated together", async () => {
    const m = makeMockPrisma({
      users: [
        {
          id: "u_1",
          isAiBacked: false,
          preferences: {
            minAge: 20,
            maxAge: 30,
            preferredGenders: ["MAN"],
            minHeightCm: null,
            maxHeightCm: null,
            preferredProfessions: [],
            typeDescriptor: null,
          },
          stats: { age: 24, gender: "WOMAN", profession: null, heightCm: null },
        },
      ],
      todays: [{ userAId: "u_1", userBId: "u_2" }],
      histories: [
        {
          userAId: "u_1",
          userBId: "u_3",
          lastMatchedAt: new Date("2026-05-10T00:00:00.000Z"),
          hasDiscard: false,
          matchCount: 1,
        },
      ],
    });

    const ctx = await loadSelectorContext(m.prisma, new Date("2026-05-17T12:00:00Z"));

    expect(ctx.candidates).toHaveLength(1);
    expect(ctx.matchedTodayPairs.size).toBe(1);
    expect(ctx.pairHistory.size).toBe(1);

    // All three Prisma methods were each called exactly once — no N+1.
    expect(m.calls.userFindMany).toHaveLength(1);
    expect(m.calls.dailyMatchFindMany).toHaveLength(1);
    expect(m.calls.rematchHistoryFindMany).toHaveLength(1);
  });
});
