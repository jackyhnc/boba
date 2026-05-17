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
import { persistOnboardingUpdates } from "../onboarding/prisma-deps.js";
import { route, renderRevealBody, type OutboundAction } from "./conversation.js";
import {
  findUserByPhone,
  loadActiveMatchForUser,
  persistInboundMessage,
  persistOutboundMessage,
  recordDeliveryStatus,
  type TwilioPrisma,
} from "./prisma-deps.js";
import { verifyTwilioSignature } from "./signature.js";

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

// Twilio inbound webhook params we care about.
interface TwilioInboundParams {
  From?: string;
  To?: string;
  Body?: string;
  MessageSid?: string;
  AccountSid?: string;
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

  app.post("/webhooks/twilio/inbound", async (req, reply) => {
    const params = (req.body ?? {}) as TwilioInboundParams;

    if (!verifyInboundSignature(req, env, app)) {
      return reply.code(403).header("content-type", "text/plain").send("invalid signature");
    }

    const from = (params.From ?? "").trim();
    const body = (params.Body ?? "").toString();
    const messageSid = params.MessageSid ?? null;

    if (!from || !body) {
      // Twilio shouldn't send these missing, but be explicit if it does.
      app.log.warn({ params }, "twilio.inbound: missing From or Body");
      return reply.code(400).header("content-type", "text/plain").send("missing From/Body");
    }

    const sender = await findUserByPhone(db, from);
    const activeMatch = sender ? await loadActiveMatchForUser(db, sender.id) : null;

    const result = route({
      sender,
      fromPhone: from,
      body,
      activeMatch,
    });

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
      });
      inboundRowId = inbound.id;
    }

    // Apply onboarding advance (if any) BEFORE we send the reply, so the
    // cursor stored on the user reflects what we're about to ask.
    if (result.onboardingAdvance) {
      const { userId, advance } = result.onboardingAdvance;
      await persistOnboardingUpdates(
        db,
        userId,
        advance.updates,
        advance.nextStep,
        advance.markActive,
      );
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

    // Send each outbound and persist a Message row for it. Milestone
    // reveals need the partner's stats interpolated; we resolve those
    // here (the router only sees ids).
    const matchIdForStats = result.persistInbound?.matchId ?? null;
    for (const action of result.outbounds) {
      const finalBody =
        action.kind === "milestone_reveal" && matchIdForStats
          ? await materialiseRevealBody(db, action, sender, activeMatch)
          : action.body;

      let sid: string | null = null;
      try {
        const sent = await twilio.sendSms({ to: action.toPhone, body: finalBody });
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
