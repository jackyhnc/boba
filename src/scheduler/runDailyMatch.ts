// One-shot daily-match runner.
//
// Composes the three matching stages (load context → select pairs → persist
// rows) and then notifies each pair so they know to start texting. Designed
// to be idempotent per matchDate: persistence relies on the
// `@@unique([userAId, userBId, matchDate])` on `DailyMatch`, so re-running
// will skip pairs that already have a row for today (via the
// `matchedTodayPairs` set computed inside `loadSelectorContext`).

import type { FastifyBaseLogger } from "fastify";
import { selectDailyMatches } from "../matching/selector.js";
import {
  loadSelectorContext,
  persistDailyMatches,
  type MatchingPrisma,
} from "../matching/prisma-deps.js";
import type { SelectedMatch } from "../matching/types.js";
import type { TwilioClient } from "../twilio/client.js";

// We pull a phone number per user id off this narrow read interface so
// callers don't need to plumb a full Prisma surface into the runner.
export interface PhoneLookup {
  user: {
    findMany(args: {
      where: { id: { in: string[] } };
      select: { id: true; phone: true };
    }): Promise<Array<{ id: string; phone: string }>>;
  };
}

export interface DailyMatchRunResult {
  /** Total candidates considered for the run. */
  candidates: number;
  /** Pairs the selector chose. */
  selected: SelectedMatch[];
  /** Created `DailyMatch` row ids in selector order. */
  createdMatchIds: string[];
  /** Notifications successfully dispatched (recipient phones). */
  notified: string[];
  /** Notifications that failed (recipient phones + error message). */
  notifyErrors: Array<{ phone: string; error: string }>;
}

export const DEFAULT_NEW_MATCH_NOTIFICATION =
  "Your match for today is here 🧋. Say hi — you have until tonight to keep things going. Reply KEEP, MAYBE, or DISCARD at the end of the day.";

/**
 * Run a single daily-match cycle.
 *
 * `today` is the calendar date we're matching for. Defaults to `new Date()`.
 * Notification SMS is sent via the provided `TwilioClient`; pass a dry-run
 * client (or `TWILIO_DRY_RUN=true` in env) when scheduling on the dev box.
 */
export async function runDailyMatch(args: {
  prisma: MatchingPrisma & PhoneLookup;
  twilio: TwilioClient;
  today?: Date;
  logger?: FastifyBaseLogger;
  notificationBody?: string;
}): Promise<DailyMatchRunResult> {
  const today = args.today ?? new Date();
  const logger = args.logger;
  const body = args.notificationBody ?? DEFAULT_NEW_MATCH_NOTIFICATION;

  const ctx = await loadSelectorContext(args.prisma, today);
  const selected = selectDailyMatches(today, ctx);
  logger?.info(
    { candidates: ctx.candidates.length, selected: selected.length },
    "scheduler.runDailyMatch: selection complete",
  );

  const createdMatchIds = await persistDailyMatches(args.prisma, selected, today);

  // Resolve phones in one query and notify both sides.
  const userIds = new Set<string>();
  for (const m of selected) {
    userIds.add(m.userAId);
    userIds.add(m.userBId);
  }
  const phoneRows = await args.prisma.user.findMany({
    where: { id: { in: [...userIds] } },
    select: { id: true, phone: true },
  });
  const phoneById = new Map(phoneRows.map((r) => [r.id, r.phone]));

  const notified: string[] = [];
  const notifyErrors: Array<{ phone: string; error: string }> = [];
  for (const id of userIds) {
    const phone = phoneById.get(id);
    if (!phone) {
      // Stranded — user row disappeared between persist and lookup. Log + skip.
      logger?.warn({ id }, "scheduler.runDailyMatch: no phone for matched user");
      continue;
    }
    try {
      await args.twilio.sendSms({ to: phone, body });
      notified.push(phone);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notifyErrors.push({ phone, error: msg });
      logger?.warn({ phone, err }, "scheduler.runDailyMatch: notify failed");
    }
  }

  return {
    candidates: ctx.candidates.length,
    selected,
    createdMatchIds,
    notified,
    notifyErrors,
  };
}
