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
  smsOptedOut?: boolean;
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

interface FakeInvite {
  id: string;
  code: string;
  redeemedById: string | null;
  redeemedAt: Date | null;
}

function makeFakeDb(): {
  db: TwilioPrisma;
  users: FakeUser[];
  matches: FakeMatch[];
  invites: FakeInvite[];
  insertedMessages: Array<{ matchId: string; senderId: string; direction: string; body: string; depthScore?: number; twilioSid: string | null }>;
  upsertedMilestones: Array<{ matchId: string; milestone: string }>;
} {
  const users: FakeUser[] = [];
  const matches: FakeMatch[] = [];
  const invites: FakeInvite[] = [];
  const insertedMessages: Array<{ matchId: string; senderId: string; direction: string; body: string; depthScore?: number; twilioSid: string | null }> = [];
  const upsertedMilestones: Array<{ matchId: string; milestone: string }> = [];

  const db = {
    user: {
      findUnique: async ({ where, select }: { where: { phone?: string; id?: string }; select?: { stats?: unknown; smsOptedOut?: boolean } }) => {
        const u = users.find(
          (x) => (where.phone && x.phone === where.phone) || (where.id && x.id === where.id),
        );
        if (!u) return null;
        if (select?.stats) {
          return { stats: u.stats ?? null };
        }
        // Narrow select for the `isSmsOptedOut` helper.
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
        return { ...u, reportCount: (rec.reportCount as number) ?? 0, status: u.status };
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
        return {
          id,
          phone: u.phone,
          displayName: null,
          status: u.status,
          onboardingStep: null,
          smsOptedOut: false,
        };
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
    report: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        return { id: `r_${(data as { reporterId: string }).reporterId}_${Date.now()}` };
      },
    },
    inviteCode: {
      findUnique: async ({ where }: { where: { code: string } }) => {
        const row = invites.find((i) => i.code === where.code);
        if (!row) return null;
        return { id: row.id, redeemedById: row.redeemedById };
      },
      findFirst: async ({ where }: { where: { redeemedById: string } }) => {
        const row = invites.find((i) => i.redeemedById === where.redeemedById);
        return row ? { id: row.id, code: row.code } : null;
      },
      update: async ({ where, data }: { where: { id: string }; data: { redeemedById: string; redeemedAt: Date } }) => {
        const row = invites.find((i) => i.id === where.id);
        if (!row) throw new Error(`no invite ${where.id}`);
        row.redeemedById = data.redeemedById;
        row.redeemedAt = data.redeemedAt;
        return row;
      },
    },
    $transaction: async <T,>(fn: (tx: unknown) => Promise<T>) => fn(db),
  } as unknown as TwilioPrisma;

  return { db, users, matches, invites, insertedMessages, upsertedMilestones };
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
  it("auto-provisions an unknown phone into ONBOARDING and welcomes them", async () => {
    const { db, users } = makeFakeDb();
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
    // The user was auto-created and is now ONBOARDING at ask_invite_code.
    expect(users).toHaveLength(1);
    expect(users[0]!.phone).toBe("+15550009999");
    expect(users[0]!.status).toBe("ONBOARDING");
    expect(users[0]!.onboardingStep).toBe("ask_invite_code");
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

  it("redeems an invite code during onboarding and advances to ask_display_name", async () => {
    const { db, users, invites } = makeFakeDb();
    users.push({
      id: "u_onb",
      phone: "+15550005001",
      displayName: null,
      status: "ONBOARDING",
      onboardingStep: "ask_invite_code",
    });
    invites.push({
      id: "inv_1",
      code: "ABCD1234",
      redeemedById: null,
      redeemedAt: null,
    });
    const { client, calls } = makeFakeTwilio();
    const app = await buildApp({ twilio: { deps: { prisma: db, twilio: client } } });

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/twilio/inbound",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        From: "+15550005001",
        Body: "abcd-1234",
        MessageSid: "SM" + "i".repeat(32),
      }).toString(),
    });
    expect(res.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toMatch(/what should we call you/i);
    const u = users.find((x) => x.id === "u_onb")!;
    expect(u.onboardingStep).toBe("ask_display_name");
    expect(invites[0]!.redeemedById).toBe("u_onb");
    await app.close();
  });

  it("rejects a bad invite code and keeps cursor on ask_invite_code", async () => {
    const { db, users } = makeFakeDb();
    users.push({
      id: "u_onb",
      phone: "+15550005002",
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
        From: "+15550005002",
        Body: "ZZZZ9999", // well-formed alphabet, but no row matches.
        MessageSid: "SM" + "x".repeat(32),
      }).toString(),
    });
    expect(res.statusCode).toBe(200);
    expect(calls[0]!.body).toMatch(/don't recognize that code/);
    expect(users.find((x) => x.id === "u_onb")!.onboardingStep).toBe(
      "ask_invite_code",
    );
    await app.close();
  });

  it("REPORT keyword acks and increments partner's report count", async () => {
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
        Body: "REPORT harassment: keeps sending nudes",
        MessageSid: "SM" + "r".repeat(32),
      }).toString(),
    });
    expect(res.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.to).toBe("+15550000001");
    expect(calls[0]!.body).toMatch(/logged it/i);
    const bob = users.find((u) => u.id === "u_bob")! as unknown as { reportCount?: number };
    expect(bob.reportCount).toBe(1);
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
    expect(calls[0]!.body).toMatch(/invite code/);
    // After the welcome the user's cursor is at ask_invite_code (invites required).
    const onb = users.find((u) => u.id === "u_onb")!;
    expect(onb.onboardingStep).toBe("ask_invite_code");
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

  it("STOP from an existing user flips smsOptedOut and sends only the compliance ack", async () => {
    const { db, users, insertedMessages } = makeFakeDb();
    users.push({
      id: "u_alice",
      phone: "+15550000001",
      displayName: "Alice",
      status: "ACTIVE",
      onboardingStep: null,
      smsOptedOut: false,
    });
    const { client, calls } = makeFakeTwilio();
    const app = await buildApp({ twilio: { deps: { prisma: db, twilio: client } } });

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/twilio/inbound",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        From: "+15550000001",
        Body: "STOP",
        MessageSid: "SM" + "s".repeat(32),
      }).toString(),
    });

    expect(res.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.to).toBe("+15550000001");
    expect(calls[0]!.body).toMatch(/opted out/i);
    expect(users[0]!.smsOptedOut).toBe(true);
    // No match message persisted for a meta-protocol STOP.
    expect(insertedMessages).toEqual([]);
    await app.close();
  });

  it("an opted-out recipient gets no relayed messages from their match partner", async () => {
    const { db, users, matches, insertedMessages } = makeFakeDb();
    users.push(
      {
        id: "u_alice",
        phone: "+15550000001",
        displayName: "Alice",
        status: "ACTIVE",
        onboardingStep: null,
        smsOptedOut: false,
      },
      {
        id: "u_bob",
        phone: "+15550000002",
        displayName: "Bob",
        status: "ACTIVE",
        onboardingStep: null,
        smsOptedOut: true, // bob has STOPped — no more SMS to him
      },
    );
    matches.push({
      id: "m_stop",
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
        Body: "hi bob, how's your day going?",
        MessageSid: "SM" + "x".repeat(32),
      }).toString(),
    });

    expect(res.statusCode).toBe(200);
    // Alice's inbound was persisted for the match, but no outbound to Bob.
    expect(calls).toHaveLength(0);
    expect(insertedMessages.some((m) => m.senderId === "u_alice")).toBe(true);
    await app.close();
  });

  it("HELP from an unknown number replies with compliance copy but does not auto-provision an account", async () => {
    const { db, users } = makeFakeDb();
    const { client, calls } = makeFakeTwilio();
    const app = await buildApp({ twilio: { deps: { prisma: db, twilio: client } } });

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/twilio/inbound",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        From: "+15550009999",
        Body: "HELP",
        MessageSid: "SM" + "h".repeat(32),
      }).toString(),
    });

    expect(res.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toMatch(/msg.*data rates/i);
    expect(users).toEqual([]); // no account created
    await app.close();
  });

  it("START from an opted-out user re-enables sending", async () => {
    const { db, users } = makeFakeDb();
    users.push({
      id: "u_alice",
      phone: "+15550000001",
      displayName: "Alice",
      status: "ACTIVE",
      onboardingStep: null,
      smsOptedOut: true,
    });
    const { client, calls } = makeFakeTwilio();
    const app = await buildApp({ twilio: { deps: { prisma: db, twilio: client } } });

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/twilio/inbound",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        From: "+15550000001",
        Body: "START",
        MessageSid: "SM" + "r".repeat(32),
      }).toString(),
    });

    expect(res.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toMatch(/opted back in/i);
    expect(users[0]!.smsOptedOut).toBe(false);
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
