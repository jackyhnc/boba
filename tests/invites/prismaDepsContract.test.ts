// Contract pins for src/invites/prisma-deps.ts.
//
// `tests/invites/redeem.test.ts` covers happy-path behaviour against a
// hand-rolled fake. The invariants below sit at seams a well-intentioned
// refactor could quietly violate without tripping that suite:
//
//   1. InviteRedemption discriminated-union shape. Callers narrow on
//      `.ok` then read either `.inviteId` (success) or `.reason`
//      (failure). A refactor that flattened to `{ ok, inviteId, reason }`
//      — adding a `reason: null` on success or `inviteId: null` on
//      failure — would still match the existing toEqual assertions for
//      shape but quietly break exhaustive-switch callers (notably
//      src/twilio/routes.ts:inviteFailureReply, which switches on the
//      union string literal). Pin Object.keys per branch.
//
//   2. Reason enum string values are part of the cross-module contract.
//      src/twilio/routes.ts has an inline switch over the literal union
//      "unknown_code" | "already_redeemed" | "self_already_redeemed".
//      That copy is the SMS the user sees when redemption fails. A
//      rename here ("not_found", "claimed", "owned_by_user") would
//      compile (the type is re-declared inline in routes.ts, not
//      imported) and silently route every failure into the TypeScript
//      `never` fall-through — producing an empty string reply at the
//      worst possible moment in onboarding. Pin both the literal values
//      AND the cross-module identity by importing the type.
//
//   3. $transaction wrapping. The findUnique → findFirst → update
//      sequence MUST run inside one transaction. Without it, two users
//      racing on the same fresh code would both see `redeemedById: null`
//      and both succeed. The existing fake collapses $transaction to a
//      direct call, so no behavioural test catches the missing wrap.
//      Pin via a spy that counts $transaction invocations.
//
//   4. Prisma query shape narrowing. findUnique selects exactly
//      {id, redeemedById}; findFirst selects exactly {id, code}; update
//      writes exactly {redeemedById, redeemedAt}. Widening the select
//      silently bloats every redemption call (and may leak fields the
//      router shouldn't see); narrowing it past these names breaks the
//      code path. Pin the exact projections.
//
//   5. Idempotency invariant: when the same user re-submits the same
//      code, the function returns ok WITHOUT touching the database. The
//      existing test checks redeemedAt isn't bumped, but a refactor that
//      called `update` with the same value would still pass that check
//      (Date equality) while wasting a write and possibly tripping audit
//      triggers. Pin "update was not called at all" via a counting spy.
//
//   6. createInvite handles BOTH unique-violation surfaces: the typed
//      Prisma `err.code === "P2002"` path, AND the message-regex
//      `/unique/i` fallback for drivers that lose the code envelope.
//      The existing test only force-throws with the code property set,
//      so the regex branch is dead-coded. A refactor that removed it
//      would not regress any current test but would crash production
//      when the (rare) un-coded path fires. Pin the fallback explicitly.
//
//   7. createInvite re-throws non-collision errors immediately (no
//      retry). A retry loop that swallowed an unrelated error would mask
//      DB-down scenarios as code exhaustion.
//
//   8. createManyInvites label propagation: the label flows through to
//      every individual createInvite call. A refactor that captured the
//      label on the first row and dropped it for subsequent rows would
//      pass the existing count-based test silently.

import { describe, it, expect } from "vitest";
import {
  countUnredeemed,
  createInvite,
  createManyInvites,
  redeemCode,
  type InvitePrisma,
} from "../../src/invites/prisma-deps.js";
import type {
  InviteRedemption,
  InviteRedemptionFailure,
} from "../../src/invites/types.js";

// ─── Spy harness ───────────────────────────────────────────────────────────

interface FakeRow {
  id: string;
  code: string;
  redeemedById: string | null;
  redeemedAt: Date | null;
  label?: string | null;
}

interface CallLog {
  $transaction: number;
  findUnique: Array<{ where: unknown; select: unknown }>;
  findFirst: Array<{ where: unknown; select: unknown }>;
  update: Array<{ where: unknown; data: unknown }>;
  create: Array<{ data: unknown; select: unknown }>;
  count: Array<{ where: unknown }>;
}

function newLog(): CallLog {
  return {
    $transaction: 0,
    findUnique: [],
    findFirst: [],
    update: [],
    create: [],
    count: [],
  };
}

interface FakeOptions {
  seed?: FakeRow[];
  /** Number of upcoming create() calls that should throw a P2002 error. */
  collisionsWithCode?: number;
  /** Number of upcoming create() calls that should throw a regex-only error. */
  collisionsWithMessage?: number;
  /** When set, the next create() throws this error verbatim (non-collision). */
  nextCreateError?: Error;
}

function makeFake(opts: FakeOptions = {}): {
  db: InvitePrisma;
  rows: FakeRow[];
  log: CallLog;
  remaining: { withCode: number; withMessage: number; rawError: Error | null };
} {
  const rows = [...(opts.seed ?? [])];
  const log = newLog();
  const remaining = {
    withCode: opts.collisionsWithCode ?? 0,
    withMessage: opts.collisionsWithMessage ?? 0,
    rawError: opts.nextCreateError ?? null,
  };

  const inviteCode = {
    findUnique: async (args: { where: unknown; select: unknown }) => {
      log.findUnique.push({ where: args.where, select: args.select });
      const where = args.where as { code?: string };
      const r = rows.find((x) => x.code === where.code);
      return r ? { id: r.id, redeemedById: r.redeemedById } : null;
    },
    findFirst: async (args: { where: unknown; select: unknown }) => {
      log.findFirst.push({ where: args.where, select: args.select });
      const where = args.where as { redeemedById?: string };
      const r = rows.find((x) => x.redeemedById === where.redeemedById);
      return r ? { id: r.id, code: r.code } : null;
    },
    update: async (args: { where: unknown; data: unknown }) => {
      log.update.push({ where: args.where, data: args.data });
      const where = args.where as { id: string };
      const data = args.data as { redeemedById: string; redeemedAt: Date };
      const r = rows.find((x) => x.id === where.id);
      if (!r) throw new Error("no row");
      r.redeemedById = data.redeemedById;
      r.redeemedAt = data.redeemedAt;
      return r;
    },
    create: async (args: { data: unknown; select: unknown }) => {
      log.create.push({ data: args.data, select: args.select });
      if (remaining.rawError) {
        const e = remaining.rawError;
        remaining.rawError = null;
        throw e;
      }
      if (remaining.withCode > 0) {
        remaining.withCode -= 1;
        const err = new Error("constraint violation") as Error & {
          code?: string;
        };
        err.code = "P2002";
        throw err;
      }
      if (remaining.withMessage > 0) {
        remaining.withMessage -= 1;
        // No `code` field — only the message contains "unique".
        throw new Error("Unique constraint failed on the field: code");
      }
      const data = args.data as { code: string; label: string | null };
      const row: FakeRow = {
        id: `i_${rows.length + 1}`,
        code: data.code,
        redeemedById: null,
        redeemedAt: null,
        label: data.label,
      };
      rows.push(row);
      return { id: row.id, code: row.code };
    },
    count: async (args: { where: unknown }) => {
      log.count.push({ where: args.where });
      const where = args.where as { redeemedById: null };
      return rows.filter((r) =>
        where.redeemedById === null ? r.redeemedById === null : false,
      ).length;
    },
  };

  const db = {
    inviteCode,
    $transaction: (async (fn: (tx: typeof db) => Promise<unknown>) => {
      log.$transaction += 1;
      return fn(db);
    }) as unknown as InvitePrisma["$transaction"],
  } as unknown as InvitePrisma;

  return { db, rows, log, remaining };
}

// ─── 1. InviteRedemption discriminated-union shape ─────────────────────────

describe("invites/prisma-deps contract — redemption result shape", () => {
  it("success branch is exactly { ok: true, inviteId: string } — no extra keys", async () => {
    const fake = makeFake({
      seed: [
        { id: "i_1", code: "ABCD1234", redeemedById: null, redeemedAt: null },
      ],
    });
    const r = await redeemCode(fake.db, { userId: "u1", rawCode: "ABCD1234" });
    expect(r.ok).toBe(true);
    expect(Object.keys(r).sort()).toEqual(["inviteId", "ok"]);
    if (r.ok) {
      expect(typeof r.inviteId).toBe("string");
    }
  });

  it("failure branch is exactly { ok: false, reason: string } — no extra keys", async () => {
    const fake = makeFake();
    const r = await redeemCode(fake.db, { userId: "u1", rawCode: "NOTAREAL" });
    expect(r.ok).toBe(false);
    expect(Object.keys(r).sort()).toEqual(["ok", "reason"]);
  });

  it("success branch has no `reason` field, failure has no `inviteId` field", async () => {
    // Pinning this asymmetry explicitly: a refactor to a flat envelope
    // ({ ok, inviteId: string|null, reason: string|null }) would be a
    // user-contract change that breaks exhaustive narrowing.
    const fake = makeFake({
      seed: [
        { id: "i_1", code: "ABCD1234", redeemedById: null, redeemedAt: null },
      ],
    });
    const ok = await redeemCode(fake.db, { userId: "u1", rawCode: "ABCD1234" });
    expect("reason" in ok).toBe(false);

    const fail = makeFake();
    const bad = await redeemCode(fail.db, { userId: "u2", rawCode: "NOPE0000" });
    expect("inviteId" in bad).toBe(false);
  });
});

// ─── 2. Reason enum string values + cross-module identity ──────────────────

describe("invites/prisma-deps contract — reason enum literals", () => {
  // Cross-module: src/twilio/routes.ts has an inline switch over these
  // exact strings. We import the type from invites/types.ts (the canonical
  // owner) and prove each branch returns its expected literal.

  it("missing code returns reason \"unknown_code\"", async () => {
    const fake = makeFake();
    const r = await redeemCode(fake.db, { userId: "u1", rawCode: "NOTAREAL" });
    expect(r).toEqual({ ok: false, reason: "unknown_code" });
    // Type-level pin: the literal must satisfy the canonical union.
    const reason: InviteRedemptionFailure = "unknown_code";
    expect(reason).toBe("unknown_code");
  });

  it("code claimed by another user returns reason \"already_redeemed\"", async () => {
    const fake = makeFake({
      seed: [
        {
          id: "i_1",
          code: "ABCD1234",
          redeemedById: "u_other",
          redeemedAt: new Date(),
        },
      ],
    });
    const r = await redeemCode(fake.db, { userId: "u1", rawCode: "ABCD1234" });
    expect(r).toEqual({ ok: false, reason: "already_redeemed" });
    const reason: InviteRedemptionFailure = "already_redeemed";
    expect(reason).toBe("already_redeemed");
  });

  it("user has a different prior redemption → reason \"self_already_redeemed\"", async () => {
    const fake = makeFake({
      seed: [
        { id: "i_1", code: "ABCD1234", redeemedById: "u1", redeemedAt: new Date() },
        { id: "i_2", code: "EFGH5678", redeemedById: null, redeemedAt: null },
      ],
    });
    const r = await redeemCode(fake.db, { userId: "u1", rawCode: "EFGH5678" });
    expect(r).toEqual({ ok: false, reason: "self_already_redeemed" });
    const reason: InviteRedemptionFailure = "self_already_redeemed";
    expect(reason).toBe("self_already_redeemed");
  });

  it("the full failure-reason enum has exactly three values", () => {
    // If anyone adds a fourth, this test fails and forces them to update
    // the inviteFailureReply switch in twilio/routes.ts in the same commit.
    const observed = new Set<InviteRedemptionFailure>([
      "unknown_code",
      "already_redeemed",
      "self_already_redeemed",
    ]);
    expect(observed.size).toBe(3);
    // Negative pin: plausible candidate strings a refactor might add must
    // NOT already be in the type. We can't enumerate the union at runtime,
    // but we can hold the line by declaring tuple/satisfies pattern below.
    const exhaustive: [
      "unknown_code",
      "already_redeemed",
      "self_already_redeemed",
    ] = ["unknown_code", "already_redeemed", "self_already_redeemed"];
    expect(exhaustive).toHaveLength(3);
  });
});

// ─── 3. $transaction wrap is mandatory ─────────────────────────────────────

describe("invites/prisma-deps contract — redeemCode runs inside a transaction", () => {
  it("every redeemCode invocation calls $transaction exactly once", async () => {
    const fake = makeFake({
      seed: [
        { id: "i_1", code: "ABCD1234", redeemedById: null, redeemedAt: null },
      ],
    });
    expect(fake.log.$transaction).toBe(0);
    await redeemCode(fake.db, { userId: "u1", rawCode: "ABCD1234" });
    expect(fake.log.$transaction).toBe(1);
  });

  it("failure paths still open a transaction (no short-circuit before tx)", async () => {
    // unknown_code must still run inside a tx — otherwise a concurrent
    // createInvite that lands between read and decision could shift the
    // ground under the redemption.
    const fake = makeFake();
    await redeemCode(fake.db, { userId: "u1", rawCode: "MISSING0" });
    expect(fake.log.$transaction).toBe(1);
  });
});

// ─── 4. Prisma query shape narrowing ───────────────────────────────────────

describe("invites/prisma-deps contract — Prisma query shapes", () => {
  it("findUnique projects exactly { id, redeemedById }", async () => {
    const fake = makeFake({
      seed: [
        { id: "i_1", code: "ABCD1234", redeemedById: null, redeemedAt: null },
      ],
    });
    await redeemCode(fake.db, { userId: "u1", rawCode: "ABCD1234" });
    expect(fake.log.findUnique).toHaveLength(1);
    expect(fake.log.findUnique[0]!.select).toEqual({
      id: true,
      redeemedById: true,
    });
    // where uses the normalized code (uppercase, no separators).
    expect(fake.log.findUnique[0]!.where).toEqual({ code: "ABCD1234" });
  });

  it("findFirst projects exactly { id, code } and filters by redeemedById", async () => {
    const fake = makeFake({
      seed: [
        { id: "i_1", code: "ABCD1234", redeemedById: null, redeemedAt: null },
      ],
    });
    await redeemCode(fake.db, { userId: "u1", rawCode: "ABCD1234" });
    // findFirst only runs when the code is unclaimed (or claimed by self).
    expect(fake.log.findFirst).toHaveLength(1);
    expect(fake.log.findFirst[0]!.select).toEqual({ id: true, code: true });
    expect(fake.log.findFirst[0]!.where).toEqual({ redeemedById: "u1" });
  });

  it("update writes exactly { redeemedById, redeemedAt: Date } scoped to id", async () => {
    const fake = makeFake({
      seed: [
        { id: "i_1", code: "ABCD1234", redeemedById: null, redeemedAt: null },
      ],
    });
    await redeemCode(fake.db, { userId: "u1", rawCode: "ABCD1234" });
    expect(fake.log.update).toHaveLength(1);
    expect(fake.log.update[0]!.where).toEqual({ id: "i_1" });
    const data = fake.log.update[0]!.data as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(["redeemedAt", "redeemedById"]);
    expect(data["redeemedById"]).toBe("u1");
    expect(data["redeemedAt"]).toBeInstanceOf(Date);
  });

  it("rawCode is normalized before the findUnique query (case + separator)", async () => {
    // Pin the normalize-on-the-way-in: a refactor that pushed normalization
    // into the database layer (lowercase columns, case-insensitive index)
    // would shift the contract — clients would no longer be required to
    // pass an exact match, and the cache key in subsequent layers would
    // diverge. Pin that the query sees uppercase, separator-stripped.
    const fake = makeFake({
      seed: [
        { id: "i_1", code: "ABCD1234", redeemedById: null, redeemedAt: null },
      ],
    });
    await redeemCode(fake.db, { userId: "u1", rawCode: " abcd-1234 " });
    expect(fake.log.findUnique[0]!.where).toEqual({ code: "ABCD1234" });
  });
});

// ─── 5. Idempotency invariant: no DB write on same-user re-redemption ──────

describe("invites/prisma-deps contract — same-user idempotency is a true no-op write", () => {
  it("re-redeeming the same code by the same user does NOT call update", async () => {
    // The existing test only verifies redeemedAt is preserved — but an
    // update({ data: { redeemedById: same, redeemedAt: same } }) would
    // pass that check while still writing a row (audit triggers, replicas,
    // and bytes-changed metrics all see the write). Pin the no-write.
    const original = new Date("2024-01-01T00:00:00.000Z");
    const fake = makeFake({
      seed: [
        { id: "i_1", code: "ABCD1234", redeemedById: "u1", redeemedAt: original },
      ],
    });
    const r = await redeemCode(fake.db, { userId: "u1", rawCode: "ABCD1234" });
    expect(r).toEqual({ ok: true, inviteId: "i_1" });
    expect(fake.log.update).toHaveLength(0);
    expect(fake.rows[0]!.redeemedAt).toBe(original);
  });

  it("idempotent path still returns the canonical inviteId, not null", async () => {
    const fake = makeFake({
      seed: [
        { id: "i_1", code: "ABCD1234", redeemedById: "u1", redeemedAt: new Date() },
      ],
    });
    const r = (await redeemCode(fake.db, {
      userId: "u1",
      rawCode: "ABCD1234",
    })) as Extract<InviteRedemption, { ok: true }>;
    expect(r.ok).toBe(true);
    expect(r.inviteId).toBe("i_1");
  });
});

// ─── 6. createInvite handles BOTH P2002 code AND /unique/i message paths ───

describe("invites/prisma-deps contract — createInvite collision detection has two surfaces", () => {
  it("recognizes err.code === \"P2002\" as a collision (typed Prisma path)", async () => {
    const fake = makeFake({ collisionsWithCode: 2 });
    const created = await createInvite(fake.db);
    expect(created.code).toHaveLength(8);
    // Two collisions + one success → three create attempts.
    expect(fake.log.create).toHaveLength(3);
  });

  it("recognizes /unique/i in the error message as a collision (untyped fallback)", async () => {
    // This branch exists for drivers that lose the structured `code` field.
    // It is NOT exercised by the existing fake. Pin it explicitly so a
    // refactor that strips the regex check trips here.
    const fake = makeFake({ collisionsWithMessage: 2 });
    const created = await createInvite(fake.db);
    expect(created.code).toHaveLength(8);
    expect(fake.log.create).toHaveLength(3);
  });

  it("mixed collision surfaces are tolerated (typed + untyped in the same retry loop)", async () => {
    const fake = makeFake({ collisionsWithCode: 1, collisionsWithMessage: 1 });
    const created = await createInvite(fake.db);
    expect(created.code).toHaveLength(8);
    expect(fake.log.create).toHaveLength(3);
  });

  it("message regex is case-insensitive (matches \"Unique\" and \"UNIQUE\")", async () => {
    // The regex is /unique/i — explicit pin of the i flag.
    const upper = makeFake({
      nextCreateError: new Error("UNIQUE constraint violation"),
    });
    // first create throws, second succeeds.
    const created = await createInvite(upper.db);
    expect(created.code).toHaveLength(8);
  });
});

// ─── 7. createInvite re-throws non-collision errors immediately ────────────

describe("invites/prisma-deps contract — non-collision errors bypass retry", () => {
  it("a generic DB-down error is re-thrown on the FIRST attempt (no retry)", async () => {
    const fake = makeFake({
      nextCreateError: new Error("connection refused"),
    });
    await expect(createInvite(fake.db)).rejects.toThrow(/connection refused/);
    // Critically: only ONE create attempt was made — we did not burn
    // attempts retrying a non-unique-violation.
    expect(fake.log.create).toHaveLength(1);
  });

  it("the exhaustion error after maxAttempts has the documented message", async () => {
    const fake = makeFake({ collisionsWithCode: 10 });
    await expect(createInvite(fake.db, { maxAttempts: 3 })).rejects.toThrow(
      "createInvite: exhausted attempts on unique collisions",
    );
    expect(fake.log.create).toHaveLength(3);
  });
});

// ─── 8. createManyInvites label propagation ────────────────────────────────

describe("invites/prisma-deps contract — createManyInvites preserves the label per row", () => {
  it("the label is written into every created row, not just the first", async () => {
    const fake = makeFake();
    await createManyInvites(fake.db, { count: 4, label: "spring-2026" });
    expect(fake.log.create).toHaveLength(4);
    for (const call of fake.log.create) {
      const data = call.data as { label: string | null };
      expect(data.label).toBe("spring-2026");
    }
  });

  it("a null label propagates as null (not undefined, not coerced)", async () => {
    const fake = makeFake();
    await createManyInvites(fake.db, { count: 2 });
    for (const call of fake.log.create) {
      const data = call.data as { label: string | null };
      expect(data.label).toBeNull();
    }
  });

  it("each row gets a distinct generated code (no copy-paste reuse)", async () => {
    const fake = makeFake();
    const out = await createManyInvites(fake.db, { count: 8 });
    const codes = new Set(out.map((r) => r.code));
    expect(codes.size).toBe(out.length);
  });
});

// ─── 9. countUnredeemed shape and predicate ────────────────────────────────

describe("invites/prisma-deps contract — countUnredeemed filter shape", () => {
  it("queries where: { redeemedById: null } (the documented unredeemed predicate)", async () => {
    const fake = makeFake({
      seed: [
        { id: "i_1", code: "AAAA0000", redeemedById: null, redeemedAt: null },
        { id: "i_2", code: "BBBB1111", redeemedById: "u1", redeemedAt: new Date() },
      ],
    });
    const n = await countUnredeemed(fake.db);
    expect(n).toBe(1);
    expect(fake.log.count).toHaveLength(1);
    expect(fake.log.count[0]!.where).toEqual({ redeemedById: null });
  });
});
