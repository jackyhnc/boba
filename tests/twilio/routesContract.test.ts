// Contract pins for `src/twilio/routes.ts` — the Twilio webhook surface.
//
// Why this file exists. `tests/twilio/routes.test.ts` is a behavioural
// test: it asserts that the major code paths (onboarding, relay, REPORT,
// DISCARD, KEEP→continue, AI-backed partner, STOP/HELP/START) do the
// right thing end-to-end. That file leaves several STRUCTURAL contracts
// of the webhook surface itself unpinned — invariants that aren't visible
// from any single happy-path assertion but that the rest of the system
// (carriers, Twilio's retry behaviour, 10DLC vetting) depends on:
//
//   1. **Twilio retry-safety**: every accepted POST must return 200 with
//      an EMPTY TwiML body. Twilio retries on non-2xx (re-delivering the
//      same inbound) and AUTO-REPLIES the body if it's non-empty TwiML.
//      A refactor that returns `{ ok: true }` JSON, or a non-empty
//      `<Message>...</Message>`, double-delivers our outbound or
//      duplicates the inbound row.
//
//   2. **Signature verification happens BEFORE any side-effect**. A
//      refactor that looks up the user (or auto-provisions a row) before
//      verifying the signature lets a spoofed inbound write to the DB
//      regardless of whether the signature was valid. The behavioural
//      file's "rejects an unsigned request" test does not pin this —
//      the DB it injects happens to never be called on the success path
//      either, so the ordering isn't observable.
//
//   3. **Response-shape matrix**: the exact (statusCode, content-type,
//      body) triple for every code path. Twilio's webhook contract
//      treats text/xml as TwiML and parses it; text/plain is logged as
//      an error. A content-type drift from text/xml → application/json
//      would not break any of the existing behavioural tests (they only
//      assert status codes and a substring of the body) but would break
//      the carrier integration.
//
//   4. **TWILIO_REQUIRE_SIGNATURE=true with no auth token must REJECT**,
//      not silently skip into success. This is the production-safety
//      gate: it's what we set in render.yaml so that a missing
//      TWILIO_AUTH_TOKEN secret fails closed instead of accepting
//      anything. The existing tests only check the inverse pair
//      (token set + bad sig → reject; no token + REQUIRE=false → skip).
//
//   5. **Signature URL composition uses PUBLIC_WEBHOOK_BASE_URL + req.url**,
//      not whatever Fastify's `req.url` reports for the host. Behind a
//      proxy (Render, Fly), `req.hostname` may be `0.0.0.0:8080` while
//      Twilio signed `https://app.boba.dev/...`. A refactor that uses
//      `req.protocol + req.hostname + req.url` would break every signed
//      inbound in production. Pinned via a base URL different from the
//      Fastify inject default.
//
//   6. **STOP and HELP from an unknown phone do not auto-provision a
//      User row**. Wrong-number STOPs are common; we don't want a
//      stranger's phone in our user table just because they texted STOP
//      to the number once. HELP is pinned in routes.test.ts; STOP is
//      symmetric and not.
//
//   7. **Exact invite-failure reply copy for all three reasons**. The
//      behavioural file pins only "unknown_code" via a "don't recognize"
//      regex; "already_redeemed" and "self_already_redeemed" branches
//      are unpinned and a copy edit there would ship unnoticed.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import { computeTwilioSignature } from "../../src/twilio/signature.js";
import { _resetEnvCacheForTests } from "../../src/config/env.js";
import type { TwilioClient } from "../../src/twilio/client.js";
import type { TwilioPrisma } from "../../src/twilio/prisma-deps.js";

// ─── Minimal fake DB ───────────────────────────────────────────────────
//
// Re-built here (rather than imported from routes.test.ts) because the
// contract tests deliberately exercise a smaller surface. The
// `throwingDb` variant below is what pins the ordering contracts.

interface FakeUser {
  id: string;
  phone: string;
  displayName: string | null;
  status: "ACTIVE" | "ONBOARDING" | "PAUSED" | "BANNED";
  onboardingStep: string | null;
  smsOptedOut?: boolean;
}

interface FakeInvite {
  id: string;
  code: string;
  redeemedById: string | null;
  redeemedAt: Date | null;
}

interface FakeDb {
  db: TwilioPrisma;
  users: FakeUser[];
  invites: FakeInvite[];
  inserted: Array<{ matchId: string; senderId: string; direction: string; body: string; twilioSid: string | null }>;
}

function makeFakeDb(): FakeDb {
  const users: FakeUser[] = [];
  const invites: FakeInvite[] = [];
  const inserted: Array<{ matchId: string; senderId: string; direction: string; body: string; twilioSid: string | null }> = [];

  const db = {
    user: {
      findUnique: async ({ where, select }: { where: { phone?: string; id?: string }; select?: { stats?: unknown; smsOptedOut?: boolean } }) => {
        const u = users.find(
          (x) => (where.phone && x.phone === where.phone) || (where.id && x.id === where.id),
        );
        if (!u) return null;
        if (select?.stats) return { stats: null };
        if (select && Object.keys(select).length === 1 && select.smsOptedOut) {
          return { smsOptedOut: u.smsOptedOut ?? false };
        }
        return {
          id: u.id,
          phone: u.phone,
          displayName: u.displayName,
          status: u.status,
          onboardingStep: u.onboardingStep,
          smsOptedOut: u.smsOptedOut ?? false,
        };
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const u = users.find((x) => x.id === where.id);
        if (!u) throw new Error(`no user ${where.id}`);
        const rec = u as unknown as Record<string, unknown>;
        for (const [k, v] of Object.entries(data)) {
          if (v && typeof v === "object" && "increment" in (v as Record<string, unknown>)) {
            rec[k] = ((rec[k] as number | undefined) ?? 0) + ((v as { increment: number }).increment);
          } else {
            rec[k] = v;
          }
        }
        return { ...u };
      },
      create: async ({ data }: { data: { phone: string; status: FakeUser["status"] } }) => {
        const id = `u_auto_${users.length + 1}`;
        const u: FakeUser = {
          id,
          phone: data.phone,
          displayName: null,
          status: data.status,
          onboardingStep: null,
          smsOptedOut: false,
        };
        users.push(u);
        return { id, phone: u.phone, displayName: null, status: u.status, onboardingStep: null, smsOptedOut: false };
      },
    },
    stats: { upsert: async () => ({}) },
    preferences: { upsert: async () => ({}) },
    dailyMatch: {
      findFirst: async () => null,
      findUnique: async () => null,
      update: async () => ({}),
      create: async () => ({ id: "m_new" }),
    },
    message: {
      create: async ({ data }: { data: { matchId: string; senderId: string; direction: string; body: string; twilioSid: string | null } }) => {
        inserted.push(data);
        return { id: `msg_${inserted.length}` };
      },
      findUnique: async ({ where }: { where: { twilioSid: string } }) => {
        return inserted.find((m) => m.twilioSid === where.twilioSid) ? { id: "msg" } : null;
      },
    },
    milestoneProgress: {
      upsert: async () => ({ id: "mp", matchId: "m", milestone: "AGE", unlockedAt: new Date() }),
      findMany: async () => [],
    },
    endOfDayDecision: { upsert: async () => ({}) },
    rematchHistory: { upsert: async () => ({}) },
    report: { create: async () => ({ id: "r" }) },
    inviteCode: {
      findUnique: async ({ where }: { where: { code: string } }) => {
        const row = invites.find((i) => i.code === where.code);
        return row ? { id: row.id, redeemedById: row.redeemedById } : null;
      },
      findFirst: async ({ where }: { where: { redeemedById: string } }) => {
        const row = invites.find((i) => i.redeemedById === where.redeemedById);
        return row ? { id: row.id, code: row.code } : null;
      },
      update: async ({ where, data }: { where: { id: string }; data: { redeemedById: string; redeemedAt: Date } }) => {
        const row = invites.find((i) => i.id === where.id)!;
        row.redeemedById = data.redeemedById;
        row.redeemedAt = data.redeemedAt;
        return row;
      },
    },
    $transaction: async <T,>(fn: (tx: unknown) => Promise<T>) => fn(db),
  } as unknown as TwilioPrisma;

  return { db, users, invites, inserted };
}

/**
 * A Prisma surface that explodes on EVERY method call. Used to pin the
 * "no DB writes before signature verification" contract: if signature
 * check rejects first, none of these throws fires; if a refactor moves
 * a DB call before the signature check, the test fails with the throw
 * surfacing as a 500 (or as the wrong status code).
 */
function makeThrowingDb(): TwilioPrisma {
  const explode = () => {
    throw new Error("DB called before signature verification — contract violated");
  };
  const handler: ProxyHandler<Record<string, unknown>> = {
    get: (_t, prop) => {
      if (prop === "then") return undefined; // not a thenable
      // Each model name returns a proxy whose method calls throw.
      return new Proxy({}, { get: () => explode });
    },
  };
  return new Proxy({}, handler) as unknown as TwilioPrisma;
}

function makeFakeTwilio(): {
  client: TwilioClient;
  calls: Array<{ to: string; body: string; mediaUrl?: string }>;
} {
  const calls: Array<{ to: string; body: string; mediaUrl?: string }> = [];
  const client: TwilioClient = {
    sendSms: vi.fn(async ({ to, body, mediaUrl }) => {
      calls.push({ to, body, mediaUrl });
      return { sid: `SM_${calls.length}`, dryRun: false, status: 201 };
    }),
  };
  return { client, calls };
}

const ORIGINAL_ENV = { ...process.env };
const SIGNED_BASE = "https://boba.test"; // matches the PUBLIC_WEBHOOK_BASE_URL we set below

beforeEach(() => {
  _resetEnvCacheForTests();
  process.env.NODE_ENV = "test";
  process.env.LOG_LEVEL = "fatal";
  process.env.TWILIO_DRY_RUN = "true";
  process.env.TWILIO_AUTH_TOKEN = "";
  process.env.TWILIO_REQUIRE_SIGNATURE = "false";
  process.env.PUBLIC_WEBHOOK_BASE_URL = SIGNED_BASE;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  _resetEnvCacheForTests();
});

// ─── 1. Twilio retry-safety: exact response triple ──────────────────────

describe("routes contract — Twilio retry-safety response shape", () => {
  it("accepted inbound returns 200 text/xml with EXACTLY the empty TwiML body", async () => {
    // The empty TwiML body is the contract that prevents Twilio's
    // auto-reply: any non-empty `<Response>` element with `<Message>`
    // inside it would cause Twilio to send a second SMS on top of ours.
    // Pinned bit-for-bit so a "formatter" refactor (eg. pretty-print
    // whitespace, or "encoding" → "encoding ") fails this test.
    const { db } = makeFakeDb();
    const { client } = makeFakeTwilio();
    const app = await buildApp({ twilio: { deps: { prisma: db, twilio: client } } });

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/twilio/inbound",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        From: "+15550009999",
        Body: "hi",
        MessageSid: "SM" + "1".repeat(32),
      }).toString(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/xml");
    expect(res.body).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    await app.close();
  });

  it("missing From returns 400 text/plain — Twilio will NOT auto-reply", async () => {
    const { db } = makeFakeDb();
    const { client } = makeFakeTwilio();
    const app = await buildApp({ twilio: { deps: { prisma: db, twilio: client } } });

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/twilio/inbound",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ Body: "hi" }).toString(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers["content-type"]).toBe("text/plain");
    expect(res.body).toBe("missing From/Body");
    await app.close();
  });

  it("missing Body AND Media returns 400 text/plain", async () => {
    const { db } = makeFakeDb();
    const { client } = makeFakeTwilio();
    const app = await buildApp({ twilio: { deps: { prisma: db, twilio: client } } });

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/twilio/inbound",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ From: "+15550000001" }).toString(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers["content-type"]).toBe("text/plain");
    expect(res.body).toBe("missing From/Body");
    await app.close();
  });

  it("inbound with Body empty but NumMedia=1 + MediaUrl0 → accepted (MMS-only inbound)", async () => {
    // Pin the OR semantics: an inbound with media but empty Body is
    // valid (e.g. photo upload during onboarding). A refactor that
    // checks `if (!body)` instead of `if (!body && !media)` rejects
    // every MMS photo upload.
    const { db, users } = makeFakeDb();
    users.push({
      id: "u_onb",
      phone: "+15550000077",
      displayName: null,
      status: "ONBOARDING",
      onboardingStep: "ask_photo",
    });
    const { client } = makeFakeTwilio();
    const app = await buildApp({ twilio: { deps: { prisma: db, twilio: client } } });

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/twilio/inbound",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        From: "+15550000077",
        Body: "",
        NumMedia: "1",
        MediaUrl0: "https://api.twilio.com/2010-04-01/Accounts/AC/Messages/MM/Media/ME",
        MediaContentType0: "image/jpeg",
        MessageSid: "SM" + "m".repeat(32),
      }).toString(),
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("status callback with known sid returns 204 with empty body", async () => {
    // The status callback is a one-way ACK; Twilio doesn't care what
    // body comes back. 204 is correct (No Content). A refactor that
    // returns 200 + TwiML would make Twilio's parsing flag this as
    // a malformed response in their dashboards.
    const { db, inserted } = makeFakeDb();
    inserted.push({ matchId: "m1", senderId: "u1", direction: "OUTBOUND", body: "hi", twilioSid: "SMabc" });
    const { client } = makeFakeTwilio();
    const app = await buildApp({ twilio: { deps: { prisma: db, twilio: client } } });

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/twilio/status",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ MessageSid: "SMabc", MessageStatus: "delivered" }).toString(),
    });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe("");
    await app.close();
  });

  it("status callback with UNKNOWN sid still returns 204 (graceful no-op, not 404)", async () => {
    // Twilio sends status callbacks for messages we may have already
    // garbage-collected, or for messages our backup process never
    // recorded. A 404 here would surface in Twilio's error dashboards
    // and could trigger automated rate-limiting on the webhook URL.
    const { db } = makeFakeDb();
    const { client } = makeFakeTwilio();
    const app = await buildApp({ twilio: { deps: { prisma: db, twilio: client } } });

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/twilio/status",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ MessageSid: "SM_never_seen", MessageStatus: "delivered" }).toString(),
    });
    expect(res.statusCode).toBe(204);
    await app.close();
  });

  it("status callback with missing sid returns 400 text/plain 'missing MessageSid'", async () => {
    const { db } = makeFakeDb();
    const { client } = makeFakeTwilio();
    const app = await buildApp({ twilio: { deps: { prisma: db, twilio: client } } });

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/twilio/status",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ MessageStatus: "delivered" }).toString(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers["content-type"]).toBe("text/plain");
    expect(res.body).toBe("missing MessageSid");
    await app.close();
  });
});

// ─── 2. Signature-first ordering ────────────────────────────────────────

describe("routes contract — signature is verified BEFORE any DB call", () => {
  it("bad signature on /inbound returns 403 WITHOUT touching the DB", async () => {
    // The throwingDb explodes on every method. If the route handler
    // does any DB lookup (`findUserByPhone`, `loadActiveMatchForUser`,
    // `user.create` for auto-provision) BEFORE the signature check,
    // the throw propagates and the response is 500, not 403.
    process.env.TWILIO_AUTH_TOKEN = "tok-X";
    _resetEnvCacheForTests();

    const db = makeThrowingDb();
    const { client } = makeFakeTwilio();
    const app = await buildApp({ twilio: { deps: { prisma: db, twilio: client } } });

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/twilio/inbound",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": "obviously-wrong-signature",
      },
      payload: new URLSearchParams({
        From: "+15550009999",
        Body: "hello",
        MessageSid: "SM" + "z".repeat(32),
      }).toString(),
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers["content-type"]).toBe("text/plain");
    expect(res.body).toBe("invalid signature");
    await app.close();
  });

  it("missing signature header on /inbound returns 403 WITHOUT touching the DB", async () => {
    process.env.TWILIO_AUTH_TOKEN = "tok-X";
    _resetEnvCacheForTests();

    const db = makeThrowingDb();
    const { client } = makeFakeTwilio();
    const app = await buildApp({ twilio: { deps: { prisma: db, twilio: client } } });

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/twilio/inbound",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        From: "+15550009999",
        Body: "hello",
        MessageSid: "SM" + "z".repeat(32),
      }).toString(),
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("bad signature on /status returns 403 WITHOUT touching the DB", async () => {
    process.env.TWILIO_AUTH_TOKEN = "tok-X";
    _resetEnvCacheForTests();

    const db = makeThrowingDb();
    const { client } = makeFakeTwilio();
    const app = await buildApp({ twilio: { deps: { prisma: db, twilio: client } } });

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/twilio/status",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": "nope",
      },
      payload: new URLSearchParams({ MessageSid: "SMabc", MessageStatus: "delivered" }).toString(),
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers["content-type"]).toBe("text/plain");
    expect(res.body).toBe("invalid signature");
    await app.close();
  });
});

// ─── 3. Dev-mode escape hatch and production safety gate ────────────────

describe("routes contract — TWILIO_AUTH_TOKEN / TWILIO_REQUIRE_SIGNATURE matrix", () => {
  it("no auth token + REQUIRE_SIGNATURE=false → skip verify, accept any inbound", async () => {
    // Documents dev-mode behaviour: when neither var is set, the route
    // logs a warning and proceeds. This is what the local-dev story
    // depends on (no Twilio creds in your shell, but you can still
    // curl the webhook to test).
    process.env.TWILIO_AUTH_TOKEN = "";
    process.env.TWILIO_REQUIRE_SIGNATURE = "false";
    _resetEnvCacheForTests();

    const { db } = makeFakeDb();
    const { client, calls } = makeFakeTwilio();
    const app = await buildApp({ twilio: { deps: { prisma: db, twilio: client } } });

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/twilio/inbound",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        From: "+15550009999",
        Body: "hi",
        MessageSid: "SM" + "d".repeat(32),
      }).toString(),
    });
    expect(res.statusCode).toBe(200);
    expect(calls).toHaveLength(1); // we replied
    await app.close();
  });

  it("no auth token + REQUIRE_SIGNATURE=true → REJECT (production fail-closed)", async () => {
    // This is the gate that protects a misconfigured production
    // deploy: render.yaml sets TWILIO_REQUIRE_SIGNATURE=true so that
    // a missing TWILIO_AUTH_TOKEN secret rejects everything rather
    // than letting the world spoof inbounds. A refactor that flips
    // the boolean OR direction would silently disable this.
    process.env.TWILIO_AUTH_TOKEN = "";
    process.env.TWILIO_REQUIRE_SIGNATURE = "true";
    _resetEnvCacheForTests();

    const db = makeThrowingDb();
    const { client } = makeFakeTwilio();
    const app = await buildApp({ twilio: { deps: { prisma: db, twilio: client } } });

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/twilio/inbound",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        // Even sending a signature header doesn't help — we have no
        // token to verify with, so we MUST reject.
        "x-twilio-signature": "irrelevant",
      },
      payload: new URLSearchParams({
        From: "+15550009999",
        Body: "hi",
        MessageSid: "SM" + "g".repeat(32),
      }).toString(),
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

// ─── 4. Signature URL composition uses PUBLIC_WEBHOOK_BASE_URL ──────────

describe("routes contract — signature URL composition", () => {
  it("verifies against PUBLIC_WEBHOOK_BASE_URL + req.url, NOT req.host", async () => {
    // Behind a proxy (Render, Fly), Twilio signs the public URL but
    // Fastify's `req.host` reports the internal listener
    // (`localhost:80`). The route MUST use PUBLIC_WEBHOOK_BASE_URL to
    // compose the URL it verifies against. If a refactor switches to
    // `${req.protocol}://${req.hostname}${req.url}`, this test
    // (signature computed against the public base) will fail.
    process.env.TWILIO_AUTH_TOKEN = "tok-PROD";
    process.env.PUBLIC_WEBHOOK_BASE_URL = "https://prod.boba.app";
    _resetEnvCacheForTests();

    const params = {
      From: "+15550009999",
      Body: "hello",
      MessageSid: "SM" + "p".repeat(32),
    };
    // Sign against the PUBLIC URL (what Twilio sees), not against
    // `localhost:80/webhooks/...` (what Fastify's inject sees).
    const sig = computeTwilioSignature(
      "tok-PROD",
      "https://prod.boba.app/webhooks/twilio/inbound",
      params,
    );

    const { db } = makeFakeDb();
    const { client } = makeFakeTwilio();
    const app = await buildApp({ twilio: { deps: { prisma: db, twilio: client } } });

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/twilio/inbound",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": sig,
      },
      payload: new URLSearchParams(params).toString(),
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("trailing slash on PUBLIC_WEBHOOK_BASE_URL is normalised before signing", async () => {
    // Operators forget the slash convention; the route normalises it.
    // Pin so a "simplification" that drops the `.replace(/\/$/, "")`
    // surfaces as a signature mismatch on every prod inbound.
    process.env.TWILIO_AUTH_TOKEN = "tok-NORM";
    process.env.PUBLIC_WEBHOOK_BASE_URL = "https://prod.boba.app/"; // ← trailing slash
    _resetEnvCacheForTests();

    const params = {
      From: "+15550009999",
      Body: "hi",
      MessageSid: "SM" + "q".repeat(32),
    };
    const sig = computeTwilioSignature(
      "tok-NORM",
      "https://prod.boba.app/webhooks/twilio/inbound", // ← Twilio signs the canonical URL
      params,
    );

    const { db } = makeFakeDb();
    const { client } = makeFakeTwilio();
    const app = await buildApp({ twilio: { deps: { prisma: db, twilio: client } } });

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/twilio/inbound",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": sig,
      },
      payload: new URLSearchParams(params).toString(),
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

// ─── 5. STOP / HELP from unknown phone do not auto-provision ────────────

describe("routes contract — STOP/HELP from unknown phone does NOT auto-provision", () => {
  it("STOP from unknown phone replies with compliance copy and does NOT create a User row", async () => {
    // Wrong-number STOPs are a known SMS pattern; auto-provisioning
    // a User for every stranger who texts STOP would pollute the
    // table and inflate the carrier-perceived opt-out rate. HELP is
    // already pinned in routes.test.ts; STOP is the symmetric case.
    const { db, users } = makeFakeDb();
    const { client, calls } = makeFakeTwilio();
    const app = await buildApp({ twilio: { deps: { prisma: db, twilio: client } } });

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/twilio/inbound",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        From: "+15550009998",
        Body: "STOP",
        MessageSid: "SM" + "s".repeat(32),
      }).toString(),
    });
    expect(res.statusCode).toBe(200);
    expect(users).toEqual([]); // ← the contract: no row was created
    // STOP from a stranger gets the STOP_ACK reply (this is the
    // carrier-required "your number is opted out" message even
    // though we never had them opted in).
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toMatch(/opted out/i);
    await app.close();
  });

  it("a NON-keyword inbound from an unknown phone DOES auto-provision", async () => {
    // The negative half of the above contract: a normal "hi" from
    // a stranger goes through to onboarding. Pinned together because
    // it makes the STOP/HELP suppression's intent legible (we only
    // suppress those two keywords, not "all unknown senders").
    const { db, users } = makeFakeDb();
    const { client } = makeFakeTwilio();
    const app = await buildApp({ twilio: { deps: { prisma: db, twilio: client } } });

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/twilio/inbound",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        From: "+15550009996",
        Body: "hi",
        MessageSid: "SM" + "t".repeat(32),
      }).toString(),
    });
    expect(res.statusCode).toBe(200);
    expect(users).toHaveLength(1);
    expect(users[0]!.phone).toBe("+15550009996");
    expect(users[0]!.status).toBe("ONBOARDING");
    await app.close();
  });
});

// ─── 6. Invite-failure reply copy — exact bodies for all three reasons ──

describe("routes contract — invite-failure reply copy", () => {
  it("unknown_code: 'don't recognize that code' + ABCD-1234 example", async () => {
    // Behavioural file pins this branch with a /don't recognize/ regex.
    // Tightened here to the full exact body so a copy edit that
    // changes the example format (e.g. lowercase, or removes the
    // dash) surfaces against the literal.
    const { db, users } = makeFakeDb();
    users.push({
      id: "u_onb",
      phone: "+15550005010",
      displayName: null,
      status: "ONBOARDING",
      onboardingStep: "ask_invite_code",
    });
    const { client, calls } = makeFakeTwilio();
    const app = await buildApp({ twilio: { deps: { prisma: db, twilio: client } } });

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/twilio/inbound",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        From: "+15550005010",
        Body: "ZZZZ9999",
        MessageSid: "SM" + "u".repeat(32),
      }).toString(),
    });
    expect(res.statusCode).toBe(200);
    expect(calls[0]!.body).toBe(
      "We don't recognize that code. Double-check spelling — they look like ABCD-1234.",
    );
    await app.close();
  });

  it("already_redeemed: friendly 'Got another?' copy when someone else used it", async () => {
    // This branch is unpinned in routes.test.ts. The 'self_already_redeemed'
    // copy (next test) reads very differently — a copy edit that
    // accidentally swapped them would be ugly UX. Pinned literal.
    const { db, users, invites } = makeFakeDb();
    users.push({
      id: "u_onb",
      phone: "+15550005011",
      displayName: null,
      status: "ONBOARDING",
      onboardingStep: "ask_invite_code",
    });
    invites.push({
      id: "inv_used",
      // Crockford base32 alphabet only (no I, L, O, U) — see invites/code.ts.
      code: "REDX1234",
      redeemedById: "u_someone_else",
      redeemedAt: new Date(),
    });
    const { client, calls } = makeFakeTwilio();
    const app = await buildApp({ twilio: { deps: { prisma: db, twilio: client } } });

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/twilio/inbound",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        From: "+15550005011",
        Body: "REDX1234",
        MessageSid: "SM" + "v".repeat(32),
      }).toString(),
    });
    expect(res.statusCode).toBe(200);
    expect(calls[0]!.body).toBe(
      "That code has already been used by someone else. Got another?",
    );
    // Cursor stays on ask_invite_code (no redemption happened).
    expect(users.find((u) => u.id === "u_onb")!.onboardingStep).toBe("ask_invite_code");
    await app.close();
  });

  it("self_already_redeemed: gracefully moves on to ask_display_name", async () => {
    // The self-collision case happens when a user re-texts their own
    // code after already redeeming it during a previous session. The
    // copy promises forward motion ("we'll keep onboarding moving")
    // — pin literal so we don't accidentally regress to the
    // already_redeemed copy.
    const { db, users, invites } = makeFakeDb();
    users.push({
      id: "u_onb",
      phone: "+15550005012",
      displayName: null,
      status: "ONBOARDING",
      onboardingStep: "ask_invite_code",
    });
    // To trigger self_already_redeemed: the user has previously
    // redeemed some OTHER code, and now texts a fresh unredeemed code.
    // (Re-texting the same code they already own falls into the
    // happy path; see invites/prisma-deps.ts:32-50.)
    invites.push(
      {
        id: "inv_prev",
        code: "PRVX1234", // Crockford base32 (no I/L/O/U)
        redeemedById: "u_onb",
        redeemedAt: new Date(),
      },
      {
        id: "inv_self",
        code: "SAMX1234",
        redeemedById: null,
        redeemedAt: null,
      },
    );
    const { client, calls } = makeFakeTwilio();
    const app = await buildApp({ twilio: { deps: { prisma: db, twilio: client } } });

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/twilio/inbound",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        From: "+15550005012",
        Body: "SAMX1234",
        MessageSid: "SM" + "w".repeat(32),
      }).toString(),
    });
    expect(res.statusCode).toBe(200);
    expect(calls[0]!.body).toBe(
      "Looks like you've already redeemed an invite. We'll keep onboarding moving — what should we call you?",
    );
    await app.close();
  });
});
