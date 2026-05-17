// Daily-match selection.
//
// Given a `SelectorContext` (candidates + history) and a date, pick a set of
// `SelectedMatch` pairs for the day:
//
//   1. Score every eligible unordered pair (`scoreCompatibility`).
//   2. Drop pairs the gates rejected, plus pairs that:
//      - already have a match record for today (the same caller will run
//        this routine once per day; this is a belt-and-braces guard),
//      - have ever produced a Discard from either side (permanent block),
//      - are still inside the rematch cooldown window.
//   3. Greedy max-weight assignment: sort eligible pairs by score desc and
//      walk the list, claiming each pair whose two users are not yet
//      assigned.
//
// Greedy is intentional for v1 — the optimal assignment problem (max-weight
// matching on a general graph) is solvable but overkill for the cohort sizes
// we're targeting (one campus). The heuristic is also easy to reason about
// when scoring weights change.

import { orderPair } from "../lib/pair.js";
import { scoreCompatibility } from "./scoring.js";
import {
  DEFAULT_SELECTOR_CONFIG,
  type CandidateProfile,
  type PairHistoryEntry,
  type SelectedMatch,
  type SelectorConfig,
  type SelectorContext,
} from "./types.js";

/** Canonical key for an ordered pair: "userAId|userBId" with A < B. */
export function pairKey(x: string, y: string): string {
  const { userAId, userBId } = orderPair(x, y);
  return `${userAId}|${userBId}`;
}

/**
 * Select today's matches.
 *
 * `today` is interpreted as a calendar date — the time component is ignored
 * for cooldown comparisons. Callers should pass the same date they'll later
 * use when writing `DailyMatch` rows.
 */
export function selectDailyMatches(
  today: Date,
  ctx: SelectorContext,
  configOverrides?: Partial<SelectorConfig>,
): SelectedMatch[] {
  const config = { ...DEFAULT_SELECTOR_CONFIG, ...configOverrides };
  const todayKey = toDateKey(today);

  type Scored = SelectedMatch & { reasons: string[] };
  const scored: Scored[] = [];

  for (let i = 0; i < ctx.candidates.length; i++) {
    for (let j = i + 1; j < ctx.candidates.length; j++) {
      const a = ctx.candidates[i];
      const b = ctx.candidates[j];
      if (!a || !b) continue;

      const key = pairKey(a.userId, b.userId);

      if (ctx.matchedTodayPairs.has(key)) continue;

      const history = ctx.pairHistory.get(key);
      if (history && !pairEligibleByHistory(history, todayKey, config)) continue;

      const result = scoreCompatibility(a, b);
      if (result.ineligible) continue;
      if (result.score < config.minScore) continue;

      const { userAId, userBId } = orderPair(a.userId, b.userId);
      scored.push({ userAId, userBId, score: result.score, reasons: result.reasons });
    }
  }

  // Sort by score desc with a deterministic tiebreaker on pair key.
  scored.sort((x, y) => {
    if (y.score !== x.score) return y.score - x.score;
    if (x.userAId !== y.userAId) return x.userAId.localeCompare(y.userAId);
    return x.userBId.localeCompare(y.userBId);
  });

  const claimed = new Set<string>();
  const matches: SelectedMatch[] = [];
  for (const pair of scored) {
    if (claimed.has(pair.userAId) || claimed.has(pair.userBId)) continue;
    claimed.add(pair.userAId);
    claimed.add(pair.userBId);
    matches.push({ userAId: pair.userAId, userBId: pair.userBId, score: pair.score });
  }
  return matches;
}

function pairEligibleByHistory(
  history: PairHistoryEntry,
  todayKey: string,
  config: SelectorConfig,
): boolean {
  if (history.hasDiscard) return false;
  const daysSince = dayDiff(history.lastMatchedOn, todayKey);
  return daysSince >= config.rematchCooldownDays;
}

/** Convert a Date to a local-date "YYYY-MM-DD" string (UTC-based, no TZ drift). */
export function toDateKey(d: Date): string {
  const yyyy = d.getUTCFullYear().toString().padStart(4, "0");
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = d.getUTCDate().toString().padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** Whole-day difference between two YYYY-MM-DD keys (b - a). */
export function dayDiff(a: string, b: string): number {
  const aMs = Date.UTC(
    Number(a.slice(0, 4)),
    Number(a.slice(5, 7)) - 1,
    Number(a.slice(8, 10)),
  );
  const bMs = Date.UTC(
    Number(b.slice(0, 4)),
    Number(b.slice(5, 7)) - 1,
    Number(b.slice(8, 10)),
  );
  return Math.round((bMs - aMs) / (24 * 60 * 60 * 1000));
}

// Re-export `CandidateProfile` so callers building a context can import it
// from a single place.
export type { CandidateProfile };
