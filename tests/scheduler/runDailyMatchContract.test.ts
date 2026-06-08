// Contract pins for `runDailyMatch` — the seams that
// `tests/scheduler/runDailyMatch.test.ts` does NOT pin.
//
// The existing behavioural test covers the happy path, notify errors,
// stranded users, persist-survives-twilio-outage, and custom body
// propagation. It does NOT pin:
//
//   1. The user-facing default SMS verbatim (`DEFAULT_NEW_MATCH_NOTIFICATION`).
//      This text ships to every matched user — a typo or accidental rewrite
//      is a customer-facing regression.
//   2. The phone-lookup query shape: `{ where: { id: { in: [...userIds] } },
//      select: { id: true, phone: true } }`. Drifting the projection
//      (e.g. selecting `*`) leaks PII and inflates payloads; drifting the
//      where clause silently breaks the lookup.
//   3. Call ordering: every `dailyMatch.create` MUST complete before any
//      `twilio.sendSms`. If notification ever moves above persistence, a
//      Twilio outage would lose persisted-but-unnotified matches into
//      thin air — the durability invariant.
//   4. The result envelope: exact key set + ordering of `DailyMatchRunResult`.
//      Admin endpoints and the cron tick log read these by name; a rename
//      (`createdMatchIds` → `created`) is a silent ops break.
//   5. Non-Error coercion in notifyErrors: when `sendSms` rejects with a
//      non-Error value, `error` is `String(value)` — the route surface
//      promises a string, never an object.
//   6. One sendSms per matched USER (not per pair). For two pairs (4
//      distinct users) we expect 4 sends.
//   7. Custom-body propagation: when `notificationBody` is provided, every
//      send uses EXACTLY that string — no template fill, no append, no
//      coercion.
//   8. `today` default: when omitted, the runner derives `new Date()`
//      synchronously at call time (and the value flows through to
//      `loadSelectorContext`).
//
// The mocks below capture call ORDER across `dailyMatch.create` and
// `twilio.sendSms` via a shared `events` array so the persist-before-notify
// invariant is observable rather than inferred.

import { describe, it, expect, vi } from "vitest";
import {
  runDailyMatch,
  DEFAULT_NEW_MATCH_NOTIFICATION,
  type PhoneLookup,
} from "../../src/scheduler/runDailyMatch.js";
import type { MatchingPrisma } from "../../src/matching/prisma-deps.js";
import type { TwilioClient } from "../../src/twilio/client.js";

// ─── Shared candidate templates ────────────────────────────────────────────

type Gender = "WOMAN" | "MAN" | "NONBINARY" | "OTHER";

interface FakeUser {
  id: string;
  phone: string;
  status: "ACTIVE" | "ONBOARDING" | "PAUSED" | "BANNED";
  preferences: {
    minAge: number | null;
    maxAge: number | null;
    preferredGenders: Gender[];
    minHeightCm: number | null;
    maxHeightCm: number | null;
    preferredProfessions: string[];
    typeDescriptor: string | null;
  } | null;
  stats: {
    age: number | null;
    gender: Gender | null;
    profession: string | null;
    heightCm: number | null;
  } | null;
  isAiBacked: boolean;
}

function woman(id: string, phone: string, prefersAge = [20, 30] as const): FakeUser {
  return {
    id,
    phone,
    status: "ACTIVE",
    isAiBacked: false,
    preferences: {
      minAge: prefersAge[0],
      maxAge: prefersAge[1],
      preferredGenders: ["MAN"],
      minHeightCm: null,
      maxHeightCm: null,
      preferredProfessions: [],
      typeDescriptor: null,
    },
    stats: { age: 24, gender: "WOMAN", profession: null, heightCm: 168 },
  };
}

function man(id: string, phone: string, prefersAge = [20, 30] as const): FakeUser {
  return {
    id,
    phone,
    status: "ACTIVE",
    isAiBacked: false,
    preferences: {
      minAge: prefersAge[0],
      maxAge: prefersAge[1],
      preferredGenders: ["WOMAN"],
      minHeightCm: null,
      maxHeightCm: null,
      preferredProfessions: [],
      typeDescriptor: null,
    },
    stats: { age: 25, gender: "MAN", profession: null, heightCm: 180 },
  };
}

// ─── Fake DB that records every call + the args ────────────────────────────

interface DbHarness {
  db: MatchingPrisma & PhoneLookup;
  events: Array<{ kind: "create" | "sendSms"; at: number; detail: unknown }>;
  phoneLookupCalls: Array<{
    where: { id: { in: string[] } };
    select: { id: true; phone: true };
  }>;
  createdMatches: Array<{
    userAId: string;
    userBId: string;
    matchDate: Date;
    compatibilityScore: number;
  }>;
}

function makeDb(users: FakeUser[]): DbHarness {
  const events: DbHarness["events"] = [];
  const phoneLookupCalls: DbHarness["phoneLookupCalls"] = [];
  const createdMatches: DbHarness["createdMatches"] = [];
  let seq = 0;
  const nextSeq = () => ++seq;

  const db = {
    user: {
      findMany: async (args: {
        where?: { id?: { in: string[] }; status?: unknown };
        select?: { id?: true; phone?: true };
        include?: unknown;
      }) => {
        if (args.where?.id?.in) {
          // Phone-resolution stage.
          phoneLookupCalls.push({
            where: { id: { in: args.where.id.in } },
            select: args.select as { id: true; phone: true },
          });
          return users
            .filter((u) => args.where!.id!.in.includes(u.id))
            .map((u) => ({ id: u.id, phone: u.phone }));
        }
        // Candidate-load stage.
        return users.filter(
          (u) => u.status === "ACTIVE" && u.preferences && u.stats,
        );
      },
    },
    dailyMatch: {
      findMany: async () => [],
      create: async ({
        data,
      }: {
        data: {
          userAId: string;
          userBId: string;
          matchDate: Date;
          compatibilityScore: number;
        };
      }) => {
        createdMatches.push(data);
        events.push({ kind: "create", at: nextSeq(), detail: { ...data } });
        return { id: `m_${createdMatches.length}` };
      },
    },
    rematchHistory: {
      findMany: async () => [],
      upsert: async () => ({}),
    },
    $transaction: (async <T>(fn: (tx: unknown) => Promise<T>) =>
      fn(db)) as unknown as MatchingPrisma["$transaction"],
  } as unknown as MatchingPrisma & PhoneLookup;

  return { db, events, phoneLookupCalls, createdMatches };
}

function recordingTwilio(harness: DbHarness, behaviour?: (to: string) => void): {
  client: TwilioClient;
  calls: Array<{ to: string; body: string }>;
} {
  const calls: Array<{ to: string; body: string }> = [];
  let seq = harness.events.length;
  const nextSeq = () => {
    // Continue the same monotonic counter the DB uses, so ordering across
    // create + sendSms is observable on a single number line.
    seq = Math.max(seq, ...harness.events.map((e) => e.at)) + 1;
    return seq;
  };
  const client: TwilioClient = {
    sendSms: vi.fn(async ({ to, body }: { to: string; body: string }) => {
      calls.push({ to, body });
      harness.events.push({ kind: "sendSms", at: nextSeq(), detail: { to, body } });
      behaviour?.(to);
      return { sid: `SM_${calls.length}`, dryRun: false, status: 201 };
    }),
  };
  return { client, calls };
}

// ─── Specs ──────────────────────────────────────────────────────────────────

const TODAY = new Date("2026-05-17T12:00:00Z");

describe("DEFAULT_NEW_MATCH_NOTIFICATION — verbatim COPY pin", () => {
  it("is a single specific string (typos here ship to every matched user)", () => {
    expect(DEFAULT_NEW_MATCH_NOTIFICATION).toBe(
      "Your match for today is here 🧋. Say hi — you have until tonight to keep things going. Reply KEEP, MAYBE, or DISCARD at the end of the day.",
    );
  });

  it("contains the boba emoji as the raw unicode character (not an escape)", () => {
    expect(DEFAULT_NEW_MATCH_NOTIFICATION).toContain("🧋");
    expect(DEFAULT_NEW_MATCH_NOTIFICATION).not.toContain("\\u");
  });

  it("uses an em-dash (U+2014), not a hyphen, between the two clauses", () => {
    // Em-dash vs hyphen is invisible on most screens but renders differently
    // on iMessage; pin the actual code point.
    expect(DEFAULT_NEW_MATCH_NOTIFICATION).toContain("—");
    expect(DEFAULT_NEW_MATCH_NOTIFICATION).not.toContain("- ");
  });

  it("names all three end-of-day keywords in the canonical order KEEP, MAYBE, DISCARD", () => {
    const keepIdx = DEFAULT_NEW_MATCH_NOTIFICATION.indexOf("KEEP");
    const maybeIdx = DEFAULT_NEW_MATCH_NOTIFICATION.indexOf("MAYBE");
    const discardIdx = DEFAULT_NEW_MATCH_NOTIFICATION.indexOf("DISCARD");
    expect(keepIdx).toBeGreaterThan(-1);
    expect(maybeIdx).toBeGreaterThan(keepIdx);
    expect(discardIdx).toBeGreaterThan(maybeIdx);
  });

  it("is the default body the runner picks when notificationBody is omitted", async () => {
    const fake = makeDb([woman("u_w", "+15550009001"), man("u_m", "+15550009002")]);
    const tw = recordingTwilio(fake);
    await runDailyMatch({ prisma: fake.db, twilio: tw.client, today: TODAY });
    expect(tw.calls.length).toBeGreaterThan(0);
    for (const c of tw.calls) {
      expect(c.body).toBe(DEFAULT_NEW_MATCH_NOTIFICATION);
    }
  });
});

describe("Phone-lookup query shape", () => {
  it("uses select: { id: true, phone: true } (no PII leak, no `*` projection)", async () => {
    const fake = makeDb([woman("u_w", "+15550010001"), man("u_m", "+15550010002")]);
    const tw = recordingTwilio(fake);
    await runDailyMatch({ prisma: fake.db, twilio: tw.client, today: TODAY });

    expect(fake.phoneLookupCalls).toHaveLength(1);
    expect(fake.phoneLookupCalls[0]!.select).toEqual({ id: true, phone: true });
    // No additional projection fields.
    expect(Object.keys(fake.phoneLookupCalls[0]!.select).sort()).toEqual([
      "id",
      "phone",
    ]);
  });

  it("queries by `id IN [...userIds]` with both matched users", async () => {
    const fake = makeDb([woman("u_w", "+15550010001"), man("u_m", "+15550010002")]);
    const tw = recordingTwilio(fake);
    await runDailyMatch({ prisma: fake.db, twilio: tw.client, today: TODAY });

    expect(fake.phoneLookupCalls[0]!.where).toEqual({
      id: { in: expect.any(Array) },
    });
    const ids = fake.phoneLookupCalls[0]!.where.id.in;
    expect([...ids].sort()).toEqual(["u_m", "u_w"]);
  });

  it("deduplicates user ids (Set semantics) — no id appears twice in the IN clause", async () => {
    // Same two users, one pair — `userIds` is a Set, so even if the loop
    // added a duplicate the IN list would be deduped. Pin that the IN list
    // length equals the distinct-user count.
    const fake = makeDb([woman("u_w", "+15550010001"), man("u_m", "+15550010002")]);
    const tw = recordingTwilio(fake);
    await runDailyMatch({ prisma: fake.db, twilio: tw.client, today: TODAY });

    const ids = fake.phoneLookupCalls[0]!.where.id.in;
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("Call ordering — persist-before-notify durability invariant", () => {
  it("every dailyMatch.create completes BEFORE the first twilio.sendSms", async () => {
    const fake = makeDb([woman("u_w", "+15550011001"), man("u_m", "+15550011002")]);
    const tw = recordingTwilio(fake);
    await runDailyMatch({ prisma: fake.db, twilio: tw.client, today: TODAY });

    const lastCreateAt = Math.max(
      ...fake.events.filter((e) => e.kind === "create").map((e) => e.at),
    );
    const firstSendAt = Math.min(
      ...fake.events.filter((e) => e.kind === "sendSms").map((e) => e.at),
    );
    expect(lastCreateAt).toBeLessThan(firstSendAt);
  });

  it("if every send throws, all creates still ran (persisted matches survive Twilio outage)", async () => {
    // This duplicates a behavioural assertion from runDailyMatch.test.ts but
    // pins it through the EVENT timeline: even when sendSms throws on every
    // call, the create event was already in the record before the first
    // sendSms attempt.
    const fake = makeDb([woman("u_w", "+15550011101"), man("u_m", "+15550011102")]);
    const tw = recordingTwilio(fake, () => {
      throw new Error("twilio down");
    });
    await runDailyMatch({ prisma: fake.db, twilio: tw.client, today: TODAY });

    const creates = fake.events.filter((e) => e.kind === "create");
    const sends = fake.events.filter((e) => e.kind === "sendSms");
    expect(creates).toHaveLength(1);
    // The send was attempted (and threw) — so sends were recorded.
    expect(sends.length).toBeGreaterThan(0);
    // And the create happened before any send attempt.
    expect(creates[0]!.at).toBeLessThan(Math.min(...sends.map((s) => s.at)));
  });
});

describe("DailyMatchRunResult envelope shape", () => {
  it("returns exactly these five keys in this order: candidates, selected, createdMatchIds, notified, notifyErrors", async () => {
    const fake = makeDb([woman("u_w", "+15550012001"), man("u_m", "+15550012002")]);
    const tw = recordingTwilio(fake);
    const result = await runDailyMatch({
      prisma: fake.db,
      twilio: tw.client,
      today: TODAY,
    });
    expect(Object.keys(result)).toEqual([
      "candidates",
      "selected",
      "createdMatchIds",
      "notified",
      "notifyErrors",
    ]);
  });

  it("returns the same five keys on the empty path", async () => {
    const fake = makeDb([]);
    const tw = recordingTwilio(fake);
    const result = await runDailyMatch({
      prisma: fake.db,
      twilio: tw.client,
      today: TODAY,
    });
    expect(Object.keys(result)).toEqual([
      "candidates",
      "selected",
      "createdMatchIds",
      "notified",
      "notifyErrors",
    ]);
    expect(result.candidates).toBe(0);
    expect(result.selected).toEqual([]);
    expect(result.createdMatchIds).toEqual([]);
    expect(result.notified).toEqual([]);
    expect(result.notifyErrors).toEqual([]);
  });

  it("createdMatchIds is an Array<string> (the row ids), parallel to selected[]", async () => {
    const fake = makeDb([woman("u_w", "+15550012101"), man("u_m", "+15550012102")]);
    const tw = recordingTwilio(fake);
    const result = await runDailyMatch({
      prisma: fake.db,
      twilio: tw.client,
      today: TODAY,
    });
    expect(result.createdMatchIds).toHaveLength(result.selected.length);
    for (const id of result.createdMatchIds) {
      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(0);
    }
  });

  it("notified is Array<string> of recipient phones (NOT user ids, NOT objects)", async () => {
    const fake = makeDb([woman("u_w", "+15550012201"), man("u_m", "+15550012202")]);
    const tw = recordingTwilio(fake);
    const result = await runDailyMatch({
      prisma: fake.db,
      twilio: tw.client,
      today: TODAY,
    });
    expect(result.notified.sort()).toEqual(["+15550012201", "+15550012202"]);
    for (const v of result.notified) expect(typeof v).toBe("string");
  });
});

describe("notifyErrors entry shape", () => {
  it("each entry is exactly { phone: string, error: string } — no extra fields", async () => {
    const fake = makeDb([woman("u_w", "+15550013001"), man("u_m", "+15550013002")]);
    const tw = recordingTwilio(fake, (to) => {
      if (to.endsWith("01")) throw new Error("boom");
    });
    const result = await runDailyMatch({
      prisma: fake.db,
      twilio: tw.client,
      today: TODAY,
    });
    expect(result.notifyErrors).toHaveLength(1);
    const e = result.notifyErrors[0]!;
    expect(Object.keys(e).sort()).toEqual(["error", "phone"]);
    expect(typeof e.phone).toBe("string");
    expect(typeof e.error).toBe("string");
    expect(e.phone).toBe("+15550013001");
    expect(e.error).toBe("boom");
  });

  it("non-Error rejections are coerced to String(value), not surfaced as objects", async () => {
    // sendSms rejecting with a plain string is unusual but legal — the
    // runner promises a string in the surface, so we must coerce.
    const fake = makeDb([woman("u_w", "+15550013101"), man("u_m", "+15550013102")]);
    let throws = 0;
    const client: TwilioClient = {
      sendSms: vi.fn(async () => {
        throws++;
        // Throw a non-Error every time — both calls should land in
        // notifyErrors as coerced strings.
        throw "carrier-string-rejection";
      }),
    };
    const result = await runDailyMatch({
      prisma: fake.db,
      twilio: client,
      today: TODAY,
    });
    expect(throws).toBe(2);
    expect(result.notifyErrors).toHaveLength(2);
    for (const e of result.notifyErrors) {
      expect(typeof e.error).toBe("string");
      expect(e.error).toBe("carrier-string-rejection");
    }
  });

  it("a numeric rejection is coerced to its String() form", async () => {
    const fake = makeDb([woman("u_w", "+15550013201"), man("u_m", "+15550013202")]);
    const client: TwilioClient = {
      sendSms: vi.fn(async () => {
        throw 42;
      }),
    };
    const result = await runDailyMatch({
      prisma: fake.db,
      twilio: client,
      today: TODAY,
    });
    expect(result.notifyErrors).toHaveLength(2);
    for (const e of result.notifyErrors) {
      expect(e.error).toBe("42");
    }
  });
});

describe("Send count is per-USER, not per-pair", () => {
  it("two users matched once → exactly 2 sendSms calls", async () => {
    const fake = makeDb([woman("u_w", "+15550014001"), man("u_m", "+15550014002")]);
    const tw = recordingTwilio(fake);
    await runDailyMatch({ prisma: fake.db, twilio: tw.client, today: TODAY });
    expect(tw.calls).toHaveLength(2);
  });

  it("each matched user receives exactly one send (no duplicate sends)", async () => {
    const fake = makeDb([woman("u_w", "+15550014101"), man("u_m", "+15550014102")]);
    const tw = recordingTwilio(fake);
    await runDailyMatch({ prisma: fake.db, twilio: tw.client, today: TODAY });
    const recipients = tw.calls.map((c) => c.to);
    expect(new Set(recipients).size).toBe(recipients.length);
  });
});

describe("Custom notificationBody propagation", () => {
  it("propagates the supplied string VERBATIM (no template fill, no append, no normalize)", async () => {
    const fake = makeDb([woman("u_w", "+15550015001"), man("u_m", "+15550015002")]);
    const tw = recordingTwilio(fake);
    const custom = "Boba launch night 🚀 — text back!";
    await runDailyMatch({
      prisma: fake.db,
      twilio: tw.client,
      today: TODAY,
      notificationBody: custom,
    });
    expect(tw.calls.length).toBeGreaterThan(0);
    for (const c of tw.calls) {
      expect(c.body).toBe(custom);
    }
  });

  it("explicit empty string is honoured (NOT coerced back to the default)", async () => {
    // `??` only falls back on null/undefined — an empty string MUST pass
    // through. Pinning this prevents a future maintainer from
    // "harmlessly" switching to `||` and accidentally re-injecting the
    // default body when an operator deliberately set an empty value.
    const fake = makeDb([woman("u_w", "+15550015101"), man("u_m", "+15550015102")]);
    const tw = recordingTwilio(fake);
    await runDailyMatch({
      prisma: fake.db,
      twilio: tw.client,
      today: TODAY,
      notificationBody: "",
    });
    for (const c of tw.calls) {
      expect(c.body).toBe("");
    }
  });
});

describe("today default", () => {
  it("when `today` is omitted, runner derives a Date at call time", async () => {
    // Capture the matchDate the create() call receives — that comes from
    // `startOfUtcDay(today)` inside persistDailyMatches, so its UTC-day
    // floor will equal the floor of "now".
    const fake = makeDb([woman("u_w", "+15550016001"), man("u_m", "+15550016002")]);
    const tw = recordingTwilio(fake);
    const before = Date.now();
    await runDailyMatch({ prisma: fake.db, twilio: tw.client });
    const after = Date.now();

    expect(fake.createdMatches).toHaveLength(1);
    const matchDate = fake.createdMatches[0]!.matchDate;
    expect(matchDate).toBeInstanceOf(Date);

    // The matchDate is the UTC-day floor of "now". Confirm it falls on the
    // same UTC date as the call window.
    const expectedFloor = new Date(
      Date.UTC(
        new Date(before).getUTCFullYear(),
        new Date(before).getUTCMonth(),
        new Date(before).getUTCDate(),
      ),
    );
    const expectedFloorAlt = new Date(
      Date.UTC(
        new Date(after).getUTCFullYear(),
        new Date(after).getUTCMonth(),
        new Date(after).getUTCDate(),
      ),
    );
    const got = matchDate.getTime();
    // "Now" may straddle a UTC midnight; accept either side of the boundary.
    expect([expectedFloor.getTime(), expectedFloorAlt.getTime()]).toContain(got);
  });

  it("explicit `today` is honoured — matchDate is the UTC-day floor of the supplied value", async () => {
    const fake = makeDb([woman("u_w", "+15550016101"), man("u_m", "+15550016102")]);
    const tw = recordingTwilio(fake);
    await runDailyMatch({
      prisma: fake.db,
      twilio: tw.client,
      today: new Date("2027-03-14T23:59:59.999Z"),
    });
    expect(fake.createdMatches).toHaveLength(1);
    const matchDate = fake.createdMatches[0]!.matchDate;
    expect(matchDate.toISOString()).toBe("2027-03-14T00:00:00.000Z");
  });
});
