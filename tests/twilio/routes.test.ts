import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import { computeTwilioSignature } from "../../src/twilio/signature.js";
import { _resetEnvCacheForTests } from "../../src/config/env.js";
import type { TwilioClient } from "../../src/twilio/client.js";
import type { TwilioPrisma } from "../../src/twilio/prisma-deps.js";

// ─── In-memory Prisma stub ──────────────────────────────────────────────────
//
// We mock just enough surface that the routes layer's calls land somewhere
// observable. The conversation/route logic itself is exercised in
// conversation.test.ts.

interface FakeUser {
  id: string;
  phone: string;
  displayName: string | null;
  status: "ACTIVE" | "ONBOARDING" | "PAUSED" | "BANNED";
  onboardingStep: string | null;
  stats?: { age: number | null; profession: string | null; heightCm: number | null };
}

interface FakeMatch {
  id: string;
  userAId: string;
  userBId: string;
  state: "ACTIVE" | "AWAITING_DECISION" | "CONTINUED" | "ENDED_BY_DISCARD" | "EXPIRED";
  matchDate: Date;
  messages: Array<{ senderId: string; body: string; depthScore: number; createdAt: Date }>;
  milestones: Array<{ milestone: "AGE" | "PROFESSION" | "HEIGHT" | "FACE" }>;
}

function makeFakeDb(): {
  db: TwilioPrisma;
  users: FakeUser[];
  matches: FakeMatch[];
  insertedMessages: Array<{ matchId: string; senderId: string; direction: string; body: string; depthScore?: number; twilioSid: string | null }>;
  upsertedMilestones: Array<{ matchId: string; milestone: string }>;
} {
  const users: FakeUser[] = [];
  const matches: FakeMatch[] = [];
  const insertedMessages: Array<{ matchId: string; senderId: string; direction: string; body: string; depthScore?: number; twilioSid: string | null }> = [];
  const upsertedMilestones: Array<{ matchId: string; milestone: string }> = [];

  const db = {
    user: {
      findUnique: async ({ where, select }: { where: { phone?: string; id?: string }; select?: { stats?: unknown } }) => {
        const u = users.find(
          (x) => (where.phone && x.phone === where.phone) || (where.id && x.id === where.id),
        );
        if (!u) return null;
        if (select?.stats) {
          return { stats: u.stats ?? null };
        }
        return {
          id: u.id,
          phone: u.phone,
          displayName: u.displayName,
          status: u.status,
          onboardingStep: u.onboardingStep,
        };
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const u = users.find((x) => x.id === where.id);
        if (!u) throw new Error(`no user ${where.id}`);
        for (const [k, v] of Object.entries(data)) {
          (u as unknown as Record<string, unknown>)[k] = v;
        }
        return u;
      },
    },
    stats: {
      upsert: async ({ where, create, update }: { where: { userId: string }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
        const u = users.find((x) => x.id === where.userId);
        if (!u) throw new Error(`no user ${where.userId}`);
        // Track minimal stats fields used by the test view of FakeUser.
        const base = (u.stats ?? { age: null, profession: null, heightCm: null }) as Record<string, unknown>;
        if (!u.stats) {
          u.stats = { age: null, profession: null, heightCm: null };
        }
        for (const [k, v] of Object.entries({ ...create, ...update })) {
          if (k === "age" || k === "profession" || k === "heightCm") {
            (u.stats as Record<string, unknown>)[k] = v as never;
          }
        }
        return { ...base };
      },
    },
    preferences: {
      upsert: async () => ({}),
    },
    dailyMatch: {
      findFirst: async ({ where }: { where: { state: string; OR: Array<{ userAId?: string; userBId?: string }> } }) => {
        const targetUserId =
          where.OR[0]?.userAId ?? where.OR[1]?.userBId ?? where.OR[0]?.userBId ?? "";
        const m = matches.find(
          (mm) =>
            mm.state === where.state &&
            (mm.userAId === targetUserId || mm.userBId === targetUserId),
        );
        if (!m) return null;
        const userA = users.find((u) => u.id === m.userAId)!;
        const userB = users.find((u) => u.id === m.userBId)!;
        return {
          id: m.id,
          userAId: m.userAId,
          userBId: m.userBId,
          userA: { id: userA.id, phone: userA.phone },
          userB: { id: userB.id, phone: userB.phone },
          messages: m.messages.map((msg) => ({
            senderId: msg.senderId,
            body: msg.body,
            depthScore: msg.depthScore,
          })),
          milestones: m.milestones.map((mi) => ({ milestone: mi.milestone })),
        };
      },
      findUnique: async ({ where }: { where: { id: string } }) => {
        const m = matches.find((mm) => mm.id === where.id);
        if (!m) return null;
        const decisions = (m as unknown as { decisions?: Array<{ userId: string; decision: string }> }).decisions ?? [];
        return {
          id: m.id,
          userAId: m.userAId,
          userBId: m.userBId,
          matchDate: m.matchDate,
          state: m.state,
          compatibilityScore: 0.5,
          decisions: [...decisions],
        };
      },
      update: async ({ where, data }: { where: { id: string }; data: { state?: FakeMatch["state"] } }) => {
        const m = matches.find((mm) => mm.id === where.id);
        if (m && data.state) m.state = data.state;
        return m as never;
      },
      create: async ({ data }: { data: { userAId: string; userBId: string; matchDate: Date; state: FakeMatch["state"]; compatibilityScore: number; parentMatchId?: string | null } }) => {
        const id = `m_new_${matches.length + 1}`;
        matches.push({
          id,
          userAId: data.userAId,
          userBId: data.userBId,
          state: data.state,
          matchDate: data.matchDate,
          messages: [],
          milestones: [],
        });
        return { id };
      },
    },
    message: {
      create: async ({ data }: { data: { matchId: string; senderId: string; direction: string; body: string; depthScore?: number; twilioSid: string | null } }) => {
        const id = `msg_${insertedMessages.length + 1}`;
        insertedMessages.push({
          matchId: data.matchId,
          senderId: data.senderId,
          direction: data.direction,
          body: data.body,
          depthScore: data.depthScore,
          twilioSid: data.twilioSid,
        });
        return { id };
      },
      findUnique: async ({ where }: { where: { twilioSid: string } }) => {
        const found = insertedMessages.find((m) => m.twilioSid === where.twilioSid);
        return found ? { id: "msg" } : null;
      },
    },
    milestoneProgress: {
      upsert: async ({
        where,
      }: {
        where: { matchId_milestone: { matchId: string; milestone: string } };
      }) => {
        upsertedMilestones.push(where.matchId_milestone);
        return { id: "m_p", matchId: where.matchId_milestone.matchId, milestone: where.matchId_milestone.milestone, unlockedAt: new Date() };
      },
      findMany: async () => [],
    },
    endOfDayDecision: {
      upsert: async ({ where, create }: { where: { matchId_userId: { matchId: string; userId: string } }; create: { decision: string } }) => {
        // We piggyback on the existing match's `decisions` array (added below).
        const m = matches.find((mm) => mm.id === where.matchId_userId.matchId);
        if (m) {
          const dec = (m as unknown as { decisions?: Array<{ userId: string; decision: string }> }).decisions ?? [];
          const idx = dec.findIndex((d) => d.userId === where.matchId_userId.userId);
          if (idx >= 0) dec[idx]!.decision = create.decision;
          else dec.push({ userId: where.matchId_userId.userId, decision: create.decision });
          (m as unknown as { decisions: typeof dec }).decisions = dec;
        }
        return {};
      },
    },
    rematchHistory: {
      upsert: async () => ({}),
    },
    $transaction: async <T,>(fn: (tx: unknown) => Promise<T>) => fn(db),
  } as unknown as TwilioPrisma;

  return { db, users, matches, insertedMessages, upsertedMilestones };
}

function makeFakeTwilio(): { client: TwilioClient; calls: Array<{ to: string; body: string }> } {
  const calls: Array<{ to: string; body: string }> = [];
  const client: TwilioClient = {
    sendSms: vi.fn(async ({ to, body }) => {
      calls.push({ to, body });
      return { sid: `SM_${calls.length}`, dryRun: false, status: 201 };
    }),
  };
  return { client, calls };
}

// Snapshot env vars so tests can mutate them safely.
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  _resetEnvCacheForTests();
  // Default test env — dry-run on, signature relaxed.
  process.env.NODE_ENV = "test";
  process.env.LOG_LEVEL = "fatal";
  process.env.TWILIO_DRY_RUN = "true";
  process.env.TWILIO_AUTH_TOKEN = "";
  process.env.TWILIO_REQUIRE_SIGNATURE = "false";
  process.env.PUBLIC_WEBHOOK_BASE_URL = "https://boba.test";
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  _resetEnvCacheForTests();
});

describe("POST /webhooks/twilio/inbound", () => {
  it("replies with empty TwiML and intro for an unknown phone", async () => {
    const { db } = makeFakeDb();
    const { client, calls } = makeFakeTwilio();
    const app = await buildApp({ twilio: { deps: { prisma: db, twilio: client } } });

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/twilio/inbound",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        From: "+15550009999",
        Body: "hi who is this?",
        MessageSid: "SM" + "z".repeat(32),
      }).toString(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/xml");
    expect(res.body).toContain("<Response></Response>");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.to).toBe("+15550009999");
    expect(calls[0]!.body).toMatch(/Boba/i);
    await app.close();
  });

  it("relays inbound from ACTIVE user with a live match", async () => {
    const { db, users, matches, insertedMessages, upsertedMilestones } = makeFakeDb();
    users.push(
      { id: "u_alice", phone: "+15550000001", displayName: "Alice", status: "ACTIVE", onboardingStep: null, stats: { age: 22, profession: "physics", heightCm: 170 } },
      { id: "u_bob", phone: "+15550000002", displayName: "Bob", status: "ACTIVE", onboardingStep: null, stats: { age: 24, profession: "designer", heightCm: 180 } },
    );
    matches.push({
      id: "m_today",
      userAId: "u_alice",
      userBId: "u_bob",
      state: "ACTIVE",
      matchDate: new Date(),
      messages: [],
      milestones: [],
    });

    const { client, calls } = makeFakeTwilio();
    const app = await buildApp({ twilio: { deps: { prisma: db, twilio: client } } });

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/twilio/inbound",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        From: "+15550000001",
        Body: "hey, how's your day going?",
        MessageSid: "SM" + "a".repeat(32),
      }).toString(),
    });
    expect(res.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.to).toBe("+15550000002"); // relayed to Bob
    expect(calls[0]!.body).toBe("hey, how's your day going?");

    // Inbound + outbound persisted, in that order.
    expect(insertedMessages).toHaveLength(2);
    expect(insertedMessages[0]).toMatchObject({
      matchId: "m_today",
      senderId: "u_alice",
      direction: "INBOUND",
      twilioSid: "SM" + "a".repeat(32),
    });
    expect(insertedMessages[1]).toMatchObject({
      matchId: "m_today",
      senderId: "u_alice", // relay attributed to originating user
      direction: "OUTBOUND",
    });
    expect(upsertedMilestones).toEqual([]);
    await app.close();
  });

  it("DISCARD keyword ends the match and emits announcements to both users", async () => {
    const { db, users, matches } = makeFakeDb();
    users.push(
      { id: "u_alice", phone: "+15550000001", displayName: "Alice", status: "ACTIVE", onboardingStep: null },
      { id: "u_bob", phone: "+15550000002", displayName: "Bob", status: "ACTIVE", onboardingStep: null },
    );
    matches.push({
      id: "m_today",
      userAId: "u_alice",
      userBId: "u_bob",
      state: "ACTIVE",
      matchDate: new Date(),
      messages: [],
      milestones: [],
    });

    const { client, calls } = makeFakeTwilio();
    const app = await buildApp({ twilio: { deps: { prisma: db, twilio: client } } });

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/twilio/inbound",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        From: "+15550000001",
        Body: "DISCARD",
        MessageSid: "SM" + "d".repeat(32),
      }).toString(),
    });
    expect(res.statusCode).toBe(200);
    // 1 ack to alice + 1 announcement to bob + 1 final announcement to alice.
    expect(calls).toHaveLength(3);
    const recipients = calls.map((c) => c.to).sort();
    expect(recipients).toEqual(["+15550000001", "+15550000001", "+15550000002"]);
    expect(matches[0]!.state).toBe("ENDED_BY_DISCARD");
    await app.close();
  });

  it("does not relay for ONBOARDING users (no active match assumed)", async () => {
    const { db, users, insertedMessages } = makeFakeDb();
    users.push({
      id: "u_onb",
      phone: "+15550001001",
      displayName: null,
      status: "ONBOARDING",
      onboardingStep: null,
    });
    const { client, calls } = makeFakeTwilio();
    const app = await buildApp({ twilio: { deps: { prisma: db, twilio: client } } });

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/twilio/inbound",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        From: "+15550001001",
        Body: "ready",
        MessageSid: "SM" + "b".repeat(32),
      }).toString(),
    });
    expect(res.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.to).toBe("+15550001001");
    expect(calls[0]!.body).toMatch(/Welcome to Boba/);
    // After the welcome the user's cursor is at ask_display_name.
    const onb = users.find((u) => u.id === "u_onb")!;
    expect(onb.onboardingStep).toBe("ask_display_name");
    expect(insertedMessages).toEqual([]);
    await app.close();
  });

  it("returns 400 when From or Body is missing", async () => {
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
    await app.close();
  });

  it("rejects an unsigned request when auth token is set", async () => {
    process.env.TWILIO_AUTH_TOKEN = "tok-A";
    _resetEnvCacheForTests();

    const { db } = makeFakeDb();
    const { client } = makeFakeTwilio();
    const app = await buildApp({ twilio: { deps: { prisma: db, twilio: client } } });

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/twilio/inbound",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        From: "+15550000001",
        Body: "hi",
      }).toString(),
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("accepts a properly signed request when auth token is set", async () => {
    process.env.TWILIO_AUTH_TOKEN = "tok-B";
    _resetEnvCacheForTests();

    const params = { From: "+15550009999", Body: "hi", MessageSid: "SM" + "c".repeat(32) };
    const url = "https://boba.test/webhooks/twilio/inbound";
    const sig = computeTwilioSignature("tok-B", url, params);

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

describe("POST /webhooks/twilio/status", () => {
  it("returns 204 for a known sid", async () => {
    const { db, insertedMessages } = makeFakeDb();
    insertedMessages.push({
      matchId: "m1",
      senderId: "u1",
      direction: "OUTBOUND",
      body: "hi",
      twilioSid: "SMabc",
    });
    const { client } = makeFakeTwilio();
    const app = await buildApp({ twilio: { deps: { prisma: db, twilio: client } } });
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/twilio/status",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ MessageSid: "SMabc", MessageStatus: "delivered" }).toString(),
    });
    expect(res.statusCode).toBe(204);
    await app.close();
  });

  it("returns 400 when sid missing", async () => {
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
    await app.close();
  });
});
