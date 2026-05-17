import { describe, it, expect, vi } from "vitest";
import {
  loadUnlockedMilestones,
  recordMilestone,
  type MilestonePrisma,
} from "../../src/milestones/prisma-deps.js";
import type { MilestoneType } from "@prisma/client";

interface UpsertArgs {
  where: { matchId_milestone: { matchId: string; milestone: MilestoneType } };
  create: { matchId: string; milestone: MilestoneType };
  update: Record<string, never>;
}

interface FindManyArgs {
  where: { matchId: string };
  select: { milestone: true };
}

function makeMockPrisma(initial: Array<{ matchId: string; milestone: MilestoneType }> = []): {
  prisma: MilestonePrisma;
  upserts: UpsertArgs[];
  store: Map<string, { id: string; matchId: string; milestone: MilestoneType; unlockedAt: Date }>;
} {
  const upserts: UpsertArgs[] = [];
  const store = new Map<
    string,
    { id: string; matchId: string; milestone: MilestoneType; unlockedAt: Date }
  >();
  let nextId = 1;
  for (const row of initial) {
    const key = `${row.matchId}|${row.milestone}`;
    store.set(key, {
      id: `mp-${nextId++}`,
      ...row,
      unlockedAt: new Date("2026-05-17T00:00:00Z"),
    });
  }

  const milestoneProgress = {
    upsert: vi.fn(async (args: UpsertArgs) => {
      upserts.push(args);
      const key = `${args.where.matchId_milestone.matchId}|${args.where.matchId_milestone.milestone}`;
      const existing = store.get(key);
      if (existing) return existing;
      const row = {
        id: `mp-${nextId++}`,
        matchId: args.create.matchId,
        milestone: args.create.milestone,
        unlockedAt: new Date(),
      };
      store.set(key, row);
      return row;
    }),
    findMany: vi.fn(async (args: FindManyArgs) => {
      const rows: { milestone: MilestoneType }[] = [];
      for (const row of store.values()) {
        if (row.matchId === args.where.matchId) rows.push({ milestone: row.milestone });
      }
      return rows;
    }),
  };

  const prisma = { milestoneProgress } as unknown as MilestonePrisma;
  return { prisma, upserts, store };
}

describe("recordMilestone", () => {
  it("creates a MilestoneProgress row via upsert (idempotent shape)", async () => {
    const { prisma, upserts, store } = makeMockPrisma();
    const row = await recordMilestone(prisma, "match-1", "AGE");
    expect(row.matchId).toBe("match-1");
    expect(row.milestone).toBe<MilestoneType>("AGE");
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.update).toEqual({});
    expect(store.size).toBe(1);
  });

  it("returns the existing row on a repeat call without bumping unlockedAt", async () => {
    const { prisma, store } = makeMockPrisma([{ matchId: "match-1", milestone: "AGE" }]);
    const initialRow = store.get("match-1|AGE")!;
    const row = await recordMilestone(prisma, "match-1", "AGE");
    expect(row.id).toBe(initialRow.id);
    expect(row.unlockedAt).toEqual(initialRow.unlockedAt);
  });

  it("scopes rows by matchId", async () => {
    const { prisma } = makeMockPrisma();
    await recordMilestone(prisma, "match-1", "AGE");
    await recordMilestone(prisma, "match-2", "AGE");
    const aSet = await loadUnlockedMilestones(prisma, "match-1");
    const bSet = await loadUnlockedMilestones(prisma, "match-2");
    expect(aSet).toEqual(new Set(["AGE"]));
    expect(bSet).toEqual(new Set(["AGE"]));
  });
});

describe("loadUnlockedMilestones", () => {
  it("returns the set of unlocked milestones for a match", async () => {
    const { prisma } = makeMockPrisma([
      { matchId: "m1", milestone: "AGE" },
      { matchId: "m1", milestone: "PROFESSION" },
      { matchId: "m2", milestone: "AGE" },
    ]);
    const got = await loadUnlockedMilestones(prisma, "m1");
    expect(got).toEqual(new Set<MilestoneType>(["AGE", "PROFESSION"]));
  });

  it("returns an empty set when nothing is unlocked", async () => {
    const { prisma } = makeMockPrisma();
    const got = await loadUnlockedMilestones(prisma, "m-empty");
    expect(got.size).toBe(0);
  });
});
