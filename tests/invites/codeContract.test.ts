// Contract pins for src/invites/code.ts.
//
// `tests/invites/code.test.ts` already covers happy-path behaviour, but it
// asserts only a handful of representative examples (one well-formed code,
// two excluded letters from the Crockford set). The invariants below sit at
// seams a well-intentioned refactor — or a fixture writer in another test
// file — could quietly violate:
//
//   1. ALPHABET identity. Crockford base32 EXCLUDES I, L, O, U specifically
//      (not arbitrary "ambiguous-looking" letters). A refactor that "fixes"
//      the alphabet to RFC-4648 base32 or appends lowercase would change the
//      printable surface users have memorised. Pin every accepted character
//      and every rejected confusable.
//   2. INVITE_CODE_LENGTH is part of the printed contract on cards / posters
//      (display form is groups of 4). A change to 6 or 10 would silently
//      pass code.test.ts as long as generateCode and isWellFormed both
//      moved together. Pin the constant.
//   3. generateCode NEVER emits an excluded letter. Empirically pinning this
//      at high sample count guards against a refactor that swaps the source
//      string for one that happens to contain I/L/O/U (e.g. switching to a
//      "human-friendly" alphabet from a popular npm package).
//   4. isWellFormed is case-sensitive — it does NOT internally normalise.
//      Callers must normalize first. A refactor that helpfully toLowerCases
//      would let lowercase fixtures slip through and break the "uppercase
//      on the wire" invariant downstream (the DB stores uppercase; the
//      lookup is exact-match in invites/prisma-deps.ts).
//   5. The normalize / isWellFormed ASYMMETRY: normalizeCode strips
//      separators but does NOT strip Crockford-excluded letters (I/L/O/U
//      are [A-Z], so they survive the regex). A user typing "ILOU1234" gets
//      a well-shaped 8-char output that isWellFormed then rejects. This is
//      the production trap the previous agent hit when constructing invite
//      fixtures from the {A-Z, 0-9} space without filtering. Pin the
//      asymmetry so the next fixture author can rely on the test failure
//      message rather than re-deriving it from first principles.
//   6. normalizeCode strips Unicode noise (emoji, accented letters, em-dash,
//      smart quotes) — these can paste in from messaging apps and must not
//      survive into a code string. Behaviour test only covers ASCII space
//      and hyphen.
//   7. formatForDisplay only inserts the hyphen at the exact contract
//      length. Any other length passes through normalised but unformatted —
//      poster mockups depend on the "ABCD-1234" shape, so a refactor that
//      hyphenates "AB-CD" or "ABCDEFGH-IJKL" would corrupt the carrier UX.

import { describe, it, expect } from "vitest";
import {
  INVITE_CODE_LENGTH,
  formatForDisplay,
  generateCode,
  isWellFormed,
  normalizeCode,
} from "../../src/invites/code.js";

// Crockford base32, in order. Excludes I, L, O, U. Source of truth for the
// tests below — if this changes, every assertion that touches alphabet
// membership re-evaluates.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CROCKFORD_EXCLUSIONS = ["I", "L", "O", "U"] as const;

// ─── 1. INVITE_CODE_LENGTH is the literal 8 ────────────────────────────────

describe("invites/code contract — code-length constant", () => {
  it("INVITE_CODE_LENGTH is exactly 8", () => {
    // Print collateral (poster mockups, carrier 10DLC sample message) hard-
    // codes the 4-4 format. A change to this value MUST update those assets.
    expect(INVITE_CODE_LENGTH).toBe(8);
  });
});

// ─── 2. ALPHABET membership is the Crockford set, no more, no less ─────────

describe("invites/code contract — Crockford base32 alphabet", () => {
  // Probe the alphabet black-box: build a length-8 code from each candidate
  // character and ask isWellFormed. This avoids exporting the internal
  // ALPHABET constant while still pinning its contents exactly.

  it("every Crockford character is accepted by isWellFormed", () => {
    expect(CROCKFORD).toHaveLength(32);
    for (const ch of CROCKFORD) {
      const code = ch.repeat(INVITE_CODE_LENGTH);
      expect(isWellFormed(code), `expected isWellFormed("${code}") to be true`).toBe(true);
    }
  });

  it("the four Crockford exclusions (I, L, O, U) are rejected", () => {
    // Not a vague "ambiguous-looking" set — specifically I, L, O, U.
    // Adding 0/O/1/I/etc. lookalikes back in would be wrong even though
    // they're "ambiguous" too, because the contract is the Crockford
    // alphabet exactly.
    for (const ch of CROCKFORD_EXCLUSIONS) {
      const code = "A".repeat(INVITE_CODE_LENGTH - 1) + ch;
      expect(isWellFormed(code), `expected isWellFormed("${code}") to be false`).toBe(false);
    }
  });

  it("lowercase letters are rejected — isWellFormed does NOT normalize", () => {
    // Callers must normalizeCode before isWellFormed. Pinning this asymmetry
    // here so a refactor that "helpfully" uppercases inside isWellFormed
    // doesn't slip through (it would let a lowercase value survive to the
    // DB lookup, which is exact-match).
    expect(isWellFormed("abcd1234")).toBe(false);
    expect(isWellFormed("ABCDefgh")).toBe(false);
  });

  it("isWellFormed rejects every non-Crockford ASCII character", () => {
    // Spot-check the high-traffic confusables and separator characters that
    // a user might type or paste. None should be accepted.
    const rejected = ["-", "_", " ", ".", ",", "/", "+", "=", "*", "!", "?", "'", '"'];
    for (const ch of rejected) {
      const code = "A".repeat(INVITE_CODE_LENGTH - 1) + ch;
      expect(isWellFormed(code), `expected isWellFormed("${code}") to be false`).toBe(false);
    }
  });
});

// ─── 3. Length boundary is strict ──────────────────────────────────────────

describe("invites/code contract — isWellFormed length boundary", () => {
  it("rejects empty string", () => {
    expect(isWellFormed("")).toBe(false);
  });

  it("rejects one character short", () => {
    expect(isWellFormed("A".repeat(INVITE_CODE_LENGTH - 1))).toBe(false);
  });

  it("rejects one character long", () => {
    expect(isWellFormed("A".repeat(INVITE_CODE_LENGTH + 1))).toBe(false);
  });

  it("accepts exactly INVITE_CODE_LENGTH valid characters", () => {
    expect(isWellFormed("A".repeat(INVITE_CODE_LENGTH))).toBe(true);
  });
});

// ─── 4. generateCode is bounded to the Crockford alphabet ──────────────────

describe("invites/code contract — generateCode alphabet bound", () => {
  // The existing 50-sample / 200-sample tests check well-formed and
  // uniqueness. They don't catch a regression that swaps the source string
  // for an alphabet containing I/L/O/U (e.g. RFC-4648 base32, or a copy-
  // pasted "human-friendly" set from another library). At 1000 samples ×
  // 8 chars each, an I/L/O/U appearing roughly 4/32 of the time would
  // expectation-hit 1000 occurrences — bias toward catching the regression
  // is extreme.

  const SAMPLE_COUNT = 1000;

  it(`across ${SAMPLE_COUNT} generated codes, no character is outside the Crockford alphabet`, () => {
    const allowed = new Set(CROCKFORD);
    for (let i = 0; i < SAMPLE_COUNT; i++) {
      const code = generateCode();
      for (const ch of code) {
        expect(
          allowed.has(ch),
          `generateCode emitted "${ch}" (not in Crockford alphabet); full code "${code}"`,
        ).toBe(true);
      }
    }
  });

  it(`across ${SAMPLE_COUNT} generated codes, none of I/L/O/U ever appears`, () => {
    // Stated as a separate assertion because this is THE bug we're guarding
    // against — a future maintainer reading the failure message should
    // immediately see which letter slipped in.
    for (let i = 0; i < SAMPLE_COUNT; i++) {
      const code = generateCode();
      for (const exclusion of CROCKFORD_EXCLUSIONS) {
        expect(
          code.includes(exclusion),
          `generateCode emitted excluded character "${exclusion}" in "${code}"`,
        ).toBe(false);
      }
    }
  });

  it(`generated codes are always exactly INVITE_CODE_LENGTH characters`, () => {
    for (let i = 0; i < SAMPLE_COUNT; i++) {
      expect(generateCode()).toHaveLength(INVITE_CODE_LENGTH);
    }
  });
});

// ─── 5. normalize / isWellFormed asymmetry (the production trap) ───────────

describe("invites/code contract — normalize/isWellFormed asymmetry", () => {
  // Documented inline because the previous build session lost real time to
  // it: a fixture writer constructing "USED1234" from {A-Z, 0-9} sees
  // normalizeCode return the 8-char shape unchanged, then isWellFormed
  // (which the router runs upstream of redemption) rejects it because U is
  // a Crockford exclusion. The fix is to draw fixture codes from CROCKFORD
  // only — pinned here so the failure is self-explanatory.

  it("normalizeCode preserves I/L/O/U (they are [A-Z], the regex keeps them)", () => {
    expect(normalizeCode("ILOU1234")).toBe("ILOU1234");
    expect(normalizeCode("ilou1234")).toBe("ILOU1234");
  });

  it("isWellFormed rejects the same I/L/O/U-bearing string", () => {
    expect(isWellFormed("ILOU1234")).toBe(false);
    expect(isWellFormed(normalizeCode("ILOU1234"))).toBe(false);
  });

  it("a normalized string is NOT automatically well-formed — callers must check both", () => {
    // Wrong length passes normalize but fails isWellFormed.
    const tooShort = normalizeCode("a-b-c");
    expect(tooShort).toBe("ABC");
    expect(isWellFormed(tooShort)).toBe(false);

    // Right shape, wrong alphabet — same outcome.
    const wrongAlphabet = normalizeCode("USED1234");
    expect(wrongAlphabet).toBe("USED1234");
    expect(isWellFormed(wrongAlphabet)).toBe(false);
  });
});

// ─── 6. normalizeCode strips Unicode/symbol noise ──────────────────────────

describe("invites/code contract — normalizeCode strips noise", () => {
  it("strips Unicode separators commonly pasted from messaging apps", () => {
    // En-dash, em-dash, smart-hyphen, NBSP, narrow-NBSP, smart quotes.
    expect(normalizeCode("ABCD–1234")).toBe("ABCD1234"); // en-dash
    expect(normalizeCode("ABCD—1234")).toBe("ABCD1234"); // em-dash
    expect(normalizeCode("ABCD 1234")).toBe("ABCD1234"); // NBSP
    expect(normalizeCode("“ABCD1234”")).toBe("ABCD1234"); // curly quotes
  });

  it("strips emoji and decorative characters", () => {
    expect(normalizeCode("ABCD1234\u{1F389}")).toBe("ABCD1234");
    expect(normalizeCode("\u{1F4F1}ABCD1234")).toBe("ABCD1234");
  });

  it("strips accented Latin letters (they are NOT [A-Z])", () => {
    // The regex is /[^A-Z0-9]/, intentionally ASCII-only. A user pasting
    // "ÁBCD1234" loses the Á rather than getting it folded to A — that
    // matches what the carrier-printed code would actually be (always
    // ASCII), so a paste that doesn't round-trip cleanly should fail
    // upstream rather than coerce into something the carrier could not
    // have generated.
    expect(normalizeCode("ÁBCD1234")).toBe("BCD1234");
    expect(normalizeCode("ñ1234567")).toBe("1234567");
  });

  it("preserves lowercase ASCII by uppercasing it before the strip", () => {
    expect(normalizeCode("abcd1234")).toBe("ABCD1234");
    expect(normalizeCode("aBcD1234")).toBe("ABCD1234");
  });

  it("an empty input returns an empty string", () => {
    expect(normalizeCode("")).toBe("");
    expect(normalizeCode("    ")).toBe("");
    expect(normalizeCode("---___")).toBe("");
  });
});

// ─── 7. formatForDisplay hyphenates only at the exact contract length ─────

describe("invites/code contract — formatForDisplay length-conditional hyphen", () => {
  it("inserts a single hyphen between the two 4-char halves at exact length", () => {
    expect(formatForDisplay("ABCD1234")).toBe("ABCD-1234");
  });

  it("normalizes noise BEFORE deciding whether to hyphenate", () => {
    // The dispatcher logic is normalize → check length → conditional hyphen.
    // A user-typed "abcd-1234" must come out as "ABCD-1234", not "ABCD-1234"
    // with stray characters or wrong segmentation.
    expect(formatForDisplay("abcd-1234")).toBe("ABCD-1234");
    expect(formatForDisplay("a-b-c-d-1-2-3-4")).toBe("ABCD-1234");
    expect(formatForDisplay("  ABCD 1234  ")).toBe("ABCD-1234");
  });

  it("does NOT hyphenate inputs that normalize to a non-canonical length", () => {
    // A poster mockup or printable card relies on the 4-4 shape. If a
    // refactor ever tried to "be helpful" by hyphenating arbitrary lengths
    // (e.g. "AB-CD" for 4-char inputs, or "ABCD-EFGH-IJKL" for 12), the
    // print collateral assumption breaks. Pin the strict length gate.
    expect(formatForDisplay("XX")).toBe("XX");
    expect(formatForDisplay("ABCDEFG")).toBe("ABCDEFG"); // 7
    expect(formatForDisplay("ABCDEFGHI")).toBe("ABCDEFGHI"); // 9
    expect(formatForDisplay("ABCDEFGHIJKL")).toBe("ABCDEFGHIJKL"); // 12
  });

  it("an empty input returns an empty string (no hyphen, no crash)", () => {
    expect(formatForDisplay("")).toBe("");
    expect(formatForDisplay("---")).toBe("");
  });
});
