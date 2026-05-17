// Invite-code types.

export type InviteRedemptionFailure =
  | "unknown_code"
  | "already_redeemed"
  | "self_already_redeemed";

export interface InviteRedemptionSuccess {
  ok: true;
  inviteId: string;
}

export interface InviteRedemptionFailureResult {
  ok: false;
  reason: InviteRedemptionFailure;
}

export type InviteRedemption =
  | InviteRedemptionSuccess
  | InviteRedemptionFailureResult;

/** Result of *generating* a new code. */
export interface GeneratedInvite {
  id: string;
  code: string;
}
