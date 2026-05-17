// End-of-day decision logic.
//
// Pure functions:
//   - parseDecisionKeyword: detect "KEEP" / "MAYBE" / "DISCARD" in an SMS body
//   - resolve: combine two decisions into an outcome
//   - replyForUser: the SMS we send back to a user after their own decision
//   - resolutionAnnouncement: the SMS we send to BOTH users once resolved
//
// All Prisma I/O lives in prisma-deps.ts.

import type { Decision, ResolutionResult } from "./types.js";

const KEYWORD_MAP: Record<string, Decision> = {
  KEEP: "KEEP",
  K: "KEEP",
  MAYBE: "MAYBE",
  M: "MAYBE",
  DISCARD: "DISCARD",
  PASS: "DISCARD",
  NOPE: "DISCARD",
  D: "DISCARD",
};

/**
 * Returns the matching `Decision` for an SMS body, or null if the body is
 * not a decision keyword. We accept exact-token matches only — a message
 * like "KEEP this convo going!" is not a decision, it's chat.
 */
export function parseDecisionKeyword(body: string): Decision | null {
  const token = body.trim().toUpperCase();
  return KEYWORD_MAP[token] ?? null;
}

/**
 * Resolve two end-of-day decisions into an outcome.
 *
 * - Any DISCARD → ended_by_discard.
 * - Both decided otherwise → continue.
 * - Otherwise → pending.
 */
export function resolve(
  a: Decision | null,
  b: Decision | null,
): ResolutionResult {
  if (a === "DISCARD" || b === "DISCARD") {
    return { outcome: "ended_by_discard", decisionA: a, decisionB: b };
  }
  if (a !== null && b !== null) {
    return { outcome: "continue", decisionA: a, decisionB: b };
  }
  return { outcome: "pending", decisionA: a, decisionB: b };
}

// ─── Copy ───────────────────────────────────────────────────────────────────

export const COPY = {
  ackKeep:
    "Got it — you'd like to keep talking. We'll let you know once your match decides.",
  ackMaybe:
    "Got it — you're open to it. We'll let you know once your match decides.",
  ackDiscard:
    "Got it — match ended. We'll line up someone new for you tomorrow.",
  pendingForPartner:
    "Your match made their end-of-day decision. Reply KEEP, MAYBE, or DISCARD when you're ready.",
  continued:
    "🎉 You're both in. Your conversation continues tomorrow — same number, fresh day.",
  endedByDiscard:
    "This match has ended. We'll set you up with someone new tomorrow.",
} as const;

export function replyForOwnDecision(decision: Decision): string {
  switch (decision) {
    case "KEEP":
      return COPY.ackKeep;
    case "MAYBE":
      return COPY.ackMaybe;
    case "DISCARD":
      return COPY.ackDiscard;
  }
}

export function resolutionAnnouncement(outcome: ResolutionResult["outcome"]): string {
  switch (outcome) {
    case "continue":
      return COPY.continued;
    case "ended_by_discard":
      return COPY.endedByDiscard;
    case "pending":
      return COPY.pendingForPartner;
  }
}
