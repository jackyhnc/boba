import Fastify, { type FastifyInstance } from "fastify";
import sensible from "@fastify/sensible";
import formbody from "@fastify/formbody";
import { loadEnv } from "./config/env.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerTwilioRoutes, type RegisterOptions as TwilioRegisterOptions } from "./twilio/routes.js";

export interface BuildAppOptions {
  twilio?: TwilioRegisterOptions;
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

  return app;
}
