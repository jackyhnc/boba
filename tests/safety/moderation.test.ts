import { describe, it, expect } from "vitest";
import {
  detectHarassment,
  parseReportCommand,
} from "../../src/safety/moderation.js";
import {
  incrementReportCount,
  recordReport,
  type ModerationPrisma,
} from "../../src/safety/prisma-deps.js";

describe("detectHarassment", () => {
  it("flags an explicit threat as severe", () => {
    const r = detectHarassment("i will kill you");
    expect(r.flagged).toBe(true);
    expect(r.severe).toBe(true);
    expect(r.categories).toContain("threat");
  });

  it("flags coerced sexual demands as severe", () => {
    const r = detectHarassment("send me nudes");
    expect(r.severe).toBe(true);
    expect(r.categories).toContain("sexual_coercion");
  });

  it("flags mild profanity without being severe", () => {
    const r = detectHarassment("fuck off");
    expect(r.flagged).toBe(true);
    expect(r.severe).toBe(false);
    expect(r.categories).toContain("profanity");
  });

  it("does not flag benign chat", () => {
    expect(detectHarassment("how's your day?").flagged).toBe(false);
  });

  it("empty input is unflagged", () => {
    expect(detectHarassment("").flagged).toBe(false);
  });
});

describe("parseReportCommand", () => {
  it("bare REPORT yields unspecified", () => {
    expect(parseReportCommand("REPORT")).toEqual({
      reason: "unspecified",
      details: null,
    });
  });
  it("REPORT <reason>", () => {
    expect(parseReportCommand("report harassment")).toEqual({
      reason: "harassment",
      details: null,
    });
  });
  it("REPORT <reason>: <details>", () => {
    expect(
      parseReportCommand("REPORT harassment: they keep sending nudes"),
    ).toEqual({
      reason: "harassment",
      details: "they keep sending nudes",
    });
  });
  it("not a report", () => {
    expect(parseReportCommand("how's your day")).toBeNull();
    expect(parseReportCommand("REPORTING for duty")).toBeNull();
  });
  it("trims whitespace", () => {
    expect(parseReportCommand("  REPORT  spam  ")).toEqual({
      reason: "spam",
      details: null,
    });
  });
});

describe("recordReport (Prisma adapter)", () => {
  function fakeDb(opts: { initialReportCount?: number } = {}): {
    db: ModerationPrisma;
    state: {
      reports: Array<{ reporterId: string; subjectId: string; reason: string; details: string | null }>;
      reportCount: number;
      status: "ACTIVE" | "BANNED";
    };
  } {
    const state = {
      reports: [] as Array<{ reporterId: string; subjectId: string; reason: string; details: string | null }>,
      reportCount: opts.initialReportCount ?? 0,
      status: "ACTIVE" as "ACTIVE" | "BANNED",
    };
    const db: ModerationPrisma = {
      report: {
        create: async ({ data }: { data: { reporterId: string; subjectId: string; reason: string; details: string | null } }) => {
          state.reports.push(data);
          return { id: `r_${state.reports.length}` };
        },
      } as never,
      user: {
        update: async ({ data }: { data: { reportCount?: { increment: number }; status?: "BANNED" } }) => {
          if (data.reportCount?.increment) state.reportCount += data.reportCount.increment;
          if (data.status === "BANNED") state.status = "BANNED";
          return { reportCount: state.reportCount, status: state.status };
        },
      } as never,
      $transaction: (async (fn: (tx: ModerationPrisma) => Promise<unknown>) => fn(db)) as unknown as ModerationPrisma["$transaction"],
    };
    return { db, state };
  }

  it("creates a Report row and increments count", async () => {
    const { db, state } = fakeDb();
    const r = await recordReport(db, {
      reporterId: "u_a",
      subjectId: "u_b",
      reason: "harassment",
      details: null,
    });
    expect(r.reportId).toBe("r_1");
    expect(r.newReportCount).toBe(1);
    expect(r.autoBanned).toBe(false);
    expect(state.status).toBe("ACTIVE");
  });

  it("auto-bans at threshold (default 3)", async () => {
    const { db, state } = fakeDb({ initialReportCount: 2 });
    const r = await recordReport(db, {
      reporterId: "u_a",
      subjectId: "u_b",
      reason: "harassment",
      details: "ongoing",
    });
    expect(r.newReportCount).toBe(3);
    expect(r.autoBanned).toBe(true);
    expect(state.status).toBe("BANNED");
  });

  it("respects a custom threshold", async () => {
    const { db } = fakeDb({ initialReportCount: 0 });
    const r = await recordReport(db, {
      reporterId: "u_a",
      subjectId: "u_b",
      reason: "spam",
      details: null,
      autoBanThreshold: 1,
    });
    expect(r.autoBanned).toBe(true);
  });

  it("incrementReportCount bumps without a Report row", async () => {
    const { db, state } = fakeDb({ initialReportCount: 0 });
    const r = await incrementReportCount(db, "u_b");
    expect(r.newReportCount).toBe(1);
    expect(state.reports).toHaveLength(0);
  });
});
