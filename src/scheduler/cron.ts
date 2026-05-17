// Cron driver around `runDailyMatch`.
//
// Boots only when `SCHEDULER_ENABLED=true` so dev / CI never schedule by
// accident. The schedule string is a standard 5-field cron expression
// interpreted in UTC (override timezone via the optional `tz` arg).
//
// We swallow runner errors so a single failure doesn't crash the
// scheduled task — they're surfaced through the logger and the next
// tick will try again.

import cron, { type ScheduledTask } from "node-cron";
import type { FastifyBaseLogger } from "fastify";
import type { TwilioClient } from "../twilio/client.js";
import {
  runDailyMatch,
  type PhoneLookup,
} from "./runDailyMatch.js";
import type { MatchingPrisma } from "../matching/prisma-deps.js";

export interface SchedulerDeps {
  prisma: MatchingPrisma & PhoneLookup;
  twilio: TwilioClient;
  logger: FastifyBaseLogger;
  cronExpression: string;
  timezone?: string;
}

export interface SchedulerHandle {
  /** node-cron task we can stop on shutdown. */
  task: ScheduledTask;
  /** Trigger a run now (also used by the admin endpoint). */
  triggerNow: () => Promise<Awaited<ReturnType<typeof runDailyMatch>>>;
}

export function startScheduler(deps: SchedulerDeps): SchedulerHandle {
  if (!cron.validate(deps.cronExpression)) {
    throw new Error(`invalid cron expression: ${deps.cronExpression}`);
  }

  const runOnce = async (): Promise<Awaited<ReturnType<typeof runDailyMatch>>> => {
    deps.logger.info({ cron: deps.cronExpression }, "scheduler.tick");
    try {
      const result = await runDailyMatch({
        prisma: deps.prisma,
        twilio: deps.twilio,
        logger: deps.logger,
      });
      deps.logger.info(
        {
          candidates: result.candidates,
          selected: result.selected.length,
          notified: result.notified.length,
          notifyErrors: result.notifyErrors.length,
        },
        "scheduler.tick complete",
      );
      return result;
    } catch (err) {
      deps.logger.error({ err }, "scheduler.tick failed");
      throw err;
    }
  };

  const task = cron.schedule(
    deps.cronExpression,
    () => {
      // node-cron swallows promise rejections; we already log inside `runOnce`.
      void runOnce();
    },
    {
      timezone: deps.timezone ?? "UTC",
    },
  );

  return { task, triggerNow: runOnce };
}

export function stopScheduler(handle: SchedulerHandle): void {
  handle.task.stop();
}
