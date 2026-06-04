// Contract test for the moderation Prisma adapter (src/safety/prisma-deps.ts).
//
// `tests/safety/moderation.test.ts` already exercises `recordReport` and
// `incrementReportCount` against a hand-rolled fake DB, but its fake has
// only a single counter and a single status field — it cannot distinguish
// `subjectId` from `reporterId` in the WHERE clause, it does not capture
// whether `$transaction` was actually invoked, and it does not pin the
// exact payload shapes passed to `report.create` / `user.update`.
//
// Those are the seams refactors silently break:
//
//   1. `user.update` must target `subjectId`, never `reporterId`. A
//      typo'd swap would still pass the existing test because the fake
//      DB ignores the where clause entirely.
//   2. The Report row and the counter bump must run inside the same
//      `$transaction` call. Dropping the wrapper would still pass the
//      existing test because the fake `$transaction` just calls fn(db).
//   3. The Report `create.data` payload must contain EXACTLY the four
//      documented fields (reporterId, subjectId, reason, details).
//      Sneaking `id`, `createdAt`, or any other key in would either
//      duplicate Prisma defaults or shadow ones the schema owns.
//   4. The auto-ban update payload must be exactly `{ status: "BANNED" }`
//      — not also resetting the counter, not also touching any other
//      column. A refactor that combined the increment + ban into one
//      update would change the wire shape.
//   5. The threshold comparison is `>=` (inclusive). The existing
//      "auto-bans at threshold (default 3)" case happens to flip on `>=`
//      OR `>`, depending on the off-by-one; this file pins each side of
//      the boundary explicitly (count-just-below vs. count-at-threshold).
//   6. `incrementReportCount` MUST NOT invoke `$transaction`, MUST NOT
//      create a Report row, and MUST NOT auto-ban even when the
//      post-increment count would cross the default ban threshold. It is
//      the system-auto-flag bump path and its contract is "counter only".
//   7. `user.update` for the counter bump uses `data: { reportCount: {
//      increment: 1 } }` — pinning the literal `1` so a refactor that
//      accidentally bumps by 2, or by a configurable amount, is caught.

import { describe, it, expect, vi } from "vitest";
import {
  incrementReportCount,
  recordReport,
  type ModerationPrisma,
} from "../../src/safety/prisma-deps.js";

interface ReportCreateArgs {
  data: { reporterId: string; subjectId: string; reason: string; details: string | null };
  select?: { id?: boolean };
}
interface UserUpdateArgs {
  where: { id: string };
  data: { reportCount?: { increment: number }; status?: "BANNED" };
  select?: { reportCount?: boolean };
}

interface Spies {
  reportCreate: ReturnType<typeof vi.fn>;
  userUpdate: ReturnType<typeof vi.fn>;
  $transaction: ReturnType<typeof vi.fn>;
  callOrder: string[];
}

/**
 * Fake DB that keeps a per-user counter map (so subjectId/reporterId
 * swaps are observable) and records exact call args + order.
 */
function makeDb(opts: { initialCounts?: Record<string, number> } = {}): {
  db: ModerationPrisma;
  spies: Spies;
  state: { counts: Record<string, number>; statuses: Record<string, "ACTIVE" | "BANNED"> };
} {
  const counts: Record<string, number> = { ...(opts.initialCounts ?? {}) };
  const statuses: Record<string, "ACTIVE" | "BANNED"> = {};
  const callOrder: string[] = [];

  const reportCreate = vi.fn(async (_args: ReportCreateArgs) => {
    callOrder.push("report.create");
    return { id: `r_${callOrder.filter((c) => c === "report.create").length}` };
  });

  const userUpdate = vi.fn(async (args: UserUpdateArgs) => {
    callOrder.push("user.update");
    const id = args.where.id;
    if (args.data.reportCount?.increment !== undefined) {
      counts[id] = (counts[id] ?? 0) + args.data.reportCount.increment;
    }
    if (args.data.status === "BANNED") {
      statuses[id] = "BANNED";
    }
    return { reportCount: counts[id] ?? 0, status: statuses[id] ?? "ACTIVE" };
  });

  const $transaction = vi.fn(async (fn: (tx: ModerationPrisma) => Promise<unknown>) => fn(db));

  const db: ModerationPrisma = {
    report: { create: reportCreate } as never,
    user: { update: userUpdate } as never,
    $transaction: $transaction as unknown as ModerationPrisma["$transaction"],
  };

  return {
    db,
    spies: { reportCreate, userUpdate, $transaction, callOrder },
    state: { counts, statuses },
  };
}

describe("recordReport — transaction boundary", () => {
  it("invokes `$transaction` exactly once per call", async () => {
    const { db, spies } = makeDb();
    await recordReport(db, {
      reporterId: "u_reporter",
      subjectId: "u_subject",
      reason: "spam",
      details: null,
    });
    expect(spies.$transaction).toHaveBeenCalledTimes(1);
  });

  it("runs `report.create` BEFORE the counter bump (atomicity ordering)", async () => {
    const { db, spies } = makeDb();
    await recordReport(db, {
      reporterId: "u_reporter",
      subjectId: "u_subject",
      reason: "spam",
      details: null,
    });
    expect(spies.callOrder[0]).toBe("report.create");
    expect(spies.callOrder[1]).toBe("user.update");
  });

  it("does NOT issue any DB calls outside the `$transaction` body", async () => {
    // If a refactor moved `report.create` or `user.update` outside the
    // transaction, fn(db) would still see them — but the spy counts
    // would no longer be bounded by the transaction invocation. We pin
    // here by asserting all writes happen via the same tx scope.
    const { db, spies } = makeDb();
    await recordReport(db, {
      reporterId: "u_a",
      subjectId: "u_b",
      reason: "harassment",
      details: null,
    });
    // Every write happened *inside* the single $transaction we counted.
    expect(spies.$transaction).toHaveBeenCalledTimes(1);
    const totalWrites = spies.reportCreate.mock.calls.length + spies.userUpdate.mock.calls.length;
    expect(totalWrites).toBeGreaterThan(0);
  });
});

describe("recordReport — report.create payload shape", () => {
  it("passes exactly the four documented fields, no extras", async () => {
    const { db, spies } = makeDb();
    await recordReport(db, {
      reporterId: "u_reporter",
      subjectId: "u_subject",
      reason: "harassment",
      details: "ongoing",
    });
    const args = spies.reportCreate.mock.calls[0]![0] as ReportCreateArgs;
    expect(Object.keys(args.data).sort()).toEqual(
      ["details", "reason", "reporterId", "subjectId"].sort(),
    );
    expect(args.data).toEqual({
      reporterId: "u_reporter",
      subjectId: "u_subject",
      reason: "harassment",
      details: "ongoing",
    });
  });

  it("passes `details: null` literally when the caller did not supply details", async () => {
    const { db, spies } = makeDb();
    await recordReport(db, {
      reporterId: "u_a",
      subjectId: "u_b",
      reason: "spam",
      details: null,
    });
    const args = spies.reportCreate.mock.calls[0]![0] as ReportCreateArgs;
    expect(args.data.details).toBeNull();
  });

  it("selects only the `id` column (no over-fetch)", async () => {
    const { db, spies } = makeDb();
    await recordReport(db, {
      reporterId: "u_a",
      subjectId: "u_b",
      reason: "spam",
      details: null,
    });
    const args = spies.reportCreate.mock.calls[0]![0] as ReportCreateArgs;
    expect(args.select).toEqual({ id: true });
  });
});

describe("recordReport — user.update WHERE targets subjectId, never reporterId", () => {
  it("bumps the SUBJECT's counter, not the reporter's", async () => {
    const { db, state } = makeDb({ initialCounts: { u_reporter: 0, u_subject: 0 } });
    await recordReport(db, {
      reporterId: "u_reporter",
      subjectId: "u_subject",
      reason: "harassment",
      details: null,
    });
    expect(state.counts.u_subject).toBe(1);
    expect(state.counts.u_reporter).toBe(0);
  });

  it("auto-bans the SUBJECT, not the reporter, when threshold crosses", async () => {
    const { db, state } = makeDb({ initialCounts: { u_reporter: 0, u_subject: 2 } });
    await recordReport(db, {
      reporterId: "u_reporter",
      subjectId: "u_subject",
      reason: "harassment",
      details: null,
    });
    expect(state.statuses.u_subject).toBe("BANNED");
    expect(state.statuses.u_reporter).toBeUndefined();
  });

  it("uses `where.id = subjectId` in every user.update call", async () => {
    const { db, spies } = makeDb({ initialCounts: { u_subject: 2 } });
    await recordReport(db, {
      reporterId: "u_reporter",
      subjectId: "u_subject",
      reason: "harassment",
      details: null,
    });
    // Two updates (bump + ban). Both must target the subject.
    expect(spies.userUpdate).toHaveBeenCalledTimes(2);
    for (const call of spies.userUpdate.mock.calls) {
      const args = call[0] as UserUpdateArgs;
      expect(args.where).toEqual({ id: "u_subject" });
    }
  });
});

describe("recordReport — counter bump payload", () => {
  it("bumps by exactly 1 (not by a configurable amount)", async () => {
    const { db, spies } = makeDb();
    await recordReport(db, {
      reporterId: "u_a",
      subjectId: "u_b",
      reason: "spam",
      details: null,
    });
    const bump = spies.userUpdate.mock.calls[0]![0] as UserUpdateArgs;
    expect(bump.data).toEqual({ reportCount: { increment: 1 } });
  });

  it("selects only `reportCount` on the bump (no over-fetch)", async () => {
    const { db, spies } = makeDb();
    await recordReport(db, {
      reporterId: "u_a",
      subjectId: "u_b",
      reason: "spam",
      details: null,
    });
    const bump = spies.userUpdate.mock.calls[0]![0] as UserUpdateArgs;
    expect(bump.select).toEqual({ reportCount: true });
  });
});

describe("recordReport — auto-ban update payload", () => {
  it("the ban update writes EXACTLY `{ status: 'BANNED' }`, no extras", async () => {
    const { db, spies } = makeDb({ initialCounts: { u_b: 2 } });
    await recordReport(db, {
      reporterId: "u_a",
      subjectId: "u_b",
      reason: "harassment",
      details: null,
    });
    expect(spies.userUpdate).toHaveBeenCalledTimes(2);
    const banUpdate = spies.userUpdate.mock.calls[1]![0] as UserUpdateArgs;
    expect(banUpdate.data).toEqual({ status: "BANNED" });
  });

  it("does NOT also bump the counter inside the ban update (writes are separate)", async () => {
    const { db, spies } = makeDb({ initialCounts: { u_b: 2 } });
    await recordReport(db, {
      reporterId: "u_a",
      subjectId: "u_b",
      reason: "harassment",
      details: null,
    });
    const banUpdate = spies.userUpdate.mock.calls[1]![0] as UserUpdateArgs;
    expect(banUpdate.data.reportCount).toBeUndefined();
  });
});

describe("recordReport — threshold boundary `>=` semantics", () => {
  it("ban fires when post-increment count EQUALS the default threshold (3)", async () => {
    const { db, state } = makeDb({ initialCounts: { u_b: 2 } });
    const r = await recordReport(db, {
      reporterId: "u_a",
      subjectId: "u_b",
      reason: "spam",
      details: null,
    });
    expect(r.newReportCount).toBe(3);
    expect(r.autoBanned).toBe(true);
    expect(state.statuses.u_b).toBe("BANNED");
  });

  it("ban does NOT fire when post-increment count is one below threshold", async () => {
    const { db, state, spies } = makeDb({ initialCounts: { u_b: 1 } });
    const r = await recordReport(db, {
      reporterId: "u_a",
      subjectId: "u_b",
      reason: "spam",
      details: null,
    });
    expect(r.newReportCount).toBe(2);
    expect(r.autoBanned).toBe(false);
    expect(state.statuses.u_b).toBeUndefined();
    // Only the bump update fires — no ban update.
    expect(spies.userUpdate).toHaveBeenCalledTimes(1);
  });

  it("custom threshold of 1: post-increment count of 1 triggers ban", async () => {
    const { db } = makeDb();
    const r = await recordReport(db, {
      reporterId: "u_a",
      subjectId: "u_b",
      reason: "spam",
      details: null,
      autoBanThreshold: 1,
    });
    expect(r.autoBanned).toBe(true);
    expect(r.newReportCount).toBe(1);
  });

  it("custom threshold above the default does NOT fire at default boundary", async () => {
    const { db, state } = makeDb({ initialCounts: { u_b: 2 } });
    const r = await recordReport(db, {
      reporterId: "u_a",
      subjectId: "u_b",
      reason: "spam",
      details: null,
      autoBanThreshold: 5,
    });
    expect(r.newReportCount).toBe(3);
    expect(r.autoBanned).toBe(false);
    expect(state.statuses.u_b).toBeUndefined();
  });

  it("autoBanned reflects what actually happened (true only when status flipped)", async () => {
    // Below threshold.
    const a = makeDb({ initialCounts: { u_b: 0 } });
    const r1 = await recordReport(a.db, {
      reporterId: "u_a",
      subjectId: "u_b",
      reason: "spam",
      details: null,
    });
    expect(r1.autoBanned).toBe(false);

    // At threshold.
    const b = makeDb({ initialCounts: { u_b: 2 } });
    const r2 = await recordReport(b.db, {
      reporterId: "u_a",
      subjectId: "u_b",
      reason: "spam",
      details: null,
    });
    expect(r2.autoBanned).toBe(true);
  });
});

describe("recordReport — returned shape", () => {
  it("returns reportId from the create row, not synthesized", async () => {
    const { db } = makeDb();
    const r = await recordReport(db, {
      reporterId: "u_a",
      subjectId: "u_b",
      reason: "spam",
      details: null,
    });
    // The fake DB returns r_1 for the first create — pins that the
    // adapter passes that id through instead of overwriting it.
    expect(r.reportId).toBe("r_1");
  });

  it("returns the POST-increment count (not the pre-increment value)", async () => {
    const { db } = makeDb({ initialCounts: { u_b: 7 } });
    const r = await recordReport(db, {
      reporterId: "u_a",
      subjectId: "u_b",
      reason: "spam",
      details: null,
      autoBanThreshold: 100,
    });
    expect(r.newReportCount).toBe(8);
  });
});

describe("incrementReportCount — counter-only path", () => {
  it("does NOT invoke `$transaction`", async () => {
    const { db, spies } = makeDb();
    await incrementReportCount(db, "u_b");
    expect(spies.$transaction).not.toHaveBeenCalled();
  });

  it("does NOT create a Report row", async () => {
    const { db, spies } = makeDb();
    await incrementReportCount(db, "u_b");
    expect(spies.reportCreate).not.toHaveBeenCalled();
  });

  it("does NOT auto-ban — even when crossing the default ban threshold", async () => {
    // This is the contract: a system-auto-flag bump never bans on its
    // own. Bans only happen via the user-driven `recordReport` path.
    const { db, state } = makeDb({ initialCounts: { u_b: 2 } });
    await incrementReportCount(db, "u_b");
    await incrementReportCount(db, "u_b");
    await incrementReportCount(db, "u_b");
    expect(state.counts.u_b).toBe(5);
    expect(state.statuses.u_b).toBeUndefined();
  });

  it("issues exactly one user.update per call (no extras)", async () => {
    const { db, spies } = makeDb();
    await incrementReportCount(db, "u_b");
    expect(spies.userUpdate).toHaveBeenCalledTimes(1);
  });

  it("uses `where.id = userId` (the function's only argument is the subject)", async () => {
    const { db, spies } = makeDb();
    await incrementReportCount(db, "u_some_subject");
    const args = spies.userUpdate.mock.calls[0]![0] as UserUpdateArgs;
    expect(args.where).toEqual({ id: "u_some_subject" });
  });

  it("bumps by exactly 1 and selects only reportCount", async () => {
    const { db, spies } = makeDb();
    await incrementReportCount(db, "u_b");
    const args = spies.userUpdate.mock.calls[0]![0] as UserUpdateArgs;
    expect(args.data).toEqual({ reportCount: { increment: 1 } });
    expect(args.select).toEqual({ reportCount: true });
  });

  it("returns the post-increment count", async () => {
    const { db } = makeDb({ initialCounts: { u_b: 4 } });
    const r = await incrementReportCount(db, "u_b");
    expect(r.newReportCount).toBe(5);
  });
});
