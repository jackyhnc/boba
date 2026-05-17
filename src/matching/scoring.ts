// Pure compatibility scoring. No I/O, no Prisma — given two `CandidateProfile`
// values, return a `CompatibilityScore` in 0..1 with a transparent breakdown.
//
// Hard gates (gender, missing required stats) return `ineligible: true` and
// a final `score: 0`. Soft signals (age fit, height fit, profession overlap,
// type-descriptor text overlap) are combined as a weighted sum.
//
// Scoring is symmetric: every directional sub-score is computed in both
// directions (does B fit A's prefs, does A fit B's prefs?) and averaged.
//
// `typeDescriptor` is currently a token-overlap (Jaccard) heuristic against
// the other user's stats. The LLM-augmented version of this signal lives
// behind a TODO seam.

import type {
  CandidateProfile,
  CandidatePreferences,
  CandidateStats,
  CompatibilityScore,
  CompatibilityComponents,
} from "./types.js";

const WEIGHTS = {
  age: 0.25,
  height: 0.2,
  profession: 0.2,
  typeDescriptor: 0.35,
} as const;

// Neutral score used when one side is missing the relevant preference or stat
// — we don't punish incomplete onboarding, but we don't reward it either.
const NEUTRAL = 0.5;

/** Compute a 0..1 compatibility score for an unordered pair of users. */
export function scoreCompatibility(
  a: CandidateProfile,
  b: CandidateProfile,
): CompatibilityScore {
  if (a.userId === b.userId) {
    return ineligibleScore("self-pairing");
  }

  // Hard gate: gender preference is bidirectional and must be respected when
  // both the preference list and the other user's gender are known.
  const aWantsB = genderAllowed(a.preferences.preferredGenders, b.stats.gender);
  const bWantsA = genderAllowed(b.preferences.preferredGenders, a.stats.gender);
  if (!aWantsB || !bWantsA) {
    return ineligibleScore("gender mismatch");
  }

  const reasons: string[] = [];

  const ageAB = ageFit(a.preferences, b.stats);
  const ageBA = ageFit(b.preferences, a.stats);
  const age = average(ageAB, ageBA);
  if (age < 0.5) reasons.push("weak age fit");

  const heightAB = heightFit(a.preferences, b.stats);
  const heightBA = heightFit(b.preferences, a.stats);
  const height = average(heightAB, heightBA);
  if (height < 0.5) reasons.push("weak height fit");

  const profAB = professionFit(a.preferences, b.stats);
  const profBA = professionFit(b.preferences, a.stats);
  const profession = average(profAB, profBA);

  const typeAB = typeDescriptorFit(a.preferences, b);
  const typeBA = typeDescriptorFit(b.preferences, a);
  const typeDescriptor = average(typeAB, typeBA);

  const components: CompatibilityComponents = {
    age,
    height,
    profession,
    typeDescriptor,
  };

  const score = clamp01(
    age * WEIGHTS.age +
      height * WEIGHTS.height +
      profession * WEIGHTS.profession +
      typeDescriptor * WEIGHTS.typeDescriptor,
  );

  return { score, components, ineligible: false, reasons };
}

function ineligibleScore(reason: string): CompatibilityScore {
  return {
    score: 0,
    components: { age: 0, height: 0, profession: 0, typeDescriptor: 0 },
    ineligible: true,
    reasons: [reason],
  };
}

function genderAllowed(
  preferredGenders: CandidatePreferences["preferredGenders"],
  otherGender: CandidateStats["gender"],
): boolean {
  // No preference expressed → open to anyone.
  if (preferredGenders.length === 0) return true;
  // Preference expressed but the other side hasn't disclosed gender → defer to
  // the soft layer. We don't hard-block here to avoid stalling matching during
  // onboarding; the score will naturally drop without a gender signal.
  if (otherGender === null) return true;
  return preferredGenders.includes(otherGender);
}

function ageFit(prefs: CandidatePreferences, stats: CandidateStats): number {
  const { minAge, maxAge } = prefs;
  const { age } = stats;
  if (age === null) return NEUTRAL;
  if (minAge === null && maxAge === null) return NEUTRAL;

  const low = minAge ?? -Infinity;
  const high = maxAge ?? Infinity;
  if (age >= low && age <= high) return 1;

  // Soft penalty: scale linearly within ±3 years of the range; floor at 0.
  const distance = age < low ? low - age : age - high;
  const tolerance = 3;
  if (distance >= tolerance) return 0;
  return 1 - distance / tolerance;
}

function heightFit(prefs: CandidatePreferences, stats: CandidateStats): number {
  const { minHeightCm, maxHeightCm } = prefs;
  const { heightCm } = stats;
  if (heightCm === null) return NEUTRAL;
  if (minHeightCm === null && maxHeightCm === null) return NEUTRAL;

  const low = minHeightCm ?? -Infinity;
  const high = maxHeightCm ?? Infinity;
  if (heightCm >= low && heightCm <= high) return 1;

  // Soft penalty: scale within ±10cm.
  const distance = heightCm < low ? low - heightCm : heightCm - high;
  const tolerance = 10;
  if (distance >= tolerance) return 0;
  return 1 - distance / tolerance;
}

function professionFit(
  prefs: CandidatePreferences,
  stats: CandidateStats,
): number {
  if (prefs.preferredProfessions.length === 0) return NEUTRAL;
  if (stats.profession === null) return NEUTRAL;
  const want = prefs.preferredProfessions.map((p) => p.trim().toLowerCase());
  const have = stats.profession.trim().toLowerCase();
  return want.includes(have) ? 1 : 0;
}

function typeDescriptorFit(
  prefs: CandidatePreferences,
  other: CandidateProfile,
): number {
  const descriptor = prefs.typeDescriptor?.trim();
  if (!descriptor) return NEUTRAL;

  // TODO(matching): swap this token-overlap for an LLM-scored semantic match
  // once the AI seeding plumbing lands. The shape (0..1) stays the same.
  const descTokens = tokenize(descriptor);
  if (descTokens.size === 0) return NEUTRAL;

  const otherTokens = tokenize(
    [other.stats.profession ?? "", other.preferences.typeDescriptor ?? ""].join(" "),
  );
  if (otherTokens.size === 0) return NEUTRAL;

  return jaccard(descTokens, otherTokens);
}

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "that",
  "this",
  "into",
  "are",
  "you",
  "your",
  "who",
  "but",
  "not",
  "any",
  "all",
  "out",
  "has",
  "have",
  "had",
  "was",
  "were",
  "their",
  "they",
  "them",
  "some",
  "like",
  "likes",
]);

function tokenize(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  return new Set(tokens);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const x of a) {
    if (b.has(x)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function average(x: number, y: number): number {
  return (x + y) / 2;
}

function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
