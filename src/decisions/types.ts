// End-of-day decision flow — type surface.

import type { Decision } from "@prisma/client";

export type { Decision };

/** Outcome of pairing two end-of-day decisions. */
export type ResolutionOutcome = "continue" | "ended_by_discard" | "pending";

/**
 * Resolution table (PRD):
 *   any DISCARD                            → ended_by_discard
 *   only one side decided                  → pending
 *   keep+keep / keep+maybe / maybe+maybe   → continue
 */
export interface ResolutionResult {
  outcome: ResolutionOutcome;
  /** Per-user decisions used to arrive at the outcome. */
  decisionA: Decision | null;
  decisionB: Decision | null;
}
