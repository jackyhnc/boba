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

describe("scoreCompatibility — hard gates", () => {
  it("rejects self-pairing", () => {
    const a = profile("u1");
    const result = scoreCompatibility(a, a);
    expect(result.ineligible).toBe(true);
    expect(result.score).toBe(0);
  });

  it("rejects pairs when A's gender preference excludes B", () => {
    const a = profile("a", { preferredGenders: [Gender.WOMAN] }, { gender: Gender.MAN });
    const b = profile("b", { preferredGenders: [Gender.MAN] }, { gender: Gender.MAN });
    const result = scoreCompatibility(a, b);
    expect(result.ineligible).toBe(true);
    expect(result.reasons).toContain("gender mismatch");
  });

  it("permits the pair when one side has no gender preference", () => {
    const a = profile("a", { preferredGenders: [] }, { gender: Gender.MAN });
    const b = profile("b", { preferredGenders: [Gender.MAN] }, { gender: Gender.WOMAN });
    const result = scoreCompatibility(a, b);
    expect(result.ineligible).toBe(false);
  });

  it("permits when the other party's gender is unknown", () => {
    const a = profile("a", { preferredGenders: [Gender.WOMAN] }, { gender: Gender.MAN });
    const b = profile("b", { preferredGenders: [Gender.MAN] }, { gender: null });
    const result = scoreCompatibility(a, b);
    expect(result.ineligible).toBe(false);
  });
});

describe("scoreCompatibility — age fit", () => {
  it("scores age inside both preference ranges at 1", () => {
    const a = profile("a", { minAge: 20, maxAge: 30 }, { age: 24 });
    const b = profile("b", { minAge: 22, maxAge: 28 }, { age: 26 });
    const result = scoreCompatibility(a, b);
    expect(result.components.age).toBe(1);
  });

  it("softly penalises ages just outside the range", () => {
    const a = profile("a", { minAge: 25, maxAge: 30 }, { age: 26 });
    const b = profile("b", { minAge: 25, maxAge: 30 }, { age: 32 }); // 2yr over
    const result = scoreCompatibility(a, b);
    // a is 26, inside b's range 25..30 → fit = 1.
    // b is 32, distance 2 over a's max with tolerance 3 → fit = 1 - 2/3 = 1/3.
    // Average: (1 + 1/3) / 2 = 2/3.
    expect(result.components.age).toBeCloseTo((1 + 1 / 3) / 2, 4);
    expect(result.components.age).toBeLessThan(1);
    expect(result.components.age).toBeGreaterThan(0.5);
  });

  it("zeroes age fit when the gap is beyond tolerance", () => {
    const a = profile("a", { minAge: 25, maxAge: 30 }, { age: 27 });
    const b = profile("b", { minAge: 25, maxAge: 30 }, { age: 40 });
    const result = scoreCompatibility(a, b);
    // b way out of a's range; a inside b's range → (0 + 1)/2 = 0.5
    expect(result.components.age).toBe(0.5);
  });

  it("returns neutral 0.5 when age data is missing", () => {
    const a = profile("a", { minAge: 25, maxAge: 30 }, { age: null });
    const b = profile("b", { minAge: 25, maxAge: 30 }, { age: null });
    const result = scoreCompatibility(a, b);
    expect(result.components.age).toBe(0.5);
  });
});

describe("scoreCompatibility — height fit", () => {
  it("rewards heights inside both preference ranges", () => {
    const a = profile("a", { minHeightCm: 160, maxHeightCm: 180 }, { heightCm: 170 });
    const b = profile("b", { minHeightCm: 160, maxHeightCm: 180 }, { heightCm: 175 });
    expect(scoreCompatibility(a, b).components.height).toBe(1);
  });

  it("zeroes height fit when both users are far outside each other's range", () => {
    const a = profile("a", { minHeightCm: 180, maxHeightCm: 200 }, { heightCm: 160 });
    const b = profile("b", { minHeightCm: 180, maxHeightCm: 200 }, { heightCm: 162 });
    const result = scoreCompatibility(a, b);
    expect(result.components.height).toBe(0);
  });
});

describe("scoreCompatibility — profession fit", () => {
  it("returns 1 when each preferred profession includes the other's", () => {
    const a = profile("a", { preferredProfessions: ["engineer"] }, { profession: "Designer" });
    const b = profile("b", { preferredProfessions: ["Designer"] }, { profession: "engineer" });
    expect(scoreCompatibility(a, b).components.profession).toBe(1);
  });

  it("returns 0.5 when no preferred professions are set", () => {
    const a = profile("a", {}, { profession: "engineer" });
    const b = profile("b", {}, { profession: "designer" });
    expect(scoreCompatibility(a, b).components.profession).toBe(0.5);
  });
});

describe("scoreCompatibility — type descriptor overlap", () => {
  it("rewards token overlap", () => {
    const a = profile(
      "a",
      { typeDescriptor: "loves climbing and indie music, runs ultramarathons" },
      { profession: "climber, runs indie music podcast" },
    );
    const b = profile(
      "b",
      { typeDescriptor: "into running and climbing, plays indie music" },
      { profession: "climber, runs indie music podcast" },
    );
    const result = scoreCompatibility(a, b);
    expect(result.components.typeDescriptor).toBeGreaterThan(0.3);
  });

  it("is neutral when descriptor is empty", () => {
    const a = profile("a", { typeDescriptor: null }, {});
    const b = profile("b", { typeDescriptor: null }, {});
    expect(scoreCompatibility(a, b).components.typeDescriptor).toBe(0.5);
  });
});

describe("scoreCompatibility — combined", () => {
  it("a high-match pair scores well above a low-match pair", () => {
    const great = scoreCompatibility(
      profile(
        "a",
        {
          preferredGenders: [Gender.WOMAN],
          minAge: 22,
          maxAge: 28,
          minHeightCm: 160,
          maxHeightCm: 175,
          preferredProfessions: ["designer"],
          typeDescriptor: "creative, sketches, indie music, climbing",
        },
        {
          gender: Gender.MAN,
          age: 26,
          heightCm: 178,
          profession: "engineer",
        },
      ),
      profile(
        "b",
        {
          preferredGenders: [Gender.MAN],
          minAge: 24,
          maxAge: 32,
          minHeightCm: 170,
          maxHeightCm: 190,
          preferredProfessions: ["engineer"],
          typeDescriptor: "indie music, sketches, climbing routes",
        },
        {
          gender: Gender.WOMAN,
          age: 25,
          heightCm: 168,
          profession: "designer",
        },
      ),
    );

    const meh = scoreCompatibility(
      profile(
        "c",
        {
          preferredGenders: [Gender.WOMAN],
          minAge: 22,
          maxAge: 28,
          preferredProfessions: ["lawyer"],
          typeDescriptor: "loves opera and yachts",
        },
        { gender: Gender.MAN, age: 35, profession: "barista" },
      ),
      profile(
        "d",
        {
          preferredGenders: [Gender.MAN],
          minAge: 25,
          maxAge: 30,
          preferredProfessions: ["doctor"],
          typeDescriptor: "punk shows and mountain biking",
        },
        { gender: Gender.WOMAN, age: 32, profession: "carpenter" },
      ),
    );

    expect(great.score).toBeGreaterThan(meh.score);
    expect(great.score).toBeGreaterThan(0.55);
    expect(meh.score).toBeLessThan(0.45);
  });
});
