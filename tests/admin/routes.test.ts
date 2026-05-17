import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import { _resetEnvCacheForTests } from "../../src/config/env.js";
import type { AdminPrisma } from "../../src/admin/prisma-deps.js";
import type { InvitePrisma } from "../../src/invites/index.js";
import type { MatchingPrisma } from "../../src/matching/prisma-deps.js";
import type { PhoneLookup } from "../../src/scheduler/index.js";
import type { TwilioClient } from "../../src/twilio/client.js";

// ─── Fakes ─────────────────────────────────────────────────────────────────

interface FakeUser {
  id: string;
  phone: string;
  displayName: string | null;
  status: "ACTIVE" | "ONBOARDING" | "PAUSED" | "BANNED";
  onboardingStep: string | null;
  reportCount: number;
  isAiBacked: boolean;
  createdAt: Date;
}

interface FakeInvite {
  id: string;
  code: string;
  label: string | null;
  redeemedById: string | null;
}

function makeFakeDb(opts: { users?: FakeUser[] } = {}): {
  db: AdminPrisma & InvitePrisma & MatchingPrisma & PhoneLookup;
  users: FakeUser[];
  invites: FakeInvite[];
} {
  const users = opts.users ? [...opts.users] : [];
  const invites: FakeInvite[] = [];
  const db = {
    user: {
      findMany: async ({ where, take, orderBy: _orderBy, cursor, skip: _skip }: { where?: { status?: string; id?: { in: string[] } }; take?: number; orderBy?: unknown; cursor?: { id: string }; skip?: number }) => {
        if (where?.id?.in) {
          return users
            .filter((u) => where.id!.in.includes(u.id))
            .map((u) => ({ id: u.id, phone: u.phone }));
        }
        let rows = users;
        if (where?.status) rows = rows.filter((u) => u.status === where.status);
        if (cursor) {
          const idx = rows.findIndex((r) => r.id === cursor.id);
          rows = idx >= 0 ? rows.slice(idx + 1) : [];
        }
        return rows.slice(0, take ?? rows.length);
      },
      findUnique: async ({ where }: { where: { id: string } }) => {
        const u = users.find((x) => x.id === where.id);
        return u ?? null;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const u = users.find((x) => x.id === where.id);
        if (!u) throw new Error("no user");
        for (const [k, v] of Object.entries(data)) {
          (u as unknown as Record<string, unknown>)[k] = v;
        }
        return u;
      },
    },
    dailyMatch: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        if (where.id !== "m_demo") return null;
        const a = users[0]!;
        const b = users[1]!;
        return {
          id: "m_demo",
          matchDate: new Date("2026-05-17"),
          state: "ACTIVE",
          compatibilityScore: 0.8,
          userA: { id: a.id, phone: a.phone, displayName: a.displayName },
          userB: { id: b.id, phone: b.phone, displayName: b.displayName },
        };
      },
      findMany: async () => [],
      create: async () => ({ id: "m_new" }),
    },
    message: {
      findMany: async () => [
        {
          id: "msg_1",
          senderId: users[0]?.id ?? "u",
          direction: "INBOUND",
          body: "hey",
          depthScore: 0.4,
          flaggedStatFishing: false,
          flaggedHarassment: false,
          createdAt: new Date(),
        },
      ],
    },
    inviteCode: {
      findUnique: async () => null,
      findFirst: async () => null,
      update: async () => ({}),
      count: async () => invites.filter((i) => i.redeemedById === null).length,
      create: async ({ data }: { data: { code: string; label: string | null } }) => {
        const row: FakeInvite = {
          id: `i_${invites.length + 1}`,
          code: data.code,
          label: data.label,
          redeemedById: null,
        };
        invites.push(row);
        return { id: row.id, code: row.code };
      },
    },
    rematchHistory: { findMany: async () => [], upsert: async () => ({}) },
    $transaction: (async <T>(fn: (tx: unknown) => Promise<T>) => fn(db)) as never,
  } as unknown as AdminPrisma & InvitePrisma & MatchingPrisma & PhoneLookup;
  return { db, users, invites };
}

function dryTwilio(): TwilioClient {
  return {
    sendSms: vi.fn(async () => ({ sid: "SM", dryRun: true, status: 200 })),
  };
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  _resetEnvCacheForTests();
  process.env.NODE_ENV = "test";
  process.env.LOG_LEVEL = "fatal";
  process.env.TWILIO_DRY_RUN = "true";
  process.env.ADMIN_TOKEN = "secret-token";
  process.env.SCHEDULER_ENABLED = "false";
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  _resetEnvCacheForTests();
});

// ─── Specs ─────────────────────────────────────────────────────────────────

describe("admin/routes — auth gate", () => {
  it("returns 401 without the header", async () => {
    const { db } = makeFakeDb();
    const app = await buildApp({
      admin: { deps: { prisma: db } },
      scheduler: { prisma: db, twilio: dryTwilio(), autoStart: false },
    });
    const res = await app.inject({ method: "GET", url: "/admin/users" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("returns 503 when ADMIN_TOKEN is empty", async () => {
    process.env.ADMIN_TOKEN = "";
    const { db } = makeFakeDb();
    const app = await buildApp({
      admin: { deps: { prisma: db } },
      scheduler: { prisma: db, twilio: dryTwilio(), autoStart: false },
    });
    const res = await app.inject({
      method: "GET",
      url: "/admin/users",
      headers: { "x-admin-token": "anything" },
    });
    expect(res.statusCode).toBe(503);
    await app.close();
  });
});

describe("admin/routes — operations", () => {
  it("lists users with pagination cursor", async () => {
    const seed: FakeUser[] = Array.from({ length: 3 }, (_, i) => ({
      id: `u_${i + 1}`,
      phone: `+155500000${i + 1}`,
      displayName: `User ${i + 1}`,
      status: "ACTIVE",
      onboardingStep: null,
      reportCount: 0,
      isAiBacked: false,
      createdAt: new Date(),
    }));
    const { db } = makeFakeDb({ users: seed });
    const app = await buildApp({
      admin: { deps: { prisma: db } },
      scheduler: { prisma: db, twilio: dryTwilio(), autoStart: false },
    });
    const res = await app.inject({
      method: "GET",
      url: "/admin/users?limit=2",
      headers: { "x-admin-token": "secret-token" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { users: FakeUser[]; nextCursor: string | null };
    expect(body.users).toHaveLength(2);
    expect(body.nextCursor).toBe("u_2");
    await app.close();
  });

  it("returns 404 for an unknown match", async () => {
    const { db } = makeFakeDb();
    const app = await buildApp({
      admin: { deps: { prisma: db } },
      scheduler: { prisma: db, twilio: dryTwilio(), autoStart: false },
    });
    const res = await app.inject({
      method: "GET",
      url: "/admin/match/nope",
      headers: { "x-admin-token": "secret-token" },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("returns a conversation view for a known match", async () => {
    const seed: FakeUser[] = [
      { id: "u_a", phone: "+1", displayName: "A", status: "ACTIVE", onboardingStep: null, reportCount: 0, isAiBacked: false, createdAt: new Date() },
      { id: "u_b", phone: "+2", displayName: "B", status: "ACTIVE", onboardingStep: null, reportCount: 0, isAiBacked: false, createdAt: new Date() },
    ];
    const { db } = makeFakeDb({ users: seed });
    const app = await buildApp({
      admin: { deps: { prisma: db } },
      scheduler: { prisma: db, twilio: dryTwilio(), autoStart: false },
    });
    const res = await app.inject({
      method: "GET",
      url: "/admin/match/m_demo",
      headers: { "x-admin-token": "secret-token" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { match: { id: string }; messages: unknown[] };
    expect(body.match.id).toBe("m_demo");
    expect(body.messages).toHaveLength(1);
    await app.close();
  });

  it("bans and unbans a user", async () => {
    const seed: FakeUser[] = [
      { id: "u_x", phone: "+9", displayName: null, status: "ACTIVE", onboardingStep: null, reportCount: 0, isAiBacked: false, createdAt: new Date() },
    ];
    const { db, users } = makeFakeDb({ users: seed });
    const app = await buildApp({
      admin: { deps: { prisma: db } },
      scheduler: { prisma: db, twilio: dryTwilio(), autoStart: false },
    });
    const banRes = await app.inject({
      method: "POST",
      url: "/admin/users/u_x/ban",
      headers: { "x-admin-token": "secret-token" },
    });
    expect(banRes.statusCode).toBe(200);
    expect(users[0]!.status).toBe("BANNED");
    const unbanRes = await app.inject({
      method: "POST",
      url: "/admin/users/u_x/unban",
      headers: { "x-admin-token": "secret-token" },
    });
    expect(unbanRes.statusCode).toBe(200);
    expect(users[0]!.status).toBe("ACTIVE");
    await app.close();
  });

  it("404s ban for unknown user", async () => {
    const { db } = makeFakeDb();
    const app = await buildApp({
      admin: { deps: { prisma: db } },
      scheduler: { prisma: db, twilio: dryTwilio(), autoStart: false },
    });
    const res = await app.inject({
      method: "POST",
      url: "/admin/users/nope/ban",
      headers: { "x-admin-token": "secret-token" },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("triggers a daily-match run on demand", async () => {
    const { db } = makeFakeDb();
    const app = await buildApp({
      admin: { deps: { prisma: db } },
      scheduler: { prisma: db, twilio: dryTwilio(), autoStart: false },
    });
    const res = await app.inject({
      method: "POST",
      url: "/admin/run-daily-match",
      headers: { "x-admin-token": "secret-token" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { candidates: number; selectedCount: number };
    expect(body.candidates).toBe(0);
    expect(body.selectedCount).toBe(0);
    await app.close();
  });

  it("bulk-creates invite codes", async () => {
    const { db, invites } = makeFakeDb();
    const app = await buildApp({
      admin: { deps: { prisma: db } },
      scheduler: { prisma: db, twilio: dryTwilio(), autoStart: false },
    });
    const res = await app.inject({
      method: "POST",
      url: "/admin/invites/bulk",
      headers: {
        "x-admin-token": "secret-token",
        "content-type": "application/json",
      },
      payload: JSON.stringify({ count: 3, label: "launch" }),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { codes: { code: string }[]; unredeemed: number };
    expect(body.codes).toHaveLength(3);
    expect(body.unredeemed).toBe(3);
    expect(invites).toHaveLength(3);
    await app.close();
  });
});
