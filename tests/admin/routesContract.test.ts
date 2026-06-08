// Wire-format contract pins for `src/admin/routes.ts`.
//
// What this file pins, and why none of it is redundant with the existing
// `tests/admin/routes.test.ts` (which covers happy paths + auth gating only):
//
//   1. **`/admin/run-daily-match` projection mapping.** The route does NOT
//      pass the underlying `runDailyMatch` result straight through. It
//      projects six fields, two of which are derived counts:
//        - `selected` (array)  → `selectedCount` (number)  [renamed AND counted]
//        - `notified` (array)  → `notified` (number)       [SAME name, counted]
//        - `candidates`, `createdMatchIds`, `notifyErrors` pass through
//      An admin dashboard that did `body.notified[0].phone` would break the
//      moment someone "simplified" the route to forward the raw result.
//      Existing tests only check the empty case where every count is 0 —
//      the count-vs-array distinction is invisible.
//
//   2. **`/admin/invites/bulk` count clamping.** `Math.max(1, Math.min(count
//      ?? 1, 200))` — the route clamps both ends. Existing tests pass
//      `count: 3` once. The clamp boundaries (0 → 1, negatives → 1, 1000 →
//      200, missing body → 1) are unique to the route layer and could be
//      lost in a refactor without breaking anything else.
//
//   3. **`/admin/invites/bulk` label whitespace handling.** `label?.trim()
//      || null` — a whitespace-only label becomes `null`, not the trimmed
//      empty string. This matters because the underlying `createInvite`
//      stores `label` verbatim in Postgres; empty strings would clutter
//      analytics that distinguish "labelled" vs "unlabelled" cohorts.
//
//   4. **`/admin/invites/bulk` returns 201, not 200.** Resource-creation
//      semantics — operators / clients may rely on the status code to
//      distinguish a created batch from a no-op. The existing test pins
//      201 once; we add coverage that the 201 holds even when the count
//      gets clamped (the clamp path could plausibly take a different
//      `reply.code()` branch in a refactor).
//
//   5. **`/admin/invites/bulk` response envelope shape.** Exact keys
//      `{ codes, unredeemed }` — nothing else. A refactor that added
//      `count` or `requested` would silently drift the wire format.
//
//   6. **404 error body shapes.** Three routes return a `404` with a body:
//        - `/admin/match/:id`        → `{ error: "match not found" }`
//        - `/admin/users/:id/ban`    → `{ error: "user not found" }`
//        - `/admin/users/:id/unban`  → `{ error: "user not found" }`
//      The existing tests assert the status code (404) but never the body.
//      A refactor that switched to `app.httpErrors.notFound(...)` (which
//      emits `{ statusCode, error, message }`) would compile, return 404,
//      and silently break any client that parses the body for the string.
//
//   7. **`/admin/users` querystring → `listUsers` argument forwarding.**
//      The route does `parseInt(limit, 10)`, falls back to `undefined`
//      when no limit, and converts `cursor` and `status` to `null` when
//      absent. These three normalisations happen at the route layer, not
//      inside `listUsers` — the prisma-deps contract test cannot see them.
//
//   8. **All admin endpoints share the auth gate.** Each route mounts
//      `preHandler: auth`. We pin this per-endpoint (not just on
//      `/admin/users` like the existing test) so that a copy-paste mistake
//      that dropped the preHandler from one new route is caught.

import { describe, it, expect, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import sensible from "@fastify/sensible";
import {
  registerAdminRoutes,
  type RegisterAdminOptions,
} from "../../src/admin/routes.js";
import { _resetEnvCacheForTests } from "../../src/config/env.js";
import type { AdminPrisma } from "../../src/admin/prisma-deps.js";
import type { InvitePrisma } from "../../src/invites/index.js";
import type { DailyMatchRunResult } from "../../src/scheduler/index.js";

// ─── Test-app builder ────────────────────────────────────────────────────
//
// The HTTP-route contract test deliberately does NOT use `buildApp`. We
// want to isolate the route layer from the scheduler/twilio plumbing so
// that the `runDailyMatch` projection can be exercised against a
// hand-built result. Going through `buildApp` would force every test to
// thread a fake matching surface AND happen to produce the desired
// `selected[] / notified[] / notifyErrors[]` triple from the inside out.

interface BuildArgs {
  prisma: AdminPrisma & InvitePrisma;
  /** Result the decorated `runDailyMatch` should resolve with. */
  dailyMatchResult?: DailyMatchRunResult;
  /** Override the env token (defaults to "secret-token"). */
  adminToken?: string;
}

async function buildTestApp(args: BuildArgs): Promise<{
  app: FastifyInstance;
  runDailyMatchCalls: number;
}> {
  let runDailyMatchCalls = 0;
  process.env.NODE_ENV = "test";
  process.env.LOG_LEVEL = "fatal";
  process.env.ADMIN_TOKEN = args.adminToken ?? "secret-token";
  _resetEnvCacheForTests();

  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate("runDailyMatch", async () => {
    runDailyMatchCalls += 1;
    return (
      args.dailyMatchResult ?? {
        candidates: 0,
        selected: [],
        createdMatchIds: [],
        notified: [],
        notifyErrors: [],
      }
    );
  });
  const opts: RegisterAdminOptions = { deps: { prisma: args.prisma } };
  await registerAdminRoutes(app, opts);
  await app.ready();
  return {
    app,
    get runDailyMatchCalls() {
      return runDailyMatchCalls;
    },
  };
}

// ─── Minimal fake DB ─────────────────────────────────────────────────────

interface FakeUser {
  id: string;
  status: "ACTIVE" | "ONBOARDING" | "PAUSED" | "BANNED";
}

interface FakeInvite {
  id: string;
  code: string;
  label: string | null;
}

interface ListUsersCall {
  where?: { status?: string } | undefined;
  take?: number;
  skip?: number;
  cursor?: { id: string };
}

interface FakeDb {
  prisma: AdminPrisma & InvitePrisma;
  calls: {
    listUsers: ListUsersCall[];
    matchFindUnique: Array<{ id: string }>;
    inviteCreate: Array<{ code: string; label: string | null }>;
    inviteCountWhere: Array<unknown>;
  };
  invites: FakeInvite[];
}

function makeDb(opts: {
  users?: FakeUser[];
  match?: { id: string } | null;
  userFindUnique?: { status: FakeUser["status"] } | null;
} = {}): FakeDb {
  const users = opts.users ?? [];
  const invites: FakeInvite[] = [];
  const calls: FakeDb["calls"] = {
    listUsers: [],
    matchFindUnique: [],
    inviteCreate: [],
    inviteCountWhere: [],
  };
  const prisma = {
    user: {
      findMany: vi.fn(async (args: ListUsersCall) => {
        calls.listUsers.push(args);
        // Honour `take` so listUsers' over-fetch nextCursor logic works.
        const take = args.take ?? users.length;
        return users
          .slice(0, take)
          .map((u) => ({
            id: u.id,
            phone: "+15550000000",
            displayName: null,
            status: u.status,
            onboardingStep: null,
            reportCount: 0,
            isAiBacked: false,
            createdAt: new Date("2026-05-01T00:00:00Z"),
          }));
      }),
      findUnique: vi.fn(async () => {
        return opts.userFindUnique === undefined ? null : opts.userFindUnique;
      }),
      update: vi.fn(async ({ data }: { data: { status: FakeUser["status"] } }) => {
        return { status: data.status };
      }),
    },
    dailyMatch: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        calls.matchFindUnique.push(where);
        return opts.match === undefined ? null : opts.match;
      }),
    },
    message: {
      findMany: vi.fn(async () => []),
    },
    inviteCode: {
      create: vi.fn(
        async ({ data }: { data: { code: string; label: string | null } }) => {
          calls.inviteCreate.push(data);
          const row: FakeInvite = {
            id: `i_${invites.length + 1}`,
            code: data.code,
            label: data.label,
          };
          invites.push(row);
          return { id: row.id, code: row.code };
        },
      ),
      count: vi.fn(async ({ where }: { where: unknown }) => {
        calls.inviteCountWhere.push(where);
        return invites.length;
      }),
    },
    $transaction: (async <T>(fn: (tx: unknown) => Promise<T>) => fn(prisma)) as never,
  } as unknown as AdminPrisma & InvitePrisma;
  return { prisma, calls, invites };
}

const AUTH = { "x-admin-token": "secret-token" } as const;

// ─── /admin/run-daily-match — projection mapping ─────────────────────────

describe("/admin/run-daily-match — projection mapping", () => {
  it("derives selectedCount from result.selected.length (rename + array → number)", async () => {
    const db = makeDb();
    const { app } = await buildTestApp({
      prisma: db.prisma,
      dailyMatchResult: {
        candidates: 7,
        selected: [
          { userAId: "a1", userBId: "b1", score: 0.9 },
          { userAId: "a2", userBId: "b2", score: 0.8 },
          { userAId: "a3", userBId: "b3", score: 0.7 },
        ],
        createdMatchIds: ["m_1", "m_2", "m_3"],
        notified: ["+1", "+2", "+3", "+4"],
        notifyErrors: [],
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/admin/run-daily-match",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.selectedCount).toBe(3);
    // The raw `selected` array MUST NOT leak through.
    expect(body.selected).toBeUndefined();
    await app.close();
  });

  it("counts notified phones — emits a NUMBER, not the phone array", async () => {
    const db = makeDb();
    const { app } = await buildTestApp({
      prisma: db.prisma,
      dailyMatchResult: {
        candidates: 4,
        selected: [],
        createdMatchIds: [],
        notified: ["+15550000001", "+15550000002", "+15550000003"],
        notifyErrors: [],
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/admin/run-daily-match",
      headers: AUTH,
    });
    const body = res.json() as Record<string, unknown>;
    expect(body.notified).toBe(3);
    expect(typeof body.notified).toBe("number");
    await app.close();
  });

  it("passes notifyErrors through verbatim (array, not counted)", async () => {
    const db = makeDb();
    const errs = [
      { phone: "+15550000001", error: "timeout" },
      { phone: "+15550000002", error: "carrier rejected" },
    ];
    const { app } = await buildTestApp({
      prisma: db.prisma,
      dailyMatchResult: {
        candidates: 2,
        selected: [],
        createdMatchIds: [],
        notified: [],
        notifyErrors: errs,
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/admin/run-daily-match",
      headers: AUTH,
    });
    const body = res.json() as Record<string, unknown>;
    expect(body.notifyErrors).toEqual(errs);
  });

  it("passes candidates and createdMatchIds through verbatim", async () => {
    const db = makeDb();
    const { app } = await buildTestApp({
      prisma: db.prisma,
      dailyMatchResult: {
        candidates: 11,
        selected: [],
        createdMatchIds: ["m_a", "m_b"],
        notified: [],
        notifyErrors: [],
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/admin/run-daily-match",
      headers: AUTH,
    });
    const body = res.json() as Record<string, unknown>;
    expect(body.candidates).toBe(11);
    expect(body.createdMatchIds).toEqual(["m_a", "m_b"]);
  });

  it("response envelope is EXACTLY these 5 keys (no extra fields leak)", async () => {
    const db = makeDb();
    const { app } = await buildTestApp({ prisma: db.prisma });
    const res = await app.inject({
      method: "POST",
      url: "/admin/run-daily-match",
      headers: AUTH,
    });
    const body = res.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      [
        "candidates",
        "createdMatchIds",
        "notified",
        "notifyErrors",
        "selectedCount",
      ].sort(),
    );
  });

  it("empty run produces the canonical zero-shape", async () => {
    const db = makeDb();
    const { app } = await buildTestApp({ prisma: db.prisma });
    const res = await app.inject({
      method: "POST",
      url: "/admin/run-daily-match",
      headers: AUTH,
    });
    expect(res.json()).toEqual({
      candidates: 0,
      selectedCount: 0,
      createdMatchIds: [],
      notified: 0,
      notifyErrors: [],
    });
  });
});

// ─── /admin/invites/bulk — count clamping ────────────────────────────────

describe("/admin/invites/bulk — count clamping", () => {
  it("clamps count=0 up to 1 (creates exactly one invite)", async () => {
    const db = makeDb();
    const { app } = await buildTestApp({ prisma: db.prisma });
    const res = await app.inject({
      method: "POST",
      url: "/admin/invites/bulk",
      headers: { ...AUTH, "content-type": "application/json" },
      payload: JSON.stringify({ count: 0 }),
    });
    expect(res.statusCode).toBe(201);
    expect(db.calls.inviteCreate).toHaveLength(1);
    const body = res.json() as { codes: unknown[] };
    expect(body.codes).toHaveLength(1);
    await app.close();
  });

  it("clamps negative count up to 1", async () => {
    const db = makeDb();
    const { app } = await buildTestApp({ prisma: db.prisma });
    const res = await app.inject({
      method: "POST",
      url: "/admin/invites/bulk",
      headers: { ...AUTH, "content-type": "application/json" },
      payload: JSON.stringify({ count: -10 }),
    });
    expect(res.statusCode).toBe(201);
    expect(db.calls.inviteCreate).toHaveLength(1);
    await app.close();
  });

  it("clamps an oversized count down to 200", async () => {
    const db = makeDb();
    const { app } = await buildTestApp({ prisma: db.prisma });
    const res = await app.inject({
      method: "POST",
      url: "/admin/invites/bulk",
      headers: { ...AUTH, "content-type": "application/json" },
      payload: JSON.stringify({ count: 100000 }),
    });
    expect(res.statusCode).toBe(201);
    expect(db.calls.inviteCreate).toHaveLength(200);
    const body = res.json() as { codes: unknown[] };
    expect(body.codes).toHaveLength(200);
    await app.close();
  });

  it("the boundary value 200 is preserved (no off-by-one in the upper clamp)", async () => {
    const db = makeDb();
    const { app } = await buildTestApp({ prisma: db.prisma });
    await app.inject({
      method: "POST",
      url: "/admin/invites/bulk",
      headers: { ...AUTH, "content-type": "application/json" },
      payload: JSON.stringify({ count: 200 }),
    });
    expect(db.calls.inviteCreate).toHaveLength(200);
    await app.close();
  });

  it("the boundary value 1 is preserved (no off-by-one in the lower clamp)", async () => {
    const db = makeDb();
    const { app } = await buildTestApp({ prisma: db.prisma });
    await app.inject({
      method: "POST",
      url: "/admin/invites/bulk",
      headers: { ...AUTH, "content-type": "application/json" },
      payload: JSON.stringify({ count: 1 }),
    });
    expect(db.calls.inviteCreate).toHaveLength(1);
    await app.close();
  });

  it("defaults count to 1 when body omits the field", async () => {
    const db = makeDb();
    const { app } = await buildTestApp({ prisma: db.prisma });
    const res = await app.inject({
      method: "POST",
      url: "/admin/invites/bulk",
      headers: { ...AUTH, "content-type": "application/json" },
      payload: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(201);
    expect(db.calls.inviteCreate).toHaveLength(1);
    await app.close();
  });
});

// ─── /admin/invites/bulk — label normalisation ───────────────────────────

describe("/admin/invites/bulk — label normalisation", () => {
  it("whitespace-only label is normalised to null (not stored as empty string)", async () => {
    const db = makeDb();
    const { app } = await buildTestApp({ prisma: db.prisma });
    await app.inject({
      method: "POST",
      url: "/admin/invites/bulk",
      headers: { ...AUTH, "content-type": "application/json" },
      payload: JSON.stringify({ count: 1, label: "   " }),
    });
    expect(db.calls.inviteCreate[0]!.label).toBeNull();
    await app.close();
  });

  it("empty-string label is normalised to null", async () => {
    const db = makeDb();
    const { app } = await buildTestApp({ prisma: db.prisma });
    await app.inject({
      method: "POST",
      url: "/admin/invites/bulk",
      headers: { ...AUTH, "content-type": "application/json" },
      payload: JSON.stringify({ count: 1, label: "" }),
    });
    expect(db.calls.inviteCreate[0]!.label).toBeNull();
    await app.close();
  });

  it("missing label is null", async () => {
    const db = makeDb();
    const { app } = await buildTestApp({ prisma: db.prisma });
    await app.inject({
      method: "POST",
      url: "/admin/invites/bulk",
      headers: { ...AUTH, "content-type": "application/json" },
      payload: JSON.stringify({ count: 1 }),
    });
    expect(db.calls.inviteCreate[0]!.label).toBeNull();
    await app.close();
  });

  it("real label is trimmed but preserved (leading/trailing whitespace stripped)", async () => {
    const db = makeDb();
    const { app } = await buildTestApp({ prisma: db.prisma });
    await app.inject({
      method: "POST",
      url: "/admin/invites/bulk",
      headers: { ...AUTH, "content-type": "application/json" },
      payload: JSON.stringify({ count: 1, label: "  launch-1  " }),
    });
    expect(db.calls.inviteCreate[0]!.label).toBe("launch-1");
    await app.close();
  });

  it("internal whitespace is preserved (only edges trimmed)", async () => {
    const db = makeDb();
    const { app } = await buildTestApp({ prisma: db.prisma });
    await app.inject({
      method: "POST",
      url: "/admin/invites/bulk",
      headers: { ...AUTH, "content-type": "application/json" },
      payload: JSON.stringify({ count: 1, label: "campus drop a" }),
    });
    expect(db.calls.inviteCreate[0]!.label).toBe("campus drop a");
    await app.close();
  });
});

// ─── /admin/invites/bulk — status code and response envelope ─────────────

describe("/admin/invites/bulk — response shape", () => {
  it("returns HTTP 201 Created (resource-creation semantics)", async () => {
    const db = makeDb();
    const { app } = await buildTestApp({ prisma: db.prisma });
    const res = await app.inject({
      method: "POST",
      url: "/admin/invites/bulk",
      headers: { ...AUTH, "content-type": "application/json" },
      payload: JSON.stringify({ count: 2 }),
    });
    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it("returns 201 even when the count is clamped (clamp path does NOT swap to 200)", async () => {
    const db = makeDb();
    const { app } = await buildTestApp({ prisma: db.prisma });
    const res = await app.inject({
      method: "POST",
      url: "/admin/invites/bulk",
      headers: { ...AUTH, "content-type": "application/json" },
      payload: JSON.stringify({ count: 0 }),
    });
    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it("response envelope is EXACTLY { codes, unredeemed } — no extra fields", async () => {
    const db = makeDb();
    const { app } = await buildTestApp({ prisma: db.prisma });
    const res = await app.inject({
      method: "POST",
      url: "/admin/invites/bulk",
      headers: { ...AUTH, "content-type": "application/json" },
      payload: JSON.stringify({ count: 2 }),
    });
    const body = res.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["codes", "unredeemed"]);
  });

  it("codes is an array of { id, code } rows, one per created invite", async () => {
    const db = makeDb();
    const { app } = await buildTestApp({ prisma: db.prisma });
    const res = await app.inject({
      method: "POST",
      url: "/admin/invites/bulk",
      headers: { ...AUTH, "content-type": "application/json" },
      payload: JSON.stringify({ count: 3 }),
    });
    const body = res.json() as { codes: Array<Record<string, unknown>> };
    expect(body.codes).toHaveLength(3);
    for (const row of body.codes) {
      expect(Object.keys(row).sort()).toEqual(["code", "id"]);
      expect(typeof row.code).toBe("string");
      expect(typeof row.id).toBe("string");
    }
  });

  it("unredeemed comes from countUnredeemed and is a number", async () => {
    const db = makeDb();
    const { app } = await buildTestApp({ prisma: db.prisma });
    const res = await app.inject({
      method: "POST",
      url: "/admin/invites/bulk",
      headers: { ...AUTH, "content-type": "application/json" },
      payload: JSON.stringify({ count: 4 }),
    });
    const body = res.json() as { unredeemed: number };
    expect(body.unredeemed).toBe(4);
    // countUnredeemed must filter `redeemedById: null` — pin that
    // the route invokes count() with the correct where clause.
    expect(db.calls.inviteCountWhere).toEqual([{ redeemedById: null }]);
    await app.close();
  });
});

// ─── 404 error body shapes ───────────────────────────────────────────────

describe("404 error bodies — exact JSON shape", () => {
  it("GET /admin/match/:id → { error: 'match not found' }", async () => {
    const db = makeDb({ match: null });
    const { app } = await buildTestApp({ prisma: db.prisma });
    const res = await app.inject({
      method: "GET",
      url: "/admin/match/nope",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "match not found" });
    await app.close();
  });

  it("POST /admin/users/:id/ban → { error: 'user not found' } when user is missing", async () => {
    const db = makeDb({ userFindUnique: null });
    const { app } = await buildTestApp({ prisma: db.prisma });
    const res = await app.inject({
      method: "POST",
      url: "/admin/users/nope/ban",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "user not found" });
    await app.close();
  });

  it("POST /admin/users/:id/unban → { error: 'user not found' } when user is missing", async () => {
    const db = makeDb({ userFindUnique: null });
    const { app } = await buildTestApp({ prisma: db.prisma });
    const res = await app.inject({
      method: "POST",
      url: "/admin/users/nope/unban",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "user not found" });
    await app.close();
  });

  it("404 bodies are distinct strings — match vs user — so dashboards can branch on them", async () => {
    const dbA = makeDb({ match: null });
    const a = await buildTestApp({ prisma: dbA.prisma });
    const dbB = makeDb({ userFindUnique: null });
    const b = await buildTestApp({ prisma: dbB.prisma });
    const matchRes = await a.app.inject({
      method: "GET",
      url: "/admin/match/x",
      headers: AUTH,
    });
    const userRes = await b.app.inject({
      method: "POST",
      url: "/admin/users/x/ban",
      headers: AUTH,
    });
    const matchBody = matchRes.json() as { error: string };
    const userBody = userRes.json() as { error: string };
    expect(matchBody.error).not.toBe(userBody.error);
    await a.app.close();
    await b.app.close();
  });
});

// ─── /admin/users querystring forwarding ─────────────────────────────────

describe("/admin/users — querystring → listUsers forwarding", () => {
  it("missing limit becomes undefined (not 0, not NaN) so the adapter's default kicks in", async () => {
    const db = makeDb();
    const { app } = await buildTestApp({ prisma: db.prisma });
    await app.inject({ method: "GET", url: "/admin/users", headers: AUTH });
    // listUsers default is limit=25 → take=26.
    expect(db.calls.listUsers[0]!.take).toBe(26);
    await app.close();
  });

  it("numeric limit is parsed via parseInt(_, 10) and forwarded", async () => {
    const db = makeDb();
    const { app } = await buildTestApp({ prisma: db.prisma });
    await app.inject({
      method: "GET",
      url: "/admin/users?limit=10",
      headers: AUTH,
    });
    expect(db.calls.listUsers[0]!.take).toBe(11); // over-fetch by one
    await app.close();
  });

  it("status querystring is forwarded as a where filter", async () => {
    const db = makeDb();
    const { app } = await buildTestApp({ prisma: db.prisma });
    await app.inject({
      method: "GET",
      url: "/admin/users?status=BANNED",
      headers: AUTH,
    });
    expect(db.calls.listUsers[0]!.where).toEqual({ status: "BANNED" });
    await app.close();
  });

  it("missing status produces no where clause (adapter sees undefined where)", async () => {
    const db = makeDb();
    const { app } = await buildTestApp({ prisma: db.prisma });
    await app.inject({ method: "GET", url: "/admin/users", headers: AUTH });
    expect(db.calls.listUsers[0]!.where).toBeUndefined();
    await app.close();
  });

  it("cursor querystring is forwarded with the inclusive-skip semantics", async () => {
    const db = makeDb();
    const { app } = await buildTestApp({ prisma: db.prisma });
    await app.inject({
      method: "GET",
      url: "/admin/users?cursor=u_42",
      headers: AUTH,
    });
    expect(db.calls.listUsers[0]!.cursor).toEqual({ id: "u_42" });
    expect(db.calls.listUsers[0]!.skip).toBe(1);
    await app.close();
  });

  it("missing cursor leaves skip and cursor undefined", async () => {
    const db = makeDb();
    const { app } = await buildTestApp({ prisma: db.prisma });
    await app.inject({ method: "GET", url: "/admin/users", headers: AUTH });
    expect(db.calls.listUsers[0]!.cursor).toBeUndefined();
    expect(db.calls.listUsers[0]!.skip).toBeUndefined();
    await app.close();
  });
});

// ─── Per-endpoint auth gate ──────────────────────────────────────────────
//
// We exercise the auth gate on EVERY admin path independently so a future
// route added without the `preHandler: auth` option is caught immediately
// instead of by an integration test that happens to test a different
// endpoint.

describe("auth gate is applied to every admin route", () => {
  it("GET /admin/users — 401 without header", async () => {
    const db = makeDb();
    const { app } = await buildTestApp({ prisma: db.prisma });
    const res = await app.inject({ method: "GET", url: "/admin/users" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("GET /admin/match/:id — 401 without header", async () => {
    const db = makeDb();
    const { app } = await buildTestApp({ prisma: db.prisma });
    const res = await app.inject({
      method: "GET",
      url: "/admin/match/anything",
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("POST /admin/users/:id/ban — 401 without header", async () => {
    const db = makeDb();
    const { app } = await buildTestApp({ prisma: db.prisma });
    const res = await app.inject({
      method: "POST",
      url: "/admin/users/u_x/ban",
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("POST /admin/users/:id/unban — 401 without header", async () => {
    const db = makeDb();
    const { app } = await buildTestApp({ prisma: db.prisma });
    const res = await app.inject({
      method: "POST",
      url: "/admin/users/u_x/unban",
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("POST /admin/run-daily-match — 401 without header (and does NOT invoke the decorator)", async () => {
    const db = makeDb();
    const test = await buildTestApp({ prisma: db.prisma });
    const res = await test.app.inject({
      method: "POST",
      url: "/admin/run-daily-match",
    });
    expect(res.statusCode).toBe(401);
    // Critical: the auth gate runs BEFORE the route handler, so the
    // decorator (which would actually trigger a daily-match cycle in
    // production) must not have been called.
    expect(test.runDailyMatchCalls).toBe(0);
    await test.app.close();
  });

  it("POST /admin/invites/bulk — 401 without header (and does NOT create any invites)", async () => {
    const db = makeDb();
    const { app } = await buildTestApp({ prisma: db.prisma });
    const res = await app.inject({
      method: "POST",
      url: "/admin/invites/bulk",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ count: 5 }),
    });
    expect(res.statusCode).toBe(401);
    expect(db.calls.inviteCreate).toHaveLength(0);
    await app.close();
  });

  it("401 error envelope is { error: 'unauthorized' } verbatim", async () => {
    const db = makeDb();
    const { app } = await buildTestApp({ prisma: db.prisma });
    const res = await app.inject({ method: "GET", url: "/admin/users" });
    expect(res.json()).toEqual({ error: "unauthorized" });
    await app.close();
  });

  it("503 (admin disabled) envelope is { error: 'admin disabled' } verbatim", async () => {
    const db = makeDb();
    const { app } = await buildTestApp({ prisma: db.prisma, adminToken: "" });
    const res = await app.inject({
      method: "GET",
      url: "/admin/users",
      headers: { "x-admin-token": "anything" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "admin disabled" });
    await app.close();
  });
});
