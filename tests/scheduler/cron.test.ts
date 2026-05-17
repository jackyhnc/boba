import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startScheduler, stopScheduler } from "../../src/scheduler/cron.js";
import type { MatchingPrisma } from "../../src/matching/prisma-deps.js";
import type { PhoneLookup } from "../../src/scheduler/runDailyMatch.js";
import type { TwilioClient } from "../../src/twilio/client.js";

function silentLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: () => silentLogger(),
    level: "silent",
  } as unknown as Parameters<typeof startScheduler>[0]["logger"];
}

function emptyDb(): MatchingPrisma & PhoneLookup {
  const db: MatchingPrisma & PhoneLookup = {
    user: {
      findMany: async () => [],
    },
    dailyMatch: {
      findMany: async () => [],
      create: async () => ({ id: "m" }),
    },
    rematchHistory: {
      findMany: async () => [],
      upsert: async () => ({}),
    },
    $transaction: (async <T>(fn: (tx: unknown) => Promise<T>) => fn(db)) as unknown as MatchingPrisma["$transaction"],
  } as unknown as MatchingPrisma & PhoneLookup;
  return db;
}

function dryTwilio(): TwilioClient {
  return {
    sendSms: vi.fn(async () => ({ sid: "SM", dryRun: true, status: 200 })),
  };
}

const handles: Array<{ stop: () => void }> = [];

beforeEach(() => {
  // Nothing global to reset.
});

afterEach(() => {
  for (const h of handles) h.stop();
  handles.length = 0;
});

describe("startScheduler", () => {
  it("rejects an invalid cron expression", () => {
    expect(() =>
      startScheduler({
        prisma: emptyDb(),
        twilio: dryTwilio(),
        logger: silentLogger(),
        cronExpression: "not-cron",
      }),
    ).toThrow(/invalid cron/i);
  });

  it("accepts a valid expression and exposes triggerNow", async () => {
    const handle = startScheduler({
      prisma: emptyDb(),
      twilio: dryTwilio(),
      logger: silentLogger(),
      cronExpression: "0 21 * * *",
    });
    handles.push({ stop: () => stopScheduler(handle) });

    const result = await handle.triggerNow();
    expect(result.candidates).toBe(0);
    expect(result.selected).toHaveLength(0);
  });

  it("stopScheduler stops the task without throwing", () => {
    const handle = startScheduler({
      prisma: emptyDb(),
      twilio: dryTwilio(),
      logger: silentLogger(),
      cronExpression: "0 * * * *",
    });
    expect(() => stopScheduler(handle)).not.toThrow();
  });
});
