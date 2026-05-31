// Contract pins for recordDecisionAndMaybeResolve's persistence wire format.
//
// `tests/decisions/record.test.ts` covers behavioural outcomes (resolution,
// state, decisions stored). The invariants below sit at the seams between
// resolve() and the DB writes — silent regressions would not surface in the
// behavioural tests because the existing tests use a canonical pair (a, b)
// and never assert on parentMatchId, matchCount values, or the FACE
// milestone key shape.
//
// Pinned here:
//   1. orderPair canonicalisation on rematchHistory.upsert WHERE — exercised
//      with a non-canonical input (b, a) so the canonical (a, b) lookup is
//      observable. Continue and ended_by_discard branches both.
//   2. orderPair canonicalisation on tomorrow's dailyMatch.create — same.
//   3. parentMatchId on tomorrow's match equals the resolved match's id.
//   4. matchCount: 2 in the continue rematch CREATE branch (NOT 1 — the
//      matching/persist path uses 1 for the first match; this is the second).
//   5. matchCount: { increment: 1 } in the continue rematch UPDATE branch.
//   6. hasDiscard: true in BOTH create and update arms of the discard branch.
//   7. The ACTIVE → AWAITING_DECISION flip is conditional — once
//      AWAITING_DECISION, no second update fires.
//   8. The FACE milestone upsert is keyed on { matchId, milestone: "FACE" }.

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

interface MatchUpdateCall {
  where: { id: string };
  data: { state: FakeMatch["state"] };
}

interface MatchCreateCall {
  userAId: string;
  userBId: string;
  matchDate: Date;
  state: FakeMatch["state"];
  compatibilityScore: number;
  parentMatchId: string | null;
}

interface RematchUpsertCall {
  where: { userAId_userBId: { userAId: string; userBId: string } };
  create: Record<string, unknown>;
  update: Record<string, unknown>;
}

interface MilestoneUpsertCall {
  where: { matchId_milestone: { matchId: string; milestone: string } };
  create: Record<string, unknown>;
  update: Record<string, unknown>;
}

function makeFakeDb(seed: { matches: FakeMatch[] }) {
  const matches = [...seed.matches];
  const decisions: Array<{ matchId: string; userId: string; decision: Decision }> = [];
  const milestoneUpserts: MilestoneUpsertCall[] = [];
  const rematchUpserts: RematchUpsertCall[] = [];
  const matchUpdates: MatchUpdateCall[] = [];
  const matchCreates: MatchCreateCall[] = [];

  const db: DecisionPrisma = {
    endOfDayDecision: {
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { matchId_userId: { matchId: string; userId: string } };
        create: { decision: Decision };
        update: { decision: Decision };
      }) => {
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
      update: async (call: MatchUpdateCall) => {
        matchUpdates.push(call);
        const m = matches.find((mm) => mm.id === call.where.id);
        if (m) m.state = call.data.state;
        return m as never;
      },
      create: async ({ data }: { data: MatchCreateCall }) => {
        matchCreates.push(data);
        const id = `m_${matches.length + 1}`;
        matches.push({ ...data, id });
        return { id };
      },
    } as never,
    milestoneProgress: {
      upsert: async (call: MilestoneUpsertCall) => {
        milestoneUpserts.push(call);
        return {};
      },
    } as never,
    rematchHistory: {
      upsert: async (call: RematchUpsertCall) => {
        rematchUpserts.push(call);
        return {};
      },
    } as never,
    $transaction: (async (fn: (tx: DecisionPrisma) => Promise<unknown>) => fn(db)) as unknown as DecisionPrisma["$transaction"],
  };

  return { db, matches, decisions, milestoneUpserts, rematchUpserts, matchUpdates, matchCreates };
}

const TODAY = new Date("2026-05-17T00:00:00Z");

async function runBothDecisions(
  fake: ReturnType<typeof makeFakeDb>,
  matchId: string,
  userAId: string,
  userBId: string,
  a: Decision,
  b: Decision,
) {
  await recordDecisionAndMaybeResolve(fake.db, { matchId, userId: userAId, decision: a, today: TODAY });
  return recordDecisionAndMaybeResolve(fake.db, { matchId, userId: userBId, decision: b, today: TODAY });
}

describe("recordDecisionAndMaybeResolve — contract pins", () => {
  describe("orderPair canonicalisation", () => {
    it("rematch upsert WHERE uses canonical (a, b) even when match.userAId='b', userBId='a' (continue branch)", async () => {
      // Non-canonical seeding: userAId="b" > userBId="a". orderPair must flip
      // these before the rematchHistory upsert WHERE / CREATE; otherwise the
      // (b, a) row would compete with the (a, b) row written by the matching
      // persist path, silently breaking rematch cooldowns.
      const fake = makeFakeDb({
        matches: [{ id: "m1", userAId: "b", userBId: "a", matchDate: TODAY, state: "ACTIVE", compatibilityScore: 0.9 }],
      });

      await runBothDecisions(fake, "m1", "b", "a", "KEEP", "KEEP");

      expect(fake.rematchUpserts).toHaveLength(1);
      expect(fake.rematchUpserts[0]!.where).toEqual({
        userAId_userBId: { userAId: "a", userBId: "b" },
      });
      expect(fake.rematchUpserts[0]!.create).toMatchObject({ userAId: "a", userBId: "b" });
    });

    it("rematch upsert WHERE uses canonical (a, b) for the ended_by_discard branch too", async () => {
      const fake = makeFakeDb({
        matches: [{ id: "m1", userAId: "b", userBId: "a", matchDate: TODAY, state: "ACTIVE", compatibilityScore: 0.5 }],
      });

      await runBothDecisions(fake, "m1", "b", "a", "KEEP", "DISCARD");

      const last = fake.rematchUpserts.at(-1)!;
      expect(last.where).toEqual({ userAId_userBId: { userAId: "a", userBId: "b" } });
      expect(last.create).toMatchObject({ userAId: "a", userBId: "b" });
    });

    it("tomorrow's dailyMatch.create uses canonical (a, b) for non-canonical inputs", async () => {
      const fake = makeFakeDb({
        matches: [{ id: "m1", userAId: "b", userBId: "a", matchDate: TODAY, state: "ACTIVE", compatibilityScore: 0.9 }],
      });

      await runBothDecisions(fake, "m1", "b", "a", "KEEP", "KEEP");

      expect(fake.matchCreates).toHaveLength(1);
      expect(fake.matchCreates[0]).toMatchObject({ userAId: "a", userBId: "b" });
    });
  });

  describe("tomorrow's match shape", () => {
    it("parentMatchId on the continuation equals the resolved match's id", async () => {
      const fake = makeFakeDb({
        matches: [{ id: "m1", userAId: "a", userBId: "b", matchDate: TODAY, state: "ACTIVE", compatibilityScore: 0.9 }],
      });

      await runBothDecisions(fake, "m1", "a", "b", "KEEP", "KEEP");

      expect(fake.matchCreates[0]!.parentMatchId).toBe("m1");
    });

    it("tomorrow's matchDate is today + 1 in UTC and inherits compatibilityScore + ACTIVE state", async () => {
      const fake = makeFakeDb({
        matches: [{ id: "m1", userAId: "a", userBId: "b", matchDate: TODAY, state: "ACTIVE", compatibilityScore: 0.73 }],
      });

      await runBothDecisions(fake, "m1", "a", "b", "MAYBE", "KEEP");

      const tomorrow = new Date(TODAY);
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      expect(fake.matchCreates[0]).toMatchObject({
        matchDate: tomorrow,
        state: "ACTIVE",
        compatibilityScore: 0.73,
      });
    });
  });

  describe("rematchHistory matchCount semantics", () => {
    it("continue CREATE arm sets matchCount: 2 (this is the second match for the pair)", async () => {
      // The matching/persist path writes matchCount: 1 on the first match for
      // the pair. By the time the decisions flow resolves to continue, the
      // pair has been matched twice (today + tomorrow). If the create arm
      // ever fires (e.g. rematchHistory was missing for some reason), 2 is
      // the right defensive value — switching it to 1 would silently
      // under-count for rematch cooldown calculations.
      const fake = makeFakeDb({
        matches: [{ id: "m1", userAId: "a", userBId: "b", matchDate: TODAY, state: "ACTIVE", compatibilityScore: 0.9 }],
      });

      await runBothDecisions(fake, "m1", "a", "b", "KEEP", "KEEP");

      expect(fake.rematchUpserts[0]!.create).toMatchObject({ matchCount: 2 });
    });

    it("continue UPDATE arm increments matchCount by 1 (not absolute, not by 2)", async () => {
      const fake = makeFakeDb({
        matches: [{ id: "m1", userAId: "a", userBId: "b", matchDate: TODAY, state: "ACTIVE", compatibilityScore: 0.9 }],
      });

      await runBothDecisions(fake, "m1", "a", "b", "MAYBE", "MAYBE");

      expect(fake.rematchUpserts[0]!.update).toMatchObject({
        matchCount: { increment: 1 },
      });
      expect(fake.rematchUpserts[0]!.update).toHaveProperty("lastMatchedAt");
    });

    it("continue UPDATE arm does NOT carry hasDiscard (only the discard branch sets it)", async () => {
      const fake = makeFakeDb({
        matches: [{ id: "m1", userAId: "a", userBId: "b", matchDate: TODAY, state: "ACTIVE", compatibilityScore: 0.9 }],
      });

      await runBothDecisions(fake, "m1", "a", "b", "KEEP", "KEEP");

      expect(fake.rematchUpserts[0]!.update).not.toHaveProperty("hasDiscard");
      expect(fake.rematchUpserts[0]!.create).not.toHaveProperty("hasDiscard");
    });
  });

  describe("ended_by_discard rematch shape", () => {
    it("CREATE arm sets hasDiscard: true (does not also set matchCount — defaults apply)", async () => {
      const fake = makeFakeDb({
        matches: [{ id: "m1", userAId: "a", userBId: "b", matchDate: TODAY, state: "ACTIVE", compatibilityScore: 0.5 }],
      });

      await runBothDecisions(fake, "m1", "a", "b", "KEEP", "DISCARD");

      const last = fake.rematchUpserts.at(-1)!;
      expect(last.create).toMatchObject({ hasDiscard: true });
      // Sanity: don't smuggle matchCount through here — pair.matchCount stays
      // owned by the persist/continue paths.
      expect(last.create).not.toHaveProperty("matchCount");
    });

    it("UPDATE arm sets hasDiscard: true and refreshes lastMatchedAt", async () => {
      const fake = makeFakeDb({
        matches: [{ id: "m1", userAId: "a", userBId: "b", matchDate: TODAY, state: "ACTIVE", compatibilityScore: 0.5 }],
      });

      await runBothDecisions(fake, "m1", "a", "b", "MAYBE", "DISCARD");

      const last = fake.rematchUpserts.at(-1)!;
      expect(last.update).toMatchObject({ hasDiscard: true });
      expect(last.update).toHaveProperty("lastMatchedAt");
    });

    it("no tomorrow match is created on a discard outcome", async () => {
      const fake = makeFakeDb({
        matches: [{ id: "m1", userAId: "a", userBId: "b", matchDate: TODAY, state: "ACTIVE", compatibilityScore: 0.5 }],
      });

      await runBothDecisions(fake, "m1", "a", "b", "DISCARD", "MAYBE");

      expect(fake.matchCreates).toHaveLength(0);
    });
  });

  describe("AWAITING_DECISION state-flip is conditional", () => {
    it("first decision: ACTIVE → AWAITING_DECISION (one update)", async () => {
      const fake = makeFakeDb({
        matches: [{ id: "m1", userAId: "a", userBId: "b", matchDate: TODAY, state: "ACTIVE", compatibilityScore: 0.5 }],
      });

      await recordDecisionAndMaybeResolve(fake.db, {
        matchId: "m1",
        userId: "a",
        decision: "KEEP",
        today: TODAY,
      });

      const flips = fake.matchUpdates.filter((u) => u.data.state === "AWAITING_DECISION");
      expect(flips).toHaveLength(1);
    });

    it("second user's pending re-decision does not re-flip to AWAITING_DECISION", async () => {
      // userA decides twice (changes their mind) before userB chimes in.
      // The match is already AWAITING_DECISION after the first call, so the
      // second call must not emit a redundant AWAITING_DECISION update.
      const fake = makeFakeDb({
        matches: [{ id: "m1", userAId: "a", userBId: "b", matchDate: TODAY, state: "ACTIVE", compatibilityScore: 0.5 }],
      });

      await recordDecisionAndMaybeResolve(fake.db, { matchId: "m1", userId: "a", decision: "KEEP", today: TODAY });
      await recordDecisionAndMaybeResolve(fake.db, { matchId: "m1", userId: "a", decision: "MAYBE", today: TODAY });

      const flips = fake.matchUpdates.filter((u) => u.data.state === "AWAITING_DECISION");
      expect(flips).toHaveLength(1);
    });
  });

  describe("FACE milestone unlock", () => {
    it("uses the composite key { matchId, milestone: 'FACE' } on continue", async () => {
      const fake = makeFakeDb({
        matches: [{ id: "m1", userAId: "a", userBId: "b", matchDate: TODAY, state: "ACTIVE", compatibilityScore: 0.9 }],
      });

      await runBothDecisions(fake, "m1", "a", "b", "KEEP", "MAYBE");

      expect(fake.milestoneUpserts).toHaveLength(1);
      expect(fake.milestoneUpserts[0]!.where).toEqual({
        matchId_milestone: { matchId: "m1", milestone: "FACE" },
      });
      // create arm carries the same key fields (otherwise an insert on a
      // missing row would write the wrong milestone).
      expect(fake.milestoneUpserts[0]!.create).toMatchObject({
        matchId: "m1",
        milestone: "FACE",
      });
    });

    it("does NOT fire on discard (face stays locked when the match ends)", async () => {
      const fake = makeFakeDb({
        matches: [{ id: "m1", userAId: "a", userBId: "b", matchDate: TODAY, state: "ACTIVE", compatibilityScore: 0.5 }],
      });

      await runBothDecisions(fake, "m1", "a", "b", "KEEP", "DISCARD");

      expect(fake.milestoneUpserts).toHaveLength(0);
    });
  });
});
