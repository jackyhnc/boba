import { describe, it, expect } from "vitest";
import { Gender } from "@prisma/client";
import {
  selectDailyMatches,
  pairKey,
  toDateKey,
  dayDiff,
} from "../../src/matching/selector.js";
import type {
  CandidateProfile,
  PairHistoryEntry,
  SelectorContext,
} from "../../src/matching/types.js";

function man(
  id: string,
  age: number,
  descriptor: string,
  heightCm = 180,
): CandidateProfile {
  return {
    userId: id,
    isAiBacked: false,
    preferences: {
      minAge: 22,
      maxAge: 30,
      preferredGenders: [Gender.WOMAN],
      minHeightCm: 160,
      maxHeightCm: 180,
      preferredProfessions: [],
      typeDescriptor: descriptor,
    },
    stats: {
      age,
      gender: Gender.MAN,
      profession: "engineer",
      heightCm,
    },
  };
}

function woman(
  id: string,
  age: number,
  descriptor: string,
  heightCm = 165,
): CandidateProfile {
  return {
    userId: id,
    isAiBacked: false,
    preferences: {
      minAge: 22,
      maxAge: 30,
      preferredGenders: [Gender.MAN],
      minHeightCm: 170,
      maxHeightCm: 195,
      preferredProfessions: [],
      typeDescriptor: descriptor,
    },
    stats: {
      age,
      gender: Gender.WOMAN,
      profession: "designer",
      heightCm,
    },
  };
}

function ctx(
  candidates: CandidateProfile[],
  partial: Partial<SelectorContext> = {},
): SelectorContext {
  return {
    candidates,
    matchedTodayPairs: partial.matchedTodayPairs ?? new Set(),
    pairHistory: partial.pairHistory ?? new Map(),
  };
}

describe("toDateKey / dayDiff", () => {
  it("formats date keys consistently", () => {
    expect(toDateKey(new Date(Date.UTC(2026, 4, 17)))).toBe("2026-05-17");
    expect(toDateKey(new Date(Date.UTC(2026, 0, 1, 23, 59, 59)))).toBe("2026-01-01");
  });

  it("dayDiff counts whole days", () => {
    expect(dayDiff("2026-05-10", "2026-05-17")).toBe(7);
    expect(dayDiff("2026-05-17", "2026-05-17")).toBe(0);
    expect(dayDiff("2026-05-18", "2026-05-17")).toBe(-1);
  });
});

describe("pairKey", () => {
  it("is canonical regardless of input order", () => {
    expect(pairKey("a", "b")).toBe("a|b");
    expect(pairKey("b", "a")).toBe("a|b");
  });
});

describe("selectDailyMatches", () => {
  const today = new Date(Date.UTC(2026, 4, 17));

  it("returns no matches when there are fewer than two candidates", () => {
    expect(selectDailyMatches(today, ctx([]))).toEqual([]);
    expect(selectDailyMatches(today, ctx([man("m1", 24, "climbing")]))).toEqual([]);
  });

  it("matches a single eligible pair", () => {
    const m = man("m1", 25, "climbing indie music");
    const w = woman("w1", 25, "climbing indie music");
    const matches = selectDailyMatches(today, ctx([m, w]));
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ userAId: "m1", userBId: "w1" });
    expect(matches[0]!.score).toBeGreaterThan(0.3);
  });

  it("greedily pairs the highest-scoring couple first", () => {
    // m1+w2 share a tight descriptor; w1 is left to pair with m2.
    const m1 = man("m1", 25, "rock climbing indie music sketching");
    const m2 = man("m2", 26, "football beer bbq");
    const w1 = woman("w1", 24, "yoga and tea");
    const w2 = woman("w2", 25, "climbing music sketching art");
    const matches = selectDailyMatches(today, ctx([m1, m2, w1, w2]));
    expect(matches).toHaveLength(2);

    // The best pair should be the descriptor-overlap one.
    const top = matches[0]!;
    expect(pairKey(top.userAId, top.userBId)).toBe(pairKey("m1", "w2"));

    // And the second pair should claim the leftovers.
    const second = matches[1]!;
    expect(pairKey(second.userAId, second.userBId)).toBe(pairKey("m2", "w1"));
  });

  it("never matches a user with two partners on the same day", () => {
    const m1 = man("m1", 25, "indie music climbing");
    const w1 = woman("w1", 25, "indie music climbing");
    const w2 = woman("w2", 26, "indie music climbing");
    const matches = selectDailyMatches(today, ctx([m1, w1, w2]));
    const allUsers = matches.flatMap((m) => [m.userAId, m.userBId]);
    expect(new Set(allUsers).size).toBe(allUsers.length);
  });

  it("excludes pairs already matched today", () => {
    const m1 = man("m1", 25, "climbing indie music");
    const w1 = woman("w1", 25, "climbing indie music");
    const matched = new Set([pairKey("m1", "w1")]);
    const matches = selectDailyMatches(today, ctx([m1, w1], { matchedTodayPairs: matched }));
    expect(matches).toHaveLength(0);
  });

  it("excludes pairs that ever produced a Discard", () => {
    const m1 = man("m1", 25, "climbing indie music");
    const w1 = woman("w1", 25, "climbing indie music");
    const history = new Map<string, PairHistoryEntry>([
      [pairKey("m1", "w1"), { lastMatchedOn: "2026-05-10", hasDiscard: true, matchCount: 1 }],
    ]);
    const matches = selectDailyMatches(today, ctx([m1, w1], { pairHistory: history }));
    expect(matches).toHaveLength(0);
  });

  it("respects the rematch cooldown window", () => {
    const m1 = man("m1", 25, "climbing indie music");
    const w1 = woman("w1", 25, "climbing indie music");

    const cooledDown = new Map<string, PairHistoryEntry>([
      [pairKey("m1", "w1"), { lastMatchedOn: "2026-05-15", hasDiscard: false, matchCount: 1 }],
    ]);
    expect(
      selectDailyMatches(today, ctx([m1, w1], { pairHistory: cooledDown })),
    ).toHaveLength(0);

    const longAgo = new Map<string, PairHistoryEntry>([
      [pairKey("m1", "w1"), { lastMatchedOn: "2026-04-01", hasDiscard: false, matchCount: 1 }],
    ]);
    expect(
      selectDailyMatches(today, ctx([m1, w1], { pairHistory: longAgo })),
    ).toHaveLength(1);
  });

  it("respects minScore configuration", () => {
    const m1 = man("m1", 25, "completely orthogonal subjects xyz");
    const w1 = woman("w1", 25, "nothing alike pqr rst");
    const matchesLow = selectDailyMatches(today, ctx([m1, w1]), { minScore: 0 });
    expect(matchesLow).toHaveLength(1);

    const matchesHigh = selectDailyMatches(today, ctx([m1, w1]), { minScore: 0.9 });
    expect(matchesHigh).toHaveLength(0);
  });

  it("never pairs users whose gender preferences exclude each other", () => {
    const m1 = man("m1", 25, "climbing");
    const m2: CandidateProfile = {
      userId: "m2",
      isAiBacked: false,
      preferences: {
        minAge: 22,
        maxAge: 30,
        preferredGenders: [Gender.WOMAN],
        minHeightCm: null,
        maxHeightCm: null,
        preferredProfessions: [],
        typeDescriptor: "climbing",
      },
      stats: { age: 25, gender: Gender.MAN, profession: "engineer", heightCm: 180 },
    };
    const matches = selectDailyMatches(today, ctx([m1, m2]));
    expect(matches).toHaveLength(0);
  });

  it("emits canonical (A < B) pair order", () => {
    const m1 = man("z-user", 25, "climbing");
    const w1 = woman("a-user", 25, "climbing");
    const matches = selectDailyMatches(today, ctx([m1, w1]));
    expect(matches).toHaveLength(1);
    const top = matches[0]!;
    expect(top.userAId < top.userBId).toBe(true);
    expect(top.userAId).toBe("a-user");
    expect(top.userBId).toBe("z-user");
  });
});
