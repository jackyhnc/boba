// Prisma adapter for end-of-day decisions.
//
// Responsibilities:
//   - Upsert a user's EndOfDayDecision for a match (idempotent — repeat
//     keywords replace the prior decision).
//   - Load both users' decisions for resolution.
//   - Transition the match state on resolution:
//       continue          → CONTINUED, FACE milestone unlocked, create
//                           tomorrow's DailyMatch with parentMatchId.
//       ended_by_discard  → ENDED_BY_DISCARD; mark RematchHistory.hasDiscard.
//   - All called inside a transaction.

import type { Decision, PrismaClient } from "@prisma/client";
import { orderPair } from "../lib/pair.js";
import { resolve } from "./flow.js";
import type { ResolutionResult } from "./types.js";

export type DecisionPrisma = Pick<
  PrismaClient,
  "endOfDayDecision" | "dailyMatch" | "milestoneProgress" | "rematchHistory" | "$transaction"
>;

/**
 * Record a user's decision and return the (possibly final) resolution
 * for the match. If both users are now in, also transition match state
 * and (for `continue`) create tomorrow's DailyMatch.
 */
export async function recordDecisionAndMaybeResolve(
  prisma: DecisionPrisma,
  args: {
    matchId: string;
    userId: string;
    decision: Decision;
    /** UTC date for "today" — used to derive tomorrow's matchDate. */
    today: Date;
  },
): Promise<{
  resolution: ResolutionResult;
  /** If `continue`, the new DailyMatch row id. Null otherwise. */
  continuationMatchId: string | null;
}> {
  return prisma.$transaction(async (tx) => {
    // Upsert this user's decision (idempotent — replacing is fine).
    await tx.endOfDayDecision.upsert({
      where: { matchId_userId: { matchId: args.matchId, userId: args.userId } },
      create: {
        matchId: args.matchId,
        userId: args.userId,
        decision: args.decision,
      },
      update: { decision: args.decision, decidedAt: new Date() },
    });

    // Load the match (for the pair) and both decisions.
    const match = await tx.dailyMatch.findUnique({
      where: { id: args.matchId },
      select: {
        id: true,
        userAId: true,
        userBId: true,
        matchDate: true,
        state: true,
        compatibilityScore: true,
        decisions: { select: { userId: true, decision: true } },
      },
    });
    if (!match) throw new Error(`decision: match ${args.matchId} not found`);

    const decisionByUser = new Map<string, Decision>();
    for (const d of match.decisions) decisionByUser.set(d.userId, d.decision);
    const decisionA = decisionByUser.get(match.userAId) ?? null;
    const decisionB = decisionByUser.get(match.userBId) ?? null;

    const resolution = resolve(decisionA, decisionB);

    // First decision: flip to AWAITING_DECISION (idempotent).
    if (match.state === "ACTIVE") {
      await tx.dailyMatch.update({
        where: { id: args.matchId },
        data: { state: "AWAITING_DECISION" },
      });
    }

    if (resolution.outcome === "pending") {
      return { resolution, continuationMatchId: null };
    }

    if (resolution.outcome === "ended_by_discard") {
      await tx.dailyMatch.update({
        where: { id: args.matchId },
        data: { state: "ENDED_BY_DISCARD" },
      });
      const { userAId, userBId } = orderPair(match.userAId, match.userBId);
      await tx.rematchHistory.upsert({
        where: { userAId_userBId: { userAId, userBId } },
        create: { userAId, userBId, hasDiscard: true },
        update: { hasDiscard: true, lastMatchedAt: new Date() },
      });
      return { resolution, continuationMatchId: null };
    }

    // `continue` — promote match and create tomorrow's row.
    await tx.dailyMatch.update({
      where: { id: args.matchId },
      data: { state: "CONTINUED" },
    });

    // Unlock FACE milestone for the now-completed day.
    await tx.milestoneProgress.upsert({
      where: { matchId_milestone: { matchId: args.matchId, milestone: "FACE" } },
      create: { matchId: args.matchId, milestone: "FACE" },
      update: {},
    });

    // Tomorrow's DailyMatch — same pair, parent link set.
    const tomorrow = new Date(args.today);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const { userAId, userBId } = orderPair(match.userAId, match.userBId);
    const next = await tx.dailyMatch.create({
      data: {
        userAId,
        userBId,
        matchDate: tomorrow,
        state: "ACTIVE",
        compatibilityScore: match.compatibilityScore,
        parentMatchId: match.id,
      },
      select: { id: true },
    });

    await tx.rematchHistory.upsert({
      where: { userAId_userBId: { userAId, userBId } },
      create: { userAId, userBId, matchCount: 2 },
      update: { matchCount: { increment: 1 }, lastMatchedAt: new Date() },
    });

    return { resolution, continuationMatchId: next.id };
  });
}
