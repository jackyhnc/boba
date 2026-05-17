import { PrismaClient } from "@prisma/client";

// Single shared Prisma client. Schema is intentionally bare for now; the next
// task will add models and migrations.
export const prisma = new PrismaClient();

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}
