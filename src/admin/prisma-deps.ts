// Prisma adapter for admin queries.

import type { PrismaClient, UserStatus } from "@prisma/client";

export type AdminPrisma = Pick<
  PrismaClient,
  "user" | "dailyMatch" | "message"
>;

export interface AdminUserRow {
  id: string;
  phone: string;
  displayName: string | null;
  status: UserStatus;
  onboardingStep: string | null;
  reportCount: number;
  isAiBacked: boolean;
  createdAt: Date;
}

export async function listUsers(
  prisma: AdminPrisma,
  args: { limit?: number; cursor?: string | null; status?: UserStatus | null } = {},
): Promise<{ users: AdminUserRow[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(args.limit ?? 25, 1), 100);
  const rows = await prisma.user.findMany({
    where: args.status ? { status: args.status } : undefined,
    orderBy: { createdAt: "desc" },
    take: limit + 1,
    ...(args.cursor ? { skip: 1, cursor: { id: args.cursor } } : {}),
    select: {
      id: true,
      phone: true,
      displayName: true,
      status: true,
      onboardingStep: true,
      reportCount: true,
      isAiBacked: true,
      createdAt: true,
    },
  });
  const nextCursor = rows.length > limit ? (rows[limit - 1]?.id ?? null) : null;
  return { users: rows.slice(0, limit), nextCursor };
}

export interface AdminConversationView {
  match: {
    id: string;
    matchDate: Date;
    state: string;
    compatibilityScore: number;
    userA: { id: string; phone: string; displayName: string | null };
    userB: { id: string; phone: string; displayName: string | null };
  };
  messages: Array<{
    id: string;
    senderId: string;
    direction: string;
    body: string;
    depthScore: number;
    flaggedStatFishing: boolean;
    flaggedHarassment: boolean;
    createdAt: Date;
  }>;
}

export async function getConversation(
  prisma: AdminPrisma,
  matchId: string,
): Promise<AdminConversationView | null> {
  const match = await prisma.dailyMatch.findUnique({
    where: { id: matchId },
    select: {
      id: true,
      matchDate: true,
      state: true,
      compatibilityScore: true,
      userA: { select: { id: true, phone: true, displayName: true } },
      userB: { select: { id: true, phone: true, displayName: true } },
    },
  });
  if (!match) return null;
  const messages = await prisma.message.findMany({
    where: { matchId },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      senderId: true,
      direction: true,
      body: true,
      depthScore: true,
      flaggedStatFishing: true,
      flaggedHarassment: true,
      createdAt: true,
    },
  });
  return { match, messages };
}

export interface BanResult {
  before: UserStatus | null;
  after: UserStatus;
}

export async function banUser(
  prisma: AdminPrisma,
  userId: string,
): Promise<BanResult | null> {
  const existing = await prisma.user.findUnique({
    where: { id: userId },
    select: { status: true },
  });
  if (!existing) return null;
  const updated = await prisma.user.update({
    where: { id: userId },
    data: { status: "BANNED" },
    select: { status: true },
  });
  return { before: existing.status, after: updated.status };
}

export async function unbanUser(
  prisma: AdminPrisma,
  userId: string,
): Promise<BanResult | null> {
  const existing = await prisma.user.findUnique({
    where: { id: userId },
    select: { status: true },
  });
  if (!existing) return null;
  // Restoring to ACTIVE; if they were mid-onboarding we leave that to
  // operator judgment via direct DB edits — this endpoint is the
  // common "unblock from BANNED" path.
  const updated = await prisma.user.update({
    where: { id: userId },
    data: { status: "ACTIVE" },
    select: { status: true },
  });
  return { before: existing.status, after: updated.status };
}
