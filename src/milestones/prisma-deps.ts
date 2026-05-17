// Prisma adapter for the milestone layer.
//
// Writes a `MilestoneProgress` row idempotently — the `@@unique([matchId,
// milestone])` constraint guarantees only one row exists per (match,
// milestone), and the upsert update branch is intentionally empty so
// `unlockedAt` is captured on first write and never overwritten.

import type { MilestoneProgress, MilestoneType, PrismaClient } from "@prisma/client";

/** Narrow Prisma surface — easy to mock in tests. */
export type MilestonePrisma = Pick<PrismaClient, "milestoneProgress">;

/**
 * Record that `milestone` has unlocked for `matchId`. Idempotent: calling
 * twice returns the same row without changing `unlockedAt`.
 */
export async function recordMilestone(
  prisma: MilestonePrisma,
  matchId: string,
  milestone: MilestoneType,
): Promise<MilestoneProgress> {
  return prisma.milestoneProgress.upsert({
    where: { matchId_milestone: { matchId, milestone } },
    create: { matchId, milestone },
    update: {},
  });
}

/** Load the set of milestones already unlocked for a match. */
export async function loadUnlockedMilestones(
  prisma: MilestonePrisma,
  matchId: string,
): Promise<Set<MilestoneType>> {
  const rows = await prisma.milestoneProgress.findMany({
    where: { matchId },
    select: { milestone: true },
  });
  return new Set(rows.map((r) => r.milestone));
}
