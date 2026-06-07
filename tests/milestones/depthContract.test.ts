// Contract pins for the depth scorer.
//
// Behavioural coverage of "longer is better", "questions help",
// "reciprocity helps" lives in `depth.test.ts`. This file pins the
// numeric / structural invariants that a "harmless refactor" can
// silently break. The existing behavioural tests use loose bounds
// (`< 0.05`, `< 0.1`, "greater than") that pass even when the
// underlying formula has been edited in ways that would matter at
// the unlock threshold (`minAvgDepthScore: 0.3 / 0.4 / 0.5` in
// `DEFAULT_UNLOCK_THRESHOLDS`).
//
// The depth scorer feeds directly into the unlock ladder via
// `averageDepthScore`. Each unlock rung (AGE, PROFESSION, HEIGHT) has
// a `minAvgDepthScore` bar. A coefficient drift here that pushes the
// average up by ~0.05 across a healthy convo would silently *advance*
// every unlock by a few messages; a drift down would silently *stall*
// it. Neither would surface as a test failure under the current
// behavioural bounds.
//
// What is pinned, and the silent-failure mode each pin guards
// against:
//
//   1. `WEIGHTS.length === 0.5` — derived from the score of a
//      saturating-length, no-question, no-reciprocity message.
//      Refactor risk: swapping the weight to `2/5 = 0.4` would still
//      pass the "long > medium > short" ordering tests but would
//      depress every conversation's average depth by ~0.06.
//   2. `WEIGHTS.question === 0.25` — derived from the delta between a
//      same-length statement and question. The existing tests assert
//      `>= 0.2`, which would pass at 0.20, 0.22, 0.25, or 0.30.
//   3. Length curve is `1 - exp(-len/100)` exactly. A swap to
//      `/50` or `/200` would re-rank every length cohort by the same
//      ordinal so the ordering tests still pass.
//   4. RECIPROCITY threshold is exactly 20 chars. Boundary at 19/20.
//      A drift to 25 would silently suppress reciprocity for a
//      common "yeah totally — i feel that" response (~25 chars).
//   5. Question regex requires ASCII `[a-z0-9]` (case-insensitive).
//      A swap to `\p{L}` would change behaviour for non-Latin
//      scripts. Documented, pinned, owner can revisit.
//   6. Body is `.trim()`-ed BEFORE length is measured AND before the
//      reciprocity-threshold check. A refactor that drops the trim
//      would let `"  hi  "` outscore `"hi"` purely on whitespace.
//   7. Empty / whitespace bodies return `=== 0` (not `~0`) — the
//      early-return path. A refactor to "compute then clamp" would
//      not be observable behaviourally but would change the
//      numerical contract (e.g. `NaN` if a length=0 path produced a
//      `0/0`).
//   8. Reciprocity walks back to the FIRST other-sender message and
//      stops there — it does NOT keep scanning past a non-question
//      OTHER to find an earlier question OTHER. Behavioural tests
//      verify the "walk past own message" path but not the
//      "stop at first OTHER" path.
//   9. Clamp at exactly 1.0 (not 0.9999...). A maxed-out scenario
//      (long body + question + reciprocity) produces 0.5+0.25+0.25 =
//      1.0 in IEEE 754; pin via `toBe(1)` not `toBeCloseTo`.
//   10. Pure function: idempotent across repeated calls; does NOT
//       mutate `previousMessages`.
//   11. `averageDepthScore` is the arithmetic mean. A refactor to
//       e.g. trimmed mean would still pass the existing two-element
//       test but would change unlock cadence on a long convo.
//   12. `averageDepthScore([])` returns `=== 0`, not `NaN` — the
//       length-guard branch.

import { describe, it, expect } from "vitest";
import { scoreMessageDepth, averageDepthScore } from "../../src/milestones/depth.js";
import type { MessageForDepth } from "../../src/milestones/types.js";

const ALICE = "u-alice";
const BOB = "u-bob";

function msg(senderId: string, body: string): MessageForDepth {
  return { senderId, body };
}

describe("depth — contract pins", () => {
  describe("WEIGHTS", () => {
    it("length weight is exactly 0.5 (derived from a saturated, q=0, recip=0 message)", () => {
      // For length = 10_000, `1 - exp(-100)` ≈ 1 to within 1e-43, so
      // weighted length ≈ WEIGHTS.length * 1. The other two signals
      // are off (no `?`, no prior context). Whatever the score is, it
      // IS WEIGHTS.length to ~15 digits.
      const score = scoreMessageDepth({
        message: msg(ALICE, "a".repeat(10_000)),
        previousMessages: [],
      });
      expect(score).toBeCloseTo(0.5, 10);
    });

    it("question weight is exactly 0.25 (derived from a same-length statement vs question delta)", () => {
      // Both 51 chars. Only difference: trailing `?` vs trailing `b`.
      // Both have alphanumerics, so the question one earns the bonus.
      const statement = scoreMessageDepth({
        message: msg(ALICE, "a".repeat(51)),
        previousMessages: [],
      });
      const question = scoreMessageDepth({
        message: msg(ALICE, "a".repeat(50) + "?"),
        previousMessages: [],
      });
      // Same length → same length component. Same trimmed length →
      // same reciprocity gate (both off). Only the question component
      // differs.
      expect(question - statement).toBeCloseTo(0.25, 10);
    });

    it("three weights sum to exactly 1.0 (so a maxed-out message clamps cleanly)", () => {
      // Maxed-out: saturating length + question + reciprocity. Should
      // hit the clamp at exactly 1.0, not over-shoot or fall short.
      const prev: MessageForDepth[] = [msg(BOB, "tell me about yourself?")];
      const maxed = scoreMessageDepth({
        message: msg(ALICE, "a".repeat(10_000) + "?"),
        previousMessages: prev,
      });
      // 0.5 + 0.25 + 0.25 = 1.0 in IEEE 754 (each weight is an exact
      // dyadic; the sum is exact). Length ≈ 1. So pre-clamp ≈ 1.0,
      // and `clamp01` returns it unchanged.
      expect(maxed).toBe(1);
    });
  });

  describe("length curve", () => {
    it("uses `1 - exp(-len/100)` exactly (pin the /100 divisor)", () => {
      // No `?`, no recip. Score = 0.5 * (1 - exp(-len/100)).
      // len = 100: 0.5 * (1 - 1/e)   ≈ 0.31606...
      // len = 200: 0.5 * (1 - 1/e^2) ≈ 0.43233...
      const at100 = scoreMessageDepth({
        message: msg(ALICE, "a".repeat(100)),
        previousMessages: [],
      });
      const at200 = scoreMessageDepth({
        message: msg(ALICE, "a".repeat(200)),
        previousMessages: [],
      });
      expect(at100).toBeCloseTo(0.5 * (1 - Math.exp(-1)), 10);
      expect(at200).toBeCloseTo(0.5 * (1 - Math.exp(-2)), 10);
    });

    it("measures TRIMMED body length, not raw length", () => {
      // "  hello  " is 9 chars raw, 5 chars trimmed. With no `?`
      // (the body contains "hello" only after trim) and no recip,
      // the score must equal score("hello").
      const trimmed = scoreMessageDepth({
        message: msg(ALICE, "hello"),
        previousMessages: [],
      });
      const padded = scoreMessageDepth({
        message: msg(ALICE, "  hello  "),
        previousMessages: [],
      });
      expect(padded).toBe(trimmed);
    });
  });

  describe("reciprocity gate", () => {
    it("trims body before checking the 20-char threshold", () => {
      // 20 chars after trim. Padding outside the gate must not push
      // a real reply over the line.
      const padded20 = scoreMessageDepth({
        message: msg(ALICE, "  " + "a".repeat(20) + "  "),
        previousMessages: [msg(BOB, "what brings you joy?")],
      });
      const trim20 = scoreMessageDepth({
        message: msg(ALICE, "a".repeat(20)),
        previousMessages: [msg(BOB, "what brings you joy?")],
      });
      expect(padded20).toBe(trim20);
    });

    it("19 chars: NO reciprocity bonus; 20 chars: full reciprocity bonus", () => {
      const prev: MessageForDepth[] = [msg(BOB, "what brings you joy?")];
      const at19 = scoreMessageDepth({
        message: msg(ALICE, "a".repeat(19)),
        previousMessages: prev,
      });
      const at19NoCtx = scoreMessageDepth({
        message: msg(ALICE, "a".repeat(19)),
        previousMessages: [],
      });
      const at20 = scoreMessageDepth({
        message: msg(ALICE, "a".repeat(20)),
        previousMessages: prev,
      });
      const at20NoCtx = scoreMessageDepth({
        message: msg(ALICE, "a".repeat(20)),
        previousMessages: [],
      });

      // 19 chars: reciprocity gate closed → identical to no-prev.
      expect(at19).toBe(at19NoCtx);
      // 20 chars: reciprocity gate opens → +0.25 over no-prev.
      expect(at20 - at20NoCtx).toBeCloseTo(0.25, 10);
    });

    it("stops at the FIRST other-sender message; does not skip past a non-question OTHER", () => {
      // prev = [BOB asks Q, ALICE answers, BOB makes a statement].
      // New msg from ALICE → walk back: ALICE (skip), BOB statement
      // → STOP. Since BOB's most recent message is not a question,
      // recip = 0. We must NOT keep walking back to find BOB's
      // earlier question.
      const reply = "a".repeat(50);
      const prev: MessageForDepth[] = [
        msg(BOB, "where did you grow up?"),
        msg(ALICE, "seattle originally"),
        msg(BOB, "ah cool"),
      ];
      const withCtx = scoreMessageDepth({
        message: msg(ALICE, reply),
        previousMessages: prev,
      });
      const noCtx = scoreMessageDepth({
        message: msg(ALICE, reply),
        previousMessages: [],
      });
      expect(withCtx).toBe(noCtx);
    });
  });

  describe("meaningful-question regex (`?` + ASCII alphanumeric)", () => {
    it("requires at least one ASCII alphanumeric, case-insensitive (A–Z, a–z, 0–9)", () => {
      // Same length, only the body shape differs.
      const baseline = scoreMessageDepth({
        message: msg(ALICE, "aa"),
        previousMessages: [],
      });

      const allowed = [
        "a?", // lowercase
        "Z?", // uppercase (case-insensitive flag)
        "5?", // digit
      ];
      for (const body of allowed) {
        const s = scoreMessageDepth({ message: msg(ALICE, body), previousMessages: [] });
        // Question bonus = 0.25. Length differs from baseline by 0
        // (both 2 chars), so the difference is exactly 0.25.
        expect(s - baseline).toBeCloseTo(0.25, 10);
      }
    });

    it("rejects `?` without any alphanumeric — punctuation/symbols/whitespace are not enough", () => {
      // `~?@`, `???`, `...?` should all fail the alphanumeric gate.
      // Score = 0.5 * (1 - exp(-len/100)) only (no q bonus, no recip).
      for (const body of ["~?@", "???", "...?"]) {
        const s = scoreMessageDepth({ message: msg(ALICE, body), previousMessages: [] });
        const expected = 0.5 * (1 - Math.exp(-body.length / 100));
        expect(s).toBeCloseTo(expected, 10);
      }
    });

    it("non-ASCII alphabetics do NOT satisfy the alphanumeric gate (documented limitation)", () => {
      // "你好?" has zero ASCII alphanumerics. This is the
      // documented current behaviour — the regex is `[a-z0-9]/i`,
      // not `\p{L}`. If we ever want to support CJK / accented
      // scripts as "meaningful questions", this pin is the seam
      // that forces a deliberate change.
      const body = "你好?";
      const s = scoreMessageDepth({ message: msg(ALICE, body), previousMessages: [] });
      const expectedAtLen3 = 0.5 * (1 - Math.exp(-body.length / 100));
      expect(s).toBeCloseTo(expectedAtLen3, 10);
    });
  });

  describe("empty / whitespace early-return", () => {
    it("returns EXACTLY 0 (not NaN, not ~0) for empty body", () => {
      const s = scoreMessageDepth({ message: msg(ALICE, ""), previousMessages: [] });
      expect(Object.is(s, 0)).toBe(true); // not NaN, not -0
    });

    it("returns EXACTLY 0 for whitespace-only body, regardless of prior context", () => {
      const s = scoreMessageDepth({
        message: msg(ALICE, "  \n\t  "),
        previousMessages: [msg(BOB, "what's on your mind?")],
      });
      expect(s).toBe(0);
    });
  });

  describe("pure function", () => {
    it("is idempotent — same input twice produces bit-identical output", () => {
      const input = {
        message: msg(ALICE, "tell me about the album you mentioned earlier"),
        previousMessages: [msg(BOB, "have you heard the new mount kimbie?")],
      };
      const a = scoreMessageDepth(input);
      const b = scoreMessageDepth(input);
      expect(a).toBe(b);
    });

    it("does not mutate `previousMessages`", () => {
      const prev: MessageForDepth[] = [msg(BOB, "what's your go-to comfort food?")];
      const snapshot = JSON.stringify(prev);
      scoreMessageDepth({
        message: msg(ALICE, "a".repeat(50)),
        previousMessages: prev,
      });
      expect(JSON.stringify(prev)).toBe(snapshot);
      expect(prev.length).toBe(1);
    });
  });

  describe("averageDepthScore", () => {
    it("empty array returns EXACTLY 0 (length-guard branch)", () => {
      const a = averageDepthScore([]);
      expect(Object.is(a, 0)).toBe(true); // not NaN, not -0
    });

    it("single element returns that element's depthScore exactly", () => {
      expect(averageDepthScore([{ depthScore: 0.7 }])).toBe(0.7);
    });

    it("arithmetic mean (not trimmed mean, not median, not weighted)", () => {
      // 0.0 + 0.5 + 1.0 = 1.5; /3 = 0.5 exactly in IEEE 754.
      expect(averageDepthScore([{ depthScore: 0 }, { depthScore: 0.5 }, { depthScore: 1 }])).toBe(
        0.5,
      );
      // A trimmed-mean refactor would drop the 0 and 1 and return 0.5
      // here too — so add a skewed case where trimming would lie.
      // [0.1, 0.1, 0.1, 1.0]: arithmetic = 1.3/4 = 0.325; trimmed
      // (drop min+max) = 0.1.
      expect(
        averageDepthScore([
          { depthScore: 0.1 },
          { depthScore: 0.1 },
          { depthScore: 0.1 },
          { depthScore: 1 },
        ]),
      ).toBeCloseTo(0.325, 10);
    });
  });
});
