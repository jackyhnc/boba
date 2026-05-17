import { describe, it, expect, vi } from "vitest";
import {
  runDailyMatch,
  type PhoneLookup,
} from "../../src/scheduler/runDailyMatch.js";
import type { MatchingPrisma } from "../../src/matching/prisma-deps.js";
import type { TwilioClient } from "../../src/twilio/client.js";

// ─── Test doubles ───────────────────────────────────────────────────────────

interface FakeUser {
  id: string;
  phone: string;
  status: "ACTIVE" | "ONBOARDING" | "PAUSED" | "BANNED";
  preferences: {
    minAge: number | null;
    maxAge: number | null;
    preferredGenders: ("WOMAN" | "MAN" | "NONBINARY" | "OTHER")[];
    minHeightCm: number | null;
    maxHeightCm: number | null;
    preferredProfessions: string[];
    typeDescriptor: string | null;
  } | null;
  stats: {
    age: number | null;
    gender: "WOMAN" | "MAN" | "NONBINARY" | "OTHER" | null;
    profession: string | null;
    heightCm: number | null;
  } | null;
  isAiBacked: boolean;
}

function makeFakeDb(opts: { users: FakeUser[] }): {
  db: MatchingPrisma & PhoneLookup;
  createdMatches: Array<{ userAId: string; userBId: string; matchDate: Date; compatibilityScore: number }>;
  rematchUpserts: { count: number };
} {
  const users = [...opts.users];
  const createdMatches: Array<{ userAId: string; userBId: string; matchDate: Date; compatibilityScore: number }> = [];
  const rematchUpserts = { count: 0 };

  const db = {
    user: {
      findMany: async (args: { where?: { status?: string; id?: { in: string[] } }; select?: { id?: true; phone?: true }; include?: unknown }) => {
        if (args.where?.id?.in) {
          return users
            .filter((u) => args.where!.id!.in.includes(u.id))
            .map((u) => ({ id: u.id, phone: u.phone }));
        }
        return users.filter((u) => u.status === "ACTIVE" && u.preferences && u.stats);
      },
    },
    dailyMatch: {
      findMany: async () => [],
      create: async ({ data }: { data: { userAId: string; userBId: string; matchDate: Date; compatibilityScore: number } }) => {
        createdMatches.push(data);
        return { id: `m_${createdMatches.length}` };
      },
    },
    rematchHistory: {
      findMany: async () => [],
      upsert: async () => {
        rematchUpserts.count += 1;
        return {};
      },
    },
    $transaction: (async (fn: (tx: unknown) => Promise<unknown>) => fn(db)) as unknown as MatchingPrisma["$transaction"],
  } as unknown as MatchingPrisma & PhoneLookup;

  return { db, createdMatches, rematchUpserts };
}

function makeFakeTwilio(): { client: TwilioClient; calls: Array<{ to: string; body: string }> } {
  const calls: Array<{ to: string; body: string }> = [];
  const client: TwilioClient = {
    sendSms: vi.fn(async ({ to, body }: { to: string; body: string }) => {
      calls.push({ to, body });
      return { sid: `SM_${calls.length}`, dryRun: false, status: 201 };
    }),
  };
  return { client, calls };
}

// ─── Specs ───────────────────────────────────────────────────────────────────

const TODAY = new Date("2026-05-17T12:00:00Z");

describe("runDailyMatch", () => {
  it("picks no matches with zero candidates", async () => {
    const fake = makeFakeDb({ users: [] });
    const { client, calls } = makeFakeTwilio();
    const result = await runDailyMatch({ prisma: fake.db, twilio: client, today: TODAY });
    expect(result.candidates).toBe(0);
    expect(result.selected).toHaveLength(0);
    expect(result.createdMatchIds).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("creates matches and notifies both sides for an obvious pairing", async () => {
    const fake = makeFakeDb({
      users: [
        {
          id: "u_w",
          phone: "+15550001001",
          status: "ACTIVE",
          isAiBacked: false,
          preferences: {
            minAge: 20,
            maxAge: 30,
            preferredGenders: ["MAN"],
            minHeightCm: null,
            maxHeightCm: null,
            preferredProfessions: [],
            typeDescriptor: null,
          },
          stats: { age: 24, gender: "WOMAN", profession: "designer", heightCm: 168 },
        },
        {
          id: "u_m",
          phone: "+15550001002",
          status: "ACTIVE",
          isAiBacked: false,
          preferences: {
            minAge: 20,
            maxAge: 30,
            preferredGenders: ["WOMAN"],
            minHeightCm: null,
            maxHeightCm: null,
            preferredProfessions: [],
            typeDescriptor: null,
          },
          stats: { age: 25, gender: "MAN", profession: "engineer", heightCm: 180 },
        },
      ],
    });
    const { client, calls } = makeFakeTwilio();
    const result = await runDailyMatch({ prisma: fake.db, twilio: client, today: TODAY });
    expect(result.selected).toHaveLength(1);
    expect(result.createdMatchIds).toHaveLength(1);
    expect(fake.createdMatches).toHaveLength(1);
    expect(fake.rematchUpserts.count).toBe(1);
    // Both users notified.
    const sortedTo = calls.map((c) => c.to).sort();
    expect(sortedTo).toEqual(["+15550001001", "+15550001002"]);
    // Bodies are the default notification.
    expect(calls[0]!.body).toMatch(/match for today/i);
  });

  it("records notify errors but doesn't crash", async () => {
    const fake = makeFakeDb({
      users: [
        {
          id: "u_w",
          phone: "+15550002001",
          status: "ACTIVE",
          isAiBacked: false,
          preferences: { minAge: 20, maxAge: 30, preferredGenders: ["MAN"], minHeightCm: null, maxHeightCm: null, preferredProfessions: [], typeDescriptor: null },
          stats: { age: 24, gender: "WOMAN", profession: null, heightCm: 168 },
        },
        {
          id: "u_m",
          phone: "+15550002002",
          status: "ACTIVE",
          isAiBacked: false,
          preferences: { minAge: 20, maxAge: 30, preferredGenders: ["WOMAN"], minHeightCm: null, maxHeightCm: null, preferredProfessions: [], typeDescriptor: null },
          stats: { age: 25, gender: "MAN", profession: null, heightCm: 180 },
        },
      ],
    });
    const flakyClient: TwilioClient = {
      sendSms: vi.fn(async ({ to }: { to: string }) => {
        if (to.endsWith("01")) throw new Error("carrier down");
        return { sid: "SM_ok", dryRun: false, status: 201 };
      }),
    };
    const result = await runDailyMatch({
      prisma: fake.db,
      twilio: flakyClient,
      today: TODAY,
    });
    expect(result.notifyErrors).toHaveLength(1);
    expect(result.notifyErrors[0]!.error).toMatch(/carrier down/);
    expect(result.notified).toHaveLength(1);
  });

  it("uses a custom notification body when provided", async () => {
    const fake = makeFakeDb({
      users: [
        {
          id: "u_w",
          phone: "+15550003001",
          status: "ACTIVE",
          isAiBacked: false,
          preferences: { minAge: 20, maxAge: 30, preferredGenders: ["MAN"], minHeightCm: null, maxHeightCm: null, preferredProfessions: [], typeDescriptor: null },
          stats: { age: 24, gender: "WOMAN", profession: null, heightCm: 168 },
        },
        {
          id: "u_m",
          phone: "+15550003002",
          status: "ACTIVE",
          isAiBacked: false,
          preferences: { minAge: 20, maxAge: 30, preferredGenders: ["WOMAN"], minHeightCm: null, maxHeightCm: null, preferredProfessions: [], typeDescriptor: null },
          stats: { age: 25, gender: "MAN", profession: null, heightCm: 180 },
        },
      ],
    });
    const { client, calls } = makeFakeTwilio();
    await runDailyMatch({
      prisma: fake.db,
      twilio: client,
      today: TODAY,
      notificationBody: "boba launch night — say hi 🧋",
    });
    expect(calls.every((c) => c.body === "boba launch night — say hi 🧋")).toBe(true);
  });
});
