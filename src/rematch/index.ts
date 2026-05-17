// Rematch eligibility.
//
// Today's matching selector already inlines history-based rejection
// (see `selector.ts > pairEligibleByHistory`). This module exposes the
// eligibility rule as a first-class, side-effect-free predicate plus a
// Prisma helper that bulk-loads `RematchHistory` rows and packages them
// into the `Map<string, PairHistoryEntry>` shape the selector consumes.
//
// Rules:
//   - Any pair with `hasDiscard` is permanently ineligible.
//   - Otherwise a pair is eligible iff `daysSince(lastMatchedOn, today)`
//     ≥ `rematchCooldownDays`.
//   - A pair the system has never matched is trivially eligible (caller
//     passes `null`).
//
// We export the predicate, the days-since helper, the loader, and a
// `cooldownRemainingDays` function so future UIs can tell a user
// "you'll see this person again in N days".

import type { PrismaClient } from "@prisma/client";
import { orderPair } from "../lib/pair.js";
import { dayDiff, pairKey, toDateKey } from "../matching/selector.js";
import {
  DEFAULT_SELECTOR_CONFIG,
  type PairHistoryEntry,
} from "../matching/types.js";

export interface EligibilityConfig {
  rematchCooldownDays: number;
}

export const DEFAULT_REMATCH_CONFIG: EligibilityConfig = {
  rematchCooldownDays: DEFAULT_SELECTOR_CONFIG.rematchCooldownDays,
};

export type EligibilityReason =
  | "never_matched"
  | "cooldown_elapsed"
  | "had_discard"
  | "within_cooldown";

export interface EligibilityResult {
  eligible: boolean;
  reason: EligibilityReason;
  /** When ineligible by cooldown, days remaining; else 0. */
  cooldownRemainingDays: number;
}

/**
 * Decide whether a pair may be matched on `today`.
 *
 * `history === null` means the pair has never been matched, which is
 * trivially eligible.
 */
export function isEligibleForRematch(args: {
  history: PairHistoryEntry | null;
  today: Date;
  config?: Partial<EligibilityConfig>;
}): EligibilityResult {
  const cfg = { ...DEFAULT_REMATCH_CONFIG, ...(args.config ?? {}) };
  if (!args.history) {
    return { eligible: true, reason: "never_matched", cooldownRemainingDays: 0 };
  }
  if (args.history.hasDiscard) {
    return { eligible: false, reason: "had_discard", cooldownRemainingDays: 0 };
  }
  const todayKey = toDateKey(args.today);
  const daysSince = dayDiff(args.history.lastMatchedOn, todayKey);
  if (daysSince >= cfg.rematchCooldownDays) {
    return { eligible: true, reason: "cooldown_elapsed", cooldownRemainingDays: 0 };
  }
  return {
    eligible: false,
    reason: "within_cooldown",
    cooldownRemainingDays: cfg.rematchCooldownDays - daysSince,
  };
}

export type RematchPrisma = Pick<PrismaClient, "rematchHistory">;

/**
 * Load the `RematchHistory` rows for the supplied set of user ids and
 * return them keyed by canonical pair key. Designed for the selector's
 * `SelectorContext.pairHistory` field.
 *
 * Implementation note: we load all rows where userAId or userBId is in
 * the provided id set, rather than computing C(n,2) pair filters. Cheaper
 * for the cohort sizes we expect.
 */
export async function loadPairHistoryFor(
  prisma: RematchPrisma,
  userIds: ReadonlyArray<string>,
): Promise<Map<string, PairHistoryEntry>> {
  if (userIds.length === 0) return new Map();
  const ids = [...userIds];
  const rows = await prisma.rematchHistory.findMany({
    where: {
      OR: [{ userAId: { in: ids } }, { userBId: { in: ids } }],
    },
    select: {
      userAId: true,
      userBId: true,
      lastMatchedAt: true,
      matchCount: true,
      hasDiscard: true,
    },
  });
  const map = new Map<string, PairHistoryEntry>();
  for (const row of rows) {
    const { userAId, userBId } = orderPair(row.userAId, row.userBId);
    map.set(pairKey(userAId, userBId), {
      lastMatchedOn: toDateKey(row.lastMatchedAt),
      hasDiscard: row.hasDiscard,
      matchCount: row.matchCount,
    });
  }
  return map;
}

/**
 * Convenience wrapper for the common single-pair lookup. Returns null if
 * no history row exists.
 */
export async function loadHistoryForPair(
  prisma: RematchPrisma,
  userIdA: string,
  userIdB: string,
): Promise<PairHistoryEntry | null> {
  const { userAId, userBId } = orderPair(userIdA, userIdB);
  const row = await prisma.rematchHistory.findUnique({
    where: { userAId_userBId: { userAId, userBId } },
    select: { lastMatchedAt: true, matchCount: true, hasDiscard: true },
  });
  if (!row) return null;
  return {
    lastMatchedOn: toDateKey(row.lastMatchedAt),
    hasDiscard: row.hasDiscard,
    matchCount: row.matchCount,
  };
}

export { pairKey } from "../matching/selector.js";
