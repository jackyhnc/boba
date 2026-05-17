// Prisma adapter for the matching layer.
//
// `loadSelectorContext` queries the DB and produces the `SelectorContext`
// the pure selector consumes. `persistDailyMatches` writes the chosen pairs
// transactionally and keeps `RematchHistory` in sync.

import type { PrismaClient } from "@prisma/client";
import { Prisma, UserStatus } from "@prisma/client";
import { orderPair } from "../lib/pair.js";
import { pairKey, toDateKey } from "./selector.js";
import type {
  CandidateProfile,
  PairHistoryEntry,
  SelectedMatch,
  SelectorContext,
} from "./types.js";

/** Type for the Prisma surface we use — narrow enough to mock in tests. */
export type MatchingPrisma = Pick<
  PrismaClient,
  "user" | "dailyMatch" | "rematchHistory" | "$transaction"
>;

/**
 * Build a `SelectorContext` from the database. A user is considered a
 * candidate when status=ACTIVE and both `preferences` and `stats` rows exist.
 */
export async function loadSelectorContext(
  prisma: MatchingPrisma,
  today: Date,
): Promise<SelectorContext> {
  const users = await prisma.user.findMany({
    where: {
      status: UserStatus.ACTIVE,
      preferences: { isNot: null },
      stats: { isNot: null },
    },
    include: { preferences: true, stats: true },
  });

  const candidates: CandidateProfile[] = [];
  for (const u of users) {
    if (!u.preferences || !u.stats) continue;
    candidates.push({
      userId: u.id,
      isAiBacked: u.isAiBacked,
      preferences: {
        minAge: u.preferences.minAge,
        maxAge: u.preferences.maxAge,
        preferredGenders: u.preferences.preferredGenders,
        minHeightCm: u.preferences.minHeightCm,
        maxHeightCm: u.preferences.maxHeightCm,
        preferredProfessions: u.preferences.preferredProfessions,
        typeDescriptor: u.preferences.typeDescriptor,
      },
      stats: {
        age: u.stats.age,
        gender: u.stats.gender,
        profession: u.stats.profession,
        heightCm: u.stats.heightCm,
      },
    });
  }

  const matchDate = startOfUtcDay(today);
  const todays = await prisma.dailyMatch.findMany({
    where: { matchDate },
    select: { userAId: true, userBId: true },
  });
  const matchedTodayPairs = new Set(todays.map((m) => pairKey(m.userAId, m.userBId)));

  const histories = await prisma.rematchHistory.findMany();
  const pairHistory = new Map<string, PairHistoryEntry>();
  for (const h of histories) {
    pairHistory.set(pairKey(h.userAId, h.userBId), {
      lastMatchedOn: toDateKey(h.lastMatchedAt),
      hasDiscard: h.hasDiscard,
      matchCount: h.matchCount,
    });
  }

  return { candidates, matchedTodayPairs, pairHistory };
}

/**
 * Write selected matches and upsert their `RematchHistory` rows in a single
 * transaction. Returns the created `DailyMatch` ids in input order.
 */
export async function persistDailyMatches(
  prisma: MatchingPrisma,
  pairs: SelectedMatch[],
  today: Date,
): Promise<string[]> {
  if (pairs.length === 0) return [];
  const matchDate = startOfUtcDay(today);

  return prisma.$transaction(async (tx) => {
    const ids: string[] = [];
    for (const pair of pairs) {
      // Defensive: the selector should already deliver canonical order, but
      // we re-order here to be belt-and-braces.
      const { userAId, userBId } = orderPair(pair.userAId, pair.userBId);

      const match = await tx.dailyMatch.create({
        data: {
          userAId,
          userBId,
          matchDate,
          compatibilityScore: pair.score,
        },
      });
      ids.push(match.id);

      await tx.rematchHistory.upsert({
        where: { userAId_userBId: { userAId, userBId } },
        create: {
          userAId,
          userBId,
          firstMatchedAt: matchDate,
          lastMatchedAt: matchDate,
          matchCount: 1,
        },
        update: {
          lastMatchedAt: matchDate,
          matchCount: { increment: 1 },
        },
      });
    }
    return ids;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

/** Normalise to 00:00:00 UTC for `@db.Date` columns. */
function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
