import { describe, it, expect } from "vitest";
import {
  isEligibleForRematch,
  loadHistoryForPair,
  loadPairHistoryFor,
  type RematchPrisma,
} from "../../src/rematch/index.js";
import { pairKey } from "../../src/matching/selector.js";

const TODAY = new Date("2026-05-17T00:00:00Z");

describe("isEligibleForRematch", () => {
  it("never matched → eligible", () => {
    expect(
      isEligibleForRematch({ history: null, today: TODAY }),
    ).toEqual({ eligible: true, reason: "never_matched", cooldownRemainingDays: 0 });
  });

  it("hasDiscard → permanently ineligible", () => {
    const r = isEligibleForRematch({
      history: { lastMatchedOn: "2020-01-01", hasDiscard: true, matchCount: 1 },
      today: TODAY,
    });
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe("had_discard");
  });

  it("within cooldown → ineligible + remaining days", () => {
    // Last matched 3 days ago, default cooldown 14 → 11 days remaining.
    const r = isEligibleForRematch({
      history: { lastMatchedOn: "2026-05-14", hasDiscard: false, matchCount: 1 },
      today: TODAY,
    });
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe("within_cooldown");
    expect(r.cooldownRemainingDays).toBe(11);
  });

  it("cooldown elapsed → eligible", () => {
    const r = isEligibleForRematch({
      history: { lastMatchedOn: "2026-04-01", hasDiscard: false, matchCount: 3 },
      today: TODAY,
    });
    expect(r.eligible).toBe(true);
    expect(r.reason).toBe("cooldown_elapsed");
  });

  it("respects config override", () => {
    // With cooldown=2, 3 days ago is past.
    const r = isEligibleForRematch({
      history: { lastMatchedOn: "2026-05-14", hasDiscard: false, matchCount: 1 },
      today: TODAY,
      config: { rematchCooldownDays: 2 },
    });
    expect(r.eligible).toBe(true);
  });

  it("exact boundary day == cooldown is eligible", () => {
    const r = isEligibleForRematch({
      history: { lastMatchedOn: "2026-05-03", hasDiscard: false, matchCount: 1 },
      today: TODAY,
      config: { rematchCooldownDays: 14 },
    });
    expect(r.eligible).toBe(true);
  });
});

describe("loadPairHistoryFor", () => {
  function fakeDb(rows: Array<{ userAId: string; userBId: string; lastMatchedAt: Date; matchCount: number; hasDiscard: boolean }>): RematchPrisma {
    return {
      rematchHistory: {
        findMany: async () => rows,
        findUnique: async ({ where }: { where: { userAId_userBId: { userAId: string; userBId: string } } }) => {
          const r = rows.find(
            (x) =>
              x.userAId === where.userAId_userBId.userAId &&
              x.userBId === where.userAId_userBId.userBId,
          );
          return r ?? null;
        },
      },
    } as unknown as RematchPrisma;
  }

  it("returns an empty map for no user ids", async () => {
    const db = fakeDb([]);
    expect(await loadPairHistoryFor(db, [])).toEqual(new Map());
  });

  it("keys rows by canonical pair", async () => {
    const db = fakeDb([
      { userAId: "u1", userBId: "u2", lastMatchedAt: new Date("2026-05-14"), matchCount: 2, hasDiscard: false },
    ]);
    const map = await loadPairHistoryFor(db, ["u1", "u2"]);
    expect(map.size).toBe(1);
    const entry = map.get(pairKey("u1", "u2"));
    expect(entry).toEqual({ lastMatchedOn: "2026-05-14", matchCount: 2, hasDiscard: false });
  });

  it("loadHistoryForPair returns null when no row exists", async () => {
    const db = fakeDb([]);
    expect(await loadHistoryForPair(db, "u1", "u2")).toBeNull();
  });

  it("loadHistoryForPair returns a normalized entry", async () => {
    const db = fakeDb([
      { userAId: "u1", userBId: "u2", lastMatchedAt: new Date("2026-05-14"), matchCount: 2, hasDiscard: true },
    ]);
    const e = await loadHistoryForPair(db, "u2", "u1"); // unordered input
    expect(e).toEqual({ lastMatchedOn: "2026-05-14", matchCount: 2, hasDiscard: true });
  });
});
