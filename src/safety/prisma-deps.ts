// Prisma adapter for moderation actions.
//
// - `recordReport`: file a Report row, bump the subject's reportCount, and
//   auto-ban once the subject crosses a threshold.
// - `incrementReportCount`: standalone counter bump, used when a hard
//   harassment flag fires without a user-driven report (system-auto-flag).

import type { PrismaClient } from "@prisma/client";

export type ModerationPrisma = Pick<
  PrismaClient,
  "report" | "user" | "$transaction"
>;

export interface RecordReportInput {
  reporterId: string;
  subjectId: string;
  reason: string;
  details: string | null;
  /** Threshold (inclusive) at which the subject is auto-banned. */
  autoBanThreshold?: number;
}

export interface RecordReportResult {
  reportId: string;
  newReportCount: number;
  autoBanned: boolean;
}

const DEFAULT_AUTO_BAN_THRESHOLD = 3;

/**
 * Persist a Report row and bump the subject's reportCount. If the
 * count reaches `autoBanThreshold`, flip the subject's status to
 * BANNED in the same transaction.
 */
export async function recordReport(
  prisma: ModerationPrisma,
  input: RecordReportInput,
): Promise<RecordReportResult> {
  const threshold = input.autoBanThreshold ?? DEFAULT_AUTO_BAN_THRESHOLD;
  return prisma.$transaction(async (tx) => {
    const report = await tx.report.create({
      data: {
        reporterId: input.reporterId,
        subjectId: input.subjectId,
        reason: input.reason,
        details: input.details,
      },
      select: { id: true },
    });
    const updated = await tx.user.update({
      where: { id: input.subjectId },
      data: { reportCount: { increment: 1 } },
      select: { reportCount: true },
    });
    let autoBanned = false;
    if (updated.reportCount >= threshold) {
      await tx.user.update({
        where: { id: input.subjectId },
        data: { status: "BANNED" },
      });
      autoBanned = true;
    }
    return {
      reportId: report.id,
      newReportCount: updated.reportCount,
      autoBanned,
    };
  });
}

/** Bump a user's reportCount without a Report row (system auto-flags). */
export async function incrementReportCount(
  prisma: ModerationPrisma,
  userId: string,
): Promise<{ newReportCount: number }> {
  const updated = await prisma.user.update({
    where: { id: userId },
    data: { reportCount: { increment: 1 } },
    select: { reportCount: true },
  });
  return { newReportCount: updated.reportCount };
}
