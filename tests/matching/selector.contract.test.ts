// Contract pins for src/matching/selector.ts.
//
// selector.test.ts already covers behaviour at sample points
// (cooldown, discard-block, minScore, greedy ordering on a single
// crafted example, gender mismatch, canonical A<B output). This file
// pins the load-bearing INVARIANTS that those sample-point tests
// don't catch:
//
//   1. Tiebreaker is (score desc, userAId asc, userBId asc) — exact.
//      Determinism is what makes the daily-match job idempotent /
//      replayable. A refactor that swaps to `Math.random()`,
//      insertion order, or a different lexicographic order would
//      change which candidate gets paired with which on equal-score
//      days without changing any sample-point behaviour.
//
//   2. `pairKey` separator is the literal "|" character. The DB
//      query layer (`prisma-deps.ts`), the in-memory
//      `matchedTodayPairs` set, the `pairHistory` map keys, and
//      grep-friendly debug logs all assume this exact format. A
//      refactor to `:` or `,` would break cross-module joins
//      silently because both sides would still use whatever the
//      helper returns, but persisted state from before the change
//      would no longer match.
//
//   3. `pairKey` throws on self-pair, surfacing the `orderPair`
//      contract at the selector's exported surface. A refactor that
//      catches+returns a sentinel would let upstream callers
//      accidentally write self-pair rows.
//
//   4. `toDateKey` uses UTC date components, not local. Verified
//      with `new Date(0)` — the Unix epoch is UTC midnight regardless
//      of the system TZ, so getUTCFullYear/Month/Date return 1970/01/01
//      everywhere. `getFullYear/Month/Date` would return 1969-12-31
//      in any Americas timezone — the test would fail on a US dev
//      box but pass on a UTC CI runner, exactly the kind of silent
//      drift this pin prevents.
//
//   5. `dayDiff` is signed (negative when b < a), rounds to integer,
//      ignores time-of-day in the date strings. Sample-points cover
//      the 7 / 0 / -1 cases; this file adds the multi-month wrap
//      and the year boundary as additional anchors.
//
//   6. `DEFAULT_SELECTOR_CONFIG` exact values: `rematchCooldownDays: 14`,
//      `minScore: 0.3`. These are the production defaults that
//      drive daily-match behaviour for every campus. The existing
//      tests pass overrides explicitly or pick fixtures that
//      happen to clear/fail the defaults; none asserts the literal
//      values, so a "tune the cooldown" change would slip through.
//
//   7. `configOverrides` is shallow-merged into the default.
//      Passing `{ minScore: 0 }` keeps `rematchCooldownDays: 14`.
//      A refactor that replaces the spread with `overrides ?? DEFAULT`
//      (a plausible "cleanup") would silently zero the cooldown
//      whenever any override is passed.
//
//   8. Selection is independent of `ctx.candidates` array order.
//      Greedy assignment ranks pairs by score after the full O(n²)
//      enumeration, so insertion order of `candidates` must not
//      affect the chosen matches. A refactor that short-circuits
//      the inner loop on first claim ("if a is already claimed,
//      skip") would silently make selection order-dependent.
//
//   9. `hasDiscard: true` is a HARD block independent of cooldown:
//      even a pair last matched ten years ago stays blocked. The
//      existing test uses a recent date so the cooldown and the
//      discard gate both happen to fire; this file isolates the
//      discard gate by using an ancient `lastMatchedOn`.
//
//  10. Returned `SelectedMatch` objects do NOT leak the internal
//      `reasons: string[]` field used during sorting. The public
//      type promises `{ userAId, userBId, score }` — a refactor
//      that returns `scored` directly (skipping the explicit
//      remap) would silently expand the shape and add bloat to
//      every downstream serializer.

import { describe, it, expect } from "vitest";
import { Gender } from "@prisma/client";
import {
  selectDailyMatches,
  pairKey,
  toDateKey,
  dayDiff,
} from "../../src/matching/selector.js";
import {
  DEFAULT_SELECTOR_CONFIG,
  type CandidateProfile,
  type PairHistoryEntry,
  type SelectorContext,
} from "../../src/matching/types.js";

function person(
  id: string,
  gender: Gender,
  prefersGender: Gender,
  descriptor = "climbing indie music",
): CandidateProfile {
  return {
    userId: id,
    isAiBacked: false,
    preferences: {
      minAge: 22,
      maxAge: 30,
      preferredGenders: [prefersGender],
      minHeightCm: null,
      maxHeightCm: null,
      preferredProfessions: [],
      typeDescriptor: descriptor,
    },
    stats: {
      age: 25,
      gender,
      profession: "engineer",
      heightCm: 175,
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

const TODAY = new Date(Date.UTC(2026, 4, 17));

// ─── 1. Tiebreaker is exactly (score desc, userAId asc, userBId asc) ─────────
//
// Construct a deliberately-tied scenario: four users where every
// cross-gender pair scores identically. The greedy algorithm must
// then break ties on userAId asc, then userBId asc. If we feed in
// ids a/b/c/d where a<b<c<d lexicographically, the first claimed
// pair must be (a, b)-shaped — specifically the lex-smallest A
// from the candidate set paired with its lex-smallest legal partner.

describe("greedy tiebreaker uses (score desc, userAId asc, userBId asc) exactly", () => {
  it("equal-score pairs resolve to the lexicographically smallest A first", () => {
    // All four users have identical prefs and stats → every legal
    // cross-gender pair scores the same. Ids chosen so canonical
    // ordering is unambiguous: "a" < "b" < "c" < "d".
    const m_a = person("a-man", Gender.MAN, Gender.WOMAN);
    const m_c = person("c-man", Gender.MAN, Gender.WOMAN);
    const w_b = person("b-woman", Gender.WOMAN, Gender.MAN);
    const w_d = person("d-woman", Gender.WOMAN, Gender.MAN);

    const matches = selectDailyMatches(TODAY, ctx([m_a, m_c, w_b, w_d]));
    expect(matches).toHaveLength(2);

    // All four legal pairs score equal; the sort breaks ties by
    // userAId asc. The smallest userAId across legal pairs is
    // "a-man" (paired canonically as A with both "b-woman" and
    // "d-woman"). Between those two, userBId asc picks "b-woman".
    expect(matches[0]).toEqual({
      userAId: "a-man",
      userBId: "b-woman",
      score: matches[0]!.score,
    });
    // The remaining pair claims the leftovers: (c-man, d-woman).
    expect(matches[1]).toEqual({
      userAId: "c-man",
      userBId: "d-woman",
      score: matches[1]!.score,
    });
  });

  it("two equally-good first-pair options break on userBId asc", () => {
    // m_z is the lex-largest userAId. Pair it with w_a or w_b — both
    // legal, both equally scored. canonical orderPair puts the smaller
    // id as A, so both pairs become (a-woman, z-man) and (b-woman, z-man)
    // — same userAId column ("z-man" is always B). Wait — canonical
    // is "a-woman" < "z-man" alphabetically? Yes: 'a' < 'z'. So
    // canonical A is the woman in both pairs. Tiebreaker on B picks
    // "z-man" (only option), then on A (a-woman vs b-woman) picks
    // "a-woman".
    const w_a = person("a-woman", Gender.WOMAN, Gender.MAN);
    const w_b = person("b-woman", Gender.WOMAN, Gender.MAN);
    const m_z = person("z-man", Gender.MAN, Gender.WOMAN);
    const matches = selectDailyMatches(TODAY, ctx([w_a, w_b, m_z]));
    expect(matches).toHaveLength(1);
    expect(matches[0]).toEqual({
      userAId: "a-woman",
      userBId: "z-man",
      score: matches[0]!.score,
    });
  });
});

// ─── 2. pairKey literal "|" separator ───────────────────────────────────────

describe("pairKey separator is exactly the '|' character", () => {
  it("emits 'A|B' with literal pipe, no spaces, no alternatives", () => {
    // Pin the exact string. A refactor that uses '::', '/', or
    // template-stringification of an object would change this.
    expect(pairKey("alpha", "beta")).toBe("alpha|beta");
    expect(pairKey("beta", "alpha")).toBe("alpha|beta");
  });

  it("preserves the literal ids on each side of the pipe (no encoding)", () => {
    // ids in this codebase are cuids/uuids; pin that no URL-encoding
    // or trimming happens. The persistence layer keys on the raw
    // user.id, so any normalisation here would create lookup misses.
    expect(pairKey("user_AB-12", "user_CD-34")).toBe("user_AB-12|user_CD-34");
  });
});

// ─── 3. pairKey throws on self-pair ─────────────────────────────────────────

describe("pairKey throws on self-pair (orderPair contract surfaced)", () => {
  it("throws synchronously with a message that includes the id", () => {
    expect(() => pairKey("user_self", "user_self")).toThrow(/user_self/);
  });
});

// ─── 4. toDateKey uses UTC, verified against the Unix epoch ─────────────────

describe("toDateKey uses UTC components (TZ-independent)", () => {
  it("Date(0) formats as 1970-01-01 regardless of system timezone", () => {
    // new Date(0) is UTC midnight Jan 1 1970. UTC component getters
    // return 1970/0/1 everywhere; LOCAL getters return 1969-12-31
    // in any negative-UTC-offset timezone. This is the cleanest
    // possible pin against an accidental drop of the UTC prefix.
    expect(toDateKey(new Date(0))).toBe("1970-01-01");
  });

  it("zero-pads month and day to two digits", () => {
    expect(toDateKey(new Date(Date.UTC(2026, 0, 5)))).toBe("2026-01-05");
    expect(toDateKey(new Date(Date.UTC(2026, 8, 9)))).toBe("2026-09-09");
  });

  it("emits YYYY-MM-DD shape (4-2-2 digits joined by '-')", () => {
    // Note: passing 99 to Date.UTC is interpreted as 1999 (legacy
    // two-digit-year quirk on the JS Date constructor), so the
    // sub-1000 padStart branch isn't reachable from app code. We
    // still pin the literal shape so a refactor that drops the
    // separator or pads to a different width is caught.
    const key = toDateKey(new Date(Date.UTC(2026, 11, 31)));
    expect(key).toBe("2026-12-31");
    expect(key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ─── 5. dayDiff: signedness, integer rounding, multi-month wrap ─────────────

describe("dayDiff sign and rounding contract", () => {
  it("is signed: b < a returns a negative integer", () => {
    expect(dayDiff("2026-05-20", "2026-05-15")).toBe(-5);
  });

  it("crosses month boundaries correctly", () => {
    // 2026 is not a leap year; Feb has 28 days. Jan 1 to Mar 1 = 59 days.
    expect(dayDiff("2026-01-01", "2026-03-01")).toBe(59);
  });

  it("crosses year boundaries correctly", () => {
    expect(dayDiff("2025-12-31", "2026-01-01")).toBe(1);
  });

  it("returns an integer (no fractional days from DST)", () => {
    // UTC-only construction is the reason there's no DST drift.
    // Pin the integer guarantee against a future refactor that
    // switches to local Date construction.
    const d = dayDiff("2026-03-07", "2026-03-09");
    expect(Number.isInteger(d)).toBe(true);
    expect(d).toBe(2);
  });
});

// ─── 6. DEFAULT_SELECTOR_CONFIG exact values ────────────────────────────────

describe("DEFAULT_SELECTOR_CONFIG production defaults", () => {
  it("rematchCooldownDays === 14", () => {
    expect(DEFAULT_SELECTOR_CONFIG.rematchCooldownDays).toBe(14);
  });

  it("minScore === 0.3", () => {
    expect(DEFAULT_SELECTOR_CONFIG.minScore).toBe(0.3);
  });

  it("has exactly the two documented keys (no silent expansion)", () => {
    // Pin the shape — adding a new config knob silently changes the
    // override-merge surface and the docs in GOAL.md.
    expect(Object.keys(DEFAULT_SELECTOR_CONFIG).sort()).toEqual(
      ["minScore", "rematchCooldownDays"].sort(),
    );
  });
});

// ─── 7. configOverrides is shallow-merged (not replaced wholesale) ──────────

describe("configOverrides is shallow-merged on top of DEFAULT_SELECTOR_CONFIG", () => {
  it("passing only { minScore } keeps the default rematchCooldownDays", () => {
    // Setup: a pair on cooldown under the DEFAULT (14 days), at 10 days out.
    // If `rematchCooldownDays` were reset to 0 by an override that
    // replaces instead of merging, the pair would be eligible. Pinned
    // by checking it's still excluded after passing { minScore: 0 } only.
    const m1 = person("m1", Gender.MAN, Gender.WOMAN);
    const w1 = person("w1", Gender.WOMAN, Gender.MAN);
    const tenDaysAgo: PairHistoryEntry = {
      lastMatchedOn: "2026-05-07", // 10 days before TODAY (2026-05-17)
      hasDiscard: false,
      matchCount: 1,
    };
    const history = new Map<string, PairHistoryEntry>([
      [pairKey("m1", "w1"), tenDaysAgo],
    ]);
    const matches = selectDailyMatches(
      TODAY,
      ctx([m1, w1], { pairHistory: history }),
      { minScore: 0 },
    );
    expect(matches).toHaveLength(0);
  });

  it("passing only { rematchCooldownDays } keeps the default minScore", () => {
    // Two users crafted to land BELOW the default minScore (0.3) but
    // above zero: ages each ≥3 yrs outside the other's range zeros
    // the age component; orthogonal descriptors zero the descriptor
    // component; null height prefs and empty profession prefs leave
    // both at NEUTRAL (0.5). Weighted: 0.25*0 + 0.2*0.5 + 0.2*0.5 +
    // 0.35*0 = 0.2 < 0.3. If passing { rematchCooldownDays: 0 } also
    // reset minScore to 0, the pair would be selected.
    const m1: CandidateProfile = {
      userId: "m1",
      isAiBacked: false,
      preferences: {
        minAge: 22,
        maxAge: 30,
        preferredGenders: [Gender.WOMAN],
        minHeightCm: null,
        maxHeightCm: null,
        preferredProfessions: [],
        typeDescriptor: "xxx yyy zzz",
      },
      stats: {
        age: 40,
        gender: Gender.MAN,
        profession: "engineer",
        heightCm: null,
      },
    };
    const w1: CandidateProfile = {
      userId: "w1",
      isAiBacked: false,
      preferences: {
        minAge: 22,
        maxAge: 30,
        preferredGenders: [Gender.MAN],
        minHeightCm: null,
        maxHeightCm: null,
        preferredProfessions: [],
        typeDescriptor: "aaa bbb ccc",
      },
      stats: {
        age: 18,
        gender: Gender.WOMAN,
        profession: "designer",
        heightCm: null,
      },
    };
    const matches = selectDailyMatches(TODAY, ctx([m1, w1]), {
      rematchCooldownDays: 0,
    });
    expect(matches).toHaveLength(0);
  });
});

// ─── 8. Selection is independent of `ctx.candidates` array order ────────────

describe("selection is invariant under candidate-array permutation", () => {
  it("shuffling the input produces the same matches (by pair, ignoring order)", () => {
    const a = person("alpha", Gender.MAN, Gender.WOMAN, "climbing indie music");
    const b = person("bravo", Gender.WOMAN, Gender.MAN, "climbing indie music");
    const c = person("charlie", Gender.MAN, Gender.WOMAN, "football beer bbq");
    const d = person("delta", Gender.WOMAN, Gender.MAN, "yoga tea reading");

    const m1 = selectDailyMatches(TODAY, ctx([a, b, c, d]));
    const m2 = selectDailyMatches(TODAY, ctx([d, c, b, a]));
    const m3 = selectDailyMatches(TODAY, ctx([b, d, a, c]));

    const key = (m: { userAId: string; userBId: string }) =>
      `${m.userAId}|${m.userBId}`;
    expect(m1.map(key).sort()).toEqual(m2.map(key).sort());
    expect(m1.map(key).sort()).toEqual(m3.map(key).sort());
  });
});

// ─── 9. hasDiscard is a hard block independent of cooldown ──────────────────

describe("hasDiscard: true blocks the pair regardless of cooldown age", () => {
  it("pair last matched 10 YEARS ago + hasDiscard:true is still excluded", () => {
    const m1 = person("m1", Gender.MAN, Gender.WOMAN);
    const w1 = person("w1", Gender.WOMAN, Gender.MAN);
    const ancient: PairHistoryEntry = {
      lastMatchedOn: "2016-05-17", // far past any conceivable cooldown
      hasDiscard: true,
      matchCount: 3,
    };
    const history = new Map<string, PairHistoryEntry>([
      [pairKey("m1", "w1"), ancient],
    ]);
    expect(
      selectDailyMatches(
        TODAY,
        ctx([m1, w1], { pairHistory: history }),
        // Even with cooldown set to 0, the discard gate must still fire.
        { rematchCooldownDays: 0 },
      ),
    ).toHaveLength(0);
  });
});

// ─── 10. Returned SelectedMatch shape has exactly the three documented keys ─

describe("SelectedMatch return shape is exactly { userAId, userBId, score }", () => {
  it("does not leak the internal `reasons` field used during sorting", () => {
    const m1 = person("m1", Gender.MAN, Gender.WOMAN);
    const w1 = person("w1", Gender.WOMAN, Gender.MAN);
    const matches = selectDailyMatches(TODAY, ctx([m1, w1]));
    expect(matches).toHaveLength(1);
    const result = matches[0]!;
    expect(Object.keys(result).sort()).toEqual(
      ["score", "userAId", "userBId"].sort(),
    );
    // Specifically: no `reasons` array bleed.
    expect("reasons" in result).toBe(false);
  });
});
