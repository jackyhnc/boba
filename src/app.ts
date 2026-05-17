import Fastify, { type FastifyInstance } from "fastify";
import sensible from "@fastify/sensible";
import formbody from "@fastify/formbody";
import { loadEnv } from "./config/env.js";
import { prisma } from "./lib/prisma.js";
import { registerHealthRoutes } from "./routes/health.js";
import {
  runDailyMatch,
  startScheduler,
  stopScheduler,
  type DailyMatchRunResult,
  type PhoneLookup,
  type SchedulerHandle,
} from "./scheduler/index.js";
import type { MatchingPrisma } from "./matching/prisma-deps.js";
import { createTwilioClient, type TwilioClient } from "./twilio/client.js";
import { registerTwilioRoutes, type RegisterOptions as TwilioRegisterOptions } from "./twilio/routes.js";

declare module "fastify" {
  interface FastifyInstance {
    /** Trigger the daily-match runner now. Used by `/admin/run-daily-match`. */
    runDailyMatch: () => Promise<DailyMatchRunResult>;
  }
}

export interface BuildAppOptions {
  twilio?: TwilioRegisterOptions;
  /** Test override for the scheduler's Prisma surface + Twilio client. */
  scheduler?: {
    prisma?: MatchingPrisma & PhoneLookup;
    twilio?: TwilioClient;
    /** Force-disable cron registration (tests). */
    autoStart?: boolean;
  };
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const env = loadEnv();

  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      transport:
        env.NODE_ENV === "development"
          ? {
              target: "pino-pretty",
              options: {
                colorize: true,
                translateTime: "SYS:HH:MM:ss.l",
                ignore: "pid,hostname",
              },
            }
          : undefined,
    },
    trustProxy: true,
    bodyLimit: 1024 * 100, // 100KB — SMS bodies are tiny
  });

  await app.register(sensible);
  // Twilio webhooks are application/x-www-form-urlencoded.
  await app.register(formbody);

  await registerHealthRoutes(app);
  await registerTwilioRoutes(app, options.twilio ?? {});

  // Daily-match scheduler. The runner is always attached (so the admin
  // endpoint can fire it on demand); the cron is only registered when
  // `SCHEDULER_ENABLED=true`.
  const schedulerPrisma =
    options.scheduler?.prisma ?? (prisma as unknown as MatchingPrisma & PhoneLookup);
  const schedulerTwilio =
    options.scheduler?.twilio ?? createTwilioClient({ env, logger: app.log });

  app.decorate("runDailyMatch", () =>
    runDailyMatch({
      prisma: schedulerPrisma,
      twilio: schedulerTwilio,
      logger: app.log,
    }),
  );

  const autoStart = options.scheduler?.autoStart ?? env.SCHEDULER_ENABLED;
  if (autoStart) {
    const handle: SchedulerHandle = startScheduler({
      prisma: schedulerPrisma,
      twilio: schedulerTwilio,
      logger: app.log,
      cronExpression: env.SCHEDULER_CRON,
    });
    app.addHook("onClose", async () => {
      stopScheduler(handle);
    });
    app.log.info(
      { cron: env.SCHEDULER_CRON },
      "scheduler started",
    );
  }

  return app;
}
