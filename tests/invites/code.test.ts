import { describe, it, expect } from "vitest";
import {
  INVITE_CODE_LENGTH,
  formatForDisplay,
  generateCode,
  isWellFormed,
  normalizeCode,
} from "../../src/invites/code.js";

describe("invites/code", () => {
  it("normalizeCode uppercases and strips noise", () => {
    expect(normalizeCode("abcd-1234")).toBe("ABCD1234");
    expect(normalizeCode("  ab cd 12 34  ")).toBe("ABCD1234");
    expect(normalizeCode("abcd_1234")).toBe("ABCD1234");
  });

  it("isWellFormed rejects wrong length / wrong alphabet", () => {
    expect(isWellFormed("ABCD1234")).toBe(true);
    expect(isWellFormed("ABC1234")).toBe(false);
    // I, L, O, U are excluded from Crockford base32.
    expect(isWellFormed("ABCDIL12")).toBe(false);
    expect(isWellFormed("ABCDOU12")).toBe(false);
  });

  it("generateCode produces well-formed codes", () => {
    for (let i = 0; i < 50; i++) {
      const c = generateCode();
      expect(c).toHaveLength(INVITE_CODE_LENGTH);
      expect(isWellFormed(c)).toBe(true);
    }
  });

  it("generateCode is high-entropy (no trivial collisions in 200)", () => {
    const set = new Set<string>();
    for (let i = 0; i < 200; i++) set.add(generateCode());
    expect(set.size).toBe(200);
  });

  it("formatForDisplay groups by 4", () => {
    expect(formatForDisplay("abcd1234")).toBe("ABCD-1234");
    expect(formatForDisplay("xx")).toBe("XX");
  });
});
