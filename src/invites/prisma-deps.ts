// Prisma adapter for invites.

import type { PrismaClient } from "@prisma/client";
import { generateCode, normalizeCode } from "./code.js";
import type { GeneratedInvite, InviteRedemption } from "./types.js";

export type InvitePrisma = Pick<PrismaClient, "inviteCode" | "$transaction">;

/**
 * Atomically redeem an invite code for a user.
 *
 * Failure modes:
 *   - unknown_code: no row matches the normalized code.
 *   - already_redeemed: the code is already claimed by *someone else*.
 *   - self_already_redeemed: this user has already redeemed a code.
 *
 * The `redeemedById` column has a unique constraint, so a user can hold
 * at most one redeemed row. We surface the dedicated error so the caller
 * can render a useful reply ("you've already joined").
 */
export async function redeemCode(
  prisma: InvitePrisma,
  args: { userId: string; rawCode: string },
): Promise<InviteRedemption> {
  const code = normalizeCode(args.rawCode);
  return prisma.$transaction(async (tx) => {
    const invite = await tx.inviteCode.findUnique({
      where: { code },
      select: { id: true, redeemedById: true },
    });
    if (!invite) return { ok: false, reason: "unknown_code" };
    if (invite.redeemedById && invite.redeemedById !== args.userId) {
      return { ok: false, reason: "already_redeemed" };
    }

    const existing = await tx.inviteCode.findFirst({
      where: { redeemedById: args.userId },
      select: { id: true, code: true },
    });
    if (existing && existing.id !== invite.id) {
      return { ok: false, reason: "self_already_redeemed" };
    }

    if (!invite.redeemedById) {
      await tx.inviteCode.update({
        where: { id: invite.id },
        data: { redeemedById: args.userId, redeemedAt: new Date() },
      });
    }
    return { ok: true, inviteId: invite.id };
  });
}

/** Persist a freshly generated invite code, retrying on collisions. */
export async function createInvite(
  prisma: InvitePrisma,
  opts: { label?: string | null; maxAttempts?: number } = {},
): Promise<GeneratedInvite> {
  const maxAttempts = opts.maxAttempts ?? 5;
  for (let i = 0; i < maxAttempts; i++) {
    const code = generateCode();
    try {
      const row = await prisma.inviteCode.create({
        data: { code, label: opts.label ?? null },
        select: { id: true, code: true },
      });
      return row;
    } catch (err) {
      const isUniqueViolation =
        typeof err === "object" &&
        err !== null &&
        // Prisma error envelopes vary across drivers; check both.
        (("code" in err && (err as { code?: string }).code === "P2002") ||
          /unique/i.test(String((err as { message?: string }).message ?? "")));
      if (!isUniqueViolation) throw err;
    }
  }
  throw new Error("createInvite: exhausted attempts on unique collisions");
}

/** Bulk-create N codes; useful for one-shot launch batches. */
export async function createManyInvites(
  prisma: InvitePrisma,
  args: { count: number; label?: string | null },
): Promise<GeneratedInvite[]> {
  const out: GeneratedInvite[] = [];
  for (let i = 0; i < args.count; i++) {
    out.push(await createInvite(prisma, { label: args.label ?? null }));
  }
  return out;
}

/** Count unredeemed codes — useful for admin / alerting. */
export async function countUnredeemed(prisma: InvitePrisma): Promise<number> {
  return prisma.inviteCode.count({ where: { redeemedById: null } });
}
