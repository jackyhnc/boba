import { describe, it, expect } from "vitest";
import {
  countUnredeemed,
  createInvite,
  createManyInvites,
  redeemCode,
  type InvitePrisma,
} from "../../src/invites/prisma-deps.js";
import { normalizeCode } from "../../src/invites/code.js";

interface FakeRow {
  id: string;
  code: string;
  redeemedById: string | null;
  redeemedAt: Date | null;
}

function fakeDb(seed: FakeRow[] = []): {
  db: InvitePrisma;
  rows: FakeRow[];
  forceCollisionsBefore: { count: number };
} {
  const rows = [...seed];
  const forceCollisionsBefore = { count: 0 };

  const db: InvitePrisma = {
    inviteCode: {
      findUnique: async ({ where }: { where: { code: string } }) => {
        const r = rows.find((x) => x.code === where.code);
        return r ? { id: r.id, redeemedById: r.redeemedById } : null;
      },
      findFirst: async ({ where }: { where: { redeemedById: string } }) => {
        const r = rows.find((x) => x.redeemedById === where.redeemedById);
        return r ? { id: r.id, code: r.code } : null;
      },
      update: async ({ where, data }: { where: { id: string }; data: { redeemedById: string; redeemedAt: Date } }) => {
        const r = rows.find((x) => x.id === where.id);
        if (!r) throw new Error("no row");
        r.redeemedById = data.redeemedById;
        r.redeemedAt = data.redeemedAt;
        return r;
      },
      count: async ({ where }: { where: { redeemedById: null } }) => {
        return rows.filter((r) =>
          where.redeemedById === null ? r.redeemedById === null : false,
        ).length;
      },
      create: async ({ data }: { data: { code: string; label: string | null } }) => {
        if (forceCollisionsBefore.count > 0) {
          forceCollisionsBefore.count -= 1;
          const err = new Error("Unique constraint failed") as Error & {
            code?: string;
          };
          err.code = "P2002";
          throw err;
        }
        const row: FakeRow = {
          id: `i_${rows.length + 1}`,
          code: data.code,
          redeemedById: null,
          redeemedAt: null,
        };
        rows.push(row);
        return { id: row.id, code: row.code };
      },
    } as never,
    $transaction: (async (fn: (tx: InvitePrisma) => Promise<unknown>) => fn(db)) as unknown as InvitePrisma["$transaction"],
  };

  return { db, rows, forceCollisionsBefore };
}

describe("redeemCode", () => {
  it("succeeds for a fresh code", async () => {
    const fake = fakeDb([
      { id: "i_1", code: "ABCD1234", redeemedById: null, redeemedAt: null },
    ]);
    const r = await redeemCode(fake.db, { userId: "u1", rawCode: "abcd-1234" });
    expect(r).toEqual({ ok: true, inviteId: "i_1" });
    expect(fake.rows[0]!.redeemedById).toBe("u1");
    expect(fake.rows[0]!.redeemedAt).toBeInstanceOf(Date);
  });

  it("normalizes the user input", async () => {
    const fake = fakeDb([
      { id: "i_1", code: "ABCD1234", redeemedById: null, redeemedAt: null },
    ]);
    expect(
      (await redeemCode(fake.db, { userId: "u1", rawCode: " abcd 1234 " })).ok,
    ).toBe(true);
    expect(normalizeCode(" abcd 1234 ")).toBe("ABCD1234");
  });

  it("returns unknown_code for a non-existent code", async () => {
    const fake = fakeDb([]);
    const r = await redeemCode(fake.db, { userId: "u1", rawCode: "ABCD1234" });
    expect(r).toEqual({ ok: false, reason: "unknown_code" });
  });

  it("returns already_redeemed when another user claimed it", async () => {
    const fake = fakeDb([
      { id: "i_1", code: "ABCD1234", redeemedById: "u_other", redeemedAt: new Date() },
    ]);
    const r = await redeemCode(fake.db, { userId: "u1", rawCode: "ABCD1234" });
    expect(r).toEqual({ ok: false, reason: "already_redeemed" });
  });

  it("returns self_already_redeemed when the same user already has a code", async () => {
    const fake = fakeDb([
      { id: "i_1", code: "ABCD1234", redeemedById: "u1", redeemedAt: new Date() },
      { id: "i_2", code: "EFGH5678", redeemedById: null, redeemedAt: null },
    ]);
    const r = await redeemCode(fake.db, { userId: "u1", rawCode: "EFGH5678" });
    expect(r).toEqual({ ok: false, reason: "self_already_redeemed" });
  });

  it("is idempotent — redeeming the same code by the same user is a no-op success", async () => {
    const original = new Date("2024-01-01");
    const fake = fakeDb([
      { id: "i_1", code: "ABCD1234", redeemedById: "u1", redeemedAt: original },
    ]);
    const r = await redeemCode(fake.db, { userId: "u1", rawCode: "ABCD1234" });
    expect(r.ok).toBe(true);
    expect(fake.rows[0]!.redeemedAt).toBe(original); // not bumped
  });
});

describe("createInvite", () => {
  it("creates a fresh code", async () => {
    const fake = fakeDb();
    const created = await createInvite(fake.db, { label: "launch" });
    expect(created.code).toHaveLength(8);
    expect(fake.rows).toHaveLength(1);
  });

  it("retries on unique-violation collisions", async () => {
    const fake = fakeDb();
    fake.forceCollisionsBefore.count = 2;
    const created = await createInvite(fake.db);
    expect(created.code).toHaveLength(8);
    expect(fake.rows).toHaveLength(1); // only the successful row survived
  });

  it("throws after maxAttempts collisions", async () => {
    const fake = fakeDb();
    fake.forceCollisionsBefore.count = 10;
    await expect(createInvite(fake.db, { maxAttempts: 3 })).rejects.toThrow(
      /exhausted/,
    );
  });
});

describe("createManyInvites + countUnredeemed", () => {
  it("creates N rows and reports unredeemed count", async () => {
    const fake = fakeDb();
    const out = await createManyInvites(fake.db, { count: 5, label: "alpha" });
    expect(out).toHaveLength(5);
    expect(await countUnredeemed(fake.db)).toBe(5);
  });
});
