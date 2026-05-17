// Onboarding flow — pure state machine.
//
// Given the user's current step and the inbound message body, advance
// to the next step (or stay put on a parse failure with a clarifying
// reply). No Prisma here; the caller persists.

import type { Gender } from "@prisma/client";
import {
  STEP_ORDER,
  type AdvanceResult,
  type OnboardingUpdates,
  type ParseResult,
  type StepId,
} from "./types.js";

// ─── Copy ───────────────────────────────────────────────────────────────────

export const COPY = {
  welcome:
    "Welcome to Boba 🧋 — conversation-first dating. We'll get you set up with a few quick questions. What should we call you? (first name is fine)",
  askAge: "Got it. How old are you?",
  askGender:
    "What's your gender? Reply WOMAN, MAN, NONBINARY, or OTHER.",
  askProfession: "What do you do? (job title or 'student' is fine)",
  askHeightCm: "How tall are you in cm? (e.g. 175)",
  askPreferredGenders:
    "Who are you open to matching with? Reply with one or more separated by commas: WOMAN, MAN, NONBINARY, OTHER.",
  askMinAge: "Minimum age you'd like to match with?",
  askMaxAge: "Maximum age?",
  askTypeDescriptor:
    "In one sentence, describe your type — what kind of person are you hoping to meet?",
  askCampusEmailDomain:
    "Last one: what's your campus email domain? (e.g. princeton.edu — we use this for university-level matching). Reply SKIP if N/A.",
  done:
    "You're all set ✅ Your first match drops today at 5pm. We'll text you here. Reply HELP at any time.",
} as const;

// ─── Parsers ────────────────────────────────────────────────────────────────

function parseDisplayName(body: string): ParseResult {
  const name = body.trim();
  if (name.length < 1 || name.length > 40) {
    return { ok: false, reason: "Names are 1–40 characters. Try again?" };
  }
  // Reject if it looks like a phone or has only digits.
  if (/^[\d\s+()-]+$/.test(name)) {
    return { ok: false, reason: "That looks like a number — what name should we use?" };
  }
  return { ok: true, updates: { user: { displayName: name } } };
}

function parseAge(body: string): ParseResult {
  const n = parseInt(body.trim(), 10);
  if (Number.isNaN(n)) return { ok: false, reason: "Please reply with a number, e.g. 22." };
  if (n < 18 || n > 99) return { ok: false, reason: "Age must be 18–99 to use Boba." };
  return { ok: true, updates: { stats: { age: n } } };
}

const GENDER_MAP: Record<string, Gender> = {
  WOMAN: "WOMAN",
  W: "WOMAN",
  F: "WOMAN",
  FEMALE: "WOMAN",
  MAN: "MAN",
  M: "MAN",
  MALE: "MAN",
  NONBINARY: "NONBINARY",
  NB: "NONBINARY",
  ENBY: "NONBINARY",
  OTHER: "OTHER",
};

function parseGender(body: string): ParseResult {
  const key = body.trim().toUpperCase();
  const g = GENDER_MAP[key];
  if (!g) {
    return {
      ok: false,
      reason: "Please reply WOMAN, MAN, NONBINARY, or OTHER.",
    };
  }
  return { ok: true, updates: { stats: { gender: g } } };
}

function parseProfession(body: string): ParseResult {
  const p = body.trim();
  if (p.length < 1 || p.length > 80) {
    return { ok: false, reason: "Keep it under 80 characters." };
  }
  return { ok: true, updates: { stats: { profession: p } } };
}

function parseHeightCm(body: string): ParseResult {
  const n = parseInt(body.trim(), 10);
  if (Number.isNaN(n)) return { ok: false, reason: "Height in cm, please — e.g. 175." };
  if (n < 120 || n > 230) return { ok: false, reason: "Height must be 120–230cm." };
  return { ok: true, updates: { stats: { heightCm: n } } };
}

function parsePreferredGenders(body: string): ParseResult {
  const parts = body.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) {
    return {
      ok: false,
      reason: "Reply with one or more: WOMAN, MAN, NONBINARY, OTHER.",
    };
  }
  const seen = new Set<Gender>();
  for (const p of parts) {
    const g = GENDER_MAP[p.toUpperCase()];
    if (!g) {
      return {
        ok: false,
        reason: `"${p}" isn't one I recognize. Reply WOMAN, MAN, NONBINARY, or OTHER.`,
      };
    }
    seen.add(g);
  }
  return {
    ok: true,
    updates: { preferences: { preferredGenders: [...seen] } },
  };
}

function parseMinAge(body: string): ParseResult {
  const n = parseInt(body.trim(), 10);
  if (Number.isNaN(n)) return { ok: false, reason: "Please send a number." };
  if (n < 18 || n > 99) return { ok: false, reason: "Min age must be 18–99." };
  return { ok: true, updates: { preferences: { minAge: n } } };
}

function parseMaxAge(body: string): ParseResult {
  const n = parseInt(body.trim(), 10);
  if (Number.isNaN(n)) return { ok: false, reason: "Please send a number." };
  if (n < 18 || n > 120) return { ok: false, reason: "Max age must be 18–120." };
  return { ok: true, updates: { preferences: { maxAge: n } } };
}

function parseTypeDescriptor(body: string): ParseResult {
  const t = body.trim();
  if (t.length < 3) {
    return { ok: false, reason: "Tell us a little more — at least a few words." };
  }
  if (t.length > 400) {
    return { ok: false, reason: "Keep it under 400 characters." };
  }
  return { ok: true, updates: { preferences: { typeDescriptor: t } } };
}

function parseCampusEmailDomain(body: string): ParseResult {
  const v = body.trim().toLowerCase();
  if (v === "skip" || v === "none" || v === "n/a") {
    return { ok: true, updates: {} };
  }
  // Accept a bare domain or an email — extract the domain.
  const atIdx = v.indexOf("@");
  const domain = atIdx >= 0 ? v.slice(atIdx + 1) : v;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) {
    return {
      ok: false,
      reason: "That doesn't look like a domain. Try `princeton.edu`, or SKIP.",
    };
  }
  return { ok: true, updates: { user: { campusEmailDomain: domain } } };
}

// ─── Step → (parser, next-step prompt) wiring ───────────────────────────────

interface StepConfig {
  parse: (body: string) => ParseResult;
  /** The prompt to send AFTER successfully completing this step. */
  nextPrompt: string;
}

// `welcome` and `done` are pseudo-steps — they don't parse anything.
const STEP_PARSERS: Record<
  Exclude<StepId, "welcome" | "done">,
  StepConfig
> = {
  ask_display_name: { parse: parseDisplayName, nextPrompt: COPY.askAge },
  ask_age: { parse: parseAge, nextPrompt: COPY.askGender },
  ask_gender: { parse: parseGender, nextPrompt: COPY.askProfession },
  ask_profession: { parse: parseProfession, nextPrompt: COPY.askHeightCm },
  ask_height_cm: { parse: parseHeightCm, nextPrompt: COPY.askPreferredGenders },
  ask_preferred_genders: {
    parse: parsePreferredGenders,
    nextPrompt: COPY.askMinAge,
  },
  ask_min_age: { parse: parseMinAge, nextPrompt: COPY.askMaxAge },
  ask_max_age: { parse: parseMaxAge, nextPrompt: COPY.askTypeDescriptor },
  ask_type_descriptor: {
    parse: parseTypeDescriptor,
    nextPrompt: COPY.askCampusEmailDomain,
  },
  ask_campus_email_domain: {
    parse: parseCampusEmailDomain,
    nextPrompt: COPY.done,
  },
};

function nextStepAfter(current: StepId): StepId {
  const idx = STEP_ORDER.indexOf(current);
  if (idx === -1 || idx === STEP_ORDER.length - 1) return "done";
  // Safe because of the bound check above.
  return STEP_ORDER[idx + 1] as StepId;
}

// ─── Driver ─────────────────────────────────────────────────────────────────

/**
 * Advance the onboarding state machine.
 *
 * `currentStep === null` means the user has just entered onboarding and
 * hasn't received the welcome yet — we send the welcome and move to the
 * first real question. `currentStep === "done"` means already complete;
 * we treat it as a no-op acknowledgement.
 *
 * Otherwise, we parse the body against the current step's parser. On
 * success we advance one slot and reply with that next step's prompt
 * (or the "done" message if there is no next slot).
 */
export function advance(
  currentStep: StepId | null,
  body: string,
): AdvanceResult {
  if (currentStep === null || currentStep === "welcome") {
    // First inbound — send welcome + ask first question.
    return {
      nextStep: "ask_display_name",
      updates: {},
      reply: COPY.welcome,
      markActive: false,
    };
  }

  if (currentStep === "done") {
    return {
      nextStep: "done",
      updates: {},
      reply: COPY.done,
      markActive: true,
    };
  }

  const cfg = STEP_PARSERS[currentStep];
  const parsed = cfg.parse(body);
  if (!parsed.ok) {
    return {
      nextStep: currentStep,
      updates: {},
      reply: parsed.reason,
      markActive: false,
    };
  }

  const next = nextStepAfter(currentStep);
  return {
    nextStep: next,
    updates: parsed.updates,
    reply: cfg.nextPrompt,
    markActive: next === "done",
  };
}

/** Exposed for tests + the relay layer that needs to merge updates. */
export function mergeUpdates(
  a: OnboardingUpdates,
  b: OnboardingUpdates,
): OnboardingUpdates {
  return {
    user: { ...(a.user ?? {}), ...(b.user ?? {}) },
    stats: { ...(a.stats ?? {}), ...(b.stats ?? {}) },
    preferences: { ...(a.preferences ?? {}), ...(b.preferences ?? {}) },
  };
}
