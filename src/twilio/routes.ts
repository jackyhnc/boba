// Twilio webhook routes.
//
//   POST /webhooks/twilio/inbound  — Twilio fires this for every inbound
//                                    SMS. We verify the signature, look up
//                                    the sender, run the conversation
//                                    router, persist the inbound message,
//                                    and emit outbound replies asynchronously
//                                    via the TwilioClient. Response body is
//                                    empty TwiML so Twilio doesn't try to
//                                    auto-reply.
//   POST /webhooks/twilio/status   — Delivery-status callback. We look up
//                                    the message by SID and acknowledge.
//
// Signature verification is enforced when `TWILIO_AUTH_TOKEN` is set OR
// `TWILIO_REQUIRE_SIGNATURE=true`. Otherwise (dev with stub creds) we log
// a warning and continue, so local testing isn't blocked before the user
// finishes provisioning Twilio.

import type { FastifyInstance, FastifyRequest } from "fastify";
import { loadEnv } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { createTwilioClient, type TwilioClient } from "./client.js";
import { createAiPersonaClient, type AiPersonaClient } from "../ai/index.js";
import {
  faceRevealBody,
  recordDecisionAndMaybeResolve,
  resolutionAnnouncement,
} from "../decisions/index.js";
import { redeemCode, type InvitePrisma } from "../invites/index.js";
import { persistOnboardingUpdates } from "../onboarding/prisma-deps.js";
import {
  incrementReportCount,
  recordReport,
} from "../safety/prisma-deps.js";
import { route, renderRevealBody, type OutboundAction } from "./conversation.js";
import {
  applySmsOptOutChange,
  findUserByPhone,
  isSmsOptedOut,
  loadActiveMatchForUser,
  persistInboundMessage,
  persistOutboundMessage,
  recordDeliveryStatus,
  type TwilioPrisma,
} from "./prisma-deps.js";
import { detectSmsKeyword } from "../safety/smsKeywords.js";
import { verifyTwilioSignature } from "./signature.js";

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

// Twilio inbound webhook params we care about.
interface TwilioInboundParams {
  From?: string;
  To?: string;
  Body?: string;
  MessageSid?: string;
  AccountSid?: string;
  NumMedia?: string;
  MediaUrl0?: string;
  MediaContentType0?: string;
  // ... many more fields are sent; we accept and ignore them.
}

interface TwilioStatusParams {
  MessageSid?: string;
  MessageStatus?: string;
  ErrorCode?: string;
}

export interface RegisterOptions {
  /** Override deps for tests (injected Prisma surface + Twilio client). */
  deps?: {
    prisma?: TwilioPrisma;
    twilio?: TwilioClient;
    /** Test override; otherwise built from env via `createAiPersonaClient`. */
    aiPersonaClient?: AiPersonaClient | null;
  };
}

export async function registerTwilioRoutes(
  app: FastifyInstance,
  options: RegisterOptions = {},
): Promise<void> {
  const env = loadEnv();
  const db = options.deps?.prisma ?? (prisma as unknown as TwilioPrisma);
  const twilio =
    options.deps?.twilio ?? createTwilioClient({ env, logger: app.log });
  const aiPersona: AiPersonaClient | null =
    options.deps?.aiPersonaClient !== undefined
      ? options.deps.aiPersonaClient
      : createAiPersonaClient({ env });

  app.post("/webhooks/twilio/inbound", async (req, reply) => {
    const params = (req.body ?? {}) as TwilioInboundParams;

    if (!verifyInboundSignature(req, env, app)) {
      return reply.code(403).header("content-type", "text/plain").send("invalid signature");
    }

    const from = (params.From ?? "").trim();
    const body = (params.Body ?? "").toString();
    const messageSid = params.MessageSid ?? null;
    const numMedia = parseInt(params.NumMedia ?? "0", 10) || 0;
    const media =
      numMedia > 0 && params.MediaUrl0
        ? {
            url: params.MediaUrl0,
            contentType: params.MediaContentType0 ?? null,
          }
        : null;

    if (!from || (!body && !media)) {
      // Twilio shouldn't send both missing, but be explicit if it does.
      app.log.warn({ params }, "twilio.inbound: missing From / Body+Media");
      return reply.code(400).header("content-type", "text/plain").send("missing From/Body");
    }

    // Auto-provision a fresh ONBOARDING user the first time we hear from
    // an unknown phone — they enter the invite-code step on the next reply.
    //
    // Exception: don't create an account on an inbound STOP/HELP from a
    // stranger. STOP from a non-account is meaningless; HELP just needs
    // a compliance reply. This keeps the user table clean of one-off
    // wrong-number STOPs (which are surprisingly common in SMS apps).
    let sender = await findUserByPhone(db, from);
    if (!sender) {
      const kw = detectSmsKeyword(body).keyword;
      if (kw !== "STOP" && kw !== "HELP") {
        const created = await db.user.create({
          data: { phone: from, status: "ONBOARDING" },
          select: {
            id: true,
            phone: true,
            displayName: true,
            status: true,
            onboardingStep: true,
            smsOptedOut: true,
          },
        });
        sender = {
          id: created.id,
          phone: created.phone,
          displayName: created.displayName,
          status: created.status,
          onboardingStep: null,
          smsOptedOut: created.smsOptedOut,
        };
      }
    }
    const activeMatch = sender ? await loadActiveMatchForUser(db, sender.id) : null;

    const result = route({
      sender,
      fromPhone: from,
      body,
      activeMatch,
      media,
      onboardingConfig: { invitesRequired: env.INVITES_REQUIRED },
    });

    // Carrier-compliance state change (STOP / START). Apply BEFORE we
    // send the ack so a race that re-reads the flag (e.g. scheduler
    // tick) sees the new value. STOP_ACK / START_ACK are always
    // deliverable — they're the legally-required reply.
    if (result.smsOptOutChange) {
      await applySmsOptOutChange(
        db,
        result.smsOptOutChange.userId,
        result.smsOptOutChange.optedOut,
      );
      app.log.info(
        {
          userId: result.smsOptOutChange.userId,
          optedOut: result.smsOptOutChange.optedOut,
          keyword: result.smsOptOutChange.keyword,
        },
        "twilio.compliance: sms opt-out flag updated",
      );
    }

    // Persist the inbound message first so we have the row id before we
    // start emitting outbounds (matters if downstream callers want to
    // reference it). We do this even if the router said "don't relay" —
    // wait, no, the router decides via `persistInbound`: if it's null,
    // there's no match yet (onboarding / unknown / no-match holding) and
    // there's nowhere to attach the row.
    let inboundRowId: string | null = null;
    if (result.persistInbound) {
      const inbound = await persistInboundMessage(db, {
        matchId: result.persistInbound.matchId,
        senderId: result.persistInbound.senderId,
        body: result.persistInbound.body,
        depthScore: result.persistInbound.depthScore,
        twilioSid: messageSid,
        flaggedStatFishing: result.persistInbound.flaggedStatFishing,
        flaggedHarassment: result.persistInbound.flaggedHarassment,
      });
      inboundRowId = inbound.id;
    }

    // Moderation actions (user REPORT or system auto-flag from harassment).
    if (result.moderation) {
      if (result.moderation.kind === "user_report") {
        await recordReport(db, {
          reporterId: result.moderation.reporterId,
          subjectId: result.moderation.subjectId,
          reason: result.moderation.reason,
          details: result.moderation.details,
        });
      } else {
        // System auto-flag: bump the sender's reportCount on severe hits.
        if (result.moderation.severe) {
          await incrementReportCount(db, result.moderation.subjectId);
        }
        app.log.warn(
          {
            subjectId: result.moderation.subjectId,
            matchId: result.moderation.matchId,
            tags: result.moderation.tags,
            severe: result.moderation.severe,
          },
          "moderation auto-flag",
        );
      }
    }

    // Apply onboarding advance (if any) BEFORE we send the reply, so the
    // cursor stored on the user reflects what we're about to ask.
    //
    // Invite-code redemption is handled here: if the advance carries an
    // `inviteCodeToRedeem`, we attempt to redeem it; on failure we
    // rewrite the outbounds to a clarifying retry and DON'T persist the
    // step (the user stays on `ask_invite_code`).
    if (result.onboardingAdvance) {
      const { userId, advance } = result.onboardingAdvance;
      if (advance.updates.inviteCodeToRedeem) {
        const redemption = await redeemCode(db as unknown as InvitePrisma, {
          userId,
          rawCode: advance.updates.inviteCodeToRedeem,
        });
        if (!redemption.ok) {
          const reasonReply = inviteFailureReply(redemption.reason);
          result.outbounds = result.outbounds.map((o) =>
            o.kind === "onboarding_stub" ? { ...o, body: reasonReply } : o,
          );
          // Skip persistence — the cursor stays where it was.
        } else {
          // Strip the directive from updates before persisting.
          const updatesCopy = { ...advance.updates };
          delete updatesCopy.inviteCodeToRedeem;
          await persistOnboardingUpdates(
            db,
            userId,
            updatesCopy,
            advance.nextStep,
            advance.markActive,
          );
        }
      } else {
        await persistOnboardingUpdates(
          db,
          userId,
          advance.updates,
          advance.nextStep,
          advance.markActive,
        );
      }
    }

    // End-of-day decision (if any). We persist + maybe resolve, then
    // emit an announcement outbound to both users once resolution is
    // known. The decision_ack outbound to the deciding user was emitted
    // by the router; we still need to send the announcement.
    if (result.decisionToRecord) {
      const today = new Date();
      const { resolution } = await recordDecisionAndMaybeResolve(db, {
        matchId: result.decisionToRecord.matchId,
        userId: result.decisionToRecord.userId,
        decision: result.decisionToRecord.decision,
        today,
      });

      // Only emit a partner-facing announcement when resolved or when
      // the partner hasn't yet decided (nudge them).
      const announcement = resolutionAnnouncement(resolution.outcome);
      // The deciding user gets the announcement only when resolution is
      // final (continued or ended); partner always gets the message.
      const partnerAction: OutboundAction = {
        toPhone: result.decisionToRecord.partnerPhone,
        toUserId: result.decisionToRecord.partnerUserId,
        fromUserId: null,
        body: announcement,
        isRelay: false,
        matchId: result.decisionToRecord.matchId,
        kind: "decision_announcement",
      };
      result.outbounds.push(partnerAction);

      if (resolution.outcome !== "pending") {
        result.outbounds.push({
          toPhone: sender!.phone,
          toUserId: sender!.id,
          fromUserId: null,
          body: announcement,
          isRelay: false,
          matchId: result.decisionToRecord.matchId,
          kind: "decision_announcement",
        });
      }

      // The payoff: when both sides chose to keep going, reveal the face.
      // Each user receives the OTHER person's photo as MMS — the last and
      // most-guarded milestone in Boba's conversation-first ladder. The
      // FACE MilestoneProgress row was already written inside
      // `recordDecisionAndMaybeResolve`; here we deliver it.
      if (resolution.outcome === "continue") {
        const reveals = await buildFaceRevealOutbounds(db, {
          matchId: result.decisionToRecord.matchId,
          deciderId: sender!.id,
          deciderPhone: sender!.phone,
          partnerId: result.decisionToRecord.partnerUserId,
          partnerPhone: result.decisionToRecord.partnerPhone,
        });
        result.outbounds.push(...reveals);
      }
    }

    // Record milestones BEFORE sending the reveal SMS so the unlock is
    // captured even if the outbound send fails. Idempotent via the
    // `@@unique([matchId, milestone])` constraint.
    for (const milestone of result.milestonesToRecord) {
      await db.milestoneProgress.upsert({
        where: { matchId_milestone: { matchId: result.persistInbound!.matchId, milestone } },
        create: { matchId: result.persistInbound!.matchId, milestone },
        update: {},
      });
    }

    // AI-seeding: if the partner is AI-backed, synthesize their reply
    // here and inject it into the outbound list. The relay outbound was
    // suppressed by the router. We persist the synthesized reply as an
    // INBOUND from the AI user (because, from the human's perspective,
    // it's a normal inbound coming back) — that keeps the milestone-
    // unlock and decision flows symmetric.
    if (result.aiReplyToGenerate && aiPersona) {
      const req = result.aiReplyToGenerate;
      try {
        const { body: aiBody } = await aiPersona.generateReply({
          matchId: req.matchId,
          humanUserId: req.humanUserId,
          aiUserId: req.aiUserId,
          personaPrompt: req.personaPrompt,
          latestInbound: { body: req.latestInbound.body, createdAtMs: Date.now() },
          priorTurns: req.priorTurns,
        });

        // Persist as if it were an inbound from the AI partner. depthScore
        // is left at 0; richer scoring can be added later.
        await persistInboundMessage(db, {
          matchId: req.matchId,
          senderId: req.aiUserId,
          body: aiBody,
          depthScore: 0,
          twilioSid: null,
        });

        // Send the AI's reply to the human user over SMS.
        result.outbounds.push({
          toPhone: req.humanUserPhone,
          toUserId: req.humanUserId,
          fromUserId: req.aiUserId,
          body: aiBody,
          isRelay: true,
          matchId: req.matchId,
          kind: "relay",
        });
      } catch (err) {
        app.log.error({ err, matchId: req.matchId }, "ai persona reply failed");
      }
    } else if (result.aiReplyToGenerate && !aiPersona) {
      app.log.debug(
        { matchId: result.aiReplyToGenerate.matchId },
        "ai partner inbound dropped: AI seeding disabled",
      );
    }

    // Send each outbound and persist a Message row for it. Milestone
    // reveals need the partner's stats interpolated; we resolve those
    // here (the router only sees ids).
    const matchIdForStats = result.persistInbound?.matchId ?? null;
    for (const action of result.outbounds) {
      const finalBody =
        action.kind === "milestone_reveal" && matchIdForStats
          ? await materialiseRevealBody(db, action, sender, activeMatch)
          : action.body;

      // Carrier-compliance guard: skip any outbound to a user who has
      // texted STOP. The STOP_ACK / HELP_REPLY / START_ACK outbounds
      // themselves are always deliverable (this is the legally-required
      // reply and STOP_ACK is sent to a just-opted-out user).
      if (!isComplianceReply(action.kind) && action.toUserId) {
        const blocked = await isSmsOptedOut(db, action.toUserId);
        if (blocked) {
          app.log.info(
            { toUserId: action.toUserId, kind: action.kind },
            "twilio.outbound suppressed: recipient is opted out",
          );
          continue;
        }
      }

      let sid: string | null = null;
      try {
        const sent = await twilio.sendSms({
          to: action.toPhone,
          body: finalBody,
          ...(action.mediaUrl ? { mediaUrl: action.mediaUrl } : {}),
        });
        sid = sent.sid;
      } catch (err) {
        app.log.error(
          { err, action, kind: action.kind },
          "twilio.outbound send failed",
        );
        // Continue with other outbounds; we still want to record what we attempted.
      }

      if (action.matchId && action.toUserId) {
        // Attribute by `fromUserId` for relays, by recipient id for
        // system-originated messages (so the row is non-null).
        const attributedSenderId = action.fromUserId ?? action.toUserId;
        await persistOutboundMessage(db, {
          matchId: action.matchId,
          senderId: attributedSenderId,
          body: finalBody,
          twilioSid: sid,
        });
      }
    }

    app.log.debug(
      { from, senderId: sender?.id ?? null, inboundRowId, outbounds: result.outbounds.length },
      "twilio.inbound routed",
    );

    return reply.code(200).header("content-type", "text/xml").send(EMPTY_TWIML);
  });

  app.post("/webhooks/twilio/status", async (req, reply) => {
    const params = (req.body ?? {}) as TwilioStatusParams;

    if (!verifyInboundSignature(req, env, app)) {
      return reply.code(403).header("content-type", "text/plain").send("invalid signature");
    }

    const sid = params.MessageSid;
    const status = params.MessageStatus ?? "unknown";
    if (!sid) {
      return reply.code(400).header("content-type", "text/plain").send("missing MessageSid");
    }

    const found = await recordDeliveryStatus(db, sid, status);
    if (!found) {
      app.log.debug({ sid, status }, "twilio.status: no matching message row");
    }
    return reply.code(204).send();
  });
}

/**
 * The three compliance-reply kinds are always deliverable, regardless
 * of the recipient's opt-out state. STOP_ACK in particular is sent to a
 * user we just marked as opted-out (one final confirmation message is
 * allowed by carriers and required by CTIA guidance).
 */
function isComplianceReply(kind: OutboundAction["kind"]): boolean {
  return (
    kind === "sms_stop_ack" || kind === "sms_help_reply" || kind === "sms_start_ack"
  );
}

function inviteFailureReply(
  reason: "unknown_code" | "already_redeemed" | "self_already_redeemed",
): string {
  switch (reason) {
    case "unknown_code":
      return "We don't recognize that code. Double-check spelling — they look like ABCD-1234.";
    case "already_redeemed":
      return "That code has already been used by someone else. Got another?";
    case "self_already_redeemed":
      return "Looks like you've already redeemed an invite. We'll keep onboarding moving — what should we call you?";
  }
}

/**
 * Resolve a milestone reveal body's stat placeholder. We re-load the
 * partner's stats (the router intentionally doesn't see them) and
 * substitute via `renderRevealBody`.
 */
async function materialiseRevealBody(
  db: TwilioPrisma,
  action: OutboundAction,
  sender: { id: string } | null,
  match: { partner: { id: string }; userAId: string; userBId: string } | null,
): Promise<string> {
  if (!match) return action.body;
  // Determine whose stats this reveal is about.
  //   - If the outbound goes to `sender`, the stat is about `partner`.
  //   - If the outbound goes to `partner`, the stat is about `sender`.
  const aboutUserId =
    action.toUserId === sender?.id ? match.partner.id : sender?.id ?? null;
  if (!aboutUserId) return action.body;
  const stats = await loadStatsFor(db, aboutUserId);
  // The router placeholder happens to encode the milestone. Detect by string.
  if (action.body.includes("{{age}}")) return renderRevealBody("AGE", stats);
  if (action.body.includes("{{profession}}")) return renderRevealBody("PROFESSION", stats);
  if (action.body.includes("{{heightCm}}")) return renderRevealBody("HEIGHT", stats);
  return action.body;
}

/**
 * Build the two end-of-day FACE reveal outbounds for a continued match.
 * Each side receives the OTHER person's photo (when present) as MMS.
 */
async function buildFaceRevealOutbounds(
  db: TwilioPrisma,
  args: {
    matchId: string;
    deciderId: string;
    deciderPhone: string;
    partnerId: string;
    partnerPhone: string;
  },
): Promise<OutboundAction[]> {
  const [deciderPhoto, partnerPhoto] = await Promise.all([
    loadPhotoUrlFor(db, args.deciderId),
    loadPhotoUrlFor(db, args.partnerId),
  ]);
  return [
    faceRevealOutbound(args.matchId, args.deciderId, args.deciderPhone, partnerPhoto),
    faceRevealOutbound(args.matchId, args.partnerId, args.partnerPhone, deciderPhoto),
  ];
}

function faceRevealOutbound(
  matchId: string,
  toUserId: string,
  toPhone: string,
  matchPhotoUrl: string | null,
): OutboundAction {
  return {
    toPhone,
    toUserId,
    fromUserId: null,
    body: faceRevealBody(matchPhotoUrl !== null),
    isRelay: false,
    matchId,
    mediaUrl: matchPhotoUrl,
    kind: "face_reveal",
  };
}

async function loadPhotoUrlFor(db: TwilioPrisma, userId: string): Promise<string | null> {
  const u = await db.user.findUnique({
    where: { id: userId },
    select: { stats: { select: { photoUrl: true } } },
  });
  return u?.stats?.photoUrl ?? null;
}

async function loadStatsFor(
  db: TwilioPrisma,
  userId: string,
): Promise<{ age: number | null; profession: string | null; heightCm: number | null }> {
  // Stats are a 1:1 with User; pull via the user relation so we don't
  // need to add a `stats` field to TwilioPrisma's narrow type.
  const u = await db.user.findUnique({
    where: { id: userId },
    select: { stats: { select: { age: true, profession: true, heightCm: true } } },
  });
  return {
    age: u?.stats?.age ?? null,
    profession: u?.stats?.profession ?? null,
    heightCm: u?.stats?.heightCm ?? null,
  };
}

/**
 * Verify the X-Twilio-Signature header. Returns true if verified OR if
 * verification is intentionally skipped in dev. Returns false to reject.
 */
function verifyInboundSignature(
  req: FastifyRequest,
  env: { TWILIO_AUTH_TOKEN: string; TWILIO_REQUIRE_SIGNATURE: boolean; PUBLIC_WEBHOOK_BASE_URL: string },
  app: FastifyInstance,
): boolean {
  const header = (req.headers["x-twilio-signature"] ?? "").toString();

  if (!env.TWILIO_AUTH_TOKEN) {
    if (env.TWILIO_REQUIRE_SIGNATURE) {
      app.log.warn(
        "twilio: TWILIO_REQUIRE_SIGNATURE=true but no auth token configured — rejecting",
      );
      return false;
    }
    app.log.warn(
      "twilio: auth token not configured, skipping signature verification (dev mode)",
    );
    return true;
  }

  // From here on we have an auth token, which means the caller is past
  // dev-stub mode and any unsigned/wrong-signed request must be rejected.
  if (!header) return false;

  // The URL signed by Twilio is the public URL configured in the console,
  // not whatever Fastify thinks it is behind a proxy. Compose from the
  // PUBLIC_WEBHOOK_BASE_URL + the request path so signatures match.
  const url = `${env.PUBLIC_WEBHOOK_BASE_URL.replace(/\/$/, "")}${req.url}`;
  const params = (req.body ?? {}) as Record<string, string | string[]>;
  const ok = verifyTwilioSignature({
    authToken: env.TWILIO_AUTH_TOKEN,
    url,
    params,
    signatureHeader: header,
  });
  if (!ok) {
    app.log.warn({ url, header }, "twilio: signature mismatch");
  }
  return ok;
}
