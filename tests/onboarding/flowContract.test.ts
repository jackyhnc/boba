// Structural contract pins for the onboarding state machine
// (src/onboarding/flow.ts + src/onboarding/types.ts).
//
// `flow.test.ts` already pins specific input/output behaviors of each
// parser. This file pins the harder-to-see *structural* invariants that
// would let a refactor silently break the machine without flipping any
// existing test:
//
//   1. STEP_PARSERS exhaustively covers every non-pseudo step in
//      STEP_ORDER. Adding a step to STEP_ORDER without wiring a parser
//      crashes at runtime with `Cannot read properties of undefined
//      (reading 'parse')`. Pinning the coverage prevents that.
//
//   2. "welcome" and "done" are the ONLY pseudo-steps — they are
//      handled inline by `advance` and intentionally absent from
//      STEP_PARSERS. If a third pseudo-step is introduced, both this
//      pin and the `advance` switch must be updated together.
//
//   3. A full walk through STEP_ORDER from the first real step to the
//      last advances exactly one slot per successful parse, never
//      skips a step, and terminates with `nextStep === "done"`. This
//      pins both the order of slots and the linkage `nextStepAfter`.
//
//   4. `markActive` is true if and only if `nextStep === "done"` —
//      across every reachable state. Flipping a user to ACTIVE before
//      onboarding finishes (or failing to flip when it does) would
//      both break invite-gated rollouts and the daily-match selector.
//
//   5. `mergeUpdates` performs a shallow merge per nested slot
//      (user / stats / preferences) — keys present in `a` but absent
//      in `b` survive. A naive "improvement" that replaced the slot
//      wholesale would silently wipe earlier answers when the relay
//      layer accumulates updates across retries.
//
//   6. `mergeUpdates` intentionally drops `inviteCodeToRedeem` — it
//      is a one-shot directive consumed by routes.ts immediately and
//      must not survive a merge (which would risk double-redemption).
//
//   7. A parser failure leaves the cursor on `currentStep`, emits the
//      parser's reason as the reply, returns empty updates, and does
//      NOT mark the user active. Pinned across every real step so a
//      refactor that changes failure handling for one slot is caught.
//
//   8. The `ask_invite_code` pass-through (invites disabled) ignores
//      the body entirely — null / empty / garbage all produce the
//      same advance. This is the seam that prevents a stuck user when
//      the env flag flips mid-flow.
//
//   9. The `done` cursor is idempotent — re-sending any body keeps the
//      cursor at `done`, emits no field updates, and keeps markActive
//      true (the user is still ACTIVE).

import { describe, it, expect } from "vitest";
import {
  advance,
  COPY,
  mergeUpdates,
} from "../../src/onboarding/flow.js";
import {
  STEP_IDS,
  STEP_ORDER,
  type StepId,
} from "../../src/onboarding/types.js";

// ─── Helpers ───────────────────────────────────────────────────────────────

const PSEUDO_STEPS: ReadonlyArray<StepId> = ["welcome", "done"];

const REAL_STEPS: ReadonlyArray<StepId> = STEP_ORDER.filter(
  (s) => !PSEUDO_STEPS.includes(s),
);

/**
 * A valid body + (optional) media for each real step. Designed to be
 * the minimal input that the parser accepts. Lives here (not in flow.ts)
 * because the pin is on coverage, not on the choice of value.
 */
const VALID_INPUT: Record<
  Exclude<StepId, "welcome" | "done">,
  { body: string; media?: { url: string; contentType: string | null } }
> = {
  ask_invite_code: { body: "ABCD-1234" },
  ask_display_name: { body: "Alice" },
  ask_age: { body: "25" },
  ask_gender: { body: "WOMAN" },
  ask_profession: { body: "student" },
  ask_height_cm: { body: "175" },
  ask_photo: {
    body: "",
    media: { url: "https://example.com/p.jpg", contentType: "image/jpeg" },
  },
  ask_preferred_genders: { body: "WOMAN, MAN" },
  ask_min_age: { body: "21" },
  ask_max_age: { body: "30" },
  ask_type_descriptor: { body: "someone curious and kind" },
  ask_campus_email_domain: { body: "princeton.edu" },
};

/**
 * An invalid body for each real step (the photo step takes the body
 * route — non-SKIP without media). Used by the failure-handling pin.
 */
const INVALID_INPUT: Record<
  Exclude<StepId, "welcome" | "done">,
  string
> = {
  ask_invite_code: "short",
  ask_display_name: "+15551234567", // numeric-looking, rejected
  ask_age: "twelve",
  ask_gender: "asdf",
  ask_profession: "x".repeat(81), // 81 > 80 cap
  ask_height_cm: "999",
  ask_photo: "ok", // not SKIP, no media → reject
  ask_preferred_genders: "dinosaur",
  ask_min_age: "10",
  ask_max_age: "9001",
  ask_type_descriptor: "x", // < 3 chars
  ask_campus_email_domain: "not a domain at all",
};

// ─── Pin 1 & 2: STEP_PARSERS structural coverage ──────────────────────────

describe("onboarding/flow — STEP_PARSERS structural coverage", () => {
  it("every non-pseudo step in STEP_ORDER advances when given valid input", () => {
    // If a step were added to STEP_ORDER without a parser entry, the
    // first inbound landing on that step would throw
    // `Cannot read properties of undefined (reading 'parse')`. Walking
    // every real step and confirming an advance pins the coverage
    // without depending on the un-exported STEP_PARSERS table.
    for (const step of REAL_STEPS) {
      const input = VALID_INPUT[step as keyof typeof VALID_INPUT];
      const r = advance(step, input.body, { media: input.media ?? null });
      expect(r.nextStep, `expected ${step} to advance`).not.toBe(step);
    }
  });

  it("welcome and done are the only pseudo-steps (handled inline by advance)", () => {
    // The pin: PSEUDO_STEPS exactly matches the steps `advance` handles
    // before consulting STEP_PARSERS. Pseudo-steps must not be parsed.
    expect([...PSEUDO_STEPS].sort()).toEqual(["done", "welcome"]);

    // welcome: any body produces the welcome reply (no parser invoked).
    const w = advance("welcome", "literally anything");
    expect(w.reply).toBe(COPY.welcomeWithInvite);
    expect(w.updates).toEqual({});

    // done: any body keeps the cursor (no parser invoked).
    const d = advance("done", "literally anything");
    expect(d.nextStep).toBe("done");
    expect(d.updates).toEqual({});
  });

  it("STEP_IDS and STEP_ORDER are the same array (single source of truth)", () => {
    // STEP_ORDER is exported separately as the linkage source for
    // nextStepAfter. If it ever diverges from STEP_IDS — e.g. a step
    // gets added to STEP_IDS but not STEP_ORDER — the type system
    // wouldn't catch it but the machine would silently skip the step.
    expect([...STEP_ORDER]).toEqual([...STEP_IDS]);
  });
});

// ─── Pin 3: linear walk through STEP_ORDER ────────────────────────────────

describe("onboarding/flow — linear walk through STEP_ORDER", () => {
  it("a full success walk visits each real step exactly once and terminates at done", () => {
    // Start from the first real step. Successive valid answers must
    // advance to exactly STEP_ORDER[i+1] each time, never skipping.
    const firstReal = REAL_STEPS[0];
    expect(firstReal).toBe("ask_invite_code"); // anchor

    let cursor: StepId = firstReal as StepId;
    const visited: StepId[] = [cursor];
    // +1 to walk *past* the last real step into "done".
    for (let i = 0; i < REAL_STEPS.length; i++) {
      const input = VALID_INPUT[cursor as keyof typeof VALID_INPUT];
      const r = advance(cursor, input.body, { media: input.media ?? null });

      const expectedIdx = STEP_ORDER.indexOf(cursor) + 1;
      const expectedNext = STEP_ORDER[expectedIdx];
      // STEP_ORDER is closed under nextStepAfter: walking off the end
      // lands on "done", which is in-bounds. A miss here means the array
      // changed shape, not that `expectedNext` is genuinely undefined.
      expect(expectedNext, `STEP_ORDER missing index ${expectedIdx}`).toBeDefined();
      expect(r.nextStep, `from ${cursor}`).toBe(expectedNext);

      cursor = r.nextStep;
      visited.push(cursor);
      if (cursor === "done") break;
    }

    // Visited the welcome-adjacent first step + every real step + done.
    expect(cursor).toBe("done");
    // Sanity: we never repeated a step.
    expect(new Set(visited).size).toBe(visited.length);
    // Sanity: every real step appears in the trace.
    for (const s of REAL_STEPS) {
      expect(visited).toContain(s);
    }
  });
});

// ─── Pin 4: markActive ⇔ nextStep === "done" ─────────────────────────────

describe("onboarding/flow — markActive invariant", () => {
  it("markActive is true if and only if nextStep === 'done', across every reachable state", () => {
    type Case = {
      label: string;
      cursor: StepId | null;
      body: string;
      media?: { url: string; contentType: string | null } | null;
      config?: { invitesRequired: boolean };
    };

    const cases: Case[] = [
      // Entry.
      { label: "null + invites required", cursor: null, body: "x" },
      {
        label: "null + invites disabled",
        cursor: null,
        body: "x",
        config: { invitesRequired: false },
      },
      { label: "welcome cursor", cursor: "welcome", body: "x" },
      // Pass-through.
      {
        label: "ask_invite_code pass-through",
        cursor: "ask_invite_code",
        body: "garbage",
        config: { invitesRequired: false },
      },
      // Every real step with a successful advance.
      ...REAL_STEPS.map((s): Case => {
        const input = VALID_INPUT[s as keyof typeof VALID_INPUT];
        return {
          label: `success: ${s}`,
          cursor: s,
          body: input.body,
          media: input.media ?? null,
        };
      }),
      // Every real step with a failed advance.
      ...REAL_STEPS.map((s): Case => {
        return { label: `failure: ${s}`, cursor: s, body: INVALID_INPUT[s as keyof typeof INVALID_INPUT] };
      }),
      // Already-done.
      { label: "done cursor", cursor: "done", body: "x" },
    ];

    for (const c of cases) {
      const r = advance(c.cursor, c.body, {
        media: c.media,
        config: c.config,
      });
      const shouldBeActive = r.nextStep === "done";
      expect(
        r.markActive,
        `markActive must equal (nextStep === "done") for [${c.label}]; got nextStep=${r.nextStep}, markActive=${r.markActive}`,
      ).toBe(shouldBeActive);
    }
  });
});

// ─── Pin 5 & 6: mergeUpdates semantics ────────────────────────────────────

describe("onboarding/flow — mergeUpdates shallow-per-slot semantics", () => {
  it("preserves keys in `a` that are absent in `b` (shallow merge per slot)", () => {
    // The relay layer accumulates updates across an inbound's life
    // cycle: an advance produces updates, and downstream code may merge
    // those with the user's prior state. If mergeUpdates replaced the
    // whole slot (instead of spreading per-key) earlier answers would
    // vanish silently the moment a single new field came in.
    const merged = mergeUpdates(
      {
        user: { displayName: "Alice", campusEmailDomain: "princeton.edu" },
        stats: { age: 22, profession: "student", heightCm: 170 },
        preferences: { minAge: 20, maxAge: 30, typeDescriptor: "kind" },
      },
      {
        // Only one field per slot — verify the others survive.
        user: { displayName: "Alicia" },
        stats: { profession: "TA" },
        preferences: { maxAge: 35 },
      },
    );
    expect(merged).toEqual({
      user: { displayName: "Alicia", campusEmailDomain: "princeton.edu" },
      stats: { age: 22, profession: "TA", heightCm: 170 },
      preferences: { minAge: 20, maxAge: 35, typeDescriptor: "kind" },
    });
  });

  it("treats missing slots in `a` or `b` as empty, never returns undefined slots", () => {
    // mergeUpdates always returns all three nested slots as objects.
    // Persisters depend on `slot && Object.keys(slot).length > 0`
    // checks; an `undefined` slot would skip the same write-path but a
    // `null` slot would crash. Pin the shape.
    const m1 = mergeUpdates({}, { user: { displayName: "X" } });
    expect(m1.user).toEqual({ displayName: "X" });
    expect(m1.stats).toEqual({});
    expect(m1.preferences).toEqual({});

    const m2 = mergeUpdates(
      { preferences: { minAge: 18 } },
      {},
    );
    expect(m2.user).toEqual({});
    expect(m2.stats).toEqual({});
    expect(m2.preferences).toEqual({ minAge: 18 });

    const m3 = mergeUpdates({}, {});
    expect(m3).toEqual({ user: {}, stats: {}, preferences: {} });
  });

  it("intentionally drops `inviteCodeToRedeem` — directive must not propagate", () => {
    // `inviteCodeToRedeem` is consumed by routes.ts immediately on the
    // step it's produced, then explicitly deleted before persistOnboardingUpdates
    // runs. If mergeUpdates carried it forward, a follow-up merge cycle
    // could resurrect it and double-redeem the code. This pin makes the
    // drop intentional and visible.
    const merged = mergeUpdates(
      { inviteCodeToRedeem: "ABCD1234", user: { displayName: "A" } },
      { user: { displayName: "B" } },
    );
    expect("inviteCodeToRedeem" in merged).toBe(false);
    expect(merged.user).toEqual({ displayName: "B" });

    const mergedB = mergeUpdates(
      { user: { displayName: "A" } },
      { inviteCodeToRedeem: "ABCD1234" },
    );
    expect("inviteCodeToRedeem" in mergedB).toBe(false);
  });

  it("b wins on per-key conflicts within a slot", () => {
    // The merge order — `{ ...a.user, ...b.user }` — means b wins for
    // any field present in both. Pinned so a refactor to a "merge with
    // a-wins" doesn't silently invert which side overwrites.
    const merged = mergeUpdates(
      { stats: { age: 22, heightCm: 170 } },
      { stats: { age: 23 } },
    );
    expect(merged.stats?.age).toBe(23);
    expect(merged.stats?.heightCm).toBe(170);
  });
});

// ─── Pin 7: parser failures are uniformly handled ─────────────────────────

describe("onboarding/flow — parser failure shape", () => {
  it("a failed parse keeps cursor at currentStep with empty updates and markActive=false", () => {
    for (const step of REAL_STEPS) {
      const body = INVALID_INPUT[step as keyof typeof INVALID_INPUT];
      const r = advance(step, body);
      expect(r.nextStep, `failure at ${step} must NOT advance`).toBe(step);
      expect(r.updates, `failure at ${step} must emit no updates`).toEqual({});
      expect(r.markActive, `failure at ${step} must NOT mark active`).toBe(
        false,
      );
      // The reply on failure is the parser's reason string (non-empty).
      expect(typeof r.reply).toBe("string");
      expect(r.reply.length).toBeGreaterThan(0);
    }
  });
});

// ─── Pin 8: invite pass-through ignores body ──────────────────────────────

describe("onboarding/flow — invite-code pass-through (invites disabled)", () => {
  it("advances to ask_display_name regardless of body content", () => {
    // The pass-through is the unstuck-me valve for a returning user
    // whose flow was started when invites were required and then the
    // env flag flipped to disabled. Body content must be irrelevant.
    const inputs = ["", "   ", "ABCD-1234", "garbage!!!", "skip"];
    const config = { invitesRequired: false };

    const results = inputs.map((body) =>
      advance("ask_invite_code", body, { config }),
    );

    for (const r of results) {
      expect(r.nextStep).toBe("ask_display_name");
      expect(r.updates).toEqual({});
      expect(r.reply).toBe(COPY.askDisplayName);
      expect(r.markActive).toBe(false);
    }
  });
});

// ─── Pin 9: done is idempotent ────────────────────────────────────────────

describe("onboarding/flow — done cursor is idempotent", () => {
  it("returns the done copy + ACTIVE flag for any body, never writes fields", () => {
    const inputs = ["", "HELP", "delete me", "back", "🧋"];

    for (const body of inputs) {
      const r = advance("done", body);
      expect(r.nextStep).toBe("done");
      expect(r.reply).toBe(COPY.done);
      expect(r.markActive).toBe(true);
      expect(r.updates).toEqual({});
    }
  });
});
