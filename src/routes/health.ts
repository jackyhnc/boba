import type { FastifyInstance } from "fastify";
import { prisma } from "../lib/prisma.js";

export interface HealthDeps {
  /** Test override; defaults to the shared Prisma client. */
  pingDb?: () => Promise<void>;
}

export async function registerHealthRoutes(
  app: FastifyInstance,
  deps: HealthDeps = {},
): Promise<void> {
  const pingDb =
    deps.pingDb ??
    (async (): Promise<void> => {
      // `SELECT 1` round-trip — cheap enough for liveness probes.
      await prisma.$queryRaw`SELECT 1`;
    });

  // Liveness: process is up.
  app.get("/health", async () => ({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  }));

  // Readiness: dependencies (Postgres) reachable. Used by Fly/Render to
  // decide whether to route traffic.
  app.get("/readyz", async (_req, reply) => {
    try {
      await pingDb();
      return { status: "ready" };
    } catch (err) {
      app.log.error({ err }, "readyz: db ping failed");
      return reply
        .code(503)
        .send({ status: "not_ready", reason: "db_unreachable" });
    }
  });

  app.get("/", async () => ({
    name: "boba",
    description: "Conversation-first dating, relayed over SMS.",
  }));
}
