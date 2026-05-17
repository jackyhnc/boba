import { PrismaClient, Prisma } from "@prisma/client";

// Single shared Prisma client. Connections are lazy; constructing the client
// does not open a DB connection, so it is safe to import in test environments
// that never call into the database.
export const prisma = new PrismaClient();

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}

// Re-exports so the rest of the codebase has a single import surface for
// Prisma types and enums.
export { PrismaClient, Prisma };
export type {
  User,
  Preferences,
  Stats,
  DailyMatch,
  Message,
  MilestoneProgress,
  EndOfDayDecision,
  RematchHistory,
  Report,
} from "@prisma/client";
export {
  UserStatus,
  Gender,
  MatchState,
  MilestoneType,
  Decision,
  MessageDirection,
} from "@prisma/client";
