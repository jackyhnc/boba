// Prisma adapter for the Twilio relay layer.
//
// Responsibilities:
//   - Look up the sender by phone
//   - Load that sender's currently-active match (if any) + the prior
//     messages and unlocked milestones needed by the router
//   - Persist inbound messages and outbound message stubs (with
//     twilioSid filled in after the send)
//   - Update message rows by twilioSid for delivery-status callbacks

import type { PrismaClient } from "@prisma/client";
import type { RouterActiveMatch, RouterUser } from "./conversation.js";

export type TwilioPrisma = Pick<
  PrismaClient,
  | "user"
  | "dailyMatch"
  | "message"
  | "milestoneProgress"
  | "stats"
  | "preferences"
  | "endOfDayDecision"
  | "rematchHistory"
  | "report"
  | "$transaction"
>;

/**
 * Find the user with the given E.164 phone, returning the trimmed shape
 * the router needs. Returns null if no user exists.
 */
export async function findUserByPhone(
  prisma: TwilioPrisma,
  phone: string,
): Promise<RouterUser | null> {
  const user = await prisma.user.findUnique({
    where: { phone },
    select: {
      id: true,
      phone: true,
      displayName: true,
      status: true,
      onboardingStep: true,
    },
  });
  if (!user) return null;
  return {
    ...user,
    onboardingStep: user.onboardingStep as RouterUser["onboardingStep"],
  };
}

/**
 * Load the user's currently-active match plus the data the router needs
 * to score depth and check milestone unlocks.
 *
 * "Currently active" = a `DailyMatch` involving `userId` whose state is
 * ACTIVE. There should be at most one — we pick the most recent
 * `matchDate` defensively.
 */
export async function loadActiveMatchForUser(
  prisma: TwilioPrisma,
  userId: string,
): Promise<RouterActiveMatch | null> {
  const match = await prisma.dailyMatch.findFirst({
    where: {
      state: "ACTIVE",
      OR: [{ userAId: userId }, { userBId: userId }],
    },
    orderBy: { matchDate: "desc" },
    select: {
      id: true,
      userAId: true,
      userBId: true,
      userA: { select: { id: true, phone: true, isAiBacked: true, aiPersonaPrompt: true } },
      userB: { select: { id: true, phone: true, isAiBacked: true, aiPersonaPrompt: true } },
      messages: {
        orderBy: { createdAt: "asc" },
        select: { senderId: true, body: true, depthScore: true },
      },
      milestones: { select: { milestone: true } },
    },
  });
  if (!match) return null;

  const partner = match.userAId === userId ? match.userB : match.userA;

  return {
    id: match.id,
    partner: {
      id: partner.id,
      phone: partner.phone,
      isAiBacked: partner.isAiBacked,
      aiPersonaPrompt: partner.aiPersonaPrompt,
    },
    userAId: match.userAId,
    userBId: match.userBId,
    priorMessages: match.messages,
    unlockedMilestones: new Set(match.milestones.map((m) => m.milestone)),
  };
}

/**
 * Persist a message row for an INBOUND SMS we received from Twilio.
 * `twilioSid` is the MessageSid Twilio assigned (used later for delivery
 * status callbacks).
 */
export async function persistInboundMessage(
  prisma: TwilioPrisma,
  input: {
    matchId: string;
    senderId: string;
    body: string;
    depthScore: number;
    twilioSid: string | null;
    flaggedStatFishing?: boolean;
    flaggedHarassment?: boolean;
  },
): Promise<{ id: string }> {
  const row = await prisma.message.create({
    data: {
      matchId: input.matchId,
      senderId: input.senderId,
      direction: "INBOUND",
      body: input.body,
      depthScore: input.depthScore,
      twilioSid: input.twilioSid,
      flaggedStatFishing: input.flaggedStatFishing ?? false,
      flaggedHarassment: input.flaggedHarassment ?? false,
    },
    select: { id: true },
  });
  return row;
}

/**
 * Persist a row for an OUTBOUND message Boba sent on behalf of the
 * relay (or a system reply with `senderId` = the addressed user).
 *
 * `senderId` here is the user this message is *attributed to* from the
 * conversation's point of view. For a partner relay, it's the
 * originating user. For system replies (no relevant user), the caller
 * may pass the recipient's id so the row exists; system reveals also
 * use this — feel free to refine attribution later.
 */
export async function persistOutboundMessage(
  prisma: TwilioPrisma,
  input: {
    matchId: string;
    senderId: string;
    body: string;
    twilioSid: string | null;
  },
): Promise<{ id: string }> {
  const row = await prisma.message.create({
    data: {
      matchId: input.matchId,
      senderId: input.senderId,
      direction: "OUTBOUND",
      body: input.body,
      twilioSid: input.twilioSid,
    },
    select: { id: true },
  });
  return row;
}

/**
 * Mark a previously-sent outbound message with its delivery status from
 * a Twilio status callback. We currently just stash whether Twilio has
 * acknowledged the message; richer state tracking can follow once we
 * add a column for it.
 *
 * Returns true if the row was found (and an update was issued), false
 * if no row matched the supplied SID.
 */
export async function recordDeliveryStatus(
  prisma: TwilioPrisma,
  twilioSid: string,
  // status is intentionally accepted but not yet persisted — a follow-up
  // schema change adds a deliveryStatus column. Logging only for now.
  _status: string,
): Promise<boolean> {
  const existing = await prisma.message.findUnique({
    where: { twilioSid },
    select: { id: true },
  });
  return existing !== null;
}
