// Shared types for the matching layer.
//
// The matching pipeline is split into pure data transformations
// (`scoring.ts`, `selector.ts`) and a Prisma-backed adapter
// (`prisma-deps.ts`, `persist.ts`). Keeping the pure layer typed against
// these local interfaces lets the algorithm be unit-tested with
// synthetic data, without a live database.

import type { Gender } from "@prisma/client";

/** Subset of a user's preferences relevant to scoring. */
export interface CandidatePreferences {
  minAge: number | null;
  maxAge: number | null;
  preferredGenders: Gender[];
  minHeightCm: number | null;
  maxHeightCm: number | null;
  preferredProfessions: string[];
  typeDescriptor: string | null;
}

/** Subset of a user's revealed stats relevant to scoring. */
export interface CandidateStats {
  age: number | null;
  gender: Gender | null;
  profession: string | null;
  heightCm: number | null;
}

/** A user as seen by the matcher. */
export interface CandidateProfile {
  userId: string;
  isAiBacked: boolean;
  preferences: CandidatePreferences;
  stats: CandidateStats;
}

/** Breakdown of a compatibility score for transparency in tests/debugging. */
export interface CompatibilityComponents {
  /** Average of both directions. */
  age: number;
  /** Average of both directions. */
  height: number;
  /** Average of both directions. */
  profession: number;
  /** Average of both directions. */
  typeDescriptor: number;
}

export interface CompatibilityScore {
  /** Final 0..1 score, or 0 if a hard gate failed. */
  score: number;
  /** Component sub-scores (averaged across both directions). */
  components: CompatibilityComponents;
  /** True when a hard eligibility gate blocked the pair. */
  ineligible: boolean;
  /** Human-readable reasons (mostly used in tests/debug logging). */
  reasons: string[];
}

/** A pair the selector chose to match today. */
export interface SelectedMatch {
  userAId: string;
  userBId: string;
  score: number;
}

/** History the selector needs to enforce cooldowns and discards. */
export interface PairHistoryEntry {
  /** Local-date string ("YYYY-MM-DD") of the most recent match. */
  lastMatchedOn: string;
  /** True if the pair ever ended in a Discard from either side. */
  hasDiscard: boolean;
  /** Number of times this pair has been matched. */
  matchCount: number;
}

/** Data the selector needs for "today". */
export interface SelectorContext {
  /** All ACTIVE, fully-onboarded users with non-null prefs+stats. */
  candidates: CandidateProfile[];
  /** Set of canonical "A|B" pair keys that already have a match today. */
  matchedTodayPairs: Set<string>;
  /** Canonical "A|B" -> history. */
  pairHistory: Map<string, PairHistoryEntry>;
}

/** Configuration for the selector. */
export interface SelectorConfig {
  /** Days a pair must wait before being eligible to rematch. */
  rematchCooldownDays: number;
  /** Minimum compatibility score required to consider a pair. */
  minScore: number;
}

export const DEFAULT_SELECTOR_CONFIG: SelectorConfig = {
  rematchCooldownDays: 14,
  minScore: 0.3,
};
