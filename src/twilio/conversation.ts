// Pure conversation router.
//
// Decides what happens when Boba receives an inbound SMS. Returns a list
// of outbound `OutboundAction`s (to whom + what to say) and an optional
// persistence directive describing how the inbound message itself should
// be recorded.
//
// This module is intentionally Prisma-free: callers load whatever context
// they need, pass it in, then carry out the actions returned. That keeps
// it trivially testable and lets the IO layer evolve independently.
//
// The full ONBOARDING state machine is the next task in GOAL.md. For now
// we emit a friendly holding reply for ONBOARDING users; the seam is
// `routeOnboarding`, which the next agent will fill in.

import type { Decision, MessageDirection, MilestoneType, UserStatus } from "@prisma/client";
import {
  parseDecisionKeyword,
  replyForOwnDecision,
} from "../decisions/flow.js";
import { scoreMessageDepth, type DepthInput } from "../milestones/depth.js";
import {
  nextMilestoneToUnlock,
  type MessageForUnlock,
} from "../milestones/index.js";
import type { MessageForDepth } from "../milestones/types.js";
import { advance as advanceOnboarding } from "../onboarding/flow.js";
import type {
  AdvanceResult as OnboardingAdvance,
  StepId as OnboardingStepId,
} from "../onboarding/types.js";

// ─── Inputs ─────────────────────────────────────────────────────────────────

/** Minimal user shape needed by the router. */
export interface RouterUser {
  id: string;
  phone: string;
  displayName: string | null;
  status: UserStatus;
  onboardingStep: OnboardingStepId | null;
}

/** Minimal partner shape needed for relay. */
export interface RouterPartner {
  id: string;
  phone: string;
}

/** Active-match context loaded by the IO layer. */
export interface RouterActiveMatch {
  id: string;
  /** The partner across this match (the user NOT receiving the inbound). */
  partner: RouterPartner;
  /** All prior messages in this match, chronological. */
  priorMessages: ReadonlyArray<MessageForDepth & MessageForUnlock>;
  /** Milestones already unlocked for this match. */
  unlockedMilestones: ReadonlySet<MilestoneType>;
  /**
   * userAId < userBId — used to attribute message counts per side in the
   * unlock rule.
   */
  userAId: string;
  userBId: string;
}

export interface RouteInput {
  /** The user the inbound SMS came from. `null` if phone isn't registered. */
  sender: RouterUser | null;
  /** The unknown sender's phone, if `sender` is null. */
  fromPhone: string;
  /** Raw message body (already trimmed of Twilio framing). */
  body: string;
  /** Active match for `sender`, if any. */
  activeMatch: RouterActiveMatch | null;
}

// ─── Outputs ────────────────────────────────────────────────────────────────

export interface OutboundAction {
  /** Destination phone (E.164). */
  toPhone: string;
  /** Outbound user id (the recipient). Used by callers to persist the message. */
  toUserId: string | null;
  /** Outbound user id of the *sender as Boba sees it*. The platform doesn't
   *  speak with its own user-id, so null for system-originated replies and
   *  the originating user's id when relaying. */
  fromUserId: string | null;
  body: string;
  /** If true, this outbound is part of a match relay (vs. system reply). */
  isRelay: boolean;
  /** Optional match id this outbound belongs to (set on relays and reveals). */
  matchId: string | null;
  /** Kind of action — useful for logging, tests and metrics. */
  kind:
    | "unknown_sender_intro"
    | "onboarding_stub"
    | "no_match_holding"
    | "paused"
    | "banned_silent"
    | "relay"
    | "milestone_reveal"
    | "decision_ack"
    | "decision_announcement";
}

/** Directive for persisting the inbound `Message` row, if applicable. */
export interface PersistInbound {
  matchId: string;
  senderId: string;
  direction: MessageDirection; // always INBOUND when present
  body: string;
  depthScore: number;
}

export interface RouteResult {
  outbounds: OutboundAction[];
  /** When set, the caller should INSERT this Message row. */
  persistInbound: PersistInbound | null;
  /** Milestones to record for this match after persistInbound is written. */
  milestonesToRecord: MilestoneType[];
  /**
   * When set, the caller should apply this onboarding advance: persist
   * the updates + cursor + (maybe) flip status to ACTIVE.
   */
  onboardingAdvance: {
    userId: string;
    advance: OnboardingAdvance;
  } | null;
  /**
   * When set, the caller should record this end-of-day decision and (if
   * the partner has already decided) emit a resolution announcement to
   * both users via the recorded continuation result.
   */
  decisionToRecord: {
    matchId: string;
    userId: string;
    /** Partner's phone — used for the announcement outbound. */
    partnerPhone: string;
    partnerUserId: string;
    decision: Decision;
  } | null;
}

// ─── Copy ───────────────────────────────────────────────────────────────────

// Centralised so tests can assert without scraping prose.
export const COPY = {
  unknownSenderIntro:
    "Hi! This is Boba — conversation-first dating. We're invite-only right now. Reply JOIN if you have an invite code, or visit boba.app to request one.",
  onboardingStub:
    "Welcome to Boba! You're partway through onboarding. We'll text you the next question shortly.",
  // Reserved for `OnboardingAdvance.reply` — kept here only for greppability.
  noMatchHolding:
    "You're all set. Your next match drops today at 5pm — we'll text you here.",
  paused:
    "Your account is paused. Reply RESUME to start receiving matches again.",
  // milestone reveal templates use {{stat}} substitution at emit time
  revealAge: "✨ Milestone unlocked — your match is {{age}} years old.",
  revealProfession: "✨ Milestone unlocked — your match works as {{profession}}.",
  revealHeight: "✨ Milestone unlocked — your match is {{heightCm}}cm tall.",
} as const;

// ─── Router ─────────────────────────────────────────────────────────────────

/**
 * Decide what to do with an inbound SMS. Pure — the caller is responsible
 * for persisting `persistInbound`, recording `milestonesToRecord`, and
 * sending each `OutboundAction` via the Twilio client.
 */
export function route(input: RouteInput): RouteResult {
  const trimmed = input.body.trim();

  // Unknown sender: don't create accounts here — the onboarding SM owns
  // that. Just hand back an intro reply.
  if (!input.sender) {
    return {
      outbounds: [
        {
          toPhone: input.fromPhone,
          toUserId: null,
          fromUserId: null,
          body: COPY.unknownSenderIntro,
          isRelay: false,
          matchId: null,
          kind: "unknown_sender_intro",
        },
      ],
      persistInbound: null,
      milestonesToRecord: [],
      onboardingAdvance: null,
      decisionToRecord: null,
    };
  }

  const user = input.sender;

  switch (user.status) {
    case "BANNED":
      // Soft-fail silently — drop the message, no reply. Reporting still
      // tracks the user, but they don't get to participate.
      return {
        outbounds: [],
        persistInbound: null,
        milestonesToRecord: [],
        onboardingAdvance: null,
        decisionToRecord: null,
      };

    case "PAUSED":
      return {
        outbounds: [systemReply(user, COPY.paused, "paused")],
        persistInbound: null,
        milestonesToRecord: [],
        onboardingAdvance: null,
        decisionToRecord: null,
      };

    case "ONBOARDING":
      return routeOnboarding(user, trimmed);

    case "ACTIVE":
      return routeActive(user, trimmed, input.activeMatch);
  }
}

/**
 * Drive the onboarding state machine for one inbound. We delegate parsing
 * + transition logic to `../onboarding/flow.ts` and emit a single system
 * reply with the next prompt (or a clarifying retry on parse failure).
 */
function routeOnboarding(user: RouterUser, body: string): RouteResult {
  const adv = advanceOnboarding(user.onboardingStep, body);
  return {
    outbounds: [systemReply(user, adv.reply, "onboarding_stub")],
    persistInbound: null,
    milestonesToRecord: [],
    onboardingAdvance: { userId: user.id, advance: adv },
    decisionToRecord: null,
  };
}

function routeActive(
  user: RouterUser,
  body: string,
  active: RouterActiveMatch | null,
): RouteResult {
  if (!active) {
    return {
      outbounds: [systemReply(user, COPY.noMatchHolding, "no_match_holding")],
      persistInbound: null,
      milestonesToRecord: [],
      onboardingAdvance: null,
      decisionToRecord: null,
    };
  }

  // End-of-day decision keyword? Intercept BEFORE we treat the message
  // as conversational. We accept these whenever a match exists — the
  // PRD doesn't require the day to be "over"; a user who wants out
  // can short-circuit. The IO layer enforces idempotency.
  const decisionKeyword = parseDecisionKeyword(body);
  if (decisionKeyword) {
    return {
      outbounds: [
        {
          toPhone: user.phone,
          toUserId: user.id,
          fromUserId: null,
          body: replyForOwnDecision(decisionKeyword),
          isRelay: false,
          matchId: active.id,
          kind: "decision_ack",
        },
      ],
      persistInbound: null,
      milestonesToRecord: [],
      onboardingAdvance: null,
      decisionToRecord: {
        matchId: active.id,
        userId: user.id,
        partnerPhone: active.partner.phone,
        partnerUserId: active.partner.id,
        decision: decisionKeyword,
      },
    };
  }

  // Score depth using prior messages from this same match.
  const depthInput: DepthInput = {
    message: { senderId: user.id, body },
    previousMessages: active.priorMessages,
  };
  const depthScore = scoreMessageDepth(depthInput);

  // Evaluate milestone unlocks AFTER this inbound is conceptually
  // persisted: we feed the unlock rule the full message list including
  // the in-flight one.
  const messagesWithCurrent: MessageForUnlock[] = [
    ...active.priorMessages.map((m) => ({ senderId: m.senderId, depthScore: m.depthScore })),
    { senderId: user.id, depthScore },
  ];
  const unlock = nextMilestoneToUnlock({
    userAId: active.userAId,
    userBId: active.userBId,
    messages: messagesWithCurrent,
    unlocked: active.unlockedMilestones,
  });

  const outbounds: OutboundAction[] = [
    // Relay to partner.
    {
      toPhone: active.partner.phone,
      toUserId: active.partner.id,
      fromUserId: user.id,
      body,
      isRelay: true,
      matchId: active.id,
      kind: "relay",
    },
  ];

  const milestonesToRecord: MilestoneType[] = [];
  if (unlock.milestone) {
    milestonesToRecord.push(unlock.milestone);
    const revealBody = renderRevealPlaceholder(unlock.milestone);
    // Reveal goes to BOTH sides of the match — partner learns the stat
    // about `user`, and `user` learns the stat about partner. The actual
    // stat values are filled in by the caller when it has the loaded
    // Stats rows (the pure router only sees ids, not stats).
    outbounds.push(
      {
        toPhone: user.phone,
        toUserId: user.id,
        fromUserId: null,
        body: revealBody,
        isRelay: false,
        matchId: active.id,
        kind: "milestone_reveal",
      },
      {
        toPhone: active.partner.phone,
        toUserId: active.partner.id,
        fromUserId: null,
        body: revealBody,
        isRelay: false,
        matchId: active.id,
        kind: "milestone_reveal",
      },
    );
  }

  return {
    outbounds,
    persistInbound: {
      matchId: active.id,
      senderId: user.id,
      direction: "INBOUND",
      body,
      depthScore,
    },
    milestonesToRecord,
    onboardingAdvance: null,
    decisionToRecord: null,
  };
}

function systemReply(
  user: RouterUser,
  body: string,
  kind: OutboundAction["kind"],
): OutboundAction {
  return {
    toPhone: user.phone,
    toUserId: user.id,
    fromUserId: null,
    body,
    isRelay: false,
    matchId: null,
    kind,
  };
}

/**
 * Returns the reveal template with the `{{stat}}` placeholder intact.
 * The caller substitutes the real stat once it has loaded the partner's
 * Stats row. Kept here so the templates live next to the rest of the
 * copy; substitution is in `renderRevealBody` below.
 */
function renderRevealPlaceholder(milestone: MilestoneType): string {
  switch (milestone) {
    case "AGE":
      return COPY.revealAge;
    case "PROFESSION":
      return COPY.revealProfession;
    case "HEIGHT":
      return COPY.revealHeight;
    case "FACE":
      // FACE is unlocked via end-of-day resolution, not message-count.
      // The router never emits a FACE reveal, but we keep the case
      // exhaustive for `MilestoneType`.
      return "✨ Milestone unlocked — face reveal.";
  }
}

/**
 * Substitute a reveal template with the actual stat. Exposed for the
 * route layer to call after loading the partner's Stats row.
 */
export function renderRevealBody(
  milestone: MilestoneType,
  partnerStats: { age: number | null; profession: string | null; heightCm: number | null },
): string {
  const template = renderRevealPlaceholder(milestone);
  return template
    .replace("{{age}}", partnerStats.age?.toString() ?? "—")
    .replace("{{profession}}", partnerStats.profession ?? "—")
    .replace("{{heightCm}}", partnerStats.heightCm?.toString() ?? "—");
}
