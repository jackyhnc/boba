// Public surface for the matching layer.

export { scoreCompatibility } from "./scoring.js";
export { selectDailyMatches, pairKey, toDateKey, dayDiff } from "./selector.js";
export { loadSelectorContext, persistDailyMatches } from "./prisma-deps.js";
export {
  DEFAULT_SELECTOR_CONFIG,
  type CandidateProfile,
  type CandidatePreferences,
  type CandidateStats,
  type CompatibilityComponents,
  type CompatibilityScore,
  type PairHistoryEntry,
  type SelectedMatch,
  type SelectorConfig,
  type SelectorContext,
} from "./types.js";
