import { buildApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import { disconnectPrisma } from "./lib/prisma.js";
import { initSentry } from "./observability/sentry.js";

async function main(): Promise<void> {
  const env = loadEnv();
  // Initialize Sentry before any Fastify hooks so error capture is live
  // from the first request. No-op when SENTRY_DSN is empty.
  initSentry({ env });
  const app = await buildApp();

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    try {
      await app.close();
      await disconnectPrisma();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, "error during shutdown");
      process.exit(1);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await app.listen({ port: env.PORT, host: "0.0.0.0" });
  } catch (err) {
    app.log.error({ err }, "failed to start");
    process.exit(1);
  }
}

void main();
