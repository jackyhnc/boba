// Contract pins for src/rematch/index.ts module SURFACE — the bits
// that aren't covered by behaviour tests (eligibility.test.ts) or the
// Prisma query-shape tests (prismaContract.test.ts) or the
// selector-vs-predicate agreement tests (contract.test.ts):
//
//   - The EligibilityReason string union has runtime consequences:
//     the strings end up in logs, will end up in admin-API responses,
//     and will plausibly end up serialized into RematchHistory rows
//     for analytics. TypeScript erases the union at runtime, so a
//     silent rename ("had_discard" → "discarded") would break log
//     queries, dashboards, and any consumer pattern-matching the
//     string — without any test failing.
//
//   - DEFAULT_REMATCH_CONFIG.rematchCooldownDays is defined as a
//     REFERENCE to DEFAULT_SELECTOR_CONFIG.rematchCooldownDays
//     (`src/rematch/index.ts:33`). The whole point of the rematch
//     module is to be the canonical home of the rule the selector
//     ALSO applies — they must agree on the cooldown number. A
//     refactor that hardcoded `14` here would not break any test
//     today even if SelectorConfig later changed to 21.
//
//   - The EligibilityResult shape is exactly 3 fields; the
//     {reason, eligible, cooldownRemainingDays} contract is what
//     callers destructure. Over-fetching (e.g. echoing the input
//     history back as a 4th field) would be a silent API expansion.
//
//   - `pairKey` is re-exported from `../matching/selector.js`
//     (last line of index.ts). That re-export is load-bearing: it
//     lets the rest of the codebase do `import { pairKey } from
//     ".../rematch"` instead of reaching across module boundaries.
//     A regression that dropped the re-export would surface as TS
//     errors in callers — but the re-export ALSO must be the SAME
//     function identity, not a wrapper, so callers can compare keys
//     produced by either path.
//
// None of these claims are pinned anywhere else in the suite.

import { describe, it, expect } from "vitest";
import {
  DEFAULT_REMATCH_CONFIG,
  isEligibleForRematch,
  pairKey as pairKeyFromRematch,
  type EligibilityReason,
  type EligibilityResult,
} from "../../src/rematch/index.js";
import {
  pairKey as pairKeyFromSelector,
  toDateKey,
} from "../../src/matching/selector.js";
import { DEFAULT_SELECTOR_CONFIG } from "../../src/matching/types.js";

const TODAY = new Date(Date.UTC(2026, 4, 17));

// Helper: build a history entry N days before TODAY.
function historyDaysAgo(
  n: number,
  hasDiscard = false,
): { lastMatchedOn: string; hasDiscard: boolean; matchCount: number } {
  const d = new Date(TODAY);
  d.setUTCDate(d.getUTCDate() - n);
  return { lastMatchedOn: toDateKey(d), hasDiscard, matchCount: 1 };
}

describe("EligibilityReason — string surface is closed and exact", () => {
  // The canonical, alphabetized set. Any future addition MUST update
  // this list (and the call sites consuming it), and any rename MUST
  // also update logs/dashboards — the failure here is the prompt.
  const REASONS_EXACT: ReadonlyArray<EligibilityReason> = [
    "cooldown_elapsed",
    "had_discard",
    "never_matched",
    "within_cooldown",
  ];

  it("there are exactly 4 reasons (no addition without a contract update)", () => {
    expect(REASONS_EXACT).toHaveLength(4);
  });

  it("each reason is reachable via the documented input combination", () => {
    // Round-trip each reason through `isEligibleForRematch` and pin the
    // observed string verbatim. If anyone renames a literal in
    // src/rematch/index.ts these expectations break loudly.
    const observed = new Set<string>();

    observed.add(
      isEligibleForRematch({ history: null, today: TODAY }).reason,
    );
    observed.add(
      isEligibleForRematch({
        history: historyDaysAgo(30),
        today: TODAY,
      }).reason,
    );
    observed.add(
      isEligibleForRematch({
        history: historyDaysAgo(3),
        today: TODAY,
      }).reason,
    );
    observed.add(
      isEligibleForRematch({
        history: historyDaysAgo(30, true),
        today: TODAY,
      }).reason,
    );

    expect([...observed].sort()).toEqual([...REASONS_EXACT]);
  });

  it("never_matched: input history === null", () => {
    expect(isEligibleForRematch({ history: null, today: TODAY }).reason).toBe(
      "never_matched",
    );
  });

  it("cooldown_elapsed: history exists, no discard, daysSince ≥ cooldown", () => {
    expect(
      isEligibleForRematch({
        history: historyDaysAgo(30),
        today: TODAY,
      }).reason,
    ).toBe("cooldown_elapsed");
  });

  it("within_cooldown: history exists, no discard, daysSince < cooldown", () => {
    expect(
      isEligibleForRematch({
        history: historyDaysAgo(3),
        today: TODAY,
      }).reason,
    ).toBe("within_cooldown");
  });

  it("had_discard: hasDiscard=true wins over any timing", () => {
    // Crucially: had_discard wins even when cooldown has elapsed, so a
    // refactor that checked cooldown before discard would still
    // pass-by-coincidence on every cooldown-violating case. Pick a
    // history that WOULD be `cooldown_elapsed` if not for the discard
    // — that pins the precedence, not just the label.
    expect(
      isEligibleForRematch({
        history: historyDaysAgo(30, true),
        today: TODAY,
      }).reason,
    ).toBe("had_discard");
  });
});

describe("EligibilityResult — shape is exactly {eligible, reason, cooldownRemainingDays}", () => {
  // Sample every reason path and assert the key set never grows. A
  // future addition like `nextEligibleAt: Date` would be a silent API
  // expansion; pin it.
  const samples: Array<{ label: string; result: EligibilityResult }> = [
    {
      label: "never_matched",
      result: isEligibleForRematch({ history: null, today: TODAY }),
    },
    {
      label: "cooldown_elapsed",
      result: isEligibleForRematch({
        history: historyDaysAgo(30),
        today: TODAY,
      }),
    },
    {
      label: "within_cooldown",
      result: isEligibleForRematch({
        history: historyDaysAgo(3),
        today: TODAY,
      }),
    },
    {
      label: "had_discard",
      result: isEligibleForRematch({
        history: historyDaysAgo(30, true),
        today: TODAY,
      }),
    },
  ];

  for (const { label, result } of samples) {
    it(`${label} → result has exactly 3 keys, alphabetized: cooldownRemainingDays, eligible, reason`, () => {
      expect(Object.keys(result).sort()).toEqual([
        "cooldownRemainingDays",
        "eligible",
        "reason",
      ]);
    });
  }
});

describe("reason ↔ eligible polarity is fixed", () => {
  // Truth table: every reason maps to a fixed boolean. A refactor that
  // (e.g.) made `cooldown_elapsed` start returning eligible:false to
  // implement a soft-cooldown experiment would break the contract that
  // the reason string alone tells the caller whether the pair passed.
  it("never_matched → eligible:true", () => {
    expect(
      isEligibleForRematch({ history: null, today: TODAY }).eligible,
    ).toBe(true);
  });

  it("cooldown_elapsed → eligible:true", () => {
    expect(
      isEligibleForRematch({
        history: historyDaysAgo(30),
        today: TODAY,
      }).eligible,
    ).toBe(true);
  });

  it("within_cooldown → eligible:false", () => {
    expect(
      isEligibleForRematch({
        history: historyDaysAgo(3),
        today: TODAY,
      }).eligible,
    ).toBe(false);
  });

  it("had_discard → eligible:false", () => {
    expect(
      isEligibleForRematch({
        history: historyDaysAgo(30, true),
        today: TODAY,
      }).eligible,
    ).toBe(false);
  });
});

describe("cooldownRemainingDays invariant — only set for within_cooldown", () => {
  // The field exists on every result for shape stability, but it's
  // semantically meaningful ONLY in the within_cooldown branch. If a
  // refactor started leaking remaining-days into other branches, the
  // future UI ("you'll see this person again in N days") would
  // misreport for never-matched and discarded pairs. Pin the zeros.
  it("never_matched → 0", () => {
    expect(
      isEligibleForRematch({ history: null, today: TODAY })
        .cooldownRemainingDays,
    ).toBe(0);
  });

  it("cooldown_elapsed → 0", () => {
    expect(
      isEligibleForRematch({
        history: historyDaysAgo(30),
        today: TODAY,
      }).cooldownRemainingDays,
    ).toBe(0);
  });

  it("had_discard → 0 (NOT the days since discard — that would be misleading UX)", () => {
    expect(
      isEligibleForRematch({
        history: historyDaysAgo(30, true),
        today: TODAY,
      }).cooldownRemainingDays,
    ).toBe(0);
  });

  it("within_cooldown → strictly positive (cooldownDays - daysSince)", () => {
    // 3 days ago, default cooldown 14 → 11 days remaining. Already
    // covered in eligibility.test.ts, but pinned here ALONGSIDE the
    // zero-cases so the invariant "positive iff within_cooldown" is
    // observable in one file.
    const r = isEligibleForRematch({
      history: historyDaysAgo(3),
      today: TODAY,
    });
    expect(r.cooldownRemainingDays).toBeGreaterThan(0);
    expect(r.cooldownRemainingDays).toBe(11);
  });

  it("within_cooldown @ boundary (daysSince = cooldown - 1) → 1 day remaining", () => {
    // Boundary probe: with default cooldown=14, 13 days ago should
    // report exactly 1 day remaining (not 0, not 2). Catches off-by-one
    // regressions in `cfg.rematchCooldownDays - daysSince`.
    expect(
      isEligibleForRematch({
        history: historyDaysAgo(13),
        today: TODAY,
      }).cooldownRemainingDays,
    ).toBe(1);
  });
});

describe("DEFAULT_REMATCH_CONFIG — cross-module identity with selector default", () => {
  it("rematchCooldownDays mirrors DEFAULT_SELECTOR_CONFIG.rematchCooldownDays", () => {
    // The whole reason the rematch module exists is to be the
    // first-class home of the rule the selector ALSO enforces. If
    // these two numbers ever drift, you have two different cooldown
    // policies depending on which entrypoint the caller used —
    // exactly the bug this module's docstring warns against.
    expect(DEFAULT_REMATCH_CONFIG.rematchCooldownDays).toBe(
      DEFAULT_SELECTOR_CONFIG.rematchCooldownDays,
    );
  });

  it("the shared default value is 14 days (pinned for stability)", () => {
    // Independent pin: even if BOTH defaults are renamed/relocated
    // together, the number 14 itself is product policy that surfaces
    // in copy ("once every two weeks"), in analytics windowing, and
    // in moderation backoff windows. A change here MUST be a
    // deliberate product decision, not a passing-through refactor.
    expect(DEFAULT_REMATCH_CONFIG.rematchCooldownDays).toBe(14);
  });

  it("DEFAULT_REMATCH_CONFIG has EXACTLY one key — `rematchCooldownDays`", () => {
    // EligibilityConfig is intentionally a strict subset of
    // SelectorConfig (no `minScore`, no scoring weights). Pin the
    // narrow surface so a future "let's share the whole config"
    // refactor surfaces here.
    expect(Object.keys(DEFAULT_REMATCH_CONFIG)).toEqual([
      "rematchCooldownDays",
    ]);
  });

  it("DEFAULT_REMATCH_CONFIG does NOT leak `minScore` from the selector config", () => {
    // The selector config has minScore=0.3. If a refactor changed
    // `EligibilityConfig` to `SelectorConfig` (or copied the whole
    // object), `minScore` would silently appear on the rematch
    // default — irrelevant to eligibility, but observable on the
    // module surface. Pin the absence.
    expect(
      (DEFAULT_REMATCH_CONFIG as unknown as Record<string, unknown>).minScore,
    ).toBe(undefined);
  });
});

describe("config override — shallow merge over DEFAULT_REMATCH_CONFIG", () => {
  // `isEligibleForRematch` does `{ ...DEFAULT_REMATCH_CONFIG, ...(args.config ?? {}) }`.
  // Pin the merge semantics so a future swap to deep-merge or to
  // `Object.assign(DEFAULT_REMATCH_CONFIG, ...)` (which would mutate
  // the default) is loud.
  it("undefined config falls back to DEFAULT_REMATCH_CONFIG.rematchCooldownDays (14)", () => {
    // 13 days ago must be within_cooldown under the default 14.
    const r = isEligibleForRematch({
      history: historyDaysAgo(13),
      today: TODAY,
    });
    expect(r.reason).toBe("within_cooldown");
  });

  it("empty {} config also falls back to defaults — no error, no override", () => {
    const r = isEligibleForRematch({
      history: historyDaysAgo(13),
      today: TODAY,
      config: {},
    });
    expect(r.reason).toBe("within_cooldown");
  });

  it("override of rematchCooldownDays takes effect, default is NOT mutated", () => {
    const before = DEFAULT_REMATCH_CONFIG.rematchCooldownDays;
    const r = isEligibleForRematch({
      history: historyDaysAgo(13),
      today: TODAY,
      config: { rematchCooldownDays: 7 },
    });
    expect(r.reason).toBe("cooldown_elapsed");
    // Identity check: the default constant must not be mutated by the
    // call (a regression to Object.assign would silently mutate it).
    expect(DEFAULT_REMATCH_CONFIG.rematchCooldownDays).toBe(before);
    expect(DEFAULT_REMATCH_CONFIG.rematchCooldownDays).toBe(14);
  });

  it("rematchCooldownDays=0 means every history pair is immediately re-eligible", () => {
    // Edge: 0-cooldown is a legitimate config (e.g. "no cooldown for
    // an experiment"). With 0, even a 0-days-ago history is eligible
    // because `daysSince >= 0` is true. Pin so a future
    // `cfg.rematchCooldownDays > 0` guard doesn't quietly break this.
    const r = isEligibleForRematch({
      history: historyDaysAgo(0),
      today: TODAY,
      config: { rematchCooldownDays: 0 },
    });
    expect(r.eligible).toBe(true);
    expect(r.reason).toBe("cooldown_elapsed");
  });
});

describe("pairKey re-export — identity with src/matching/selector.js", () => {
  // `src/rematch/index.ts` ends with `export { pairKey } from
  // "../matching/selector.js";`. The re-export is load-bearing for
  // callers and MUST be the same function identity, not a wrapper —
  // a wrapper could subtly change behaviour (case folding, sorting
  // semantics) and break cross-module key equality.
  it("the function exported by rematch is the SAME reference as selector's pairKey", () => {
    expect(pairKeyFromRematch).toBe(pairKeyFromSelector);
  });

  it("keys produced via either import are byte-identical", () => {
    // Defence-in-depth: even if a future refactor adds a thin wrapper
    // that *happens* to produce the same string, the identity check
    // above catches it. This second check catches the case where
    // someone breaks the identity check on purpose and forgets to
    // also break consumers.
    expect(pairKeyFromRematch("u1", "u2")).toBe(pairKeyFromSelector("u1", "u2"));
    expect(pairKeyFromRematch("u2", "u1")).toBe(pairKeyFromSelector("u2", "u1"));
  });
});
