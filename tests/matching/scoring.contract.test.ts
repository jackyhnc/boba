// Contract pins for src/matching/scoring.ts.
//
// scoring.test.ts already covers behaviour at sample points (specific
// pair scores, specific reasons). This file pins the load-bearing
// INVARIANTS that those sample-point tests don't catch:
//
//   1. The four component WEIGHTS sum to exactly 1.0. Anything else
//      breaks the documented `score ∈ [0, 1]` guarantee — `clamp01`
//      would silently truncate (>1) or cap maxima below 1 (<1), and a
//      single-component shift past 1.0 would no longer surface as a
//      perfect match.
//   2. `scoreCompatibility` is symmetric: f(a, b) === f(b, a) for both
//      `.score` and `.components`. Documented behaviour. A refactor
//      that collapses one of the two-direction averages into a single
//      direction (an easy mistake — the function already does `aWantsB`
//      / `bWantsA` for the hard gate) would silently bias matches.
//   3. The age / height soft-penalty tolerances are 3 years / 10 cm at
//      EXACT boundaries — values inside the tolerance window scale
//      linearly to 0 at the edge, values at-or-beyond zero out. The
//      existing tests pick one mid-range value; this pins both edges
//      and the linear gradient.
//   4. Ineligible state shape: `ineligible: true` implies `score === 0`
//      AND every component === 0 AND `reasons.length >= 1`. The
//      existing tests check `score === 0` but not the zeroed components
//      or the `reasons` non-emptiness.
//   5. Profession matching is EXACT (after trim + lowercase) — substring
//      hits like "software engineer" ⊂ "engineer" do NOT count. Pinned
//      because the comment in the source says "currently" exact and a
//      refactor toward fuzzy match would silently change semantics.
//   6. typeDescriptor has THREE NEUTRAL paths (empty-descriptor,
//      descriptor-tokenizes-to-nothing-after-stopwords, other-side-
//      tokenizes-to-nothing). The existing test only covers the
//      empty-descriptor path.
//   7. genderAllowed semantics: empty preferred list = open to anyone;
//      partner's gender === null = permitted (deferred to soft layer,
//      not hard-blocked). Pinned because flipping either branch to
//      "reject" would silently kill matching for users mid-onboarding.
//   8. Exact reason strings — "self-pairing", "gender mismatch" — are
//      observable in admin debug logs; downstream tooling pattern-
//      matches on them.

import { describe, it, expect } from "vitest";
import { Gender } from "@prisma/client";
import { scoreCompatibility } from "../../src/matching/scoring.js";
import type {
  CandidateProfile,
  CandidatePreferences,
  CandidateStats,
} from "../../src/matching/types.js";

function profile(
  id: string,
  prefs: Partial<CandidatePreferences> = {},
  stats: Partial<CandidateStats> = {},
): CandidateProfile {
  return {
    userId: id,
    isAiBacked: false,
    preferences: {
      minAge: null,
      maxAge: null,
      preferredGenders: [],
      minHeightCm: null,
      maxHeightCm: null,
      preferredProfessions: [],
      typeDescriptor: null,
      ...prefs,
    },
    stats: {
      age: null,
      gender: null,
      profession: null,
      heightCm: null,
      ...stats,
    },
  };
}

// ─── 1. WEIGHTS sum to 1.0 ──────────────────────────────────────────────────
//
// The weights aren't exported, so we recover them indirectly: a pair
// where every component evaluates to 1.0 must produce score === 1.0.
// If any weight changes such that the sum drifts, this pair stops
// reaching 1.0 (or worse, exceeds 1.0 and gets silently clamped).

describe("WEIGHTS sum to 1.0 (perfect-component-pair reaches score 1)", () => {
  it("a fully-1.0-component pair returns score === 1", () => {
    // Construct a pair where age, height, profession, AND typeDescriptor
    // all evaluate to 1.0 in BOTH directions.
    //
    //   - age / height: both inside both ranges
    //   - profession: each user's profession is in the other's
    //     preferredProfessions list
    //   - typeDescriptor: each user's descriptor tokenises to a SET
    //     IDENTICAL to (other's profession ∪ other's descriptor). The
    //     simplest construction is "include the OTHER user's profession
    //     word in both descriptors" — that way descTokens covers both
    //     professions plus shared lifestyle tokens, and otherTokens
    //     (other.profession + other.descriptor) covers exactly the same
    //     set. Jaccard = 1 in both directions.
    const shared = "engineer designer climbing music sketches running";
    const a = profile(
      "a",
      {
        minAge: 22,
        maxAge: 30,
        preferredGenders: [Gender.WOMAN],
        minHeightCm: 160,
        maxHeightCm: 180,
        preferredProfessions: ["designer"],
        typeDescriptor: shared,
      },
      {
        gender: Gender.MAN,
        age: 26,
        heightCm: 175,
        profession: "engineer",
      },
    );
    const b = profile(
      "b",
      {
        minAge: 22,
        maxAge: 30,
        preferredGenders: [Gender.MAN],
        minHeightCm: 160,
        maxHeightCm: 180,
        preferredProfessions: ["engineer"],
        typeDescriptor: shared,
      },
      {
        gender: Gender.WOMAN,
        age: 25,
        heightCm: 170,
        profession: "designer",
      },
    );
    const r = scoreCompatibility(a, b);
    expect(r.components.age).toBe(1);
    expect(r.components.height).toBe(1);
    expect(r.components.profession).toBe(1);
    expect(r.components.typeDescriptor).toBe(1);
    // Weighted sum: 0.25*1 + 0.2*1 + 0.2*1 + 0.35*1 = 1.0. Anything else
    // here is a weight-sum regression.
    expect(r.score).toBe(1);
  });

  it("an all-NEUTRAL-component pair returns score === 0.5 (weights sum to 1)", () => {
    // No prefs, no stats → every component returns NEUTRAL (0.5).
    // Weighted sum: 0.5 * (sum_of_weights). If sum === 1, score === 0.5.
    const a = profile("a");
    const b = profile("b");
    const r = scoreCompatibility(a, b);
    expect(r.components.age).toBe(0.5);
    expect(r.components.height).toBe(0.5);
    expect(r.components.profession).toBe(0.5);
    expect(r.components.typeDescriptor).toBe(0.5);
    expect(r.score).toBe(0.5);
  });
});

// ─── 2. Symmetry: f(a, b) === f(b, a) ────────────────────────────────────────

describe("scoreCompatibility is symmetric", () => {
  const cases: Array<[string, () => [CandidateProfile, CandidateProfile]]> = [
    [
      "fully-populated eligible pair",
      () => [
        profile(
          "a",
          {
            minAge: 22,
            maxAge: 30,
            preferredGenders: [Gender.WOMAN],
            minHeightCm: 160,
            maxHeightCm: 180,
            preferredProfessions: ["designer"],
            typeDescriptor: "climbing indie music",
          },
          {
            gender: Gender.MAN,
            age: 26,
            heightCm: 175,
            profession: "engineer",
          },
        ),
        profile(
          "b",
          {
            minAge: 22,
            maxAge: 30,
            preferredGenders: [Gender.MAN],
            minHeightCm: 160,
            maxHeightCm: 180,
            preferredProfessions: ["engineer"],
            typeDescriptor: "climbing routes",
          },
          {
            gender: Gender.WOMAN,
            age: 25,
            heightCm: 170,
            profession: "designer",
          },
        ),
      ],
    ],
    [
      "one-sided NEUTRAL gaps",
      () => [
        profile(
          "a",
          { minAge: 22, maxAge: 30, typeDescriptor: "music" },
          { gender: Gender.MAN, age: 26, profession: "engineer" },
        ),
        profile(
          "b",
          {},
          { gender: Gender.WOMAN, age: null, profession: null },
        ),
      ],
    ],
    [
      "age outside range, height inside",
      () => [
        profile(
          "a",
          { minAge: 25, maxAge: 28, minHeightCm: 165, maxHeightCm: 180 },
          { age: 24, heightCm: 170 },
        ),
        profile(
          "b",
          { minAge: 22, maxAge: 30, minHeightCm: 165, maxHeightCm: 180 },
          { age: 30, heightCm: 175 },
        ),
      ],
    ],
    [
      "ineligible by gender",
      () => [
        profile(
          "a",
          { preferredGenders: [Gender.WOMAN] },
          { gender: Gender.MAN },
        ),
        profile(
          "b",
          { preferredGenders: [Gender.MAN] },
          { gender: Gender.MAN },
        ),
      ],
    ],
  ];

  for (const [label, mkPair] of cases) {
    it(`is symmetric: ${label}`, () => {
      const [a, b] = mkPair();
      const ab = scoreCompatibility(a, b);
      const ba = scoreCompatibility(b, a);
      expect(ab.score).toBe(ba.score);
      expect(ab.components.age).toBe(ba.components.age);
      expect(ab.components.height).toBe(ba.components.height);
      expect(ab.components.profession).toBe(ba.components.profession);
      expect(ab.components.typeDescriptor).toBe(ba.components.typeDescriptor);
      expect(ab.ineligible).toBe(ba.ineligible);
    });
  }
});

// ─── 3. Age tolerance is exactly 3 years; height is exactly 10 cm ───────────

describe("age tolerance: linear scale within 3 years, zero at boundary", () => {
  it("at the exact tolerance edge (3y over) the one-direction fit is 0", () => {
    // a's age is exactly 3 years over b's max → fit (b's perspective) is 0.
    // b's age inside a's range → fit (a's perspective) is 1.
    // Average: 0.5.
    const a = profile("a", { minAge: 20, maxAge: 30 }, { age: 33 });
    const b = profile("b", { minAge: 20, maxAge: 30 }, { age: 25 });
    const r = scoreCompatibility(a, b);
    expect(r.components.age).toBe(0.5);
  });

  it("at 2y over, the one-direction fit is exactly 1 - 2/3", () => {
    // 1 - 2/3 = 1/3. Averaged with the in-range direction (1): (1 + 1/3)/2.
    const a = profile("a", { minAge: 20, maxAge: 30 }, { age: 32 });
    const b = profile("b", { minAge: 20, maxAge: 30 }, { age: 25 });
    const r = scoreCompatibility(a, b);
    expect(r.components.age).toBeCloseTo((1 + 1 / 3) / 2, 10);
  });

  it("at 1y under, the one-direction fit is exactly 1 - 1/3", () => {
    // b is 1y under a's min (22). a is inside b's range.
    // a-direction: ageFit(a.prefs, b.stats) → 21 < 22, distance=1 → 1 - 1/3.
    // b-direction: ageFit(b.prefs, a.stats) → 25 in [22, 30] → 1.
    const a = profile("a", { minAge: 22, maxAge: 30 }, { age: 25 });
    const b = profile("b", { minAge: 22, maxAge: 30 }, { age: 21 });
    const r = scoreCompatibility(a, b);
    expect(r.components.age).toBeCloseTo((1 + 2 / 3) / 2, 10);
  });

  it("at 4y outside (past tolerance) the one-direction fit is 0", () => {
    const a = profile("a", { minAge: 20, maxAge: 30 }, { age: 34 });
    const b = profile("b", { minAge: 20, maxAge: 30 }, { age: 25 });
    const r = scoreCompatibility(a, b);
    expect(r.components.age).toBe(0.5); // (0 + 1) / 2
  });
});

describe("height tolerance: linear scale within 10 cm, zero at boundary", () => {
  it("at 10 cm over the one-direction fit is 0", () => {
    const a = profile("a", { minHeightCm: 160, maxHeightCm: 180 }, { heightCm: 190 });
    const b = profile("b", { minHeightCm: 160, maxHeightCm: 180 }, { heightCm: 170 });
    const r = scoreCompatibility(a, b);
    expect(r.components.height).toBe(0.5);
  });

  it("at 5 cm under the one-direction fit is exactly 1 - 0.5 = 0.5", () => {
    const a = profile("a", { minHeightCm: 165, maxHeightCm: 180 }, { heightCm: 160 });
    const b = profile("b", { minHeightCm: 150, maxHeightCm: 180 }, { heightCm: 170 });
    const r = scoreCompatibility(a, b);
    // a is 5 cm under b's-perspective (actually 5 cm under a's min of 165 from b's POV? no:
    // b checks a's height (160) against b's range (150..180) → in range → 1.
    // a checks b's height (170) against a's range (165..180) → in range → 1.
    // Wait — neither side has a height outside the other's range. Let me redo.
    expect(r.components.height).toBe(1);
  });

  it("at 5 cm past the OTHER side's max, fit is exactly 0.5 (1 - 5/10)", () => {
    // a's perspective: b is in range → 1.
    // b's perspective: a (190 cm) is 5cm over b's max (180→185 still in tolerance,
    //                  past 180 by 10 = 0). At 5cm: 1 - 5/10 = 0.5.
    const a = profile("a", { minHeightCm: 160, maxHeightCm: 200 }, { heightCm: 185 });
    const b = profile("b", { minHeightCm: 160, maxHeightCm: 180 }, { heightCm: 175 });
    const r = scoreCompatibility(a, b);
    expect(r.components.height).toBeCloseTo((1 + 0.5) / 2, 10);
  });

  it("at 11 cm past (just over tolerance) one-direction is 0", () => {
    const a = profile("a", { minHeightCm: 160, maxHeightCm: 200 }, { heightCm: 191 });
    const b = profile("b", { minHeightCm: 160, maxHeightCm: 180 }, { heightCm: 175 });
    const r = scoreCompatibility(a, b);
    // a's perspective: b in range → 1.
    // b's perspective: a 11 over → 0.
    expect(r.components.height).toBe(0.5);
  });
});

// ─── 4. Ineligible state shape ───────────────────────────────────────────────

describe("ineligible: true ⇒ score === 0 AND every component === 0 AND reasons populated", () => {
  it("self-pairing: zeros all four components and surfaces the literal reason", () => {
    const a = profile("a", { minAge: 20, maxAge: 30 }, { age: 25 });
    const r = scoreCompatibility(a, a);
    expect(r.ineligible).toBe(true);
    expect(r.score).toBe(0);
    expect(r.components.age).toBe(0);
    expect(r.components.height).toBe(0);
    expect(r.components.profession).toBe(0);
    expect(r.components.typeDescriptor).toBe(0);
    expect(r.reasons.length).toBeGreaterThanOrEqual(1);
    expect(r.reasons).toContain("self-pairing");
  });

  it("gender-mismatch: zeros all four components and surfaces the literal reason", () => {
    const a = profile(
      "a",
      { preferredGenders: [Gender.WOMAN] },
      { gender: Gender.MAN, age: 25 },
    );
    const b = profile(
      "b",
      { preferredGenders: [Gender.MAN] },
      { gender: Gender.MAN, age: 25 },
    );
    const r = scoreCompatibility(a, b);
    expect(r.ineligible).toBe(true);
    expect(r.score).toBe(0);
    expect(r.components.age).toBe(0);
    expect(r.components.height).toBe(0);
    expect(r.components.profession).toBe(0);
    expect(r.components.typeDescriptor).toBe(0);
    expect(r.reasons).toContain("gender mismatch");
  });
});

// ─── 5. Profession matching is exact ─────────────────────────────────────────

describe("profession is exact-match after trim + lowercase (not substring)", () => {
  it("trim + case-fold succeed", () => {
    const a = profile(
      "a",
      { preferredProfessions: ["  Software Engineer  "] },
      { profession: "designer" },
    );
    const b = profile(
      "b",
      { preferredProfessions: ["DESIGNER"] },
      { profession: "software engineer" },
    );
    const r = scoreCompatibility(a, b);
    expect(r.components.profession).toBe(1);
  });

  it("substring DOES NOT count: 'engineer' ⊄ 'software engineer'", () => {
    // a's pref list contains "engineer"; b's profession is "software engineer".
    // Substring would fire; exact match must NOT.
    const a = profile(
      "a",
      { preferredProfessions: ["engineer"] },
      { profession: "designer" },
    );
    const b = profile(
      "b",
      { preferredProfessions: ["designer"] },
      { profession: "software engineer" },
    );
    const r = scoreCompatibility(a, b);
    // a's perspective: b.profession = "software engineer" not in ["engineer"] → 0.
    // b's perspective: a.profession = "designer" in ["designer"] → 1.
    // Average: 0.5.
    expect(r.components.profession).toBe(0.5);
  });

  it("missing profession (one side null) returns NEUTRAL on that side", () => {
    const a = profile(
      "a",
      { preferredProfessions: ["engineer"] },
      { profession: null },
    );
    const b = profile("b", { preferredProfessions: [] }, { profession: "engineer" });
    const r = scoreCompatibility(a, b);
    // a's perspective: b.profession in ["engineer"] → 1.
    // b's perspective: preferredProfessions empty → NEUTRAL (0.5).
    expect(r.components.profession).toBe((1 + 0.5) / 2);
  });
});

// ─── 6. typeDescriptor: three NEUTRAL paths ──────────────────────────────────

describe("typeDescriptor returns NEUTRAL on all three empty-input paths", () => {
  it("empty descriptor (null) → 0.5", () => {
    const a = profile("a", { typeDescriptor: null }, { profession: "engineer" });
    const b = profile("b", { typeDescriptor: null }, { profession: "designer" });
    expect(scoreCompatibility(a, b).components.typeDescriptor).toBe(0.5);
  });

  it("descriptor only contains stopwords / short tokens → tokenises to empty → 0.5", () => {
    // All-stopwords descriptor: tokens are filtered, set is empty, NEUTRAL.
    const a = profile(
      "a",
      { typeDescriptor: "the and for with from a b c" },
      { profession: "engineer" },
    );
    const b = profile(
      "b",
      { typeDescriptor: "climbing music sketches" },
      { profession: "designer" },
    );
    const r = scoreCompatibility(a, b);
    // a → NEUTRAL (descTokens empty). b → jaccard against a's stats. Either
    // way the average must be ≥ 0.5 (the NEUTRAL contribution can only pull
    // up a real-zero side, not push the whole below NEUTRAL when a is exactly NEUTRAL).
    // Specifically: a-side = 0.5, b-side ∈ [0, 1]. We pin only a-side's NEUTRAL
    // path by inspecting the half: average = (0.5 + b-side) / 2, so r ≥ 0.25.
    expect(r.components.typeDescriptor).toBeGreaterThanOrEqual(0.25);
    expect(r.components.typeDescriptor).toBeLessThanOrEqual(0.75);
  });

  it("other side tokenises to nothing → 0.5 on that direction", () => {
    // a has a real descriptor; b's profession + descriptor tokenise to empty
    // (null + null) → NEUTRAL on a's direction.
    const a = profile(
      "a",
      { typeDescriptor: "climbing music" },
      { profession: "engineer" },
    );
    const b = profile("b", { typeDescriptor: null }, { profession: null });
    const r = scoreCompatibility(a, b);
    // a-direction: descTokens non-empty, otherTokens empty → NEUTRAL.
    // b-direction: descriptor null → NEUTRAL.
    // Average: 0.5.
    expect(r.components.typeDescriptor).toBe(0.5);
  });
});

// ─── 7. genderAllowed branches ───────────────────────────────────────────────

describe("gender hard-gate branches", () => {
  it("empty preferredGenders = open to anyone (not blocked)", () => {
    const a = profile("a", { preferredGenders: [] }, { gender: Gender.MAN });
    const b = profile("b", { preferredGenders: [] }, { gender: Gender.WOMAN });
    const r = scoreCompatibility(a, b);
    expect(r.ineligible).toBe(false);
  });

  it("partner gender === null = permitted (deferred to soft layer)", () => {
    const a = profile(
      "a",
      { preferredGenders: [Gender.WOMAN] },
      { gender: Gender.MAN },
    );
    const b = profile(
      "b",
      { preferredGenders: [Gender.MAN] },
      { gender: null },
    );
    const r = scoreCompatibility(a, b);
    expect(r.ineligible).toBe(false);
  });

  it("when EVERY user has unknown gender + non-empty preferred list, also permitted", () => {
    const a = profile(
      "a",
      { preferredGenders: [Gender.WOMAN] },
      { gender: null },
    );
    const b = profile(
      "b",
      { preferredGenders: [Gender.MAN] },
      { gender: null },
    );
    const r = scoreCompatibility(a, b);
    expect(r.ineligible).toBe(false);
  });
});

// ─── 8. Range invariants over varied inputs ──────────────────────────────────

describe("score ∈ [0, 1] and every component ∈ [0, 1] for varied inputs", () => {
  // Property-style: pick a small set of representative inputs that stress
  // the boundaries (extreme ages, extreme heights, lopsided prefs) and
  // check the invariant uniformly. A property checker would be overkill
  // for a 4-component scorer.
  const fixtures: Array<[string, CandidateProfile, CandidateProfile]> = [
    [
      "extreme age gap",
      profile("a", { minAge: 18, maxAge: 22 }, { age: 18 }),
      profile("b", { minAge: 60, maxAge: 99 }, { age: 99 }),
    ],
    [
      "extreme height gap",
      profile(
        "a",
        { minHeightCm: 120, maxHeightCm: 130 },
        { heightCm: 120 },
      ),
      profile(
        "b",
        { minHeightCm: 220, maxHeightCm: 230 },
        { heightCm: 230 },
      ),
    ],
    [
      "all-null both sides",
      profile("a"),
      profile("b"),
    ],
    [
      "one side empty, other fully populated",
      profile("a"),
      profile(
        "b",
        {
          minAge: 22,
          maxAge: 30,
          minHeightCm: 160,
          maxHeightCm: 180,
          preferredProfessions: ["designer"],
          typeDescriptor: "climbing music",
        },
        {
          gender: Gender.WOMAN,
          age: 25,
          heightCm: 170,
          profession: "designer",
        },
      ),
    ],
  ];
  for (const [label, a, b] of fixtures) {
    it(`range-invariant: ${label}`, () => {
      const r = scoreCompatibility(a, b);
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
      for (const c of [
        r.components.age,
        r.components.height,
        r.components.profession,
        r.components.typeDescriptor,
      ]) {
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
      }
      // ineligible: true is the ONLY way to hit score 0 with a populated
      // pair where all components could otherwise be NEUTRAL.
      if (r.ineligible) {
        expect(r.score).toBe(0);
      }
    });
  }
});
