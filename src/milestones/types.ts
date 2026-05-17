// Shared types for the milestone-unlock layer.
//
// The unlock pipeline is split into two pure modules (`depth.ts`, `unlock.ts`)
// and a thin Prisma adapter (`prisma-deps.ts`). Pure modules consume the
// minimal data they need so they can be exercised in unit tests with
// hand-rolled fixtures.

import type { MilestoneType } from "@prisma/client";

/** Minimal message shape needed by the depth scorer. */
export interface MessageForDepth {
  senderId: string;
  body: string;
}

/** Minimal message shape needed by the unlock rule. */
export interface MessageForUnlock {
  senderId: string;
  depthScore: number;
}

/** Threshold that must be met for a single milestone to unlock. */
export interface UnlockThreshold {
  milestone: MilestoneType;
  /** Total messages exchanged across both users. */
  minTotalMessages: number;
  /** Lower bound for each side — both halves must participate. */
  minMessagesPerSide: number;
  /** Average depthScore across all messages in the match. */
  minAvgDepthScore: number;
}

/**
 * Default unlock thresholds. These are intentionally tunable — the AI-seeded
 * cold-start phase will likely loosen them. FACE is intentionally absent:
 * it unlocks via the end-of-day Keep/Maybe resolution, not depth thresholds.
 */
export const DEFAULT_UNLOCK_THRESHOLDS: readonly UnlockThreshold[] = [
  { milestone: "AGE", minTotalMessages: 10, minMessagesPerSide: 4, minAvgDepthScore: 0.3 },
  { milestone: "PROFESSION", minTotalMessages: 25, minMessagesPerSide: 10, minAvgDepthScore: 0.4 },
  { milestone: "HEIGHT", minTotalMessages: 50, minMessagesPerSide: 20, minAvgDepthScore: 0.5 },
];

/** Aggregate stats over a conversation; emitted alongside the unlock decision. */
export interface ConversationDepthStats {
  totalMessages: number;
  messagesFromA: number;
  messagesFromB: number;
  averageDepthScore: number;
}
