// Contract pins for `src/twilio/conversation.ts` — the inbound router.
//
// Why this file exists. `tests/twilio/conversation.test.ts` is a
// behavioural test: it checks individual code paths produce the right
// observable reply. The router carries several STRUCTURAL contracts that
// behavioural cases don't pin:
//
//   1. Precedence order across competing inbound interpretations
//      (SMS-compliance keyword > opt-out drop > unknown-sender intro >
//      status switch > REPORT > decision keyword > normal relay).
//      A refactor that re-orders these — e.g. checks opt-out before the
//      keyword — silently breaks 10DLC compliance (an opted-out user
//      texting STOP again would get dropped instead of re-acknowledged).
//
//   2. The `RouteResult` shape per major path: which fields are null vs.
//      populated vs. empty array. The IO layer in `src/twilio/routes.ts`
//      branches on these (`if (result.persistInbound)`, etc.), so silently
//      flipping a null to an object or vice-versa changes DB writes.
//
//   3. `OutboundAction.kind` enumeration — the IO layer logs by kind and
//      the metrics layer counts them; expanding/renaming the union without
//      updating consumers is the failure mode.
//
//   4. The hard-flag depth-zeroing contract — `depthScore === 0` is what
//      blocks milestone acceleration via stat-fishing. The existing
//      behavioural test only checks the flag is set; this pins that the
//      score becomes exactly 0 (not "low").
//
//   5. The reveal-template-vs-substitution split. The router never
//      substitutes — it emits the `{{stat}}` placeholder so the IO layer,
//      which has the partner's Stats row loaded, can render. Pinning this
//      catches a refactor that "helpfully" pre-substitutes (producing
//      `{{age}}` in delivered SMS) or moves substitution into the router
//      (where the partner's stats are not in scope).
//
//   6. `renderRevealBody` exhaustiveness across `MilestoneType` — the
//      FACE branch is unreachable from the router but must still render
//      (the type system enforces the switch is exhaustive; pinning the
//      output keeps the body sensible for any future direct caller).

import { describe, it, expect } from "vitest";
import {
  route,
  renderRevealBody,
  COPY,
  type OutboundAction,
  type RouteInput,
  type RouteResult,
  type RouterActiveMatch,
  type RouterUser,
} from "../../src/twilio/conversation.js";
import type { MilestoneType } from "@prisma/client";

const PHONE_A = "+15550000001";
const PHONE_B = "+15550000002";
const PHONE_UNKNOWN = "+15550009999";

function makeUser(overrides: Partial<RouterUser> = {}): RouterUser {
  return {
    id: "u_alice",
    phone: PHONE_A,
    displayName: "Alice",
    status: "ACTIVE",
    onboardingStep: null,
    smsOptedOut: false,
    ...overrides,
  };
}

function makeMatch(overrides: Partial<RouterActiveMatch> = {}): RouterActiveMatch {
  return {
    id: "m1",
    userAId: "u_alice",
    userBId: "u_bob",
    partner: {
      id: "u_bob",
      phone: PHONE_B,
      isAiBacked: false,
      aiPersonaPrompt: null,
    },
    priorMessages: [],
    unlockedMilestones: new Set(),
    ...overrides,
  };
}

function makeInput(overrides: Partial<RouteInput> = {}): RouteInput {
  return {
    sender: makeUser(),
    fromPhone: PHONE_A,
    body: "hey",
    activeMatch: makeMatch(),
    ...overrides,
  };
}

// ─── 1. Precedence — what wins when multiple paths could match ─────────────

describe("route — precedence (SMS keyword wins over every other path)", () => {
  it("STOP from a BANNED user runs the keyword path, not the banned-silent path", () => {
    // The carrier-compliance keyword check MUST be before the status
    // switch. If a refactor moves status-handling first, a banned user
    // texting STOP would get dropped silently and we'd lose the carrier
    // ack. CTIA + carriers treat that as a campaign-level violation.
    const out = route(
      makeInput({
        body: "STOP",
        sender: makeUser({ status: "BANNED" }),
        activeMatch: null,
      }),
    );
    expect(out.outbounds).toHaveLength(1);
    expect(out.outbounds[0]!.kind).toBe("sms_stop_ack");
    expect(out.smsOptOutChange).not.toBeNull();
  });

  it("HELP from a PAUSED user runs the help path, not the paused-notice path", () => {
    const out = route(
      makeInput({
        body: "HELP",
        sender: makeUser({ status: "PAUSED" }),
        activeMatch: null,
      }),
    );
    expect(out.outbounds[0]!.kind).toBe("sms_help_reply");
  });

  it("STOP from an opted-out user re-acknowledges (does not get dropped by opt-out gate)", () => {
    // The opt-out gate must run AFTER the keyword check. Otherwise an
    // already-opted-out user texting STOP again would hit `emptyResult()`
    // and the carrier would see no ack — same compliance problem as #1.
    const out = route(
      makeInput({
        body: "STOP",
        sender: makeUser({ smsOptedOut: true }),
      }),
    );
    expect(out.outbounds[0]!.kind).toBe("sms_stop_ack");
    expect(out.smsOptOutChange).toEqual({
      userId: "u_alice",
      optedOut: true,
      keyword: "STOP",
    });
  });

  it("opt-out gate runs BEFORE unknown-sender intro (unknown sender path doesn't fire for opted-out)", () => {
    // Conversely, the opt-out gate must NOT fire when sender is null —
    // there's nothing to silence. Pinned so a refactor that hoists the
    // opt-out check above the keyword check (and accidentally above the
    // unknown-sender check) is detectable.
    const out = route({
      sender: null,
      fromPhone: PHONE_UNKNOWN,
      body: "hello",
      activeMatch: null,
    });
    expect(out.outbounds).toHaveLength(1);
    expect(out.outbounds[0]!.kind).toBe("unknown_sender_intro");
  });

  it("REPORT outranks normal relay in an active match", () => {
    const out = route(
      makeInput({ body: "REPORT harassment they were mean" }),
    );
    expect(out.outbounds[0]!.kind).toBe("report_ack");
    expect(out.outbounds.find((o) => o.kind === "relay")).toBeUndefined();
    expect(out.persistInbound).toBeNull();
    expect(out.moderation?.kind).toBe("user_report");
  });

  it("decision keyword outranks normal relay, milestone, and content checks", () => {
    // KEEP must be intercepted; otherwise it becomes an actual relayed
    // message AND its depth gets scored. The user's end-of-day pick
    // would leak into the partner's conversation.
    const out = route(
      makeInput({
        body: "KEEP",
        activeMatch: makeMatch({
          priorMessages: Array.from({ length: 9 }, (_, i) => ({
            senderId: i % 2 === 0 ? "u_alice" : "u_bob",
            body: `prior ${i}`,
            depthScore: 0.4,
          })),
        }),
      }),
    );
    expect(out.outbounds[0]!.kind).toBe("decision_ack");
    expect(out.outbounds.find((o) => o.kind === "relay")).toBeUndefined();
    expect(out.outbounds.find((o) => o.kind === "milestone_reveal")).toBeUndefined();
    expect(out.persistInbound).toBeNull();
    expect(out.milestonesToRecord).toEqual([]);
    expect(out.decisionToRecord?.decision).toBe("KEEP");
  });
});

// ─── 2. RouteResult shape per path ─────────────────────────────────────────

const EMPTY_NON_OUTBOUND_FIELDS = {
  persistInbound: null,
  milestonesToRecord: [] as MilestoneType[],
  onboardingAdvance: null,
  decisionToRecord: null,
  moderation: null,
  aiReplyToGenerate: null,
  smsOptOutChange: null,
};

describe("route — RouteResult shape contract per path", () => {
  it("unknown-sender intro: only outbounds, every other directive null/empty", () => {
    const out = route({
      sender: null,
      fromPhone: PHONE_UNKNOWN,
      body: "hi",
      activeMatch: null,
    });
    expect(stripOutbounds(out)).toEqual(EMPTY_NON_OUTBOUND_FIELDS);
  });

  it("STOP path: outbounds + smsOptOutChange; every other directive null/empty", () => {
    const out = route(makeInput({ body: "STOP" }));
    expect(stripOutbounds(out)).toEqual({
      ...EMPTY_NON_OUTBOUND_FIELDS,
      smsOptOutChange: { userId: "u_alice", optedOut: true, keyword: "STOP" },
    });
  });

  it("HELP path: outbounds only; smsOptOutChange null (HELP is informational)", () => {
    const out = route(makeInput({ body: "HELP" }));
    expect(out.smsOptOutChange).toBeNull();
    expect(stripOutbounds(out)).toEqual(EMPTY_NON_OUTBOUND_FIELDS);
  });

  it("BANNED path: completely empty result (no ack, no persist)", () => {
    const out = route(
      makeInput({
        sender: makeUser({ status: "BANNED" }),
        body: "hello",
        activeMatch: null,
      }),
    );
    expect(out.outbounds).toEqual([]);
    expect(stripOutbounds(out)).toEqual(EMPTY_NON_OUTBOUND_FIELDS);
  });

  it("PAUSED path: outbounds only; no persistence (account is on ice)", () => {
    const out = route(
      makeInput({
        sender: makeUser({ status: "PAUSED" }),
        body: "hello",
        activeMatch: null,
      }),
    );
    expect(stripOutbounds(out)).toEqual(EMPTY_NON_OUTBOUND_FIELDS);
  });

  it("ONBOARDING path: outbounds + onboardingAdvance; persistInbound null (not a match message)", () => {
    const out = route(
      makeInput({
        body: "22",
        sender: makeUser({ status: "ONBOARDING", onboardingStep: "ask_age" }),
        activeMatch: null,
      }),
    );
    expect(out.persistInbound).toBeNull();
    expect(out.onboardingAdvance).not.toBeNull();
    expect(out.smsOptOutChange).toBeNull();
    expect(out.decisionToRecord).toBeNull();
    expect(out.moderation).toBeNull();
    expect(out.aiReplyToGenerate).toBeNull();
  });

  it("ACTIVE no-match holding: outbounds only; no persist (no match to attach to)", () => {
    const out = route(makeInput({ activeMatch: null }));
    expect(stripOutbounds(out)).toEqual(EMPTY_NON_OUTBOUND_FIELDS);
  });

  it("REPORT path: outbounds + moderation; persistInbound null (report is not a chat message)", () => {
    const out = route(makeInput({ body: "REPORT abuse details here" }));
    expect(out.persistInbound).toBeNull();
    expect(out.moderation?.kind).toBe("user_report");
    expect(out.decisionToRecord).toBeNull();
    expect(out.aiReplyToGenerate).toBeNull();
    expect(out.smsOptOutChange).toBeNull();
    expect(out.milestonesToRecord).toEqual([]);
  });

  it("decision keyword path: outbounds + decisionToRecord; persistInbound null", () => {
    const out = route(makeInput({ body: "KEEP" }));
    expect(out.persistInbound).toBeNull();
    expect(out.decisionToRecord).not.toBeNull();
    expect(out.moderation).toBeNull();
    expect(out.aiReplyToGenerate).toBeNull();
    expect(out.smsOptOutChange).toBeNull();
    expect(out.milestonesToRecord).toEqual([]);
  });

  it("normal relay: persistInbound with direction='INBOUND', flags resolved, no moderation/decision/opt-out", () => {
    const out = route(makeInput({ body: "what's your favourite season?" }));
    expect(out.persistInbound).toMatchObject({
      matchId: "m1",
      senderId: "u_alice",
      direction: "INBOUND",
      body: "what's your favourite season?",
      flaggedStatFishing: false,
      flaggedHarassment: false,
    });
    expect(out.persistInbound!.depthScore).toBeGreaterThan(0);
    expect(out.decisionToRecord).toBeNull();
    expect(out.moderation).toBeNull();
    expect(out.aiReplyToGenerate).toBeNull();
    expect(out.smsOptOutChange).toBeNull();
    expect(out.onboardingAdvance).toBeNull();
  });

  it("AI partner relay: persistInbound IS written (human msg goes to DB) AND no relay outbound", () => {
    // This is the trap: it would be tempting to skip persistInbound for
    // AI-partner matches (since "no human reads it"), but that breaks
    // depth scoring + milestone ladder + the conversation transcript
    // that gets surfaced post-reveal. Pin: the persist still happens.
    const out = route(
      makeInput({
        body: "what's the most interesting thing you read today?",
        activeMatch: makeMatch({
          partner: {
            id: "u_bob",
            phone: PHONE_B,
            isAiBacked: true,
            aiPersonaPrompt: "warm and curious",
          },
        }),
      }),
    );
    expect(out.persistInbound).not.toBeNull();
    expect(out.persistInbound!.senderId).toBe("u_alice");
    expect(out.outbounds.find((o) => o.kind === "relay")).toBeUndefined();
    expect(out.aiReplyToGenerate).not.toBeNull();
  });
});

// ─── 3. OutboundAction.kind enumeration ────────────────────────────────────

describe("OutboundAction.kind — emitted-kind enumeration", () => {
  // The IO layer logs by `kind`, and metrics count by `kind`. Renaming
  // any of these (or adding a new kind without updating consumers) is a
  // silent telemetry break. This test enumerates every kind the router
  // can emit and pins it via real scenarios.
  it("covers exactly the routable kinds (no rename / no missing path)", () => {
    const observed = new Set<OutboundAction["kind"]>();

    // unknown_sender_intro
    route({
      sender: null,
      fromPhone: PHONE_UNKNOWN,
      body: "hi",
      activeMatch: null,
    }).outbounds.forEach((o) => observed.add(o.kind));

    // onboarding_stub
    route(
      makeInput({
        body: "Alice",
        sender: makeUser({ status: "ONBOARDING", onboardingStep: "ask_display_name" }),
        activeMatch: null,
      }),
    ).outbounds.forEach((o) => observed.add(o.kind));

    // no_match_holding
    route(makeInput({ activeMatch: null })).outbounds.forEach((o) =>
      observed.add(o.kind),
    );

    // paused
    route(
      makeInput({ sender: makeUser({ status: "PAUSED" }), activeMatch: null }),
    ).outbounds.forEach((o) => observed.add(o.kind));

    // relay
    route(makeInput({ body: "how was your day?" })).outbounds.forEach((o) =>
      observed.add(o.kind),
    );

    // milestone_reveal — engineered priors to cross AGE
    route(
      makeInput({
        body: "tell me about a book that genuinely shifted how you think",
        activeMatch: makeMatch({
          priorMessages: Array.from({ length: 9 }, (_, i) => ({
            senderId: i % 2 === 0 ? "u_alice" : "u_bob",
            body: `prior ${i}`,
            depthScore: 0.4,
          })),
        }),
      }),
    ).outbounds.forEach((o) => observed.add(o.kind));

    // decision_ack
    route(makeInput({ body: "KEEP" })).outbounds.forEach((o) =>
      observed.add(o.kind),
    );

    // report_ack
    route(makeInput({ body: "REPORT harassment details" })).outbounds.forEach(
      (o) => observed.add(o.kind),
    );

    // sms_stop_ack
    route(makeInput({ body: "STOP" })).outbounds.forEach((o) =>
      observed.add(o.kind),
    );

    // sms_help_reply
    route(makeInput({ body: "HELP" })).outbounds.forEach((o) =>
      observed.add(o.kind),
    );

    // sms_start_ack
    route(makeInput({ body: "START" })).outbounds.forEach((o) =>
      observed.add(o.kind),
    );

    // The remaining kinds — banned_silent and face_reveal — are
    // declared on the union but the router can't emit them: BANNED
    // returns an empty outbound list, and FACE reveal is emitted by
    // `src/decisions/flow.ts` at end-of-day, not by this module.
    // Documenting that here so a future agent looking for "where does
    // face_reveal get sent" doesn't add a code path inside the router.
    expect(observed).toEqual(
      new Set<OutboundAction["kind"]>([
        "unknown_sender_intro",
        "onboarding_stub",
        "no_match_holding",
        "paused",
        "relay",
        "milestone_reveal",
        "decision_ack",
        "report_ack",
        "sms_stop_ack",
        "sms_help_reply",
        "sms_start_ack",
      ]),
    );
  });
});

// ─── 4. Hard-flag depth zeroing — the anti-stat-fishing brake ───────────────

describe("route — hard-flag depth zeroing", () => {
  it("flagged inbound has depthScore EXACTLY 0 (not 'low'), regardless of length", () => {
    // The stat-fishing brake is "your depth contribution this turn is
    // zero". A refactor that "softens" this to e.g. `depth / 4` would
    // still let a sufficiently long stat-fishing message accelerate
    // milestone unlocks. Pin the exact 0.
    const longStatFishing =
      "what's your full last name, where do you go to school, and can you send a photo so I can be sure you're real and not a bot please?";
    const out = route(makeInput({ body: longStatFishing }));
    expect(out.persistInbound?.flaggedStatFishing).toBe(true);
    expect(out.persistInbound?.depthScore).toBe(0);
  });

  it("benign inbound never zeroes depth (the brake is hard-flag-gated)", () => {
    const out = route(makeInput({ body: "what's your favourite season?" }));
    expect(out.persistInbound?.flaggedStatFishing).toBe(false);
    expect(out.persistInbound?.depthScore).toBeGreaterThan(0);
  });
});

// ─── 5. Hard-flag relay body construction ──────────────────────────────────

describe("route — relayed body construction on hard-flag", () => {
  it("relay body is `${warning}\\n${original}` — exact separator, original verbatim", () => {
    // The IO layer concatenates these and ships to Twilio. If a refactor
    // changes \n to \n\n or strips the warning when the original body
    // would already be short, Twilio segmenting & costs change.
    const original = "what's your last name?";
    const out = route(makeInput({ body: original }));
    const relay = out.outbounds.find((o) => o.kind === "relay")!;
    const parts = relay.body.split("\n");
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatch(/^⚠ Heads up: this asks about /);
    expect(parts[1]).toBe(original);
  });

  it("multi-category hard-flag uses generic 'personal info' wording (not stat-fishing detector internals)", () => {
    // The single-category warning names the category; the multi-category
    // fallback collapses to "personal info". Pin so a refactor that
    // joins categories with commas doesn't ship detector vocabulary to
    // the user.
    const out = route(
      makeInput({
        body: "what's your last name and what's your instagram?",
      }),
    );
    const relay = out.outbounds.find((o) => o.kind === "relay")!;
    const firstLine = relay.body.split("\n")[0]!;
    expect(firstLine).toContain("personal info");
  });
});

// ─── 6. Milestone reveal — two outbounds, one per side, template intact ────

describe("route — milestone reveal shape", () => {
  function priorsAt(count: number, depth: number) {
    return Array.from({ length: count }, (_, i) => ({
      senderId: i % 2 === 0 ? "u_alice" : "u_bob",
      body: `prior ${i}`,
      depthScore: depth,
    }));
  }

  it("emits exactly two milestone_reveal outbounds — one to each party — when AGE crosses", () => {
    const out = route(
      makeInput({
        body: "what kind of book genuinely shifted how you think about the world?",
        activeMatch: makeMatch({ priorMessages: priorsAt(9, 0.4) }),
      }),
    );
    const reveals = out.outbounds.filter((o) => o.kind === "milestone_reveal");
    expect(reveals).toHaveLength(2);
    const toPhones = reveals.map((r) => r.toPhone).sort();
    expect(toPhones).toEqual([PHONE_A, PHONE_B]);
    // Both reveals have fromUserId === null (system-originated).
    expect(reveals.every((r) => r.fromUserId === null)).toBe(true);
    // Both reveals carry the matchId — used by the IO layer to attach
    // them to the conversation transcript.
    expect(reveals.every((r) => r.matchId === "m1")).toBe(true);
  });

  it("reveal body retains the {{stat}} placeholder — substitution is the IO layer's job", () => {
    // The router doesn't have access to the partner's Stats row (by
    // design — keeps it Prisma-free). If a refactor adds substitution
    // here, the placeholder body in this test would mismatch.
    const out = route(
      makeInput({
        body: "what kind of book genuinely shifted how you think about the world?",
        activeMatch: makeMatch({ priorMessages: priorsAt(9, 0.4) }),
      }),
    );
    const reveal = out.outbounds.find((o) => o.kind === "milestone_reveal")!;
    expect(reveal.body).toContain("{{age}}");
    expect(reveal.body).not.toContain("undefined");
  });
});

// ─── 7. `renderRevealBody` exhaustiveness over MilestoneType ───────────────

describe("renderRevealBody — exhaustive over MilestoneType", () => {
  // The switch inside the router uses TypeScript exhaustiveness, so
  // adding a new MilestoneType would fail compilation. But the FACE
  // branch — unreachable from the router itself — is still part of the
  // public API of `renderRevealBody`. Pin all four branches so a future
  // milestone type addition surfaces here as a test failure too.
  const cases: Array<{
    milestone: MilestoneType;
    stats: { age: number | null; profession: string | null; heightCm: number | null };
    expectSubstring: string;
  }> = [
    { milestone: "AGE", stats: { age: 22, profession: null, heightCm: null }, expectSubstring: "22" },
    {
      milestone: "PROFESSION",
      stats: { age: null, profession: "physics student", heightCm: null },
      expectSubstring: "physics student",
    },
    { milestone: "HEIGHT", stats: { age: null, profession: null, heightCm: 174 }, expectSubstring: "174" },
    { milestone: "FACE", stats: { age: null, profession: null, heightCm: null }, expectSubstring: "face reveal" },
  ];

  for (const c of cases) {
    it(`renders ${c.milestone}`, () => {
      const body = renderRevealBody(c.milestone, c.stats);
      expect(body).toContain(c.expectSubstring);
      // No leftover Mustache: any path that forgot to substitute would
      // emit `{{` in delivered SMS.
      expect(body).not.toContain("{{");
    });
  }

  it("missing-stat renders an em-dash (U+2014), not a hyphen", () => {
    // The Stats row can have null fields if onboarding aborted partway;
    // the em-dash signals "unknown" in delivered copy. A refactor that
    // swapped to "-" would visually conflate with phone numbers in
    // delivered SMS ("+1-555-…" vs "—"). Pin the actual codepoint.
    const body = renderRevealBody("AGE", { age: null, profession: null, heightCm: null });
    expect(body).toContain("—");
    expect(body).not.toMatch(/years old\.?\s*-/);
  });
});

// ─── 8. STOP-from-unknown-sender directive shape ───────────────────────────

describe("route — STOP from unknown sender (no directive to flip)", () => {
  it("emits the ack but smsOptOutChange is null (nothing to update)", () => {
    // The IO layer would crash if it tried to Prisma.update({ userId:
    // null }), so the router must withhold the directive when the
    // sender isn't registered. Pinned because the obvious "always emit
    // the directive" refactor breaks this.
    const out = route({
      sender: null,
      fromPhone: PHONE_UNKNOWN,
      body: "STOP",
      activeMatch: null,
    });
    expect(out.outbounds[0]!.kind).toBe("sms_stop_ack");
    expect(out.outbounds[0]!.toUserId).toBeNull();
    expect(out.smsOptOutChange).toBeNull();
  });

  it("START from a not-opted-out user STILL emits the directive (idempotent flip)", () => {
    // A refactor that "optimises" by only emitting when state would
    // change loses the audit signal. The directive shape is the
    // contract regardless of whether it's a no-op DB write.
    const out = route(
      makeInput({ body: "START", sender: makeUser({ smsOptedOut: false }) }),
    );
    expect(out.smsOptOutChange).toEqual({
      userId: "u_alice",
      optedOut: false,
      keyword: "START",
    });
  });
});

// ─── 9. OutboundAction id semantics — who sent, who receives ───────────────

describe("OutboundAction — sender/recipient id semantics", () => {
  it("relay outbound: fromUserId = sender, toUserId = partner, isRelay = true, matchId set", () => {
    const out = route(makeInput({ body: "how was your day?" }));
    const relay = out.outbounds.find((o) => o.kind === "relay")!;
    expect(relay.fromUserId).toBe("u_alice");
    expect(relay.toUserId).toBe("u_bob");
    expect(relay.toPhone).toBe(PHONE_B);
    expect(relay.isRelay).toBe(true);
    expect(relay.matchId).toBe("m1");
  });

  it("system reply (e.g. decision_ack): fromUserId = null, isRelay = false", () => {
    const out = route(makeInput({ body: "KEEP" }));
    const ack = out.outbounds[0]!;
    expect(ack.kind).toBe("decision_ack");
    expect(ack.fromUserId).toBeNull();
    expect(ack.toUserId).toBe("u_alice");
    expect(ack.isRelay).toBe(false);
    // decision_ack carries the matchId — the IO layer attaches it to
    // the match for transcript purposes.
    expect(ack.matchId).toBe("m1");
  });

  it("unknown_sender_intro: fromUserId AND toUserId both null, no matchId", () => {
    const out = route({
      sender: null,
      fromPhone: PHONE_UNKNOWN,
      body: "hi",
      activeMatch: null,
    });
    const intro = out.outbounds[0]!;
    expect(intro.fromUserId).toBeNull();
    expect(intro.toUserId).toBeNull();
    expect(intro.matchId).toBeNull();
    expect(intro.isRelay).toBe(false);
  });
});

// ─── 10. COPY contract — keywords that the user is told to reply with ─────

describe("COPY — invariant keywords", () => {
  // The copy strings name protocol keywords ("JOIN", "RESUME"). If a
  // refactor edits the prose and drops one of these, the user can no
  // longer drive the state machine — they don't know the magic word.
  it("unknownSenderIntro names the invite-entry keyword (JOIN)", () => {
    expect(COPY.unknownSenderIntro).toMatch(/\bJOIN\b/);
  });

  it("paused notice names the resume keyword (RESUME)", () => {
    expect(COPY.paused).toMatch(/\bRESUME\b/);
  });

  it("reveal templates use the {{stat}} mustache form (not %s, not ${})", () => {
    expect(COPY.revealAge).toContain("{{age}}");
    expect(COPY.revealProfession).toContain("{{profession}}");
    expect(COPY.revealHeight).toContain("{{heightCm}}");
  });
});

// ─── Helpers ───────────────────────────────────────────────────────────────

function stripOutbounds(result: RouteResult): Omit<RouteResult, "outbounds"> {
  // RouteResult sans `outbounds` — lets shape-pinned tests compare the
  // remaining directive fields as a single object without inflating the
  // assertion with the outbound list (which other tests cover).
  const { outbounds: _outbounds, ...rest } = result;
  void _outbounds;
  return rest;
}
