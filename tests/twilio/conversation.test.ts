import { describe, it, expect } from "vitest";
import {
  route,
  renderRevealBody,
  COPY,
  type RouteInput,
  type RouterUser,
  type RouterActiveMatch,
} from "../../src/twilio/conversation.js";

const PHONE_ALICE = "+15550000001";
const PHONE_BOB = "+15550000002";
const PHONE_UNKNOWN = "+15550009999";

function makeUser(overrides: Partial<RouterUser> = {}): RouterUser {
  return {
    id: "u_alice",
    phone: PHONE_ALICE,
    displayName: "Alice",
    status: "ACTIVE",
    onboardingStep: null,
    ...overrides,
  };
}

function makeMatch(overrides: Partial<RouterActiveMatch> = {}): RouterActiveMatch {
  return {
    id: "m1",
    userAId: "u_alice", // lex < "u_bob"
    userBId: "u_bob",
    partner: { id: "u_bob", phone: PHONE_BOB },
    priorMessages: [],
    unlockedMilestones: new Set(),
    ...overrides,
  };
}

function makeInput(overrides: Partial<RouteInput> = {}): RouteInput {
  return {
    sender: makeUser(),
    fromPhone: PHONE_ALICE,
    body: "hey",
    activeMatch: makeMatch(),
    ...overrides,
  };
}

describe("route — stat-fishing gate", () => {
  it("hard-flags an inbound asking for last name; zeroes depth; prepends warning to partner", () => {
    const out = route(
      makeInput({
        body: "what's your last name?",
        sender: makeUser(),
      }),
    );
    expect(out.persistInbound?.flaggedStatFishing).toBe(true);
    expect(out.persistInbound?.depthScore).toBe(0);
    const relay = out.outbounds.find((o) => o.kind === "relay")!;
    expect(relay.body).toMatch(/Heads up/);
    expect(relay.body).toMatch(/what's your last name\?/);
  });

  it("does NOT gate a photo ask once FACE is unlocked", () => {
    const out = route(
      makeInput({
        body: "send a pic?",
        sender: makeUser(),
        activeMatch: makeMatch({ unlockedMilestones: new Set(["FACE"]) }),
      }),
    );
    expect(out.persistInbound?.flaggedStatFishing).toBe(false);
    const relay = out.outbounds.find((o) => o.kind === "relay")!;
    expect(relay.body).toBe("send a pic?");
  });

  it("leaves benign chat untouched", () => {
    const out = route(makeInput({ body: "how was your day?" }));
    expect(out.persistInbound?.flaggedStatFishing).toBe(false);
    expect(out.outbounds.find((o) => o.kind === "relay")?.body).toBe(
      "how was your day?",
    );
  });
});

describe("route — unknown sender", () => {
  it("replies with the intro, no persist, no milestones", () => {
    const out = route({
      sender: null,
      fromPhone: PHONE_UNKNOWN,
      body: "hello?",
      activeMatch: null,
    });
    expect(out.persistInbound).toBeNull();
    expect(out.milestonesToRecord).toEqual([]);
    expect(out.outbounds).toHaveLength(1);
    expect(out.outbounds[0]).toMatchObject({
      toPhone: PHONE_UNKNOWN,
      toUserId: null,
      fromUserId: null,
      body: COPY.unknownSenderIntro,
      isRelay: false,
      kind: "unknown_sender_intro",
      matchId: null,
    });
  });
});

describe("route — by user status", () => {
  it("BANNED drops silently — no outbound, no persist", () => {
    const out = route(
      makeInput({ sender: makeUser({ status: "BANNED" }), activeMatch: null }),
    );
    expect(out.outbounds).toEqual([]);
    expect(out.persistInbound).toBeNull();
    expect(out.milestonesToRecord).toEqual([]);
  });

  it("PAUSED replies with the paused-account notice", () => {
    const out = route(
      makeInput({ sender: makeUser({ status: "PAUSED" }), activeMatch: null }),
    );
    expect(out.outbounds).toHaveLength(1);
    expect(out.outbounds[0]).toMatchObject({
      toPhone: PHONE_ALICE,
      kind: "paused",
      body: COPY.paused,
      isRelay: false,
    });
    expect(out.persistInbound).toBeNull();
  });

  it("ONBOARDING (no step yet) sends the welcome and advances to ask_display_name", () => {
    const out = route(
      makeInput({
        sender: makeUser({ status: "ONBOARDING", onboardingStep: null }),
        activeMatch: null,
      }),
    );
    expect(out.outbounds).toHaveLength(1);
    expect(out.outbounds[0]).toMatchObject({ kind: "onboarding_stub" });
    expect(out.outbounds[0]!.body).toMatch(/Welcome to Boba/);
    expect(out.persistInbound).toBeNull();
    expect(out.onboardingAdvance).toMatchObject({
      userId: "u_alice",
      advance: { nextStep: "ask_display_name", markActive: false },
    });
  });

  it("ONBOARDING parse failure stays on the same step", () => {
    const out = route(
      makeInput({
        body: "not a number",
        sender: makeUser({ status: "ONBOARDING", onboardingStep: "ask_age" }),
        activeMatch: null,
      }),
    );
    expect(out.onboardingAdvance?.advance.nextStep).toBe("ask_age");
    expect(out.outbounds[0]!.body).toMatch(/number/i);
  });

  it("ONBOARDING parse success advances and writes updates", () => {
    const out = route(
      makeInput({
        body: "22",
        sender: makeUser({ status: "ONBOARDING", onboardingStep: "ask_age" }),
        activeMatch: null,
      }),
    );
    expect(out.onboardingAdvance?.advance.nextStep).toBe("ask_gender");
    expect(out.onboardingAdvance?.advance.updates.stats?.age).toBe(22);
  });

  it("ACTIVE with no match returns the holding pattern", () => {
    const out = route(makeInput({ activeMatch: null }));
    expect(out.outbounds).toHaveLength(1);
    expect(out.outbounds[0]).toMatchObject({
      kind: "no_match_holding",
      body: COPY.noMatchHolding,
    });
    expect(out.persistInbound).toBeNull();
  });
});

describe("route — ACTIVE relay (happy path)", () => {
  it("relays the message to the partner with the right metadata", () => {
    const out = route(makeInput({ body: "what kind of music are you into?" }));
    expect(out.outbounds).toHaveLength(1);
    const relay = out.outbounds[0];
    expect(relay).toBeDefined();
    expect(relay).toMatchObject({
      toPhone: PHONE_BOB,
      toUserId: "u_bob",
      fromUserId: "u_alice",
      body: "what kind of music are you into?",
      isRelay: true,
      kind: "relay",
      matchId: "m1",
    });
  });

  it("persists the inbound with a depthScore", () => {
    const out = route(makeInput({ body: "what kind of music are you into?" }));
    expect(out.persistInbound).not.toBeNull();
    expect(out.persistInbound).toMatchObject({
      matchId: "m1",
      senderId: "u_alice",
      direction: "INBOUND",
      body: "what kind of music are you into?",
    });
    expect(out.persistInbound!.depthScore).toBeGreaterThan(0);
    expect(out.persistInbound!.depthScore).toBeLessThanOrEqual(1);
  });

  it("scores a short, non-question message lower than a long question", () => {
    const shortOut = route(makeInput({ body: "ok" }));
    const longOut = route(
      makeInput({
        body: "what's the most interesting thing you've read this week and why did it stick?",
      }),
    );
    expect(longOut.persistInbound!.depthScore).toBeGreaterThan(
      shortOut.persistInbound!.depthScore,
    );
  });
});

describe("route — milestone unlock during relay", () => {
  // Build a match that's ALREADY at AGE thresholds for both sides so this
  // one extra message tips it over. AGE: total >=10, per-side >=4, avgDepth>=0.3.
  function priorAt(count: number, depth: number) {
    const msgs: Array<{ senderId: string; body: string; depthScore: number }> = [];
    for (let i = 0; i < count; i++) {
      const senderId = i % 2 === 0 ? "u_alice" : "u_bob";
      msgs.push({ senderId, body: `prior message ${i}`, depthScore: depth });
    }
    return msgs;
  }

  it("emits AGE milestone reveals to both sides when threshold is crossed", () => {
    // 9 priors at depth 0.4, both sides contributing → adding this one
    // bumps total to 10, alice 5 / bob 4, avg ~= 0.4.
    const priors = priorAt(9, 0.4);
    const match = makeMatch({ priorMessages: priors });
    const out = route(
      makeInput({
        activeMatch: match,
        body: "tell me about the last book that genuinely changed your mind",
      }),
    );
    expect(out.milestonesToRecord).toEqual(["AGE"]);
    // One relay + two reveal SMSes (one to each side).
    expect(out.outbounds).toHaveLength(3);
    const reveals = out.outbounds.filter((o) => o.kind === "milestone_reveal");
    expect(reveals).toHaveLength(2);
    const phones = reveals.map((r) => r.toPhone).sort();
    expect(phones).toEqual([PHONE_ALICE, PHONE_BOB]);
    // Reveal bodies carry the placeholder; substitution happens at the
    // route layer once stats are loaded.
    expect(reveals[0]!.body).toContain("{{age}}");
  });

  it("does not emit reveal when below threshold", () => {
    const match = makeMatch({ priorMessages: priorAt(3, 0.4) });
    const out = route(makeInput({ activeMatch: match, body: "hey" }));
    expect(out.milestonesToRecord).toEqual([]);
    expect(out.outbounds.every((o) => o.kind !== "milestone_reveal")).toBe(true);
  });

  it("skips reveals for already-unlocked milestones (ladder pauses at first gap)", () => {
    const match = makeMatch({
      priorMessages: priorAt(9, 0.4),
      unlockedMilestones: new Set(["AGE"]),
    });
    const out = route(
      makeInput({
        activeMatch: match,
        body: "tell me about the last book that genuinely changed your mind",
      }),
    );
    // 10 total, avg ~0.4 — that's enough for AGE but NOT for PROFESSION
    // (which wants 25 total). Ladder pauses; no reveal.
    expect(out.milestonesToRecord).toEqual([]);
    expect(out.outbounds.every((o) => o.kind !== "milestone_reveal")).toBe(true);
  });
});

describe("renderRevealBody", () => {
  it("substitutes age", () => {
    const body = renderRevealBody("AGE", { age: 22, profession: null, heightCm: null });
    expect(body).toContain("22");
    expect(body).not.toContain("{{");
  });
  it("substitutes profession", () => {
    const body = renderRevealBody("PROFESSION", {
      age: null,
      profession: "physics student",
      heightCm: null,
    });
    expect(body).toContain("physics student");
  });
  it("substitutes height", () => {
    const body = renderRevealBody("HEIGHT", { age: null, profession: null, heightCm: 174 });
    expect(body).toContain("174");
  });
  it("renders an em-dash when the underlying stat is missing", () => {
    const body = renderRevealBody("AGE", { age: null, profession: null, heightCm: null });
    expect(body).toContain("—");
  });
});
