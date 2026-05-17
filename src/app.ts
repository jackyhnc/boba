import Fastify, { type FastifyInstance } from "fastify";
import sensible from "@fastify/sensible";
import { loadEnv } from "./config/env.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerTwilioRoutes } from "./routes/twilio.js";

export async function buildApp(): Promise<FastifyInstance> {
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

  await registerHealthRoutes(app);
  await registerTwilioRoutes(app);

  return app;
}
