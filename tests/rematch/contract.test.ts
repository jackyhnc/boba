// Contract: the inline rematch gate in `selectDailyMatches`
// (`pairEligibleByHistory` in src/matching/selector.ts) and the
// standalone `isEligibleForRematch` predicate exported from
// src/rematch/index.ts encode the SAME rule and MUST agree.
//
// Both are tested independently elsewhere; this file pins them
// together. It exists because the rematch module's own docstring
// flags the duplication ("Today's matching selector already inlines
// history-based rejection... this module exposes the eligibility
// rule as a first-class, side-effect-free predicate"), so any future
// tweak to one without the other should fail loudly here.
//
// Strategy: for a grid of (lastMatchedOn relative to today, hasDiscard,
// cooldown override) states, compute the predicate's verdict and the
// selector's verdict for a single pair that would otherwise match
// strongly. They must agree on the boolean "this pair may be selected
// today" question.
import { describe, it, expect } from "vitest";
import { Gender } from "@prisma/client";
import {
  selectDailyMatches,
  pairKey,
  toDateKey,
} from "../../src/matching/selector.js";
import type {
  CandidateProfile,
  PairHistoryEntry,
  SelectorContext,
} from "../../src/matching/types.js";
import { isEligibleForRematch } from "../../src/rematch/index.js";

const TODAY = new Date(Date.UTC(2026, 4, 17)); // 2026-05-17

// Two strongly-compatible candidates so the only thing that can knock
// the pair out is the history gate — keeps the test honest.
const MAN: CandidateProfile = {
  userId: "m1",
  isAiBacked: false,
  preferences: {
    minAge: 22,
    maxAge: 30,
    preferredGenders: [Gender.WOMAN],
    minHeightCm: 160,
    maxHeightCm: 180,
    preferredProfessions: [],
    typeDescriptor: "climbing indie music coffee",
  },
  stats: {
    age: 25,
    gender: Gender.MAN,
    profession: "engineer",
    heightCm: 180,
  },
};

const WOMAN: CandidateProfile = {
  userId: "w1",
  isAiBacked: false,
  preferences: {
    minAge: 22,
    maxAge: 30,
    preferredGenders: [Gender.MAN],
    minHeightCm: 170,
    maxHeightCm: 195,
    preferredProfessions: [],
    typeDescriptor: "climbing indie music coffee",
  },
  stats: {
    age: 25,
    gender: Gender.WOMAN,
    profession: "designer",
    heightCm: 175,
  },
};

function ctxWithHistory(
  entry: PairHistoryEntry | null,
): SelectorContext {
  const pairHistory = new Map<string, PairHistoryEntry>();
  if (entry) pairHistory.set(pairKey(MAN.userId, WOMAN.userId), entry);
  return {
    candidates: [MAN, WOMAN],
    matchedTodayPairs: new Set(),
    pairHistory,
  };
}

function selectorAcceptsPair(
  entry: PairHistoryEntry | null,
  cooldownOverride?: number,
): boolean {
  const matches = selectDailyMatches(
    TODAY,
    ctxWithHistory(entry),
    cooldownOverride !== undefined
      ? { rematchCooldownDays: cooldownOverride }
      : undefined,
  );
  return matches.length === 1;
}

function predicateAcceptsPair(
  entry: PairHistoryEntry | null,
  cooldownOverride?: number,
): boolean {
  return isEligibleForRematch({
    history: entry,
    today: TODAY,
    config:
      cooldownOverride !== undefined
        ? { rematchCooldownDays: cooldownOverride }
        : undefined,
  }).eligible;
}

// Sanity: the chosen fixtures DO match when there's no history. If
// this drifts (e.g. scoring weights change), the rest of the file is
// vacuous, so guard it explicitly.
describe("rematch contract — fixtures sanity", () => {
  it("the chosen pair scores high enough to be selected with no history", () => {
    expect(selectorAcceptsPair(null)).toBe(true);
    expect(predicateAcceptsPair(null)).toBe(true);
  });
});

describe("rematch contract — selector and isEligibleForRematch agree", () => {
  // Walk lastMatchedOn from 30 days ago through tomorrow. With the
  // default 14-day cooldown this exercises both sides of the boundary,
  // the boundary day itself, and the "future timestamp" edge.
  const offsets = [-30, -15, -14, -13, -1, 0, 1];

  for (const days of offsets) {
    for (const hasDiscard of [false, true]) {
      it(`agrees: lastMatched ${days}d from today, hasDiscard=${hasDiscard}`, () => {
        const last = new Date(TODAY);
        last.setUTCDate(last.getUTCDate() + days);
        const entry: PairHistoryEntry = {
          lastMatchedOn: toDateKey(last),
          hasDiscard,
          matchCount: 1,
        };
        expect(selectorAcceptsPair(entry)).toBe(predicateAcceptsPair(entry));
      });
    }
  }

  it("agrees on the null/never-matched case", () => {
    expect(selectorAcceptsPair(null)).toBe(predicateAcceptsPair(null));
  });

  it("agrees under a tightened cooldown override (rematchCooldownDays=2)", () => {
    // 3 days ago + cooldown=2 → eligible on both sides.
    const last = new Date(TODAY);
    last.setUTCDate(last.getUTCDate() - 3);
    const entry: PairHistoryEntry = {
      lastMatchedOn: toDateKey(last),
      hasDiscard: false,
      matchCount: 1,
    };
    expect(selectorAcceptsPair(entry, 2)).toBe(true);
    expect(predicateAcceptsPair(entry, 2)).toBe(true);
    expect(selectorAcceptsPair(entry, 2)).toBe(predicateAcceptsPair(entry, 2));
  });

  it("agrees under a relaxed cooldown override (rematchCooldownDays=60)", () => {
    // 30 days ago + cooldown=60 → ineligible on both sides.
    const last = new Date(TODAY);
    last.setUTCDate(last.getUTCDate() - 30);
    const entry: PairHistoryEntry = {
      lastMatchedOn: toDateKey(last),
      hasDiscard: false,
      matchCount: 1,
    };
    expect(selectorAcceptsPair(entry, 60)).toBe(false);
    expect(predicateAcceptsPair(entry, 60)).toBe(false);
    expect(selectorAcceptsPair(entry, 60)).toBe(predicateAcceptsPair(entry, 60));
  });

  it("agrees that hasDiscard is permanent regardless of how long ago", () => {
    // Even 30 days ago with default cooldown=14, a discard blocks.
    const last = new Date(TODAY);
    last.setUTCDate(last.getUTCDate() - 30);
    const entry: PairHistoryEntry = {
      lastMatchedOn: toDateKey(last),
      hasDiscard: true,
      matchCount: 1,
    };
    expect(selectorAcceptsPair(entry)).toBe(false);
    expect(predicateAcceptsPair(entry)).toBe(false);
  });
});
