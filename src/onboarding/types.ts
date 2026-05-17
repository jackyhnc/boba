// Onboarding state machine — type surface.
//
// Onboarding is a linear sequence of questions delivered over SMS. Each
// step knows how to parse an answer and which field it lands in. We keep
// the cursor on `User.onboardingStep` as a string so the schema doesn't
// need a Prisma enum for it (steps may evolve faster than migrations).

import type { Gender } from "@prisma/client";

/**
 * Step identifiers, in the order the user encounters them.
 *
 * Order matters: `STEP_ORDER` below is the source of truth for what
 * comes next. Adding a step is one append + one parser; reordering is
 * one array edit.
 */
export const STEP_IDS = [
  "welcome",
  "ask_invite_code",
  "ask_display_name",
  "ask_age",
  "ask_gender",
  "ask_profession",
  "ask_height_cm",
  "ask_photo",
  "ask_preferred_genders",
  "ask_min_age",
  "ask_max_age",
  "ask_type_descriptor",
  "ask_campus_email_domain",
  "done",
] as const;

export type StepId = (typeof STEP_IDS)[number];

export const STEP_ORDER: ReadonlyArray<StepId> = STEP_IDS;

/**
 * What a step writes when its parser succeeds. Every field is optional —
 * a single answer touches one or two fields.
 */
export interface OnboardingUpdates {
  user?: {
    displayName?: string;
    campusEmailDomain?: string;
  };
  stats?: {
    age?: number;
    gender?: Gender;
    profession?: string;
    heightCm?: number;
    photoUrl?: string;
  };
  preferences?: {
    preferredGenders?: Gender[];
    minAge?: number;
    maxAge?: number;
    typeDescriptor?: string;
  };
  /**
   * Set during the `ask_invite_code` step. The route handler should call
   * `redeemCode({userId, rawCode})` and short-circuit on failure.
   */
  inviteCodeToRedeem?: string;
}

export interface ParseSuccess {
  ok: true;
  updates: OnboardingUpdates;
}
export interface ParseFailure {
  ok: false;
  /** Reply shown to the user explaining why we didn't accept their answer. */
  reason: string;
}
export type ParseResult = ParseSuccess | ParseFailure;

/**
 * Result of advancing the onboarding state machine for one inbound.
 *
 * `nextStep` is the step the user should now be on. When the run is
 * complete, `nextStep === "done"` AND `markActive` is true.
 */
export interface AdvanceResult {
  nextStep: StepId;
  /** Field updates to persist on User / Stats / Preferences. */
  updates: OnboardingUpdates;
  /** Outbound SMS body the user should receive. */
  reply: string;
  /** When true, the caller should flip the user's status to ACTIVE. */
  markActive: boolean;
}

/**
 * Optional Twilio-supplied media attachment on the inbound SMS — used
 * by the photo step. The flow itself doesn't care about content; the
 * route handler is responsible for validating type/size and producing
 * a URL the photo step can land in `stats.photoUrl`.
 */
export interface InboundMedia {
  url: string;
  contentType: string | null;
}

/** Optional environment knobs the flow consults. */
export interface FlowConfig {
  invitesRequired: boolean;
}

export const DEFAULT_FLOW_CONFIG: FlowConfig = {
  invitesRequired: true,
};
