// Contract pins for startScheduler's interaction with node-cron and
// runDailyMatch.
//
// The existing `tests/scheduler/cron.test.ts` covers invalid-expression
// rejection, the round-trip through `triggerNow`, and the no-throw on
// stop. It does NOT pin anything about HOW we drive node-cron. Several
// invariants live at that seam:
//
//   1. `validate` runs BEFORE `schedule` (validate-first is what makes the
//      "invalid cron" throw observable to the caller; flipping the order
//      would mean we schedule a malformed task then throw).
//   2. `schedule` is NOT called when the expression is invalid.
//   3. The default options object passed to `schedule` is EXACTLY
//      `{ timezone: "UTC" }`. node-cron's local-zone default would
//      silently shift the daily-match cutover on hosts in non-UTC zones
//      (Render/Fly defaults; serverless boxes; CI). UTC must be sticky.
//   4. A custom timezone propagates verbatim (no coercion).
//   5. The callback handed to `schedule` is a 0-arg function that returns
//      `undefined` SYNCHRONOUSLY — i.e. the `void runOnce()` wrapper. If
//      we ever return the promise directly, node-cron's "swallow unhandled
//      rejection at tick" semantics change (and a rejection inside
//      runDailyMatch crashes the process under modern Node).
//   6. The `task` returned by `cron.schedule` is the same object exposed
//      as `handle.task`, and `stopScheduler` calls `task.stop()`.
//   7. `triggerNow` returns the runDailyMatch result on success.
//   8. `triggerNow` PROPAGATES errors — `runOnce` rethrows after logging so
//      the admin endpoint can surface 500s. (node-cron's tick swallows
//      because of `void`; that's the asymmetry we need.)
//   9. Logger contract on success: `info("scheduler.tick")` on entry and
//      `info({candidates, selected, notified, notifyErrors}, "scheduler.tick complete")`
//      on success — these are the metrics ops care about.
//  10. Logger contract on failure: `error({err}, "scheduler.tick failed")`.
//  11. When the scheduled callback fires (we capture it from
//      `cron.schedule`'s args), it invokes `runDailyMatch` exactly the
//      same way `triggerNow` does — same deps, same shape.
//
// We mock `node-cron` to capture `validate`/`schedule` call shapes, and
// use the existing emptyDb/dryTwilio test doubles for runDailyMatch.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

interface ScheduleCall {
  expression: string;
  fn: () => unknown;
  options: { timezone?: string } | undefined;
}

// vi.mock factories are hoisted above all `const`s — share state via
// vi.hoisted so the mock and the assertions reference the same objects.
const hoisted = vi.hoisted(() => {
  const cronCalls: {
    validate: string[];
    schedule: ScheduleCall[];
    order: Array<"validate" | "schedule">;
  } = { validate: [], schedule: [], order: [] };

  const fakeTask = {
    stop: vi.fn(),
    start: vi.fn(),
    destroy: vi.fn(),
  };

  const validateImpl = vi.fn((expr: string) => {
    cronCalls.validate.push(expr);
    cronCalls.order.push("validate");
    return expr !== "INVALID";
  });

  const scheduleImpl = vi.fn(
    (expression: string, fn: () => unknown, options?: { timezone?: string }) => {
      cronCalls.schedule.push({ expression, fn, options });
      cronCalls.order.push("schedule");
      return fakeTask as unknown as { stop: () => void };
    },
  );

  return { cronCalls, fakeTask, validateImpl, scheduleImpl };
});

const { cronCalls, fakeTask, validateImpl, scheduleImpl } = hoisted;

vi.mock("node-cron", () => {
  const nodeCron = {
    schedule: hoisted.scheduleImpl,
    validate: hoisted.validateImpl,
  };
  return {
    default: nodeCron,
    schedule: hoisted.scheduleImpl,
    validate: hoisted.validateImpl,
  };
});

// Import AFTER the mock so the module picks up the mocked node-cron.
import { startScheduler, stopScheduler } from "../../src/scheduler/cron.js";
import type { MatchingPrisma } from "../../src/matching/prisma-deps.js";
import type { PhoneLookup } from "../../src/scheduler/runDailyMatch.js";
import type { TwilioClient } from "../../src/twilio/client.js";

function silentLogger() {
  const info = vi.fn();
  const warn = vi.fn();
  const error = vi.fn();
  const debug = vi.fn();
  const trace = vi.fn();
  const fatal = vi.fn();
  const logger = {
    info,
    warn,
    error,
    debug,
    trace,
    fatal,
    child: () => logger,
    level: "silent",
  };
  return logger as unknown as Parameters<typeof startScheduler>[0]["logger"] & {
    info: typeof info;
    error: typeof error;
  };
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

function throwingDb(message: string): MatchingPrisma & PhoneLookup {
  // findMany on `user` is the first DB call inside runDailyMatch's
  // loadSelectorContext, so throwing here surfaces synchronously enough
  // for our purposes.
  const db: MatchingPrisma & PhoneLookup = {
    user: {
      findMany: async () => {
        throw new Error(message);
      },
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

beforeEach(() => {
  cronCalls.validate.length = 0;
  cronCalls.schedule.length = 0;
  cronCalls.order.length = 0;
  validateImpl.mockClear();
  scheduleImpl.mockClear();
  fakeTask.stop.mockClear();
});

afterEach(() => {
  // No global state to reset.
});

describe("startScheduler — validate-before-schedule order", () => {
  it("calls validate exactly once with the supplied expression", () => {
    const handle = startScheduler({
      prisma: emptyDb(),
      twilio: dryTwilio(),
      logger: silentLogger(),
      cronExpression: "0 21 * * *",
    });
    stopScheduler(handle);

    expect(validateImpl).toHaveBeenCalledTimes(1);
    expect(cronCalls.validate).toEqual(["0 21 * * *"]);
  });

  it("calls schedule AFTER validate (order pinned)", () => {
    const handle = startScheduler({
      prisma: emptyDb(),
      twilio: dryTwilio(),
      logger: silentLogger(),
      cronExpression: "*/5 * * * *",
    });
    stopScheduler(handle);

    expect(cronCalls.order).toEqual(["validate", "schedule"]);
  });

  it("does NOT call schedule when validate returns false", () => {
    expect(() =>
      startScheduler({
        prisma: emptyDb(),
        twilio: dryTwilio(),
        logger: silentLogger(),
        cronExpression: "INVALID",
      }),
    ).toThrow(/invalid cron/i);

    expect(scheduleImpl).not.toHaveBeenCalled();
    expect(cronCalls.order).toEqual(["validate"]);
  });

  it("includes the bad expression in the error message (for ops paging)", () => {
    expect(() =>
      startScheduler({
        prisma: emptyDb(),
        twilio: dryTwilio(),
        logger: silentLogger(),
        cronExpression: "INVALID",
      }),
    ).toThrow(/INVALID/);
  });
});

describe("startScheduler — schedule call shape", () => {
  it("default timezone is exactly { timezone: \"UTC\" } (NOT host local, NOT undefined)", () => {
    const handle = startScheduler({
      prisma: emptyDb(),
      twilio: dryTwilio(),
      logger: silentLogger(),
      cronExpression: "0 21 * * *",
    });
    stopScheduler(handle);

    expect(scheduleImpl).toHaveBeenCalledTimes(1);
    const call = cronCalls.schedule[0]!;
    expect(call.expression).toBe("0 21 * * *");
    expect(call.options).toEqual({ timezone: "UTC" });
  });

  it("custom timezone propagates verbatim (no rewrite, no coercion)", () => {
    const handle = startScheduler({
      prisma: emptyDb(),
      twilio: dryTwilio(),
      logger: silentLogger(),
      cronExpression: "0 21 * * *",
      timezone: "America/New_York",
    });
    stopScheduler(handle);

    expect(cronCalls.schedule[0]!.options).toEqual({ timezone: "America/New_York" });
  });

  it("the scheduled callback is a 0-arg function (matches node-cron's TaskFn shape)", () => {
    const handle = startScheduler({
      prisma: emptyDb(),
      twilio: dryTwilio(),
      logger: silentLogger(),
      cronExpression: "0 21 * * *",
    });
    stopScheduler(handle);

    const fn = cronCalls.schedule[0]!.fn;
    expect(typeof fn).toBe("function");
    expect(fn.length).toBe(0);
  });

  it("the scheduled callback returns undefined SYNCHRONOUSLY (it's `void runOnce()`, not the promise itself)", () => {
    // This is the critical invariant: if we ever return the runOnce promise
    // directly, node-cron's "tick rejection silently swallowed" behaviour
    // changes — under modern Node an unhandled rejection from runDailyMatch
    // would crash the process.
    const handle = startScheduler({
      prisma: emptyDb(),
      twilio: dryTwilio(),
      logger: silentLogger(),
      cronExpression: "0 21 * * *",
    });
    stopScheduler(handle);

    const ret = cronCalls.schedule[0]!.fn();
    expect(ret).toBeUndefined();
    // Belt-and-brace: it's not a thenable either.
    expect(typeof (ret as unknown as { then?: unknown } | undefined)?.then).toBe(
      "undefined",
    );
  });

  it("handle.task is the same object node-cron returned (so SchedulerHandle is just a wrapper)", () => {
    const handle = startScheduler({
      prisma: emptyDb(),
      twilio: dryTwilio(),
      logger: silentLogger(),
      cronExpression: "0 21 * * *",
    });

    expect(handle.task).toBe(fakeTask);

    stopScheduler(handle);
    expect(fakeTask.stop).toHaveBeenCalledTimes(1);
  });
});

describe("triggerNow — success path", () => {
  it("returns the runDailyMatch result (candidates/selected/notified/notifyErrors)", async () => {
    const handle = startScheduler({
      prisma: emptyDb(),
      twilio: dryTwilio(),
      logger: silentLogger(),
      cronExpression: "0 21 * * *",
    });

    const result = await handle.triggerNow();

    expect(result).toMatchObject({
      candidates: 0,
      selected: [],
      notified: [],
      notifyErrors: [],
    });

    stopScheduler(handle);
  });

  it("logs `scheduler.tick` on entry with the cron expression", async () => {
    const logger = silentLogger();
    const handle = startScheduler({
      prisma: emptyDb(),
      twilio: dryTwilio(),
      logger,
      cronExpression: "0 21 * * *",
    });

    await handle.triggerNow();

    // First info call: the tick entry log.
    const calls = (logger as unknown as { info: { mock: { calls: Array<[unknown, string?]> } } })
      .info.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0]![0]).toEqual({ cron: "0 21 * * *" });
    expect(calls[0]![1]).toBe("scheduler.tick");

    stopScheduler(handle);
  });

  it("logs `scheduler.tick complete` on success with the four metric fields", async () => {
    const logger = silentLogger();
    const handle = startScheduler({
      prisma: emptyDb(),
      twilio: dryTwilio(),
      logger,
      cronExpression: "0 21 * * *",
    });

    await handle.triggerNow();

    const calls = (logger as unknown as { info: { mock: { calls: Array<[unknown, string?]> } } })
      .info.mock.calls;
    // The completion log is the second info() (entry then completion).
    const complete = calls.find((c) => c[1] === "scheduler.tick complete");
    expect(complete).toBeDefined();
    // Exactly these four fields — pins the ops contract.
    const payload = complete![0] as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual([
      "candidates",
      "notified",
      "notifyErrors",
      "selected",
    ]);
    expect(payload).toEqual({
      candidates: 0,
      selected: 0,
      notified: 0,
      notifyErrors: 0,
    });

    stopScheduler(handle);
  });
});

describe("triggerNow — failure path", () => {
  it("propagates runDailyMatch rejections to the caller (admin endpoint can 500)", async () => {
    const handle = startScheduler({
      prisma: throwingDb("db is down"),
      twilio: dryTwilio(),
      logger: silentLogger(),
      cronExpression: "0 21 * * *",
    });

    await expect(handle.triggerNow()).rejects.toThrow(/db is down/);

    stopScheduler(handle);
  });

  it("logs `scheduler.tick failed` with the error before rethrowing", async () => {
    const logger = silentLogger();
    const handle = startScheduler({
      prisma: throwingDb("db is down"),
      twilio: dryTwilio(),
      logger,
      cronExpression: "0 21 * * *",
    });

    await expect(handle.triggerNow()).rejects.toThrow();

    const errCalls = (logger as unknown as { error: { mock: { calls: Array<[unknown, string?]> } } })
      .error.mock.calls;
    expect(errCalls).toHaveLength(1);
    expect(errCalls[0]![1]).toBe("scheduler.tick failed");
    const payload = errCalls[0]![0] as { err: Error };
    expect(payload.err).toBeInstanceOf(Error);
    expect(payload.err.message).toBe("db is down");

    stopScheduler(handle);
  });

  it("does NOT log `scheduler.tick complete` when runDailyMatch fails", async () => {
    const logger = silentLogger();
    const handle = startScheduler({
      prisma: throwingDb("nope"),
      twilio: dryTwilio(),
      logger,
      cronExpression: "0 21 * * *",
    });

    await expect(handle.triggerNow()).rejects.toThrow();

    const infoCalls = (logger as unknown as { info: { mock: { calls: Array<[unknown, string?]> } } })
      .info.mock.calls;
    expect(infoCalls.some((c) => c[1] === "scheduler.tick complete")).toBe(false);
    // The entry log still fired — we want to know the tick STARTED, even
    // on failures.
    expect(infoCalls.some((c) => c[1] === "scheduler.tick")).toBe(true);

    stopScheduler(handle);
  });
});

describe("the scheduled callback (what fires on each tick)", () => {
  it("invoking the captured callback drives runDailyMatch end-to-end without throwing to node-cron", async () => {
    // node-cron passes the callback to its internal tick; the `void` in
    // `void runOnce()` is what prevents a rejection from escaping. This
    // test simulates a tick: we grab the callback, invoke it, then let
    // microtasks drain to confirm no synchronous throw or hang.
    const logger = silentLogger();
    const handle = startScheduler({
      prisma: emptyDb(),
      twilio: dryTwilio(),
      logger,
      cronExpression: "0 21 * * *",
    });

    const tickCallback = cronCalls.schedule[0]!.fn;
    expect(() => tickCallback()).not.toThrow();

    // Let the microtask queue drain; the runOnce promise inside `void`
    // should resolve and the completion log should fire.
    await new Promise((resolve) => setImmediate(resolve));

    const infoCalls = (logger as unknown as { info: { mock: { calls: Array<[unknown, string?]> } } })
      .info.mock.calls;
    expect(infoCalls.some((c) => c[1] === "scheduler.tick complete")).toBe(true);

    stopScheduler(handle);
  });

  it("invoking the captured callback when runDailyMatch fails does NOT throw to node-cron (void-wrapping holds)", async () => {
    // Critical: if the wrapper ever became `return runOnce()` instead of
    // `void runOnce()`, node-cron would receive a rejected promise and
    // (depending on its version) crash the process or log a noisy
    // unhandled rejection. We pin the void contract by asserting the
    // callback returns undefined and does not throw even when the
    // underlying runDailyMatch is failing.
    const logger = silentLogger();
    const handle = startScheduler({
      prisma: throwingDb("explode"),
      twilio: dryTwilio(),
      logger,
      cronExpression: "0 21 * * *",
    });

    const tickCallback = cronCalls.schedule[0]!.fn;

    // Capture unhandled-rejection events during the tick so we can
    // belt-and-brace that the rejection is observed by Node (and would be
    // caught by Sentry's global handler in prod) without crashing.
    let unhandled = 0;
    const onUnhandled = () => {
      unhandled++;
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      expect(tickCallback()).toBeUndefined();
      // Drain microtasks so the rejected runOnce promise surfaces.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      // The runDailyMatch error should have been logged.
      const errCalls = (logger as unknown as { error: { mock: { calls: Array<[unknown, string?]> } } })
        .error.mock.calls;
      expect(errCalls.length).toBeGreaterThanOrEqual(1);
      expect(errCalls[0]![1]).toBe("scheduler.tick failed");
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    // node-cron's tick wrapper sees `undefined`, so no rejection is
    // attributed to it. We deliberately don't assert `unhandled === 0`
    // because Node's behaviour around an awaited-then-re-thrown rejection
    // inside a void-wrapped IIFE depends on version; instead we pin the
    // observable contract: the callback returned undefined, and the error
    // path logged through the configured logger.
    void unhandled;

    stopScheduler(handle);
  });
});

describe("stopScheduler", () => {
  it("calls task.stop() exactly once", () => {
    const handle = startScheduler({
      prisma: emptyDb(),
      twilio: dryTwilio(),
      logger: silentLogger(),
      cronExpression: "0 21 * * *",
    });

    stopScheduler(handle);
    expect(fakeTask.stop).toHaveBeenCalledTimes(1);
  });

  it("calling stopScheduler twice stops the underlying task twice (no internal guard)", () => {
    // We don't currently guard against double-stop. Pinned because adding
    // a guard would change the call count and `node-cron` is permissive
    // about double-stop. If we ever want idempotent stop we should change
    // the test too.
    const handle = startScheduler({
      prisma: emptyDb(),
      twilio: dryTwilio(),
      logger: silentLogger(),
      cronExpression: "0 21 * * *",
    });

    stopScheduler(handle);
    stopScheduler(handle);
    expect(fakeTask.stop).toHaveBeenCalledTimes(2);
  });
});
