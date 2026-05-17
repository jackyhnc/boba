import { describe, it, expect } from "vitest";
import { scoreMessageDepth, averageDepthScore } from "../../src/milestones/depth.js";
import type { MessageForDepth } from "../../src/milestones/types.js";

const ALICE = "u-alice";
const BOB = "u-bob";

function msg(senderId: string, body: string): MessageForDepth {
  return { senderId, body };
}

describe("scoreMessageDepth", () => {
  it("returns 0 for empty / whitespace bodies", () => {
    expect(scoreMessageDepth({ message: msg(ALICE, ""), previousMessages: [] })).toBe(0);
    expect(scoreMessageDepth({ message: msg(ALICE, "    "), previousMessages: [] })).toBe(0);
    expect(scoreMessageDepth({ message: msg(ALICE, "\n\t  "), previousMessages: [] })).toBe(0);
  });

  it("scores 'ok' as nearly zero (length-driven)", () => {
    const s = scoreMessageDepth({ message: msg(ALICE, "ok"), previousMessages: [] });
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(0.05);
  });

  it("rewards length with diminishing returns", () => {
    const short = scoreMessageDepth({ message: msg(ALICE, "a".repeat(20)), previousMessages: [] });
    const medium = scoreMessageDepth({ message: msg(ALICE, "a".repeat(100)), previousMessages: [] });
    const long = scoreMessageDepth({ message: msg(ALICE, "a".repeat(300)), previousMessages: [] });

    expect(medium).toBeGreaterThan(short);
    expect(long).toBeGreaterThan(medium);
    // 100 vs 20 should jump a lot; 300 vs 100 should jump less (saturation).
    expect(medium - short).toBeGreaterThan(long - medium);
  });

  it("treats a lone '?' as not a meaningful question", () => {
    // "?" has neither length nor an alphanumeric character. Reciprocity off
    // because there's no prior context.
    const s = scoreMessageDepth({ message: msg(ALICE, "?"), previousMessages: [] });
    expect(s).toBeLessThan(0.05);
  });

  it("rewards a real question over a same-length statement", () => {
    const question = scoreMessageDepth({
      message: msg(ALICE, "what kind of music do you listen to"),
      previousMessages: [],
    });
    const sameLengthQ = scoreMessageDepth({
      message: msg(ALICE, "what kind of music do you listen to?"),
      previousMessages: [],
    });
    expect(sameLengthQ).toBeGreaterThan(question);
    expect(sameLengthQ - question).toBeGreaterThanOrEqual(0.2);
  });

  it("filters out punctuation-only 'questions' like '?????'", () => {
    const a = scoreMessageDepth({ message: msg(ALICE, "?????"), previousMessages: [] });
    const b = scoreMessageDepth({ message: msg(ALICE, "hello"), previousMessages: [] });
    // '?????' shouldn't earn the question bonus; both should be small.
    expect(a).toBeLessThan(0.05);
    expect(b).toBeLessThan(0.1);
  });

  it("awards reciprocity when responding (with substance) to the other side's question", () => {
    const reply = "a".repeat(50);
    const prev: MessageForDepth[] = [msg(BOB, "what do you do for fun?")];
    const withCtx = scoreMessageDepth({ message: msg(ALICE, reply), previousMessages: prev });
    const noCtx = scoreMessageDepth({ message: msg(ALICE, reply), previousMessages: [] });
    expect(withCtx).toBeGreaterThan(noCtx);
    expect(withCtx - noCtx).toBeCloseTo(0.25, 5);
  });

  it("does not award reciprocity if the prior message has no question", () => {
    const reply = "a".repeat(50);
    const prev: MessageForDepth[] = [msg(BOB, "i had a long day at work today")];
    const withCtx = scoreMessageDepth({ message: msg(ALICE, reply), previousMessages: prev });
    const noCtx = scoreMessageDepth({ message: msg(ALICE, reply), previousMessages: [] });
    expect(withCtx).toBe(noCtx);
  });

  it("does not award reciprocity for a one-word answer to a question", () => {
    const prev: MessageForDepth[] = [msg(BOB, "you free saturday?")];
    const s = scoreMessageDepth({ message: msg(ALICE, "yes"), previousMessages: prev });
    expect(s).toBeLessThan(0.1);
  });

  it("ignores prior messages from the same sender for reciprocity", () => {
    const reply = "a".repeat(50);
    // ALICE asked themselves a question two messages back; the most recent
    // prior is BOB's *non*-question. Reciprocity must be 0.
    const prev: MessageForDepth[] = [
      msg(ALICE, "what's your favourite movie?"),
      msg(BOB, "hard to pick one honestly"),
    ];
    const withCtx = scoreMessageDepth({ message: msg(ALICE, reply), previousMessages: prev });
    const noCtx = scoreMessageDepth({ message: msg(ALICE, reply), previousMessages: [] });
    expect(withCtx).toBe(noCtx);
  });

  it("walks back to the most-recent OTHER-sender message for reciprocity", () => {
    const reply = "a".repeat(50);
    // BOB asked a question, then ALICE replied (same sender as the new
    // message we're scoring). Reciprocity should still find BOB's question.
    const prev: MessageForDepth[] = [
      msg(BOB, "where did you grow up?"),
      msg(ALICE, "seattle originally"),
    ];
    const s = scoreMessageDepth({ message: msg(ALICE, reply), previousMessages: prev });
    const noCtx = scoreMessageDepth({ message: msg(ALICE, reply), previousMessages: [] });
    // No reciprocity bump: the most recent OTHER-sender msg is BOB's question
    // BUT the most recent prior is ALICE's own; per the rule we scan back
    // for the most recent OTHER message and that's BOB's question → bump applies.
    expect(s).toBeGreaterThan(noCtx);
    expect(s - noCtx).toBeCloseTo(0.25, 5);
  });

  it("scores a substantive reply to a question close to the top of the range", () => {
    const body =
      "i grew up in seattle and spent most weekends hiking with my dad. it's where i got into photography too.";
    const prev: MessageForDepth[] = [msg(BOB, "where are you from?")];
    const s = scoreMessageDepth({ message: msg(ALICE, body), previousMessages: prev });
    // length≈103 → ~0.64 length score, q=0, reciprocity=1 →
    // 0.5*0.64 + 0 + 0.25*1 ≈ 0.57. Allow a generous tolerance.
    expect(s).toBeGreaterThan(0.5);
    expect(s).toBeLessThanOrEqual(1);
  });

  it("clamps the score to [0, 1]", () => {
    const longQ = "a".repeat(1000) + "?";
    const prev: MessageForDepth[] = [msg(BOB, "tell me about yourself?")];
    const s = scoreMessageDepth({ message: msg(ALICE, longQ), previousMessages: prev });
    expect(s).toBeLessThanOrEqual(1);
    expect(s).toBeGreaterThan(0.9);
  });
});

describe("averageDepthScore", () => {
  it("returns 0 for an empty array", () => {
    expect(averageDepthScore([])).toBe(0);
  });

  it("averages depthScores", () => {
    expect(averageDepthScore([{ depthScore: 0.2 }, { depthScore: 0.8 }])).toBeCloseTo(0.5, 10);
  });
});
