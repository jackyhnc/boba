// Pure per-message depth scoring.
//
// Returns a 0..1 number capturing how much "conversational substance" a
// single message contributes. The score is intentionally cheap and
// transparent — the LLM-augmented variant lives behind a TODO seam.
//
// Three signals are combined as a weighted sum:
//
//   length       — longer messages tend to carry more content. We use a
//                  saturating curve (`1 - e^(-len/100)`) so a 50-char
//                  message scores ~0.39, 200-char ~0.86, with diminishing
//                  returns past ~300 chars.
//   question     — presence of a meaningful question mark. "?" alone, or
//                  "??????" spam, doesn't count.
//   reciprocity  — bonus when this message is a substantive reply to a
//                  question the other side just asked. Captures the
//                  back-and-forth signal we care about.
//
// Whitespace-only messages, empty bodies, and pure-emoji blurts score ~0.

import type { MessageForDepth } from "./types.js";

const WEIGHTS = {
  length: 0.5,
  question: 0.25,
  reciprocity: 0.25,
} as const;

// Reciprocity only fires when the reply itself is at least this long;
// "yes" answers to "do you like jazz?" shouldn't bump depth.
const RECIPROCITY_MIN_REPLY_LENGTH = 20;

/** Input for `scoreMessageDepth`. */
export interface DepthInput {
  /** The message being scored. */
  message: MessageForDepth;
  /**
   * Messages in the same conversation that strictly precede this one, in
   * chronological order (oldest first). Only the most recent message from
   * the *other* sender is consulted for reciprocity; pass an empty array
   * if no prior context is available.
   */
  previousMessages: readonly MessageForDepth[];
}

/** Compute a 0..1 depth score for a single message. */
export function scoreMessageDepth(input: DepthInput): number {
  const body = input.message.body.trim();
  if (body.length === 0) return 0;

  const lengthScore = computeLengthScore(body);
  const questionScore = hasMeaningfulQuestion(body) ? 1 : 0;
  const reciprocityScore = computeReciprocityScore(input);

  const score =
    WEIGHTS.length * lengthScore +
    WEIGHTS.question * questionScore +
    WEIGHTS.reciprocity * reciprocityScore;

  return clamp01(score);
}

/**
 * Average depth across an entire conversation. Convenience helper for callers
 * (e.g. the unlock rule) that already have per-message scores in hand.
 */
export function averageDepthScore(
  messages: ReadonlyArray<{ depthScore: number }>,
): number {
  if (messages.length === 0) return 0;
  let total = 0;
  for (const m of messages) total += m.depthScore;
  return total / messages.length;
}

function computeLengthScore(body: string): number {
  // Saturating curve: 50 chars ≈ 0.39, 100 ≈ 0.63, 200 ≈ 0.86, 300 ≈ 0.95.
  return 1 - Math.exp(-body.length / 100);
}

/**
 * True when the body contains a "?" plus at least one alphanumeric character.
 * Filters out "?", "????", "...?", etc.
 */
function hasMeaningfulQuestion(body: string): boolean {
  if (!body.includes("?")) return false;
  return /[a-z0-9]/i.test(body);
}

function computeReciprocityScore(input: DepthInput): number {
  if (input.message.body.trim().length < RECIPROCITY_MIN_REPLY_LENGTH) return 0;

  // Walk backwards to find the most recent message from the OTHER sender.
  for (let i = input.previousMessages.length - 1; i >= 0; i--) {
    const prev = input.previousMessages[i];
    if (!prev) continue;
    if (prev.senderId === input.message.senderId) continue;
    return hasMeaningfulQuestion(prev.body) ? 1 : 0;
  }
  return 0;
}

function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
