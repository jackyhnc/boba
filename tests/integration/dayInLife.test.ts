// Cross-module integration: "a day in the life of a match".
//
// The per-module unit tests exercise the router, depth scorer, unlock
// ladder, and decision resolver in isolation, each with hand-built
// fixtures. This test instead drives the SAME loop the IO layer
// (src/twilio/routes.ts) runs in production: for every inbound it calls
// the pure `route()`, then feeds the router's own outputs back as the
// next call's inputs — persisting `persistInbound` into the running
// message log and folding `milestonesToRecord` into the unlocked set.
//
// That closes the integration seam the isolated tests can't: it proves
// the router's outputs, replayed the way the real handler replays them,
// actually drive a conversation through the documented milestone ladder
// (AGE → PROFESSION → HEIGHT) and into end-of-day resolution.

import { describe, it, expect } from "vitest";
import type { MilestoneType } from "@prisma/client";
import {
  route,
  type RouteResult,
  type RouterActiveMatch,
  type RouterPartner,
  type RouterUser,
} from "../../src/twilio/conversation.js";
import {
  resolve,
  resolutionAnnouncement,
  COPY as DECISION_COPY,
} from "../../src/decisions/flow.js";

const PHONE_ALICE = "+15550000001";
const PHONE_BOB = "+15550000002";

const ALICE: RouterUser = {
  id: "u_alice", // lexically < "u_bob" → canonical userA
  phone: PHONE_ALICE,
  displayName: "Alice",
  status: "ACTIVE",
  onboardingStep: null,
  smsOptedOut: false,
};
const BOB: RouterUser = {
  id: "u_bob",
  phone: PHONE_BOB,
  displayName: "Bob",
  status: "ACTIVE",
  onboardingStep: null,
  smsOptedOut: false,
};

const ALICE_AS_PARTNER: RouterPartner = {
  id: "u_alice",
  phone: PHONE_ALICE,
  isAiBacked: false,
  aiPersonaPrompt: null,
};
const BOB_AS_PARTNER: RouterPartner = {
  id: "u_bob",
  phone: PHONE_BOB,
  isAiBacked: false,
  aiPersonaPrompt: null,
};

// A long, benign, question-bearing message. It scores high on depth
// (length + question + reciprocity) and trips NEITHER the stat-fishing
// nor the harassment probes in src/safety/* — verified by the per-turn
// `flaggedStatFishing === false` assertion below.
const SUBSTANTIVE =
  "I have been wondering lately about the things that genuinely light people up inside, " +
  "the small obsessions and quiet curiosities we rarely speak about — what comes to mind " +
  "for you, and why does it matter to you?";

interface StoredMessage {
  senderId: string;
  body: string;
  depthScore: number;
}

/**
 * Replays the production inbound loop in-memory: each `send` builds the
 * match context from accumulated state, routes one inbound, then applies
 * the router's persistence + milestone directives back into that state.
 */
function makeSimulator() {
  const priorMessages: StoredMessage[] = [];
  const unlocked = new Set<MilestoneType>();
  const unlockLog: Array<{ turn: number; milestone: MilestoneType }> = [];
  let turn = 0;

  function send(fromAlice: boolean, body: string): RouteResult {
    turn += 1;
    const sender = fromAlice ? ALICE : BOB;
    const partner = fromAlice ? BOB_AS_PARTNER : ALICE_AS_PARTNER;
    const match: RouterActiveMatch = {
      id: "m1",
      userAId: "u_alice",
      userBId: "u_bob",
      partner,
      // Pass copies so the router can't mutate our running state.
      priorMessages: priorMessages.map((m) => ({ ...m })),
      unlockedMilestones: new Set(unlocked),
    };

    const out = route({
      sender,
      fromPhone: sender.phone,
      body,
      activeMatch: match,
    });

    if (out.persistInbound) {
      priorMessages.push({
        senderId: out.persistInbound.senderId,
        body: out.persistInbound.body,
        depthScore: out.persistInbound.depthScore,
      });
    }
    for (const m of out.milestonesToRecord) {
      unlocked.add(m);
      unlockLog.push({ turn, milestone: m });
    }
    return out;
  }

  return { send, priorMessages, unlocked, unlockLog };
}

describe("integration — a day in the life of a match", () => {
  it("drives the milestone ladder AGE → PROFESSION → HEIGHT in order as the conversation accumulates", () => {
    const sim = makeSimulator();

    for (let i = 0; i < 52; i += 1) {
      const fromAlice = i % 2 === 0;
      const out = sim.send(fromAlice, SUBSTANTIVE);

      // Every conversational turn relays exactly once to the partner...
      const relays = out.outbounds.filter((o) => o.kind === "relay");
      expect(relays).toHaveLength(1);
      expect(relays[0]!.toPhone).toBe(fromAlice ? PHONE_BOB : PHONE_ALICE);
      expect(relays[0]!.body).toBe(SUBSTANTIVE);

      // ...and persists the inbound with real, ungated depth.
      expect(out.persistInbound).not.toBeNull();
      expect(out.persistInbound!.flaggedStatFishing).toBe(false);
      expect(out.persistInbound!.depthScore).toBeGreaterThan(0.5);

      // On an unlock turn the router fans a reveal to BOTH sides; otherwise
      // none. (FACE is never reached here — it unlocks via end-of-day.)
      const reveals = out.outbounds.filter((o) => o.kind === "milestone_reveal");
      if (out.milestonesToRecord.length > 0) {
        expect(reveals).toHaveLength(2);
        expect(reveals.map((r) => r.toPhone).sort()).toEqual(
          [PHONE_ALICE, PHONE_BOB].sort(),
        );
      } else {
        expect(reveals).toHaveLength(0);
      }
    }

    // Strict ladder order, no skips, no FACE.
    expect(sim.unlockLog.map((u) => u.milestone)).toEqual([
      "AGE",
      "PROFESSION",
      "HEIGHT",
    ]);

    // Pinned to the documented thresholds in DEFAULT_UNLOCK_THRESHOLDS:
    // AGE @ 10 total messages, PROFESSION @ 25, HEIGHT @ 50 (both sides
    // contributing equally, depth comfortably above each rung's floor).
    expect(sim.unlockLog).toEqual([
      { turn: 10, milestone: "AGE" },
      { turn: 25, milestone: "PROFESSION" },
      { turn: 50, milestone: "HEIGHT" },
    ]);

    expect(sim.unlocked).toEqual(new Set(["AGE", "PROFESSION", "HEIGHT"]));
  });

  it("a decision keyword short-circuits relay and records the end-of-day choice", () => {
    const sim = makeSimulator();
    const out = sim.send(true, "KEEP");

    // No relay, no persisted chat message — just the ack + directive.
    expect(out.outbounds).toHaveLength(1);
    expect(out.outbounds[0]!.kind).toBe("decision_ack");
    expect(out.outbounds.some((o) => o.kind === "relay")).toBe(false);
    expect(out.persistInbound).toBeNull();
    expect(out.decisionToRecord).toMatchObject({
      matchId: "m1",
      userId: "u_alice",
      partnerUserId: "u_bob",
      partnerPhone: PHONE_BOB,
      decision: "KEEP",
    });
  });

  it("KEEP + KEEP resolves to 'continue' through the decisions module", () => {
    const sim = makeSimulator();
    const alice = sim.send(true, "KEEP");
    const bob = sim.send(false, "KEEP");

    const resolution = resolve(
      alice.decisionToRecord!.decision,
      bob.decisionToRecord!.decision,
    );
    expect(resolution.outcome).toBe("continue");
    expect(resolutionAnnouncement(resolution.outcome)).toBe(DECISION_COPY.continued);
  });

  it("KEEP + DISCARD ends the match", () => {
    const sim = makeSimulator();
    const alice = sim.send(true, "KEEP");
    const bob = sim.send(false, "DISCARD");

    const resolution = resolve(
      alice.decisionToRecord!.decision,
      bob.decisionToRecord!.decision,
    );
    expect(resolution.outcome).toBe("ended_by_discard");
    expect(resolutionAnnouncement(resolution.outcome)).toBe(
      DECISION_COPY.endedByDiscard,
    );
  });
});
