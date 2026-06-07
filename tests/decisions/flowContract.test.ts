// Contract pins for src/decisions/flow.ts.
//
// `tests/decisions/flow.test.ts` already covers happy-path behaviour, but it
// asserts only with regex substrings (e.g. /keep talking/i) and never
// enumerates the keyword set. The invariants below sit at seams a well-
// intentioned refactor could quietly violate without tripping the existing
// suite:
//
//   1. Every COPY constant is sent verbatim over SMS — substring assertions
//      let cosmetic changes pass even when the user-visible string drifts
//      meaningfully. Pin exact bodies.
//   2. KEYWORD_MAP membership: the exact set of accepted decision tokens is
//      part of the user contract (we promise "Reply KEEP / MAYBE / DISCARD"
//      and accept K / M / D / PASS / NOPE as silent synonyms). Adding YES
//      would silently steal the carrier opt-in path; removing PASS would
//      drop a documented synonym. Exhaustive set check.
//   3. Decision-keyword vs carrier-keyword non-collision: the safety
//      detector (STOP/HELP/START variants) runs upstream of decision
//      detection in the inbound router. If a decision synonym ever
//      collides with a safety token, it becomes unreachable. Cross-check
//      the two token sets.
//   4. parseDecisionKeyword is strictly exact-token: substrings like
//      "KEEPER", "MAYBES", "DISCARDED", "KEEPING", "PASSED" must all be
//      null. Compare to the safety detector which strips trailing
//      punctuation — flow does NOT (by design), so "KEEP." is chat, not
//      a decision. Pin the punctuation behaviour difference.
//   5. resolve() echoes decisionA / decisionB in input order on every
//      branch (existing tests only inspect .outcome). A future refactor
//      that canonicalised order in resolve() — to match orderPair() — would
//      pass flow.test.ts but break decisions/prisma-deps.ts which relies
//      on positional identity to map back to the (userA, userB) row.
//   6. replyForOwnDecision and resolutionAnnouncement outputs are
//      pairwise distinct — a swap between e.g. continued and pendingForPartner
//      would pass the existing /continues/i and /ready/i regex checks (the
//      strings happen to share the word "your"), but produce wrong UX.
//   7. faceRevealBody returns one of exactly two COPY constants.

import { describe, it, expect } from "vitest";
import {
  COPY,
  faceRevealBody,
  parseDecisionKeyword,
  replyForOwnDecision,
  resolutionAnnouncement,
  resolve,
} from "../../src/decisions/flow.js";
import { detectSmsKeyword } from "../../src/safety/smsKeywords.js";
import type { Decision } from "../../src/decisions/types.js";

// ─── 1. Exact COPY body pins ───────────────────────────────────────────────

describe("decisions/flow contract — COPY exact bodies", () => {
  // SMS-visible strings. Any deliberate copy change updates this file in
  // the same commit. Drift without an update is the bug we're catching.

  it("ackKeep is the exact KEEP acknowledgement body", () => {
    expect(COPY.ackKeep).toBe(
      "Got it — you'd like to keep talking. We'll let you know once your match decides.",
    );
  });

  it("ackMaybe is the exact MAYBE acknowledgement body", () => {
    expect(COPY.ackMaybe).toBe(
      "Got it — you're open to it. We'll let you know once your match decides.",
    );
  });

  it("ackDiscard is the exact DISCARD acknowledgement body", () => {
    expect(COPY.ackDiscard).toBe(
      "Got it — match ended. We'll line up someone new for you tomorrow.",
    );
  });

  it("pendingForPartner is the exact partner-prompt body", () => {
    expect(COPY.pendingForPartner).toBe(
      "Your match made their end-of-day decision. Reply KEEP, MAYBE, or DISCARD when you're ready.",
    );
  });

  it("continued is the exact both-in body (with emoji)", () => {
    expect(COPY.continued).toBe(
      "🎉 You're both in. Your conversation continues tomorrow — same number, fresh day.",
    );
  });

  it("endedByDiscard is the exact end-of-match body", () => {
    expect(COPY.endedByDiscard).toBe(
      "This match has ended. We'll set you up with someone new tomorrow.",
    );
  });

  it("faceRevealWithPhoto is the exact MMS-companion body", () => {
    expect(COPY.faceRevealWithPhoto).toBe(
      "👀 You earned the reveal — here's the face behind the conversation.",
    );
  });

  it("faceRevealNoPhoto is the exact no-photo-fallback body", () => {
    expect(COPY.faceRevealNoPhoto).toBe(
      "👀 Reveal time! Your match hasn't added a photo yet — ask them about it tomorrow.",
    );
  });

  it("COPY exposes exactly the documented keys — no orphan strings", () => {
    expect(Object.keys(COPY).sort()).toEqual(
      [
        "ackDiscard",
        "ackKeep",
        "ackMaybe",
        "continued",
        "endedByDiscard",
        "faceRevealNoPhoto",
        "faceRevealWithPhoto",
        "pendingForPartner",
      ].sort(),
    );
  });
});

// ─── 2. Decision-keyword set is exhaustively pinned ────────────────────────

describe("decisions/flow contract — KEYWORD_MAP membership", () => {
  // We probe parseDecisionKeyword as a black box rather than importing the
  // internal KEYWORD_MAP — same effect, but keeps the map private.

  const KEEP_TOKENS = ["KEEP", "K"] as const;
  const MAYBE_TOKENS = ["MAYBE", "M"] as const;
  const DISCARD_TOKENS = ["DISCARD", "PASS", "NOPE", "D"] as const;

  it("every KEEP token maps to KEEP", () => {
    for (const t of KEEP_TOKENS) expect(parseDecisionKeyword(t)).toBe("KEEP");
  });

  it("every MAYBE token maps to MAYBE", () => {
    for (const t of MAYBE_TOKENS) expect(parseDecisionKeyword(t)).toBe("MAYBE");
  });

  it("every DISCARD token maps to DISCARD", () => {
    for (const t of DISCARD_TOKENS)
      expect(parseDecisionKeyword(t)).toBe("DISCARD");
  });

  it("plausible-looking tokens that are NOT in the set return null", () => {
    // YES / NO / Y / N are candidates a future refactor might add but would
    // collide with safety (YES is a START token) or be ambiguous.
    // OK / SURE / NAH / NEVER are common chat words that must NOT be
    // mistaken for a decision.
    const negatives = [
      "YES", "NO", "Y", "N",
      "OK", "OKAY", "SURE", "NAH", "NEVER",
      "DROP", "CONTINUE", "NEXT", "STAY", "GO",
    ];
    for (const t of negatives) {
      expect(parseDecisionKeyword(t), `expected null for ${t}`).toBeNull();
    }
  });
});

// ─── 3. Decision keywords are disjoint from carrier-mandated tokens ────────

describe("decisions/flow contract — no collision with CTIA keywords", () => {
  // The inbound router runs the safety detector BEFORE decision parsing.
  // If a decision synonym is also recognised by detectSmsKeyword, that
  // synonym becomes unreachable (the safety path short-circuits). This
  // would silently break documented decision synonyms in production.
  //
  // We hold the cross-check here rather than in smsKeywords because the
  // accepted decision set is owned by this module — additions land here
  // first, and this test forces a deliberate decision when they would
  // collide.

  const ALL_DECISION_TOKENS = [
    "KEEP", "K",
    "MAYBE", "M",
    "DISCARD", "PASS", "NOPE", "D",
  ];

  it("no decision token is also detected as a CTIA STOP/HELP/START keyword", () => {
    for (const t of ALL_DECISION_TOKENS) {
      const safety = detectSmsKeyword(t);
      expect(
        safety.keyword,
        `decision token "${t}" must not be a CTIA control keyword (got ${safety.keyword})`,
      ).toBeNull();
    }
  });
});

// ─── 4. parseDecisionKeyword is strictly exact-token ───────────────────────

describe("decisions/flow contract — parseDecisionKeyword strict matching", () => {
  it("substrings of canonical tokens are null", () => {
    const substrings = [
      "KEEPER", "KEEPING", "KEEPS",
      "MAYBES", "MAYBELLINE",
      "DISCARDED", "DISCARDS", "DISCARDING",
      "PASSED", "PASSING", "PASSES",
      "NOPED", "NOPES",
    ];
    for (const s of substrings) {
      expect(parseDecisionKeyword(s), `expected null for ${s}`).toBeNull();
    }
  });

  it("trailing punctuation is NOT tolerated (differs from safety detector by design)", () => {
    // The safety detector strips [.,!?;:]+ before matching, but flow does
    // not — a user texting "KEEP." is treated as chat, not a decision.
    // This asymmetry is intentional: decision keywords are typed
    // deliberately in response to an explicit prompt, while STOP must be
    // honoured even when typed casually. Lock it in.
    for (const punct of [".", "!", "?", ",", ";", ":"]) {
      expect(parseDecisionKeyword(`KEEP${punct}`)).toBeNull();
      expect(parseDecisionKeyword(`MAYBE${punct}`)).toBeNull();
      expect(parseDecisionKeyword(`DISCARD${punct}`)).toBeNull();
    }
  });

  it("internal whitespace splits the token, so multi-word still rejects", () => {
    // "KEEP IT" trims to "KEEP IT" — not in the map.
    expect(parseDecisionKeyword("KEEP IT")).toBeNull();
    expect(parseDecisionKeyword("K  EEP")).toBeNull();
  });

  it("pure-whitespace and empty bodies return null", () => {
    expect(parseDecisionKeyword("")).toBeNull();
    expect(parseDecisionKeyword(" ")).toBeNull();
    expect(parseDecisionKeyword("\t\n  ")).toBeNull();
  });

  it("leading/trailing whitespace IS tolerated around the exact token", () => {
    // Already covered loosely in flow.test.ts; pinning explicitly here
    // because the surrounding tests rule it out for punctuation — leaving
    // ambiguity about whether whitespace is special.
    expect(parseDecisionKeyword("  KEEP  ")).toBe("KEEP");
    expect(parseDecisionKeyword("\tDISCARD\n")).toBe("DISCARD");
  });
});

// ─── 5. resolve() echoes positional inputs verbatim ────────────────────────

describe("decisions/flow contract — resolve preserves input order", () => {
  // decisions/prisma-deps.ts uses (decisionA, decisionB) positionally to
  // map back to the match's (userAId, userBId) row. If a refactor ever
  // sorted or canonicalised these inside resolve(), the persistence layer
  // would silently write the wrong decision against the wrong user — a
  // catastrophic data-integrity bug that no behavioural test in
  // decisions/flow.test.ts would catch (it only inspects .outcome).

  const ALL: Array<Decision | null> = ["KEEP", "MAYBE", "DISCARD", null];

  it("for every (a, b) combination, result.decisionA === a and result.decisionB === b", () => {
    for (const a of ALL) {
      for (const b of ALL) {
        const r = resolve(a, b);
        expect(r.decisionA, `(${a}, ${b}) decisionA`).toBe(a);
        expect(r.decisionB, `(${a}, ${b}) decisionB`).toBe(b);
      }
    }
  });

  it("result shape is exactly { outcome, decisionA, decisionB } — no extra fields", () => {
    const r = resolve("KEEP", "MAYBE");
    expect(Object.keys(r).sort()).toEqual(["decisionA", "decisionB", "outcome"]);
  });
});

// ─── 6. replyForOwnDecision and resolutionAnnouncement outputs are distinct

describe("decisions/flow contract — cross-wiring is detectable", () => {
  // If a refactor accidentally swapped replyForOwnDecision and
  // resolutionAnnouncement branches, the existing regex tests
  // (/continues/i, /ready/i, /ended/i) could pass on the wrong outcome
  // because the COPY shares vocabulary. Pin the outputs as a set so any
  // collision surfaces immediately.

  it("replyForOwnDecision maps to ack* COPY constants, not announcement copy", () => {
    expect(replyForOwnDecision("KEEP")).toBe(COPY.ackKeep);
    expect(replyForOwnDecision("MAYBE")).toBe(COPY.ackMaybe);
    expect(replyForOwnDecision("DISCARD")).toBe(COPY.ackDiscard);
  });

  it("resolutionAnnouncement maps to announcement COPY constants, not ack copy", () => {
    expect(resolutionAnnouncement("continue")).toBe(COPY.continued);
    expect(resolutionAnnouncement("ended_by_discard")).toBe(COPY.endedByDiscard);
    expect(resolutionAnnouncement("pending")).toBe(COPY.pendingForPartner);
  });

  it("every replyForOwnDecision output is distinct from every resolutionAnnouncement output", () => {
    // Belt and braces — if the COPY surface ever drifts so that an ack
    // string equals an announcement string, the rest of the suite goes
    // ambiguous fast. Catch the collision here.
    const acks = new Set<string>([COPY.ackKeep, COPY.ackMaybe, COPY.ackDiscard]);
    const announcements: string[] = [COPY.continued, COPY.endedByDiscard, COPY.pendingForPartner];
    for (const a of announcements) {
      expect(acks.has(a), `announcement collides with ack: ${a}`).toBe(false);
    }
  });

  it("all six (ack + announcement) bodies are unique", () => {
    const all = [
      COPY.ackKeep, COPY.ackMaybe, COPY.ackDiscard,
      COPY.continued, COPY.endedByDiscard, COPY.pendingForPartner,
    ];
    expect(new Set(all).size).toBe(all.length);
  });
});

// ─── 7. faceRevealBody is binary, mapped to the two FACE constants ─────────

describe("decisions/flow contract — faceRevealBody", () => {
  it("true → faceRevealWithPhoto, false → faceRevealNoPhoto (exact identity, no template)", () => {
    expect(faceRevealBody(true)).toBe(COPY.faceRevealWithPhoto);
    expect(faceRevealBody(false)).toBe(COPY.faceRevealNoPhoto);
  });
});
