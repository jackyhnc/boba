// Contract test for `src/twilio/prisma-deps.ts` — the Prisma adapter
// behind the inbound webhook routes.
//
// Why this file exists. The routes integration suite
// (tests/twilio/routes.test.ts) uses a fake `TwilioPrisma` whose
// `user.update` simply spreads the incoming `data` and whose
// `dailyMatch.findFirst` synthesizes the partner shape from its own
// store — neither asserts what *this* adapter actually passes to
// Prisma. Five contracts live unpinned:
//
//   1. `applySmsOptOutChange` is the 10DLC carrier-compliance touch
//      point. Opting OUT must set `smsOptedOutAt` to a Date
//      (timestamped audit trail Twilio reviewers may request). Opting
//      back IN must EXPLICITLY null `smsOptedOutAt` — leaving the
//      timestamp stale would mis-represent the user's current state.
//      The routes fake's user.update spreads `data` blindly, so a
//      refactor that drops either branch would pass every route test.
//
//   2. `findUserByPhone` projects exactly the 6 fields the router
//      needs and returns null on miss. Adding stray fields here would
//      silently widen the surface the router can reach into.
//
//   3. `loadActiveMatchForUser` derives `partner` from match orientation
//      (current user is userAId ⇒ partner is userB; reverse). Flipping
//      this would relay messages to the wrong recipient — the worst
//      possible silent failure for a dating app.
//
//   4. `persistInboundMessage` / `persistOutboundMessage` hard-code
//      `direction: "INBOUND" | "OUTBOUND"` and the inbound version
//      defaults both flag fields to `false`. A truthy default on the
//      flags would gate every inbound on stat-fishing / harassment.
//
//   5. `recordDeliveryStatus` returns true iff a Message row matches
//      the SID, so the route layer can log unknown SIDs separately.

import { describe, it, expect, vi } from "vitest";
import {
  applySmsOptOutChange,
  findUserByPhone,
  isSmsOptedOut,
  loadActiveMatchForUser,
  persistInboundMessage,
  persistOutboundMessage,
  recordDeliveryStatus,
  type TwilioPrisma,
} from "../../src/twilio/prisma-deps.js";

type UserUpdateData = {
  smsOptedOut?: boolean;
  smsOptedOutAt?: Date | null;
};

interface UserUpdateArgs {
  where: { id: string };
  data: UserUpdateData;
}

interface UserFindUniqueArgs {
  where: { phone?: string; id?: string; twilioSid?: string };
  select?: Record<string, true>;
}

interface DailyMatchFindFirstArgs {
  where: {
    state: "ACTIVE";
    OR: Array<{ userAId?: string; userBId?: string }>;
  };
  orderBy: { matchDate: "desc" };
  select: Record<string, unknown>;
}

interface MessageCreateArgs {
  data: {
    matchId: string;
    senderId: string;
    direction: "INBOUND" | "OUTBOUND";
    body: string;
    depthScore?: number;
    twilioSid: string | null;
    flaggedStatFishing?: boolean;
    flaggedHarassment?: boolean;
  };
  select: { id: true };
}

interface MessageFindUniqueArgs {
  where: { twilioSid: string };
  select: { id: true };
}

// ─── applySmsOptOutChange ───────────────────────────────────────────────────

describe("applySmsOptOutChange (10DLC compliance contract)", () => {
  function fakeDb(): {
    db: TwilioPrisma;
    update: ReturnType<typeof vi.fn>;
  } {
    const update = vi.fn(async (_args: UserUpdateArgs) => ({ id: "u_1" }));
    const db = { user: { update } } as unknown as TwilioPrisma;
    return { db, update };
  }

  it("opt-out sets smsOptedOut=true AND stamps smsOptedOutAt with a Date", async () => {
    const { db, update } = fakeDb();
    const before = Date.now();
    const r = await applySmsOptOutChange(db, "u_1", true);
    const after = Date.now();

    expect(r).toEqual({ id: "u_1" });
    expect(update).toHaveBeenCalledTimes(1);
    const args = update.mock.calls[0]![0] as UserUpdateArgs;
    expect(args.where).toEqual({ id: "u_1" });
    expect(args.data.smsOptedOut).toBe(true);
    expect(args.data.smsOptedOutAt).toBeInstanceOf(Date);
    const stampedAt = (args.data.smsOptedOutAt as Date).getTime();
    expect(stampedAt).toBeGreaterThanOrEqual(before);
    expect(stampedAt).toBeLessThanOrEqual(after);
  });

  it("opt-in sets smsOptedOut=false AND EXPLICITLY nulls smsOptedOutAt", async () => {
    const { db, update } = fakeDb();
    await applySmsOptOutChange(db, "u_1", false);

    const args = update.mock.calls[0]![0] as UserUpdateArgs;
    expect(args.data.smsOptedOut).toBe(false);
    // Critical: `null`, not `undefined`. An `undefined` here would leave
    // any prior opt-out timestamp on the row, mis-representing state.
    expect(args.data.smsOptedOutAt).toBeNull();
    expect("smsOptedOutAt" in args.data).toBe(true);
  });

  it("returns { id } even though Prisma's update result is ignored", async () => {
    // The function awaits the update but doesn't read the result — it
    // synthesizes `{ id: userId }` from the input. Pinning this protects
    // callers that expect the input id back, not whatever Prisma returns.
    const update = vi.fn(async () => ({ id: "different_id_from_prisma" }));
    const db = { user: { update } } as unknown as TwilioPrisma;
    const r = await applySmsOptOutChange(db, "u_caller", true);
    expect(r).toEqual({ id: "u_caller" });
  });
});

// ─── findUserByPhone ────────────────────────────────────────────────────────

describe("findUserByPhone", () => {
  it("returns the 6-field router shape on hit", async () => {
    const findUnique = vi.fn(async (_args: UserFindUniqueArgs) => ({
      id: "u_1",
      phone: "+15551234567",
      displayName: "Sam",
      status: "ACTIVE" as const,
      onboardingStep: null,
      smsOptedOut: false,
    }));
    const db = { user: { findUnique } } as unknown as TwilioPrisma;

    const r = await findUserByPhone(db, "+15551234567");

    expect(r).toEqual({
      id: "u_1",
      phone: "+15551234567",
      displayName: "Sam",
      status: "ACTIVE",
      onboardingStep: null,
      smsOptedOut: false,
    });
    const args = findUnique.mock.calls[0]![0] as UserFindUniqueArgs;
    expect(args.where).toEqual({ phone: "+15551234567" });
    expect(args.select).toEqual({
      id: true,
      phone: true,
      displayName: true,
      status: true,
      onboardingStep: true,
      smsOptedOut: true,
    });
  });

  it("returns null when no row matches", async () => {
    const findUnique = vi.fn(async () => null);
    const db = { user: { findUnique } } as unknown as TwilioPrisma;
    const r = await findUserByPhone(db, "+15550000000");
    expect(r).toBeNull();
  });

  it("preserves onboardingStep string values verbatim", async () => {
    // The adapter casts via `as RouterUser["onboardingStep"]` — that's a
    // compile-time hint, not a runtime check. Whatever string the DB
    // hands back is what the router sees.
    const findUnique = vi.fn(async () => ({
      id: "u_2",
      phone: "+15551112222",
      displayName: null,
      status: "ONBOARDING" as const,
      onboardingStep: "ask_age",
      smsOptedOut: false,
    }));
    const db = { user: { findUnique } } as unknown as TwilioPrisma;
    const r = await findUserByPhone(db, "+15551112222");
    expect(r?.onboardingStep).toBe("ask_age");
  });
});

// ─── isSmsOptedOut ──────────────────────────────────────────────────────────

describe("isSmsOptedOut", () => {
  it("uses the narrow 1-field select", async () => {
    const findUnique = vi.fn(async (_args: UserFindUniqueArgs) => ({
      smsOptedOut: true,
    }));
    const db = { user: { findUnique } } as unknown as TwilioPrisma;
    const r = await isSmsOptedOut(db, "u_1");
    expect(r).toBe(true);
    const args = findUnique.mock.calls[0]![0] as UserFindUniqueArgs;
    expect(args.where).toEqual({ id: "u_1" });
    expect(args.select).toEqual({ smsOptedOut: true });
  });

  it("returns false when smsOptedOut is false", async () => {
    const db = {
      user: { findUnique: vi.fn(async () => ({ smsOptedOut: false })) },
    } as unknown as TwilioPrisma;
    expect(await isSmsOptedOut(db, "u_1")).toBe(false);
  });

  it("defaults to false when the user row is missing (fail-open send)", async () => {
    // The send loop calls this defensively. Missing rows shouldn't gate
    // sends — Twilio is the source of truth for actual carrier
    // suppression. Pin this so a future refactor doesn't flip it to
    // fail-closed and silently drop messages.
    const db = {
      user: { findUnique: vi.fn(async () => null) },
    } as unknown as TwilioPrisma;
    expect(await isSmsOptedOut(db, "u_missing")).toBe(false);
  });
});

// ─── loadActiveMatchForUser ─────────────────────────────────────────────────

describe("loadActiveMatchForUser — partner orientation", () => {
  function fakeMatchRow(opts: {
    userAId: string;
    userBId: string;
    milestones?: Array<"AGE" | "PROFESSION" | "HEIGHT" | "FACE">;
    messages?: Array<{ senderId: string; body: string; depthScore: number }>;
  }) {
    return {
      id: "m_1",
      userAId: opts.userAId,
      userBId: opts.userBId,
      userA: {
        id: opts.userAId,
        phone: `+1555000${opts.userAId}`,
        isAiBacked: false,
        aiPersonaPrompt: null,
      },
      userB: {
        id: opts.userBId,
        phone: `+1555000${opts.userBId}`,
        isAiBacked: false,
        aiPersonaPrompt: null,
      },
      messages: opts.messages ?? [],
      milestones: (opts.milestones ?? []).map((m) => ({ milestone: m })),
    };
  }

  it("returns null when no active match exists", async () => {
    const findFirst = vi.fn(async () => null);
    const db = {
      dailyMatch: { findFirst },
    } as unknown as TwilioPrisma;
    const r = await loadActiveMatchForUser(db, "u_a");
    expect(r).toBeNull();
  });

  it("when current user is userAId, partner is userB", async () => {
    const findFirst = vi.fn(async () =>
      fakeMatchRow({ userAId: "u_a", userBId: "u_b" }),
    );
    const db = {
      dailyMatch: { findFirst },
    } as unknown as TwilioPrisma;
    const r = await loadActiveMatchForUser(db, "u_a");
    expect(r?.partner.id).toBe("u_b");
    expect(r?.userAId).toBe("u_a");
    expect(r?.userBId).toBe("u_b");
  });

  it("when current user is userBId, partner is userA (reverse)", async () => {
    const findFirst = vi.fn(async () =>
      fakeMatchRow({ userAId: "u_a", userBId: "u_b" }),
    );
    const db = {
      dailyMatch: { findFirst },
    } as unknown as TwilioPrisma;
    const r = await loadActiveMatchForUser(db, "u_b");
    expect(r?.partner.id).toBe("u_a");
  });

  it("filters on state=ACTIVE and OR userAId/userBId; orders by matchDate desc", async () => {
    const findFirst = vi.fn(async (_args: DailyMatchFindFirstArgs) =>
      fakeMatchRow({ userAId: "u_a", userBId: "u_b" }),
    );
    const db = {
      dailyMatch: { findFirst },
    } as unknown as TwilioPrisma;
    await loadActiveMatchForUser(db, "u_a");

    const args = findFirst.mock.calls[0]![0];
    expect(args.where.state).toBe("ACTIVE");
    expect(args.where.OR).toEqual([
      { userAId: "u_a" },
      { userBId: "u_a" },
    ]);
    expect(args.orderBy).toEqual({ matchDate: "desc" });
  });

  it("hydrates unlockedMilestones into a Set", async () => {
    const findFirst = vi.fn(async () =>
      fakeMatchRow({
        userAId: "u_a",
        userBId: "u_b",
        milestones: ["AGE", "PROFESSION"],
      }),
    );
    const db = {
      dailyMatch: { findFirst },
    } as unknown as TwilioPrisma;
    const r = await loadActiveMatchForUser(db, "u_a");
    expect(r?.unlockedMilestones).toEqual(new Set(["AGE", "PROFESSION"]));
    // Set type, not Array — callers rely on .has()
    expect(r?.unlockedMilestones.has("AGE")).toBe(true);
  });

  it("priorMessages are passed through verbatim (the IO layer trusts the orderBy)", async () => {
    const msgs = [
      { senderId: "u_a", body: "hi", depthScore: 1 },
      { senderId: "u_b", body: "hey", depthScore: 2 },
    ];
    const findFirst = vi.fn(async (_args: DailyMatchFindFirstArgs) =>
      fakeMatchRow({ userAId: "u_a", userBId: "u_b", messages: msgs }),
    );
    const db = {
      dailyMatch: { findFirst },
    } as unknown as TwilioPrisma;
    const r = await loadActiveMatchForUser(db, "u_a");
    expect(r?.priorMessages).toEqual(msgs);

    const args = findFirst.mock.calls[0]![0];
    const messagesSelect = args.select.messages as {
      orderBy: { createdAt: "asc" };
    };
    expect(messagesSelect.orderBy).toEqual({ createdAt: "asc" });
  });

  it("projects partner with the 4 fields the router needs", async () => {
    const findFirst = vi.fn(async () =>
      fakeMatchRow({ userAId: "u_a", userBId: "u_b" }),
    );
    const db = {
      dailyMatch: { findFirst },
    } as unknown as TwilioPrisma;
    const r = await loadActiveMatchForUser(db, "u_a");
    expect(r?.partner).toEqual({
      id: "u_b",
      phone: "+1555000u_b",
      isAiBacked: false,
      aiPersonaPrompt: null,
    });
  });
});

// ─── persistInboundMessage ──────────────────────────────────────────────────

describe("persistInboundMessage", () => {
  function fakeDb(): { db: TwilioPrisma; create: ReturnType<typeof vi.fn> } {
    const create = vi.fn(async (_args: MessageCreateArgs) => ({ id: "msg_1" }));
    const db = { message: { create } } as unknown as TwilioPrisma;
    return { db, create };
  }

  it("hard-codes direction=INBOUND", async () => {
    const { db, create } = fakeDb();
    await persistInboundMessage(db, {
      matchId: "m_1",
      senderId: "u_a",
      body: "hi",
      depthScore: 3,
      twilioSid: "SM123",
    });
    const args = create.mock.calls[0]![0] as MessageCreateArgs;
    expect(args.data.direction).toBe("INBOUND");
  });

  it("defaults both flag fields to false when omitted", async () => {
    const { db, create } = fakeDb();
    await persistInboundMessage(db, {
      matchId: "m_1",
      senderId: "u_a",
      body: "hi",
      depthScore: 0,
      twilioSid: null,
    });
    const args = create.mock.calls[0]![0] as MessageCreateArgs;
    expect(args.data.flaggedStatFishing).toBe(false);
    expect(args.data.flaggedHarassment).toBe(false);
  });

  it("passes through truthy flag values when provided", async () => {
    const { db, create } = fakeDb();
    await persistInboundMessage(db, {
      matchId: "m_1",
      senderId: "u_a",
      body: "what's your insta",
      depthScore: 0,
      twilioSid: "SM999",
      flaggedStatFishing: true,
      flaggedHarassment: true,
    });
    const args = create.mock.calls[0]![0] as MessageCreateArgs;
    expect(args.data.flaggedStatFishing).toBe(true);
    expect(args.data.flaggedHarassment).toBe(true);
  });

  it("accepts a null twilioSid (system-generated inbound, no Twilio SID)", async () => {
    const { db, create } = fakeDb();
    await persistInboundMessage(db, {
      matchId: "m_1",
      senderId: "u_a",
      body: "hi",
      depthScore: 0,
      twilioSid: null,
    });
    const args = create.mock.calls[0]![0] as MessageCreateArgs;
    expect(args.data.twilioSid).toBeNull();
  });

  it("returns the new row id from the select projection", async () => {
    const { db } = fakeDb();
    const r = await persistInboundMessage(db, {
      matchId: "m_1",
      senderId: "u_a",
      body: "hi",
      depthScore: 0,
      twilioSid: null,
    });
    expect(r).toEqual({ id: "msg_1" });
  });
});

// ─── persistOutboundMessage ─────────────────────────────────────────────────

describe("persistOutboundMessage", () => {
  function fakeDb(): { db: TwilioPrisma; create: ReturnType<typeof vi.fn> } {
    const create = vi.fn(async (_args: MessageCreateArgs) => ({ id: "msg_out_1" }));
    const db = { message: { create } } as unknown as TwilioPrisma;
    return { db, create };
  }

  it("hard-codes direction=OUTBOUND", async () => {
    const { db, create } = fakeDb();
    await persistOutboundMessage(db, {
      matchId: "m_1",
      senderId: "u_a",
      body: "relayed",
      twilioSid: "SM_out_1",
    });
    const args = create.mock.calls[0]![0] as MessageCreateArgs;
    expect(args.data.direction).toBe("OUTBOUND");
  });

  it("forwards matchId / senderId / body / twilioSid verbatim", async () => {
    const { db, create } = fakeDb();
    await persistOutboundMessage(db, {
      matchId: "m_xyz",
      senderId: "u_orig",
      body: "hello",
      twilioSid: "SM_abc",
    });
    const args = create.mock.calls[0]![0] as MessageCreateArgs;
    expect(args.data.matchId).toBe("m_xyz");
    expect(args.data.senderId).toBe("u_orig");
    expect(args.data.body).toBe("hello");
    expect(args.data.twilioSid).toBe("SM_abc");
  });

  it("accepts a null twilioSid (queued before the send completes)", async () => {
    const { db, create } = fakeDb();
    await persistOutboundMessage(db, {
      matchId: "m_1",
      senderId: "u_a",
      body: "queued",
      twilioSid: null,
    });
    const args = create.mock.calls[0]![0] as MessageCreateArgs;
    expect(args.data.twilioSid).toBeNull();
  });

  it("does NOT pass any flag fields (those are inbound-only)", async () => {
    const { db, create } = fakeDb();
    await persistOutboundMessage(db, {
      matchId: "m_1",
      senderId: "u_a",
      body: "hi",
      twilioSid: null,
    });
    const args = create.mock.calls[0]![0] as MessageCreateArgs;
    expect("flaggedStatFishing" in args.data).toBe(false);
    expect("flaggedHarassment" in args.data).toBe(false);
    expect("depthScore" in args.data).toBe(false);
  });

  it("returns the new row id", async () => {
    const { db } = fakeDb();
    const r = await persistOutboundMessage(db, {
      matchId: "m_1",
      senderId: "u_a",
      body: "hi",
      twilioSid: null,
    });
    expect(r).toEqual({ id: "msg_out_1" });
  });
});

// ─── recordDeliveryStatus ───────────────────────────────────────────────────

describe("recordDeliveryStatus", () => {
  it("returns true when the SID matches an existing row", async () => {
    const findUnique = vi.fn(async (_args: MessageFindUniqueArgs) => ({
      id: "msg_1",
    }));
    const db = { message: { findUnique } } as unknown as TwilioPrisma;
    const r = await recordDeliveryStatus(db, "SM_found", "delivered");
    expect(r).toBe(true);
    const args = findUnique.mock.calls[0]![0] as MessageFindUniqueArgs;
    expect(args.where).toEqual({ twilioSid: "SM_found" });
    expect(args.select).toEqual({ id: true });
  });

  it("returns false when no row matches the SID", async () => {
    const findUnique = vi.fn(async () => null);
    const db = { message: { findUnique } } as unknown as TwilioPrisma;
    const r = await recordDeliveryStatus(db, "SM_unknown", "delivered");
    expect(r).toBe(false);
  });

  it("status argument is accepted but not yet persisted (logging-only)", async () => {
    // Pin the current behavior: a future schema change will add a
    // `deliveryStatus` column and start writing it. Until then, the
    // function MUST NOT call any write — only the findUnique read.
    const findUnique = vi.fn(async () => ({ id: "msg_1" }));
    const update = vi.fn();
    const db = {
      message: { findUnique, update },
    } as unknown as TwilioPrisma;
    await recordDeliveryStatus(db, "SM_1", "failed");
    expect(update).not.toHaveBeenCalled();
  });
});
