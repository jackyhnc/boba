// Admin endpoints — operator tooling.
//
// All routes:
//   - Require `X-Admin-Token: <ADMIN_TOKEN env>` (see `auth.ts`).
//   - Return JSON.
//   - Are intentionally NOT exposed in the OpenAPI/swagger surface (none
//     ships yet) so external dashboards must opt in by reading these
//     comments + tests.

import type { FastifyInstance } from "fastify";
import type { UserStatus } from "@prisma/client";
import {
  createManyInvites,
  countUnredeemed,
  type InvitePrisma,
} from "../invites/index.js";
import { loadEnv } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { makeAdminAuth } from "./auth.js";
import {
  banUser,
  getConversation,
  listUsers,
  unbanUser,
  type AdminPrisma,
} from "./prisma-deps.js";

export interface RegisterAdminOptions {
  deps?: {
    prisma?: AdminPrisma & InvitePrisma;
  };
}

export async function registerAdminRoutes(
  app: FastifyInstance,
  options: RegisterAdminOptions = {},
): Promise<void> {
  const env = loadEnv();
  const db =
    options.deps?.prisma ?? (prisma as unknown as AdminPrisma & InvitePrisma);
  const auth = makeAdminAuth({ expected: env.ADMIN_TOKEN });

  app.get<{
    Querystring: { limit?: string; cursor?: string; status?: string };
  }>(
    "/admin/users",
    { preHandler: auth },
    async (req, _reply) => {
      const limit = req.query.limit ? parseInt(req.query.limit, 10) : undefined;
      const status = (req.query.status as UserStatus | undefined) ?? null;
      const cursor = req.query.cursor ?? null;
      return listUsers(db, { limit, cursor, status });
    },
  );

  app.get<{ Params: { id: string } }>(
    "/admin/match/:id",
    { preHandler: auth },
    async (req, reply) => {
      const view = await getConversation(db, req.params.id);
      if (!view) {
        return reply.code(404).send({ error: "match not found" });
      }
      return view;
    },
  );

  app.post<{ Params: { id: string } }>(
    "/admin/users/:id/ban",
    { preHandler: auth },
    async (req, reply) => {
      const result = await banUser(db, req.params.id);
      if (!result) return reply.code(404).send({ error: "user not found" });
      return result;
    },
  );

  app.post<{ Params: { id: string } }>(
    "/admin/users/:id/unban",
    { preHandler: auth },
    async (req, reply) => {
      const result = await unbanUser(db, req.params.id);
      if (!result) return reply.code(404).send({ error: "user not found" });
      return result;
    },
  );

  app.post(
    "/admin/run-daily-match",
    { preHandler: auth },
    async (_req, _reply) => {
      const result = await app.runDailyMatch();
      return {
        candidates: result.candidates,
        selectedCount: result.selected.length,
        createdMatchIds: result.createdMatchIds,
        notified: result.notified.length,
        notifyErrors: result.notifyErrors,
      };
    },
  );

  app.post<{ Body: { count?: number; label?: string } }>(
    "/admin/invites/bulk",
    { preHandler: auth },
    async (req, reply) => {
      const count = Math.max(1, Math.min(req.body?.count ?? 1, 200));
      const label = req.body?.label?.trim() || null;
      const codes = await createManyInvites(db, { count, label });
      const remaining = await countUnredeemed(db);
      return reply.code(201).send({ codes, unredeemed: remaining });
    },
  );
}
