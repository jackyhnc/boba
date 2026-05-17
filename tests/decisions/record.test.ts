import { describe, it, expect } from "vitest";
import type { Decision } from "@prisma/client";
import {
  recordDecisionAndMaybeResolve,
  type DecisionPrisma,
} from "../../src/decisions/prisma-deps.js";

interface FakeMatch {
  id: string;
  userAId: string;
  userBId: string;
  matchDate: Date;
  state: "ACTIVE" | "AWAITING_DECISION" | "CONTINUED" | "ENDED_BY_DISCARD" | "EXPIRED";
  compatibilityScore: number;
}

function makeFakeDb(seed: { matches: FakeMatch[] }) {
  const matches = [...seed.matches];
  const decisions: Array<{ matchId: string; userId: string; decision: Decision }> = [];
  const milestones: Array<{ matchId: string; milestone: string }> = [];
  const rematchUpserts: Array<{
    userAId: string;
    userBId: string;
    create: Record<string, unknown>;
    update: Record<string, unknown>;
  }> = [];
  const created: FakeMatch[] = [];

  const db: DecisionPrisma = {
    endOfDayDecision: {
      upsert: async ({ where, create, update }: { where: { matchId_userId: { matchId: string; userId: string } }; create: { decision: Decision }; update: { decision: Decision } }) => {
        const idx = decisions.findIndex(
          (d) =>
            d.matchId === where.matchId_userId.matchId &&
            d.userId === where.matchId_userId.userId,
        );
        if (idx >= 0) decisions[idx]!.decision = update.decision;
        else decisions.push({ ...where.matchId_userId, decision: create.decision });
        return {};
      },
    } as never,
    dailyMatch: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const m = matches.find((mm) => mm.id === where.id);
        if (!m) return null;
        return {
          ...m,
          decisions: decisions
            .filter((d) => d.matchId === m.id)
            .map((d) => ({ userId: d.userId, decision: d.decision })),
        };
      },
      update: async ({ where, data }: { where: { id: string }; data: { state: FakeMatch["state"] } }) => {
        const m = matches.find((mm) => mm.id === where.id);
        if (m) m.state = data.state;
        return m as never;
      },
      create: async ({ data }: { data: FakeMatch & { parentMatchId?: string | null } }) => {
        const id = `m_${matches.length + created.length + 1}`;
        const row: FakeMatch = { ...(data as FakeMatch), id };
        matches.push(row);
        created.push(row);
        return { id };
      },
    } as never,
    milestoneProgress: {
      upsert: async ({ where }: { where: { matchId_milestone: { matchId: string; milestone: string } } }) => {
        milestones.push({ ...where.matchId_milestone });
        return {};
      },
    } as never,
    rematchHistory: {
      upsert: async ({ where, create, update }: { where: { userAId_userBId: { userAId: string; userBId: string } }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
        rematchUpserts.push({ ...where.userAId_userBId, create, update });
        return {};
      },
    } as never,
    // Cast: Prisma's $transaction overload set is broader than we need here.
    $transaction: (async (fn: (tx: DecisionPrisma) => Promise<unknown>) => fn(db)) as unknown as DecisionPrisma["$transaction"],
  };

  return { db, matches, decisions, milestones, rematchUpserts, created };
}

const TODAY = new Date("2026-05-17T00:00:00Z");

describe("recordDecisionAndMaybeResolve", () => {
  it("first decision flips to AWAITING_DECISION and stays pending", async () => {
    const fake = makeFakeDb({
      matches: [
        { id: "m1", userAId: "a", userBId: "b", matchDate: TODAY, state: "ACTIVE", compatibilityScore: 0.7 },
      ],
    });
    const { resolution, continuationMatchId } = await recordDecisionAndMaybeResolve(
      fake.db,
      { matchId: "m1", userId: "a", decision: "KEEP", today: TODAY },
    );
    expect(resolution.outcome).toBe("pending");
    expect(continuationMatchId).toBeNull();
    expect(fake.matches[0]!.state).toBe("AWAITING_DECISION");
  });

  it("KEEP + KEEP continues, unlocks FACE, creates tomorrow's match", async () => {
    const fake = makeFakeDb({
      matches: [
        { id: "m1", userAId: "a", userBId: "b", matchDate: TODAY, state: "ACTIVE", compatibilityScore: 0.9 },
      ],
    });
    await recordDecisionAndMaybeResolve(fake.db, {
      matchId: "m1",
      userId: "a",
      decision: "KEEP",
      today: TODAY,
    });
    const { resolution, continuationMatchId } = await recordDecisionAndMaybeResolve(
      fake.db,
      { matchId: "m1", userId: "b", decision: "KEEP", today: TODAY },
    );
    expect(resolution.outcome).toBe("continue");
    expect(continuationMatchId).not.toBeNull();
    expect(fake.matches[0]!.state).toBe("CONTINUED");
    expect(fake.milestones).toContainEqual({ matchId: "m1", milestone: "FACE" });
    const tomorrow = new Date(TODAY);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    expect(fake.created[0]).toMatchObject({
      userAId: "a",
      userBId: "b",
      state: "ACTIVE",
      compatibilityScore: 0.9,
      matchDate: tomorrow,
    });
    expect(fake.rematchUpserts[0]).toMatchObject({
      userAId: "a",
      userBId: "b",
    });
  });

  it("any DISCARD ends the match and marks rematch.hasDiscard", async () => {
    const fake = makeFakeDb({
      matches: [
        { id: "m1", userAId: "a", userBId: "b", matchDate: TODAY, state: "ACTIVE", compatibilityScore: 0.5 },
      ],
    });
    await recordDecisionAndMaybeResolve(fake.db, {
      matchId: "m1",
      userId: "a",
      decision: "KEEP",
      today: TODAY,
    });
    const { resolution } = await recordDecisionAndMaybeResolve(fake.db, {
      matchId: "m1",
      userId: "b",
      decision: "DISCARD",
      today: TODAY,
    });
    expect(resolution.outcome).toBe("ended_by_discard");
    expect(fake.matches[0]!.state).toBe("ENDED_BY_DISCARD");
    expect(fake.created).toHaveLength(0);
    expect(fake.rematchUpserts.at(-1)).toMatchObject({
      create: expect.objectContaining({ hasDiscard: true }),
    });
  });

  it("MAYBE + MAYBE continues", async () => {
    const fake = makeFakeDb({
      matches: [
        { id: "m1", userAId: "a", userBId: "b", matchDate: TODAY, state: "ACTIVE", compatibilityScore: 0.3 },
      ],
    });
    await recordDecisionAndMaybeResolve(fake.db, {
      matchId: "m1",
      userId: "a",
      decision: "MAYBE",
      today: TODAY,
    });
    const { resolution } = await recordDecisionAndMaybeResolve(fake.db, {
      matchId: "m1",
      userId: "b",
      decision: "MAYBE",
      today: TODAY,
    });
    expect(resolution.outcome).toBe("continue");
    expect(fake.matches[0]!.state).toBe("CONTINUED");
  });

  it("upsert overwrites a prior decision when the user changes their mind", async () => {
    const fake = makeFakeDb({
      matches: [
        { id: "m1", userAId: "a", userBId: "b", matchDate: TODAY, state: "ACTIVE", compatibilityScore: 0.6 },
      ],
    });
    await recordDecisionAndMaybeResolve(fake.db, {
      matchId: "m1",
      userId: "a",
      decision: "KEEP",
      today: TODAY,
    });
    await recordDecisionAndMaybeResolve(fake.db, {
      matchId: "m1",
      userId: "a",
      decision: "DISCARD",
      today: TODAY,
    });
    const { resolution } = await recordDecisionAndMaybeResolve(fake.db, {
      matchId: "m1",
      userId: "b",
      decision: "KEEP",
      today: TODAY,
    });
    expect(resolution.outcome).toBe("ended_by_discard");
    expect(fake.decisions.find((d) => d.userId === "a")!.decision).toBe("DISCARD");
  });
});
