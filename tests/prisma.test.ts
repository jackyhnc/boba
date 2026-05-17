import { describe, it, expect } from "vitest";
import {
  PrismaClient,
  prisma,
  UserStatus,
  Gender,
  MatchState,
  MilestoneType,
  Decision,
  MessageDirection,
} from "../src/lib/prisma.js";
import { orderPair, isOrderedPair } from "../src/lib/pair.js";

describe("prisma client", () => {
  it("constructs without connecting", () => {
    // Connections are lazy; constructing should never throw.
    const client = new PrismaClient();
    expect(client).toBeDefined();
    expect(typeof client.$connect).toBe("function");
    expect(typeof client.$disconnect).toBe("function");
  });

  it("exposes the shared singleton", () => {
    expect(prisma).toBeDefined();
    expect(typeof prisma.$disconnect).toBe("function");
  });

  it("exposes the core domain models as queryable namespaces", () => {
    // These should exist on the generated client once the schema is in place.
    expect(prisma.user).toBeDefined();
    expect(prisma.preferences).toBeDefined();
    expect(prisma.stats).toBeDefined();
    expect(prisma.dailyMatch).toBeDefined();
    expect(prisma.message).toBeDefined();
    expect(prisma.milestoneProgress).toBeDefined();
    expect(prisma.endOfDayDecision).toBeDefined();
    expect(prisma.rematchHistory).toBeDefined();
    expect(prisma.report).toBeDefined();
  });

  it("re-exports enum values at runtime", () => {
    expect(UserStatus.ONBOARDING).toBe("ONBOARDING");
    expect(UserStatus.ACTIVE).toBe("ACTIVE");
    expect(Gender.WOMAN).toBe("WOMAN");
    expect(MatchState.ACTIVE).toBe("ACTIVE");
    expect(MatchState.ENDED_BY_DISCARD).toBe("ENDED_BY_DISCARD");
    expect(MilestoneType.AGE).toBe("AGE");
    expect(MilestoneType.FACE).toBe("FACE");
    expect(Decision.KEEP).toBe("KEEP");
    expect(Decision.DISCARD).toBe("DISCARD");
    expect(MessageDirection.INBOUND).toBe("INBOUND");
  });
});

describe("orderPair", () => {
  it("sorts ids into canonical (A < B) order", () => {
    expect(orderPair("b", "a")).toEqual({ userAId: "a", userBId: "b" });
    expect(orderPair("a", "b")).toEqual({ userAId: "a", userBId: "b" });
  });

  it("rejects self-pairing", () => {
    expect(() => orderPair("same", "same")).toThrow(/cannot pair a user with themselves/);
  });

  it("isOrderedPair detects canonical order", () => {
    expect(isOrderedPair("a", "b")).toBe(true);
    expect(isOrderedPair("b", "a")).toBe(false);
  });
});
