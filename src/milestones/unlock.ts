// Pure unlock-ladder rule.
//
// Given a conversation (messages with sender ids + depth scores) and the
// set of milestones already unlocked, decide which milestone (if any) the
// caller should unlock next.
//
// Unlocks happen in a strict ladder: AGE → PROFESSION → HEIGHT. We walk
// `DEFAULT_UNLOCK_THRESHOLDS` in order and return the first milestone that
// (a) is not yet unlocked and (b) meets its threshold. If the first
// not-yet-unlocked milestone fails its threshold we return `null` — no
// skipping ahead, since later milestones require strictly more activity.
//
// FACE is intentionally outside this ladder. It is unlocked by the
// end-of-day Keep/Maybe resolution flow and not by message-count signals.

import type { MilestoneType } from "@prisma/client";
import { averageDepthScore } from "./depth.js";
import {
  DEFAULT_UNLOCK_THRESHOLDS,
  type ConversationDepthStats,
  type MessageForUnlock,
  type UnlockThreshold,
} from "./types.js";

/** Input for `nextMilestoneToUnlock`. */
export interface UnlockInput {
  /** Canonical pair: `userAId < userBId` (matches `DailyMatch` invariant). */
  userAId: string;
  userBId: string;
  /** All messages in the match, chronological. */
  messages: readonly MessageForUnlock[];
  /** Milestones that have already been unlocked for this match. */
  unlocked: ReadonlySet<MilestoneType>;
}

/** Result of a single unlock evaluation. */
export interface UnlockEvaluation {
  /** The next milestone to unlock, or `null` if no action is warranted. */
  milestone: MilestoneType | null;
  /** Aggregate stats — emitted so callers can log / surface progress. */
  stats: ConversationDepthStats;
}

/**
 * Decide which milestone (if any) to unlock next. Pure. Pass custom
 * thresholds to override (e.g. for AI-seeded conversations or tests).
 */
export function nextMilestoneToUnlock(
  input: UnlockInput,
  thresholds: readonly UnlockThreshold[] = DEFAULT_UNLOCK_THRESHOLDS,
): UnlockEvaluation {
  const stats = summarize(input);

  for (const t of thresholds) {
    if (input.unlocked.has(t.milestone)) continue;
    // First not-yet-unlocked rung in the ladder. Either it meets the
    // threshold and we return it, or the ladder pauses here.
    return { milestone: meetsThreshold(stats, t) ? t.milestone : null, stats };
  }
  return { milestone: null, stats };
}

/** Compute aggregate stats over an unlock input. Pure. */
export function summarize(input: UnlockInput): ConversationDepthStats {
  let messagesFromA = 0;
  let messagesFromB = 0;
  for (const m of input.messages) {
    if (m.senderId === input.userAId) messagesFromA++;
    else if (m.senderId === input.userBId) messagesFromB++;
    // Senders outside the pair are ignored; this shouldn't happen for a
    // well-formed match but the rule stays defensive against bad data.
  }
  return {
    totalMessages: input.messages.length,
    messagesFromA,
    messagesFromB,
    averageDepthScore: averageDepthScore(input.messages),
  };
}

function meetsThreshold(
  stats: ConversationDepthStats,
  t: UnlockThreshold,
): boolean {
  return (
    stats.totalMessages >= t.minTotalMessages &&
    stats.messagesFromA >= t.minMessagesPerSide &&
    stats.messagesFromB >= t.minMessagesPerSide &&
    stats.averageDepthScore >= t.minAvgDepthScore
  );
}
