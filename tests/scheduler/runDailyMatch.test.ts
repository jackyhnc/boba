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

  it("skips a stranded user (phone row vanished between persist and lookup) without crashing or recording a notify error", async () => {
    // Both users are ACTIVE candidates, so they get matched and the row is
    // persisted. But the second-stage phone lookup only returns ONE of them —
    // simulating the race where the user's row was deleted between
    // persistDailyMatches and the findMany. The contract from
    // src/scheduler/runDailyMatch.ts:88-94 is: log + skip the stranded side,
    // notify the survivor, and never count "no phone" as a notify error.
    const baseUsers: FakeUser[] = [
      {
        id: "u_w",
        phone: "+15550004001",
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
        stats: { age: 24, gender: "WOMAN", profession: null, heightCm: 168 },
      },
      {
        id: "u_m",
        phone: "+15550004002",
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
        stats: { age: 25, gender: "MAN", profession: null, heightCm: 180 },
      },
    ];

    const createdMatches: Array<{ userAId: string; userBId: string }> = [];
    const db = {
      user: {
        findMany: async (args: {
          where?: { status?: string; id?: { in: string[] } };
        }) => {
          if (args.where?.id?.in) {
            // Phone lookup — return only u_m (u_w stranded).
            return baseUsers
              .filter(
                (u) => args.where!.id!.in.includes(u.id) && u.id !== "u_w",
              )
              .map((u) => ({ id: u.id, phone: u.phone }));
          }
          return baseUsers;
        },
      },
      dailyMatch: {
        findMany: async () => [],
        create: async ({
          data,
        }: {
          data: { userAId: string; userBId: string };
        }) => {
          createdMatches.push({ userAId: data.userAId, userBId: data.userBId });
          return { id: `m_${createdMatches.length}` };
        },
      },
      rematchHistory: {
        findMany: async () => [],
        upsert: async () => ({}),
      },
      $transaction: (async (fn: (tx: unknown) => Promise<unknown>) =>
        fn(db)) as unknown as MatchingPrisma["$transaction"],
    } as unknown as MatchingPrisma & PhoneLookup;

    const { client, calls } = makeFakeTwilio();
    const result = await runDailyMatch({
      prisma: db,
      twilio: client,
      today: TODAY,
    });

    // Match was persisted before the stranded lookup, so it survives.
    expect(result.selected).toHaveLength(1);
    expect(result.createdMatchIds).toHaveLength(1);
    expect(createdMatches).toHaveLength(1);

    // Only the surviving user is notified.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.to).toBe("+15550004002");
    expect(result.notified).toEqual(["+15550004002"]);

    // Stranded side is NOT a notify error — it's a silent skip.
    expect(result.notifyErrors).toEqual([]);
  });

  it("keeps persisted matches in the result even when every notify throws (persist-before-notify durability)", async () => {
    // Twilio is totally down. Both notifications throw. The match must still
    // be persisted and surface in createdMatchIds, and both failures must
    // land in notifyErrors. This pins the ordering invariant that
    // persistDailyMatches runs before any sendSms call.
    const fake = makeFakeDb({
      users: [
        {
          id: "u_w",
          phone: "+15550005001",
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
          stats: { age: 24, gender: "WOMAN", profession: null, heightCm: 168 },
        },
        {
          id: "u_m",
          phone: "+15550005002",
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
          stats: { age: 25, gender: "MAN", profession: null, heightCm: 180 },
        },
      ],
    });
    const allFailClient: TwilioClient = {
      sendSms: vi.fn(async () => {
        throw new Error("twilio outage");
      }),
    };
    const result = await runDailyMatch({
      prisma: fake.db,
      twilio: allFailClient,
      today: TODAY,
    });

    expect(result.selected).toHaveLength(1);
    expect(result.createdMatchIds).toHaveLength(1);
    expect(fake.createdMatches).toHaveLength(1);
    expect(fake.rematchUpserts.count).toBe(1);
    expect(result.notified).toEqual([]);
    expect(result.notifyErrors).toHaveLength(2);
    for (const e of result.notifyErrors) {
      expect(e.error).toMatch(/twilio outage/);
    }
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
