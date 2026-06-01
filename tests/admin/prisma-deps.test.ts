// Contract test for `src/admin/prisma-deps.ts` — the Prisma adapter behind
// the admin HTTP routes.
//
// Why this file exists. Three pieces of logic live inside this module that
// no other test directly pins:
//
//   1. `listUsers` clamps the `limit` argument with
//      `Math.min(Math.max(limit ?? 25, 1), 100)` and over-fetches by one
//      row (`take: limit + 1`) so the caller can detect whether a next
//      page exists. The route layer just forwards `?limit=` straight in,
//      and the existing `tests/admin/routes.test.ts` fake DB ignores the
//      `take + 1` semantics — so dropping the clamp or the over-fetch
//      would silently regress the API contract without breaking any
//      existing test.
//
//   2. `listUsers` cursor pagination uses `skip: 1, cursor: { id }`
//      because Prisma's cursor is inclusive by default. The HTTP route
//      exposes `?cursor=` (admin/routes.ts:51) but no existing test
//      exercises it; removing the `skip: 1` would duplicate the cursor
//      row at every page boundary.
//
//   3. `unbanUser` always restores `status: "ACTIVE"` regardless of the
//      user's prior status (PAUSED / ONBOARDING / BANNED). This is
//      documented behavior in the source comment (prisma-deps.ts:131-133)
//      but never asserted in tests — a refactor to "restore to prior
//      status" would compile and pass the routes test, but break the
//      documented contract operators rely on.
//
// We also pin the smaller invariants that future refactors are likely to
// touch: the exact `select` shapes, the `orderBy`, and the short-circuit
// behaviour of `banUser`/`unbanUser`/`getConversation` when the target
// row is missing (no follow-up write/read should fire).

import { describe, it, expect, vi } from "vitest";
import {
  banUser,
  getConversation,
  listUsers,
  unbanUser,
  type AdminPrisma,
} from "../../src/admin/prisma-deps.js";

type Status = "ACTIVE" | "ONBOARDING" | "PAUSED" | "BANNED";

interface UserFindManyArgs {
  where?: { status?: Status };
  orderBy?: { createdAt: "desc" };
  take?: number;
  skip?: number;
  cursor?: { id: string };
  select?: Record<string, true>;
}

interface UserFindUniqueArgs {
  where: { id: string };
  select: { status: true };
}

interface UserUpdateArgs {
  where: { id: string };
  data: { status: Status };
  select: { status: true };
}

interface MatchFindUniqueArgs {
  where: { id: string };
  select: Record<string, unknown>;
}

interface MessageFindManyArgs {
  where: { matchId: string };
  orderBy: { createdAt: "asc" };
  select: Record<string, true>;
}

interface UserRow {
  id: string;
  phone: string;
  displayName: string | null;
  status: Status;
  onboardingStep: string | null;
  reportCount: number;
  isAiBacked: boolean;
  createdAt: Date;
}

interface MatchRow {
  id: string;
  matchDate: Date;
  state: string;
  compatibilityScore: number;
  userA: { id: string; phone: string; displayName: string | null };
  userB: { id: string; phone: string; displayName: string | null };
}

interface MessageRow {
  id: string;
  senderId: string;
  direction: string;
  body: string;
  depthScore: number;
  flaggedStatFishing: boolean;
  flaggedHarassment: boolean;
  createdAt: Date;
}

interface Mock {
  prisma: AdminPrisma;
  calls: {
    userFindMany: UserFindManyArgs[];
    userFindUnique: UserFindUniqueArgs[];
    userUpdate: UserUpdateArgs[];
    matchFindUnique: MatchFindUniqueArgs[];
    messageFindMany: MessageFindManyArgs[];
  };
}

function makeMock(opts: {
  users?: UserRow[];
  findUniqueUser?: { status: Status } | null;
  updateUserStatus?: Status;
  match?: MatchRow | null;
  messages?: MessageRow[];
} = {}): Mock {
  const calls: Mock["calls"] = {
    userFindMany: [],
    userFindUnique: [],
    userUpdate: [],
    matchFindUnique: [],
    messageFindMany: [],
  };

  const prisma = {
    user: {
      findMany: vi.fn(async (args: UserFindManyArgs) => {
        calls.userFindMany.push(args);
        return opts.users ?? [];
      }),
      findUnique: vi.fn(async (args: UserFindUniqueArgs) => {
        calls.userFindUnique.push(args);
        return opts.findUniqueUser === undefined
          ? null
          : opts.findUniqueUser;
      }),
      update: vi.fn(async (args: UserUpdateArgs) => {
        calls.userUpdate.push(args);
        return { status: opts.updateUserStatus ?? args.data.status };
      }),
    },
    dailyMatch: {
      findUnique: vi.fn(async (args: MatchFindUniqueArgs) => {
        calls.matchFindUnique.push(args);
        return opts.match === undefined ? null : opts.match;
      }),
    },
    message: {
      findMany: vi.fn(async (args: MessageFindManyArgs) => {
        calls.messageFindMany.push(args);
        return opts.messages ?? [];
      }),
    },
  } as unknown as AdminPrisma;

  return { prisma, calls };
}

function makeUserRow(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: "u_default",
    phone: "+15550000000",
    displayName: null,
    status: "ACTIVE",
    onboardingStep: null,
    reportCount: 0,
    isAiBacked: false,
    createdAt: new Date("2026-05-01T00:00:00Z"),
    ...overrides,
  };
}

// ─── listUsers — limit clamping ───────────────────────────────────────────

describe("listUsers — limit clamping", () => {
  it("defaults to limit 25 when undefined and over-fetches by one (take: 26)", async () => {
    const m = makeMock();
    await listUsers(m.prisma);
    expect(m.calls.userFindMany).toHaveLength(1);
    expect(m.calls.userFindMany[0]!.take).toBe(26);
  });

  it("clamps limit=0 up to 1 (take: 2)", async () => {
    const m = makeMock();
    await listUsers(m.prisma, { limit: 0 });
    expect(m.calls.userFindMany[0]!.take).toBe(2);
  });

  it("clamps a negative limit up to 1 (take: 2)", async () => {
    const m = makeMock();
    await listUsers(m.prisma, { limit: -10 });
    expect(m.calls.userFindMany[0]!.take).toBe(2);
  });

  it("clamps an oversized limit down to 100 (take: 101)", async () => {
    const m = makeMock();
    await listUsers(m.prisma, { limit: 1000 });
    expect(m.calls.userFindMany[0]!.take).toBe(101);
  });

  it("honors an in-range explicit limit (take: limit + 1)", async () => {
    const m = makeMock();
    await listUsers(m.prisma, { limit: 50 });
    expect(m.calls.userFindMany[0]!.take).toBe(51);
  });

  it("the boundary value 100 is preserved (take: 101)", async () => {
    const m = makeMock();
    await listUsers(m.prisma, { limit: 100 });
    expect(m.calls.userFindMany[0]!.take).toBe(101);
  });

  it("the boundary value 1 is preserved (take: 2)", async () => {
    const m = makeMock();
    await listUsers(m.prisma, { limit: 1 });
    expect(m.calls.userFindMany[0]!.take).toBe(2);
  });
});

// ─── listUsers — where + orderBy + select ────────────────────────────────

describe("listUsers — where + orderBy + select", () => {
  it("omits the where filter entirely when no status is supplied", async () => {
    const m = makeMock();
    await listUsers(m.prisma);
    expect(m.calls.userFindMany[0]!.where).toBeUndefined();
  });

  it("omits the where filter when status is explicit null", async () => {
    const m = makeMock();
    await listUsers(m.prisma, { status: null });
    expect(m.calls.userFindMany[0]!.where).toBeUndefined();
  });

  it("filters by status when provided", async () => {
    const m = makeMock();
    await listUsers(m.prisma, { status: "BANNED" });
    expect(m.calls.userFindMany[0]!.where).toEqual({ status: "BANNED" });
  });

  it("orders by createdAt descending (newest users first)", async () => {
    const m = makeMock();
    await listUsers(m.prisma);
    expect(m.calls.userFindMany[0]!.orderBy).toEqual({ createdAt: "desc" });
  });

  it("pins the select shape — admin view columns only, no PII bleed", async () => {
    const m = makeMock();
    await listUsers(m.prisma);
    expect(m.calls.userFindMany[0]!.select).toEqual({
      id: true,
      phone: true,
      displayName: true,
      status: true,
      onboardingStep: true,
      reportCount: true,
      isAiBacked: true,
      createdAt: true,
    });
  });
});

// ─── listUsers — cursor pagination ───────────────────────────────────────

describe("listUsers — cursor pagination", () => {
  it("does not pass skip or cursor when no cursor is supplied", async () => {
    const m = makeMock();
    await listUsers(m.prisma);
    expect(m.calls.userFindMany[0]!.skip).toBeUndefined();
    expect(m.calls.userFindMany[0]!.cursor).toBeUndefined();
  });

  it("does not pass skip or cursor when cursor is explicit null", async () => {
    const m = makeMock();
    await listUsers(m.prisma, { cursor: null });
    expect(m.calls.userFindMany[0]!.skip).toBeUndefined();
    expect(m.calls.userFindMany[0]!.cursor).toBeUndefined();
  });

  it("passes skip: 1 (so the cursor row is not duplicated) when cursor is set", async () => {
    const m = makeMock();
    await listUsers(m.prisma, { cursor: "u_42" });
    expect(m.calls.userFindMany[0]!.skip).toBe(1);
    expect(m.calls.userFindMany[0]!.cursor).toEqual({ id: "u_42" });
  });
});

// ─── listUsers — nextCursor semantics ────────────────────────────────────

describe("listUsers — nextCursor semantics", () => {
  it("returns nextCursor=null when fewer rows came back than the limit", async () => {
    const rows = [makeUserRow({ id: "u_1" }), makeUserRow({ id: "u_2" })];
    const m = makeMock({ users: rows });
    const out = await listUsers(m.prisma, { limit: 25 });
    expect(out.nextCursor).toBeNull();
    expect(out.users.map((u) => u.id)).toEqual(["u_1", "u_2"]);
  });

  it("returns nextCursor=null when rows exactly equals the limit (over-fetch caught nothing extra)", async () => {
    const rows = [
      makeUserRow({ id: "u_1" }),
      makeUserRow({ id: "u_2" }),
    ];
    const m = makeMock({ users: rows });
    const out = await listUsers(m.prisma, { limit: 2 });
    expect(out.nextCursor).toBeNull();
    expect(out.users).toHaveLength(2);
  });

  it("returns nextCursor=rows[limit-1].id when the over-fetch found one extra row", async () => {
    const rows = [
      makeUserRow({ id: "u_1" }),
      makeUserRow({ id: "u_2" }),
      makeUserRow({ id: "u_3" }),
    ];
    const m = makeMock({ users: rows });
    const out = await listUsers(m.prisma, { limit: 2 });
    expect(out.nextCursor).toBe("u_2");
    expect(out.users.map((u) => u.id)).toEqual(["u_1", "u_2"]);
  });

  it("slices off the over-fetched extra row so the user-facing page size is exactly `limit`", async () => {
    const rows = Array.from({ length: 6 }, (_, i) =>
      makeUserRow({ id: `u_${i + 1}` }),
    );
    const m = makeMock({ users: rows });
    const out = await listUsers(m.prisma, { limit: 5 });
    expect(out.users).toHaveLength(5);
    expect(out.nextCursor).toBe("u_5");
    expect(out.users.map((u) => u.id)).toEqual([
      "u_1",
      "u_2",
      "u_3",
      "u_4",
      "u_5",
    ]);
  });
});

// ─── getConversation ─────────────────────────────────────────────────────

describe("getConversation", () => {
  it("returns null and does NOT query messages when the match is missing", async () => {
    const m = makeMock({ match: null });
    const out = await getConversation(m.prisma, "m_missing");
    expect(out).toBeNull();
    expect(m.calls.matchFindUnique).toHaveLength(1);
    expect(m.calls.messageFindMany).toHaveLength(0);
  });

  it("looks the match up by id with the documented select shape (no body bleed on the match row)", async () => {
    const m = makeMock({ match: null });
    await getConversation(m.prisma, "m_42");
    const args = m.calls.matchFindUnique[0]!;
    expect(args.where).toEqual({ id: "m_42" });
    expect(args.select).toEqual({
      id: true,
      matchDate: true,
      state: true,
      compatibilityScore: true,
      userA: { select: { id: true, phone: true, displayName: true } },
      userB: { select: { id: true, phone: true, displayName: true } },
    });
  });

  it("orders messages ascending so the moderator sees the conversation in real-time order", async () => {
    const match: MatchRow = {
      id: "m_1",
      matchDate: new Date("2026-05-17"),
      state: "ACTIVE",
      compatibilityScore: 0.8,
      userA: { id: "u_a", phone: "+1", displayName: "A" },
      userB: { id: "u_b", phone: "+2", displayName: "B" },
    };
    const m = makeMock({ match, messages: [] });
    await getConversation(m.prisma, "m_1");
    expect(m.calls.messageFindMany).toHaveLength(1);
    expect(m.calls.messageFindMany[0]!.orderBy).toEqual({ createdAt: "asc" });
    expect(m.calls.messageFindMany[0]!.where).toEqual({ matchId: "m_1" });
  });

  it("pins the message select shape — flagged-* booleans must remain visible to moderators", async () => {
    const match: MatchRow = {
      id: "m_1",
      matchDate: new Date("2026-05-17"),
      state: "ACTIVE",
      compatibilityScore: 0.8,
      userA: { id: "u_a", phone: "+1", displayName: "A" },
      userB: { id: "u_b", phone: "+2", displayName: "B" },
    };
    const m = makeMock({ match, messages: [] });
    await getConversation(m.prisma, "m_1");
    expect(m.calls.messageFindMany[0]!.select).toEqual({
      id: true,
      senderId: true,
      direction: true,
      body: true,
      depthScore: true,
      flaggedStatFishing: true,
      flaggedHarassment: true,
      createdAt: true,
    });
  });
});

// ─── banUser ─────────────────────────────────────────────────────────────

describe("banUser", () => {
  it("returns null and does NOT call update when the user is missing", async () => {
    const m = makeMock({ findUniqueUser: null });
    const out = await banUser(m.prisma, "u_missing");
    expect(out).toBeNull();
    expect(m.calls.userFindUnique).toHaveLength(1);
    expect(m.calls.userUpdate).toHaveLength(0);
  });

  it("writes status: BANNED and returns the prior status as `before`", async () => {
    const m = makeMock({ findUniqueUser: { status: "ACTIVE" } });
    const out = await banUser(m.prisma, "u_x");
    expect(m.calls.userUpdate).toHaveLength(1);
    expect(m.calls.userUpdate[0]!.where).toEqual({ id: "u_x" });
    expect(m.calls.userUpdate[0]!.data).toEqual({ status: "BANNED" });
    expect(out).toEqual({ before: "ACTIVE", after: "BANNED" });
  });

  it("preserves whatever prior status the lookup returned (e.g. PAUSED)", async () => {
    const m = makeMock({ findUniqueUser: { status: "PAUSED" } });
    const out = await banUser(m.prisma, "u_x");
    expect(out).toEqual({ before: "PAUSED", after: "BANNED" });
  });

  it("is idempotent on an already-BANNED user — before === after === BANNED", async () => {
    const m = makeMock({ findUniqueUser: { status: "BANNED" } });
    const out = await banUser(m.prisma, "u_x");
    expect(out).toEqual({ before: "BANNED", after: "BANNED" });
    expect(m.calls.userUpdate).toHaveLength(1);
  });

  it("reads only the status column on the lookup — no PII fetch for a ban", async () => {
    const m = makeMock({ findUniqueUser: { status: "ACTIVE" } });
    await banUser(m.prisma, "u_x");
    expect(m.calls.userFindUnique[0]!.select).toEqual({ status: true });
  });
});

// ─── unbanUser ───────────────────────────────────────────────────────────

describe("unbanUser", () => {
  it("returns null and does NOT call update when the user is missing", async () => {
    const m = makeMock({ findUniqueUser: null });
    const out = await unbanUser(m.prisma, "u_missing");
    expect(out).toBeNull();
    expect(m.calls.userUpdate).toHaveLength(0);
  });

  it("always restores to ACTIVE — even from BANNED", async () => {
    const m = makeMock({ findUniqueUser: { status: "BANNED" } });
    const out = await unbanUser(m.prisma, "u_x");
    expect(m.calls.userUpdate[0]!.data).toEqual({ status: "ACTIVE" });
    expect(out).toEqual({ before: "BANNED", after: "ACTIVE" });
  });

  it("does NOT special-case ONBOARDING — operator-documented behavior is to force ACTIVE", async () => {
    // Source comment (prisma-deps.ts:131-133): "Restoring to ACTIVE; if they
    // were mid-onboarding we leave that to operator judgment via direct DB
    // edits." If a refactor decides to be clever and route ONBOARDING back
    // to ONBOARDING, this test catches it.
    const m = makeMock({ findUniqueUser: { status: "ONBOARDING" } });
    const out = await unbanUser(m.prisma, "u_x");
    expect(m.calls.userUpdate[0]!.data).toEqual({ status: "ACTIVE" });
    expect(out).toEqual({ before: "ONBOARDING", after: "ACTIVE" });
  });

  it("does NOT special-case PAUSED — same forced-ACTIVE contract", async () => {
    const m = makeMock({ findUniqueUser: { status: "PAUSED" } });
    const out = await unbanUser(m.prisma, "u_x");
    expect(m.calls.userUpdate[0]!.data).toEqual({ status: "ACTIVE" });
    expect(out).toEqual({ before: "PAUSED", after: "ACTIVE" });
  });

  it("is idempotent on an already-ACTIVE user", async () => {
    const m = makeMock({ findUniqueUser: { status: "ACTIVE" } });
    const out = await unbanUser(m.prisma, "u_x");
    expect(out).toEqual({ before: "ACTIVE", after: "ACTIVE" });
    expect(m.calls.userUpdate).toHaveLength(1);
  });
});
