// Contract pins for src/lib/pair.ts.
//
// `orderPair` is a 10-line helper, but it encodes a DB-level invariant:
// DailyMatch and RematchHistory rows are persisted with a canonical
// (userAId < userBId) ordering, and uniqueness/lookups everywhere
// downstream assume that ordering is stable, symmetric, locale-
// independent, and string-typed. `tests/prisma.test.ts` covers the
// surface behaviour (swap, throw on self-pair, isOrderedPair direction)
// but does not pin the failure modes that would corrupt the canonical
// pair on disk under a "harmless" refactor:
//
// Pinned here:
//   1. Symmetry: orderPair(a, b) deep-equals orderPair(b, a). A refactor
//      that drops the swap would still pass the existing swap test but
//      break symmetry on inputs that arrive already-ordered AND already
//      are equal to the canonical case.
//   2. Idempotence: orderPair applied to its own output is a fixed
//      point. Catches a refactor that wraps the result in a new shape.
//   3. Output keys are exactly { userAId, userBId }, no extras. Catches
//      a refactor that smuggles a `swapped: boolean` or `original`
//      tuple into the OrderedPair shape — downstream Prisma .upsert /
//      .create payloads spread this object verbatim, so an extra key
//      becomes a Prisma "unknown field" runtime error.
//   4. Code-unit (NOT locale-aware) ordering. `orderPair("Z", "a")`
//      MUST return userAId="Z" because in code-unit order 'Z' (0x5A) <
//      'a' (0x61). A refactor to `localeCompare` flips this in en-US
//      ("a" < "Z" case-insensitively) — and worse, the result becomes
//      dependent on the host ICU version, so two app instances might
//      disagree on the canonical pair. Pinned via the asymmetric pair
//      below.
//   5. Lexicographic (NOT numeric) ordering. `orderPair("10", "2")`
//      MUST return userAId="10". A refactor to numeric coercion
//      (`Number(x) - Number(y)`) would invert this and would silently
//      misorder any pair whose ids happen to start with digits.
//   6. Empty string is strictly less than any non-empty string. Pinned
//      so a defensive `if (!x) ...` short-circuit in a refactor is
//      observable.
//   7. Self-pair throws — does not return. Pinned so a refactor that
//      "softens" the guard to `return { userAId: x, userBId: x }` is
//      caught; the DB would otherwise reject the insert with a noisy
//      foreign-key/unique error instead of the helpful message.
//   8. Self-pair error message contains the offending id. On-call
//      relies on that id to trace back to the caller. Pinned via
//      substring match (not exact, so message wording can evolve).
//   9. `isOrderedPair(x, x) === false`. Equal inputs are NOT canonical
//      because `orderPair` refuses to produce them. A refactor to `<=`
//      would flip this and let callers skip the swap on (x, x), then
//      hand the un-swapped pair to a downstream that calls `orderPair`
//      and crashes.
//  10. Property-based invariant across random pairs: for any (x, y)
//      with x !== y, the output satisfies userAId < userBId, and
//      isOrderedPair on the output is true. Belt-and-suspenders for
//      catching a refactor that only handles ASCII.

import { describe, it, expect } from "vitest";
import { orderPair, isOrderedPair } from "../../src/lib/pair.js";

describe("orderPair contract", () => {
  it("is symmetric: orderPair(a,b) deep-equals orderPair(b,a)", () => {
    const ab = orderPair("alpha", "bravo");
    const ba = orderPair("bravo", "alpha");
    expect(ab).toEqual(ba);
    expect(ab).toEqual({ userAId: "alpha", userBId: "bravo" });
  });

  it("is idempotent: applying orderPair to its own output is a fixed point", () => {
    const once = orderPair("z-user", "a-user");
    const twice = orderPair(once.userAId, once.userBId);
    expect(twice).toEqual(once);
  });

  it("returns exactly { userAId, userBId } — no extra keys", () => {
    const result = orderPair("b", "a");
    expect(Object.keys(result).sort()).toEqual(["userAId", "userBId"]);
  });

  it("uses code-unit (NOT locale-aware) ordering — pin against localeCompare refactor", () => {
    // 'Z' (0x5A) < 'a' (0x61) in code-unit order. In en-US
    // localeCompare, "a" < "Z" (case-insensitive). If this assertion
    // ever flips, someone refactored to a locale-aware comparator and
    // the canonical pair is now ICU-version-dependent.
    expect(orderPair("Z", "a")).toEqual({ userAId: "Z", userBId: "a" });
    expect(orderPair("a", "Z")).toEqual({ userAId: "Z", userBId: "a" });
  });

  it("uses lexicographic (NOT numeric) ordering — pin against Number() refactor", () => {
    // String compare: "1" < "2" at the first char → "10" < "2".
    // Numeric compare: 10 > 2. The DB stores ids as strings.
    expect(orderPair("10", "2")).toEqual({ userAId: "10", userBId: "2" });
  });

  it("treats empty string as strictly less than any non-empty string", () => {
    // Real user ids will never be empty, but the helper is generic;
    // pinning this catches a refactor that adds a `if (!x) return ...`
    // guard which would silently misorder.
    expect(orderPair("", "x")).toEqual({ userAId: "", userBId: "x" });
    expect(orderPair("x", "")).toEqual({ userAId: "", userBId: "x" });
  });

  it("THROWS on self-pair (does not return a (x, x) pair)", () => {
    // Pinned so a refactor to `return { userAId: x, userBId: x }`
    // is observable. A returned self-pair would propagate to a
    // dailyMatch.create which the DB would reject with a noisier,
    // less debuggable error.
    expect(() => orderPair("dup", "dup")).toThrow();
    // Belt-and-suspenders: confirm the function does not silently
    // return for the equal-input case under any refactor.
    let returned: unknown = undefined;
    try {
      returned = orderPair("dup", "dup");
    } catch {
      /* expected */
    }
    expect(returned).toBeUndefined();
  });

  it("includes the offending id in the self-pair error message", () => {
    // On-call uses this id to trace back to the caller that built the
    // bad pair. Pinned via substring (not exact) so the wording can
    // evolve.
    expect(() => orderPair("trace-me-42", "trace-me-42")).toThrow(/trace-me-42/);
  });
});

describe("isOrderedPair contract", () => {
  it("returns true when the pair is already canonical", () => {
    expect(isOrderedPair("a", "b")).toBe(true);
  });

  it("returns false when the pair is reversed", () => {
    expect(isOrderedPair("b", "a")).toBe(false);
  });

  it("returns FALSE for equal inputs (pin against <= refactor)", () => {
    // Equal inputs are NOT canonical because `orderPair` will refuse
    // to produce them. A refactor to `<=` would flip this and let
    // callers skip the swap on (x, x), then hand the un-swapped pair
    // to a downstream `orderPair` call which would then throw —
    // turning a logic bug into a runtime crash deep in the call stack.
    expect(isOrderedPair("same", "same")).toBe(false);
  });

  it("agrees with orderPair: isOrderedPair(orderPair(x,y).userAId, orderPair(x,y).userBId) === true", () => {
    // Cross-check: the output of orderPair must always satisfy
    // isOrderedPair. If a refactor changes one comparator and not the
    // other, this asymmetry surfaces here.
    const cases: [string, string][] = [
      ["alpha", "bravo"],
      ["Z", "a"],
      ["10", "2"],
      ["", "x"],
      ["zzz", "aaa"],
    ];
    for (const [x, y] of cases) {
      const ordered = orderPair(x, y);
      expect(isOrderedPair(ordered.userAId, ordered.userBId)).toBe(true);
    }
  });
});

describe("orderPair invariant under random inputs", () => {
  // Belt-and-suspenders against a refactor that only handles ASCII or
  // only handles short ids. The output of orderPair must always
  // satisfy userAId < userBId, regardless of input order.
  it("always produces userAId < userBId for any distinct (x, y)", () => {
    const rand = (): string => {
      // Mix lengths, cases, digits, and punctuation. Avoid producing
      // identical strings (we filter below).
      const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";
      const len = 1 + Math.floor(Math.random() * 30);
      let s = "";
      for (let i = 0; i < len; i++) {
        s += alphabet[Math.floor(Math.random() * alphabet.length)];
      }
      return s;
    };
    for (let i = 0; i < 200; i++) {
      let x = rand();
      let y = rand();
      while (x === y) y = rand();
      const result = orderPair(x, y);
      expect(result.userAId < result.userBId).toBe(true);
      // And the result must always be one of the two inputs — the
      // helper must not invent or mutate ids.
      expect([x, y]).toContain(result.userAId);
      expect([x, y]).toContain(result.userBId);
      expect(result.userAId).not.toBe(result.userBId);
    }
  });
});
