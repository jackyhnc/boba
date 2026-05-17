import { describe, it, expect, vi } from "vitest";
import { persistDailyMatches } from "../../src/matching/prisma-deps.js";
import type { MatchingPrisma } from "../../src/matching/prisma-deps.js";
import type { SelectedMatch } from "../../src/matching/types.js";

interface DailyMatchCreate {
  data: {
    userAId: string;
    userBId: string;
    matchDate: Date;
    compatibilityScore: number;
  };
}

interface RematchUpsert {
  where: { userAId_userBId: { userAId: string; userBId: string } };
  create: {
    userAId: string;
    userBId: string;
    firstMatchedAt: Date;
    lastMatchedAt: Date;
    matchCount: number;
  };
  update: { lastMatchedAt: Date; matchCount: { increment: number } };
}

interface Recorder {
  matchCreates: DailyMatchCreate[];
  rematchUpserts: RematchUpsert[];
  transactionCalls: number;
}

function makeMockPrisma(): { prisma: MatchingPrisma; rec: Recorder } {
  const rec: Recorder = {
    matchCreates: [],
    rematchUpserts: [],
    transactionCalls: 0,
  };

  let nextId = 1;
  const tx = {
    dailyMatch: {
      create: vi.fn(async (args: DailyMatchCreate) => {
        rec.matchCreates.push(args);
        return { id: `dm-${nextId++}`, ...args.data };
      }),
    },
    rematchHistory: {
      upsert: vi.fn(async (args: RematchUpsert) => {
        rec.rematchUpserts.push(args);
        return { id: `rh-${nextId++}` };
      }),
    },
  };

  // $transaction(fn, options) — call fn with our tx stand-in.
  const $transaction = vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => {
    rec.transactionCalls++;
    return fn(tx);
  });

  // We only exercise the writeable surface; reads aren't used by persist.
  const prisma = {
    user: {} as MatchingPrisma["user"],
    dailyMatch: {} as MatchingPrisma["dailyMatch"],
    rematchHistory: {} as MatchingPrisma["rematchHistory"],
    $transaction,
  } as unknown as MatchingPrisma;

  return { prisma, rec };
}

describe("persistDailyMatches", () => {
  it("returns immediately and skips the transaction for an empty input", async () => {
    const { prisma, rec } = makeMockPrisma();
    const ids = await persistDailyMatches(prisma, [], new Date("2026-05-17T12:00:00Z"));
    expect(ids).toEqual([]);
    expect(rec.transactionCalls).toBe(0);
  });

  it("creates one DailyMatch + one RematchHistory upsert per pair, in one transaction", async () => {
    const { prisma, rec } = makeMockPrisma();
    const today = new Date("2026-05-17T12:34:00Z");
    const pairs: SelectedMatch[] = [
      { userAId: "u-aaa", userBId: "u-bbb", score: 0.91 },
      { userAId: "u-ccc", userBId: "u-ddd", score: 0.7 },
    ];

    const ids = await persistDailyMatches(prisma, pairs, today);

    expect(rec.transactionCalls).toBe(1);
    expect(ids).toEqual(["dm-1", "dm-3"]);
    expect(rec.matchCreates).toHaveLength(2);
    expect(rec.rematchUpserts).toHaveLength(2);

    // matchDate is normalised to UTC midnight.
    const first = rec.matchCreates[0]!;
    expect(first.data.userAId).toBe("u-aaa");
    expect(first.data.userBId).toBe("u-bbb");
    expect(first.data.compatibilityScore).toBe(0.91);
    expect(first.data.matchDate.toISOString()).toBe("2026-05-17T00:00:00.000Z");

    const upsert = rec.rematchUpserts[0]!;
    expect(upsert.where.userAId_userBId).toEqual({ userAId: "u-aaa", userBId: "u-bbb" });
    expect(upsert.update.matchCount.increment).toBe(1);
    expect(upsert.create.matchCount).toBe(1);
    expect(upsert.create.firstMatchedAt.toISOString()).toBe("2026-05-17T00:00:00.000Z");
  });

  it("re-orders ids canonically before writing", async () => {
    const { prisma, rec } = makeMockPrisma();
    const today = new Date("2026-05-17T00:00:00Z");
    // Caller passes a non-canonical pair — persist should fix it.
    await persistDailyMatches(prisma, [{ userAId: "zzz", userBId: "aaa", score: 0.5 }], today);
    expect(rec.matchCreates[0]!.data).toMatchObject({ userAId: "aaa", userBId: "zzz" });
    expect(rec.rematchUpserts[0]!.where.userAId_userBId).toEqual({
      userAId: "aaa",
      userBId: "zzz",
    });
  });
});
