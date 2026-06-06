// Contract pins for the milestone unlock ladder.
//
// Behavioural coverage of the rung-by-rung unlock decisions lives in
// `unlock.test.ts`. This file pins STRUCTURAL invariants that the
// behavioural tests don't exercise:
//
//   1. DEFAULT_UNLOCK_THRESHOLDS shape — exact order, length, key-set,
//      no FACE, and monotonically increasing volume/depth bars.
//   2. The `>=` (inclusive) boundary at every threshold floor — a
//      regression to `>` would silently delay every unlock by one
//      message / one tick of depth and would not be caught by the
//      well-above-threshold fixtures in unlock.test.ts.
//   3. The "first unmet rung pauses the ladder" rule across ALL three
//      cross-rung combinations, not just AGE-blocks-PROFESSION.
//   4. The pure-function contract: neither `messages` nor `unlocked`
//      may be mutated by a call.
//
// These are easy to regress on innocuous refactors — swapping a `>=`
// for `>`, reordering the ladder, adding an extra threshold field that
// summarize() doesn't compute — and the existing behavioural tests use
// volume/depth values that are *well above* every threshold, so they
// pass even with off-by-one or boundary-flip bugs.

import { describe, it, expect } from "vitest";
import type { MilestoneType } from "@prisma/client";
import { nextMilestoneToUnlock, summarize } from "../../src/milestones/unlock.js";
import {
  DEFAULT_UNLOCK_THRESHOLDS,
  type MessageForUnlock,
  type UnlockThreshold,
} from "../../src/milestones/types.js";

const A = "u-a";
const B = "u-b";

/** Build a flat array of `fromA` A-messages then `fromB` B-messages, all at `depth`. */
function makeMessages(
  fromA: number,
  fromB: number,
  depth: number,
): MessageForUnlock[] {
  const out: MessageForUnlock[] = [];
  for (let i = 0; i < fromA; i++) out.push({ senderId: A, depthScore: depth });
  for (let i = 0; i < fromB; i++) out.push({ senderId: B, depthScore: depth });
  return out;
}

describe("DEFAULT_UNLOCK_THRESHOLDS — structural invariants", () => {
  it("contains exactly three rungs", () => {
    // FACE is reserved for the end-of-day Keep/Maybe resolution and must
    // not appear in the depth ladder. A fourth rung would also indicate
    // someone forgot to update meetsThreshold (which keys off the
    // 4-field shape) or summarize (which currently doesn't compute any
    // signal beyond depth/volume).
    expect(DEFAULT_UNLOCK_THRESHOLDS.length).toBe(3);
  });

  it("lists rungs in exact order: AGE → PROFESSION → HEIGHT", () => {
    // The "first unmet rung pauses the ladder" rule means the ladder's
    // order IS its meaning — swapping HEIGHT and PROFESSION would let
    // someone see a profession reveal before height, which is the wrong
    // PRD direction. Pin by extracting the milestone values verbatim.
    const order: MilestoneType[] = DEFAULT_UNLOCK_THRESHOLDS.map((t) => t.milestone);
    expect(order).toEqual<MilestoneType[]>(["AGE", "PROFESSION", "HEIGHT"]);
  });

  it("does not list FACE in the depth ladder", () => {
    // Explicit: FACE is unlocked by the end-of-day flow, never by the
    // milestone-unlock rule. A regression that adds FACE here would
    // make `nextMilestoneToUnlock` start returning FACE pre-EOD, which
    // would dox users.
    expect(DEFAULT_UNLOCK_THRESHOLDS.some((t) => t.milestone === "FACE")).toBe(false);
  });

  it("each rung has exactly the four expected keys", () => {
    // Pins the schema. Adding a field (e.g. `minQuestionRatio`) without
    // updating `meetsThreshold` is a silent bug: the new bar is ignored
    // and the rung unlocks too easily. Pin via deep-equal on sorted keys.
    const expected = [
      "milestone",
      "minAvgDepthScore",
      "minMessagesPerSide",
      "minTotalMessages",
    ];
    for (const t of DEFAULT_UNLOCK_THRESHOLDS) {
      expect(Object.keys(t).sort()).toEqual(expected);
    }
  });

  it("minTotalMessages is strictly increasing across rungs", () => {
    // The "later rungs require strictly more activity" comment in
    // unlock.ts depends on this. If a refactor sets HEIGHT to require
    // fewer total messages than PROFESSION, the no-skip-ahead rule
    // becomes meaningless: HEIGHT would unlock the moment PROFESSION
    // does (or before).
    for (let i = 1; i < DEFAULT_UNLOCK_THRESHOLDS.length; i++) {
      const prev = DEFAULT_UNLOCK_THRESHOLDS[i - 1]!;
      const curr = DEFAULT_UNLOCK_THRESHOLDS[i]!;
      expect(curr.minTotalMessages).toBeGreaterThan(prev.minTotalMessages);
    }
  });

  it("minMessagesPerSide is strictly increasing across rungs", () => {
    for (let i = 1; i < DEFAULT_UNLOCK_THRESHOLDS.length; i++) {
      const prev = DEFAULT_UNLOCK_THRESHOLDS[i - 1]!;
      const curr = DEFAULT_UNLOCK_THRESHOLDS[i]!;
      expect(curr.minMessagesPerSide).toBeGreaterThan(prev.minMessagesPerSide);
    }
  });

  it("minAvgDepthScore is non-decreasing across rungs", () => {
    // Non-decreasing (not strictly increasing) leaves room for two
    // adjacent rungs to share a depth bar — fine in principle. Pin the
    // weaker invariant so we don't lock ourselves out of that knob,
    // but still catch a regression that drops a later rung's bar.
    for (let i = 1; i < DEFAULT_UNLOCK_THRESHOLDS.length; i++) {
      const prev = DEFAULT_UNLOCK_THRESHOLDS[i - 1]!;
      const curr = DEFAULT_UNLOCK_THRESHOLDS[i]!;
      expect(curr.minAvgDepthScore).toBeGreaterThanOrEqual(prev.minAvgDepthScore);
    }
  });

  it("per-side floor is consistent with the total (2 * perSide <= total)", () => {
    // If 2 * minMessagesPerSide > minTotalMessages, the per-side bar
    // alone implies the total bar — the total field becomes dead code,
    // signalling a config mistake. Pin to catch.
    for (const t of DEFAULT_UNLOCK_THRESHOLDS) {
      expect(2 * t.minMessagesPerSide).toBeLessThanOrEqual(t.minTotalMessages);
    }
  });

  it("all thresholds are non-negative and depth bars are within [0, 1]", () => {
    for (const t of DEFAULT_UNLOCK_THRESHOLDS) {
      expect(t.minTotalMessages).toBeGreaterThanOrEqual(0);
      expect(t.minMessagesPerSide).toBeGreaterThanOrEqual(0);
      expect(t.minAvgDepthScore).toBeGreaterThanOrEqual(0);
      expect(t.minAvgDepthScore).toBeLessThanOrEqual(1);
    }
  });
});

describe("meetsThreshold boundary — exactly at the floor unlocks", () => {
  // These pin the inclusive `>=` comparison on every dimension. Use a
  // custom threshold so the boundary values are simple integers and a
  // dyadic-rational depth (0.5) that survives floating-point summation.

  const T: UnlockThreshold = {
    milestone: "AGE",
    minTotalMessages: 10,
    minMessagesPerSide: 4,
    minAvgDepthScore: 0.5,
  };

  it("exactly minTotalMessages with valid per-side split unlocks", () => {
    // 10 total, 5 each side (>= 4), depth 0.5 (== 0.5) → all at the floor.
    const messages = makeMessages(5, 5, 0.5);
    const r = nextMilestoneToUnlock(
      { userAId: A, userBId: B, messages, unlocked: new Set() },
      [T],
    );
    expect(r.milestone).toBe<MilestoneType>("AGE");
  });

  it("one below minTotalMessages does NOT unlock", () => {
    // 9 total, 5/4 split — per-side ok, depth ok, total just below.
    const messages = makeMessages(5, 4, 0.5);
    const r = nextMilestoneToUnlock(
      { userAId: A, userBId: B, messages, unlocked: new Set() },
      [T],
    );
    expect(r.milestone).toBeNull();
  });

  it("exactly minMessagesPerSide on the lighter side unlocks", () => {
    // 6 from A, 4 from B → total 10, per-side floor met on the dot.
    const messages = makeMessages(6, 4, 0.5);
    const r = nextMilestoneToUnlock(
      { userAId: A, userBId: B, messages, unlocked: new Set() },
      [T],
    );
    expect(r.milestone).toBe<MilestoneType>("AGE");
  });

  it("one below minMessagesPerSide on either side does NOT unlock", () => {
    // 7 from A, 3 from B — total 10 OK, A side OK, B side 3 < 4.
    const lopsidedB = makeMessages(7, 3, 0.5);
    expect(
      nextMilestoneToUnlock(
        { userAId: A, userBId: B, messages: lopsidedB, unlocked: new Set() },
        [T],
      ).milestone,
    ).toBeNull();

    // Symmetric: A side fails.
    const lopsidedA = makeMessages(3, 7, 0.5);
    expect(
      nextMilestoneToUnlock(
        { userAId: A, userBId: B, messages: lopsidedA, unlocked: new Set() },
        [T],
      ).milestone,
    ).toBeNull();
  });

  it("exactly minAvgDepthScore unlocks (>= not >)", () => {
    // Every message at depth 0.5 → average exactly 0.5, equal to floor.
    const messages = makeMessages(5, 5, 0.5);
    const r = nextMilestoneToUnlock(
      { userAId: A, userBId: B, messages, unlocked: new Set() },
      [T],
    );
    expect(r.milestone).toBe<MilestoneType>("AGE");
  });

  it("just below minAvgDepthScore does NOT unlock", () => {
    // 0.5 - small epsilon. Use 0.4 to stay clear of float-rounding.
    const messages = makeMessages(5, 5, 0.4);
    const r = nextMilestoneToUnlock(
      { userAId: A, userBId: B, messages, unlocked: new Set() },
      [T],
    );
    expect(r.milestone).toBeNull();
  });
});

describe("no-skip semantics — pauses at the first unmet rung", () => {
  // These pin that the ladder never jumps past an unmet rung, across
  // every cross-rung combination — not just the AGE→PROFESSION case
  // covered in unlock.test.ts.

  it("unlocked={} + HEIGHT-volume returns AGE, never PROFESSION/HEIGHT", () => {
    // Far more than HEIGHT requires, but AGE is the first unmet rung.
    const messages = makeMessages(100, 100, 0.9);
    const r = nextMilestoneToUnlock({
      userAId: A,
      userBId: B,
      messages,
      unlocked: new Set(),
    });
    expect(r.milestone).toBe<MilestoneType>("AGE");
  });

  it("unlocked={AGE} + HEIGHT-volume returns PROFESSION, never HEIGHT", () => {
    const messages = makeMessages(100, 100, 0.9);
    const r = nextMilestoneToUnlock({
      userAId: A,
      userBId: B,
      messages,
      unlocked: new Set<MilestoneType>(["AGE"]),
    });
    expect(r.milestone).toBe<MilestoneType>("PROFESSION");
  });

  it("unlocked={PROFESSION} + HEIGHT-volume returns AGE (first unmet wins)", () => {
    // Defensive: if AGE was somehow skipped/never recorded but
    // PROFESSION is marked unlocked, the rule still walks the ladder
    // top-down and offers AGE first. Pins that `nextMilestoneToUnlock`
    // does not assume monotone unlock state — it consults `unlocked`
    // per-rung and returns the first rung whose entry isn't present.
    const messages = makeMessages(100, 100, 0.9);
    const r = nextMilestoneToUnlock({
      userAId: A,
      userBId: B,
      messages,
      unlocked: new Set<MilestoneType>(["PROFESSION"]),
    });
    expect(r.milestone).toBe<MilestoneType>("AGE");
  });

  it("unlocked={AGE, PROFESSION} + AGE-only volume returns null (no false unlock for HEIGHT)", () => {
    // HEIGHT's bar isn't met → the function returns null, not HEIGHT.
    // The existing test 157 ("returns null when the next rung's depth
    // bar isn't met") only covers PROFESSION; this pins HEIGHT.
    const messages = makeMessages(6, 6, 0.4);
    const r = nextMilestoneToUnlock({
      userAId: A,
      userBId: B,
      messages,
      unlocked: new Set<MilestoneType>(["AGE", "PROFESSION"]),
    });
    expect(r.milestone).toBeNull();
  });
});

describe("purity — inputs are not mutated", () => {
  // The rule consumes ReadonlySet / readonly array. TypeScript can't
  // enforce that at runtime, so a refactor that "optimizes" by adding
  // `input.unlocked.add(...)` would corrupt callers' state. Pin via
  // snapshot-equality before/after.

  it("does not mutate the `unlocked` set", () => {
    const unlocked = new Set<MilestoneType>(["AGE"]);
    const before = [...unlocked].sort();
    const messages = makeMessages(13, 13, 0.45);
    nextMilestoneToUnlock({ userAId: A, userBId: B, messages, unlocked });
    expect([...unlocked].sort()).toEqual(before);
  });

  it("does not mutate the `messages` array", () => {
    const messages = makeMessages(6, 6, 0.4);
    const snapshot = messages.map((m) => ({ ...m }));
    nextMilestoneToUnlock({ userAId: A, userBId: B, messages, unlocked: new Set() });
    expect(messages).toEqual(snapshot);
  });

  it("summarize does not mutate the `messages` array", () => {
    const messages = makeMessages(6, 6, 0.4);
    const snapshot = messages.map((m) => ({ ...m }));
    summarize({ userAId: A, userBId: B, messages, unlocked: new Set() });
    expect(messages).toEqual(snapshot);
  });

  it("returns the same result on repeated calls with the same input", () => {
    // Determinism pin: no Date.now(), no Math.random(), no caching that
    // would change behaviour on the second call.
    const messages = makeMessages(13, 13, 0.45);
    const input = {
      userAId: A,
      userBId: B,
      messages,
      unlocked: new Set<MilestoneType>(["AGE"]),
    };
    const first = nextMilestoneToUnlock(input);
    const second = nextMilestoneToUnlock(input);
    expect(second).toEqual(first);
  });
});

describe("thresholds parameter — default is DEFAULT_UNLOCK_THRESHOLDS", () => {
  it("omitting the thresholds arg behaves identically to passing DEFAULT_UNLOCK_THRESHOLDS", () => {
    // Pin the public surface: callers across the codebase rely on the
    // default. If the default param ever changes, this catches it.
    const messages = makeMessages(13, 13, 0.45);
    const input = {
      userAId: A,
      userBId: B,
      messages,
      unlocked: new Set<MilestoneType>(["AGE"]),
    };
    const implicit = nextMilestoneToUnlock(input);
    const explicit = nextMilestoneToUnlock(input, DEFAULT_UNLOCK_THRESHOLDS);
    expect(implicit).toEqual(explicit);
  });

  it("empty thresholds returns null and still emits computed stats", () => {
    // If a caller passes an empty ladder we shouldn't crash — the loop
    // simply never enters and we return null. Stats are still computed
    // because summarize runs unconditionally.
    const messages = makeMessages(6, 6, 0.4);
    const r = nextMilestoneToUnlock(
      { userAId: A, userBId: B, messages, unlocked: new Set() },
      [],
    );
    expect(r.milestone).toBeNull();
    expect(r.stats.totalMessages).toBe(12);
    expect(r.stats.messagesFromA).toBe(6);
    expect(r.stats.messagesFromB).toBe(6);
  });
});
