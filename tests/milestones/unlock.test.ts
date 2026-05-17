import { describe, it, expect } from "vitest";
import { nextMilestoneToUnlock, summarize } from "../../src/milestones/unlock.js";
import {
  DEFAULT_UNLOCK_THRESHOLDS,
  type MessageForUnlock,
  type UnlockThreshold,
} from "../../src/milestones/types.js";
import type { MilestoneType } from "@prisma/client";

const A = "u-a";
const B = "u-b";

function makeMessages(
  fromA: number,
  fromB: number,
  depth: number,
): MessageForUnlock[] {
  const out: MessageForUnlock[] = [];
  // Interleave roughly evenly — order doesn't matter for the rule, but it's
  // closer to the real shape of a conversation.
  const total = fromA + fromB;
  let aLeft = fromA;
  let bLeft = fromB;
  for (let i = 0; i < total; i++) {
    if (aLeft > 0 && (bLeft === 0 || i % 2 === 0)) {
      out.push({ senderId: A, depthScore: depth });
      aLeft--;
    } else {
      out.push({ senderId: B, depthScore: depth });
      bLeft--;
    }
  }
  return out;
}

describe("summarize", () => {
  it("counts each side and averages depth", () => {
    const messages: MessageForUnlock[] = [
      { senderId: A, depthScore: 0.4 },
      { senderId: B, depthScore: 0.6 },
      { senderId: A, depthScore: 0.5 },
    ];
    const s = summarize({ userAId: A, userBId: B, messages, unlocked: new Set() });
    expect(s.totalMessages).toBe(3);
    expect(s.messagesFromA).toBe(2);
    expect(s.messagesFromB).toBe(1);
    expect(s.averageDepthScore).toBeCloseTo(0.5, 10);
  });

  it("ignores messages from senders outside the pair (defensive)", () => {
    const messages: MessageForUnlock[] = [
      { senderId: A, depthScore: 0.5 },
      { senderId: "stranger", depthScore: 0.5 },
    ];
    const s = summarize({ userAId: A, userBId: B, messages, unlocked: new Set() });
    expect(s.totalMessages).toBe(2);
    expect(s.messagesFromA).toBe(1);
    expect(s.messagesFromB).toBe(0);
  });

  it("handles an empty conversation", () => {
    const s = summarize({ userAId: A, userBId: B, messages: [], unlocked: new Set() });
    expect(s).toEqual({
      totalMessages: 0,
      messagesFromA: 0,
      messagesFromB: 0,
      averageDepthScore: 0,
    });
  });
});

describe("nextMilestoneToUnlock — defaults", () => {
  it("returns null for an empty conversation", () => {
    const result = nextMilestoneToUnlock({
      userAId: A,
      userBId: B,
      messages: [],
      unlocked: new Set(),
    });
    expect(result.milestone).toBeNull();
    expect(result.stats.totalMessages).toBe(0);
  });

  it("returns null below the AGE threshold (too few messages)", () => {
    // 6 messages each side, depth 0.5: total=12 (>=10) and depth ok, but
    // only one side meets per-side floor of 4 → wait, both sides DO meet
    // per-side floor 4 here. Use 3 each instead.
    const messages = makeMessages(3, 3, 0.5);
    const result = nextMilestoneToUnlock({
      userAId: A,
      userBId: B,
      messages,
      unlocked: new Set(),
    });
    expect(result.milestone).toBeNull();
  });

  it("returns null when one side hasn't met the per-side floor", () => {
    // 10 from A, 0 from B — total >= 10 but per-side fails.
    const messages = makeMessages(10, 0, 0.5);
    const result = nextMilestoneToUnlock({
      userAId: A,
      userBId: B,
      messages,
      unlocked: new Set(),
    });
    expect(result.milestone).toBeNull();
  });

  it("returns null when depth is too low for AGE", () => {
    const messages = makeMessages(6, 6, 0.1);
    const result = nextMilestoneToUnlock({
      userAId: A,
      userBId: B,
      messages,
      unlocked: new Set(),
    });
    expect(result.milestone).toBeNull();
  });

  it("returns AGE when totals, per-side floor, and depth all meet thresholds", () => {
    const messages = makeMessages(6, 6, 0.4);
    const result = nextMilestoneToUnlock({
      userAId: A,
      userBId: B,
      messages,
      unlocked: new Set(),
    });
    expect(result.milestone).toBe<MilestoneType>("AGE");
  });

  it("does not skip ahead past an unmet rung even if a later rung's depth is satisfied", () => {
    // 6 each side, depth 0.5 → AGE threshold met. PROFESSION needs 25 total
    // so isn't met. Caller hasn't unlocked AGE yet → we return AGE, not
    // PROFESSION. (Strict ladder.)
    const messages = makeMessages(6, 6, 0.5);
    const result = nextMilestoneToUnlock({
      userAId: A,
      userBId: B,
      messages,
      unlocked: new Set(),
    });
    expect(result.milestone).toBe<MilestoneType>("AGE");
  });

  it("returns PROFESSION once AGE is unlocked and the bar is cleared", () => {
    const messages = makeMessages(13, 13, 0.45);
    const result = nextMilestoneToUnlock({
      userAId: A,
      userBId: B,
      messages,
      unlocked: new Set(["AGE"]),
    });
    expect(result.milestone).toBe<MilestoneType>("PROFESSION");
  });

  it("returns null when the next rung's depth bar isn't met", () => {
    // 13 each side — enough volume for PROFESSION — but depth only 0.3.
    const messages = makeMessages(13, 13, 0.3);
    const result = nextMilestoneToUnlock({
      userAId: A,
      userBId: B,
      messages,
      unlocked: new Set(["AGE"]),
    });
    expect(result.milestone).toBeNull();
  });

  it("returns HEIGHT once PROFESSION is unlocked and the bar is cleared", () => {
    const messages = makeMessages(25, 25, 0.55);
    const result = nextMilestoneToUnlock({
      userAId: A,
      userBId: B,
      messages,
      unlocked: new Set(["AGE", "PROFESSION"]),
    });
    expect(result.milestone).toBe<MilestoneType>("HEIGHT");
  });

  it("returns null when all rungs are already unlocked", () => {
    const messages = makeMessages(30, 30, 0.7);
    const result = nextMilestoneToUnlock({
      userAId: A,
      userBId: B,
      messages,
      unlocked: new Set(["AGE", "PROFESSION", "HEIGHT"]),
    });
    expect(result.milestone).toBeNull();
  });

  it("FACE is never returned by the depth ladder", () => {
    // Even with massive volume and depth, FACE stays out — it's reserved
    // for the end-of-day resolution flow.
    const messages = makeMessages(500, 500, 1);
    const result = nextMilestoneToUnlock({
      userAId: A,
      userBId: B,
      messages,
      unlocked: new Set(["AGE", "PROFESSION", "HEIGHT"]),
    });
    expect(result.milestone).toBeNull();
    expect(DEFAULT_UNLOCK_THRESHOLDS.some((t) => t.milestone === "FACE")).toBe(false);
  });

  it("respects custom thresholds", () => {
    const custom: UnlockThreshold[] = [
      { milestone: "AGE", minTotalMessages: 2, minMessagesPerSide: 1, minAvgDepthScore: 0.1 },
    ];
    const messages = makeMessages(1, 1, 0.2);
    const result = nextMilestoneToUnlock(
      { userAId: A, userBId: B, messages, unlocked: new Set() },
      custom,
    );
    expect(result.milestone).toBe<MilestoneType>("AGE");
  });

  it("emits aggregate stats alongside the decision", () => {
    const messages = makeMessages(6, 6, 0.4);
    const result = nextMilestoneToUnlock({
      userAId: A,
      userBId: B,
      messages,
      unlocked: new Set(),
    });
    expect(result.stats).toEqual({
      totalMessages: 12,
      messagesFromA: 6,
      messagesFromB: 6,
      averageDepthScore: expect.closeTo(0.4, 10),
    });
  });
});
