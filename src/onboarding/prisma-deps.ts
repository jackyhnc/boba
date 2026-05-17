// Prisma adapter for onboarding.
//
// Persists the updates produced by the pure flow, advances the cursor,
// and flips status → ACTIVE when the run completes.

import type { PrismaClient } from "@prisma/client";
import type { OnboardingUpdates, StepId } from "./types.js";

export type OnboardingPrisma = Pick<
  PrismaClient,
  "user" | "stats" | "preferences"
>;

/**
 * Apply the field updates for an onboarding step in a single transaction.
 * Stats and Preferences rows are upserted (a user may not have them yet).
 */
export async function persistOnboardingUpdates(
  prisma: OnboardingPrisma,
  userId: string,
  updates: OnboardingUpdates,
  nextStep: StepId,
  markActive: boolean,
): Promise<void> {
  const userPatch: Record<string, unknown> = {
    onboardingStep: nextStep,
  };
  if (markActive) {
    userPatch.status = "ACTIVE";
    userPatch.onboardingStep = null;
  }
  if (updates.user?.displayName !== undefined) {
    userPatch.displayName = updates.user.displayName;
  }
  if (updates.user?.campusEmailDomain !== undefined) {
    userPatch.campusEmailDomain = updates.user.campusEmailDomain;
  }

  await prisma.user.update({ where: { id: userId }, data: userPatch });

  if (updates.stats && Object.keys(updates.stats).length > 0) {
    await prisma.stats.upsert({
      where: { userId },
      create: { userId, ...updates.stats },
      update: { ...updates.stats },
    });
  }
  if (updates.preferences && Object.keys(updates.preferences).length > 0) {
    await prisma.preferences.upsert({
      where: { userId },
      create: { userId, ...updates.preferences },
      update: { ...updates.preferences },
    });
  }
}
