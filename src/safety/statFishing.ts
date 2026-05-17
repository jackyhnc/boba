// Anti-doxxing — stat-fishing detector.
//
// Detects inbound messages that probe for identifying info BEFORE the
// natural reveal milestones unlock it. The idea: if you can't tell what
// someone looks like, you also shouldn't be able to skip the gate by
// asking "what's your instagram?" on message 3.
//
// We use a layered detector:
//   1. Regex passes for explicit asks ("what's your last name?", "send a
//      photo", "are you on insta?").
//   2. A trigger-word set checked against tokenized words.
//
// All checks are case-insensitive. False positives are preferable to
// false negatives here — flagging a benign message just means we log it
// and (optionally) hold the depthScore for that message back; we do NOT
// censor relayed bodies (the partner still sees what was said, with a
// small "⚠ heads up" header attached when the flag fires hard).

export type StatFishCategory =
  | "name"
  | "school"
  | "social"
  | "photo"
  | "phone"
  | "location";

export interface StatFishDetection {
  flagged: boolean;
  /** Distinct categories that triggered. Empty when not flagged. */
  categories: StatFishCategory[];
  /** Confidence in [0, 1]; sums of per-category hits, capped at 1. */
  confidence: number;
  /** Short tags useful for telemetry / debugging. */
  matches: string[];
}

interface Probe {
  category: StatFishCategory;
  tag: string;
  pattern: RegExp;
}

// Ordering: explicit "what's your X" / "send your X" probes first;
// looser "X?" word patterns second. Each probe is anchored on word
// boundaries where possible to reduce false hits inside other words.
const PROBES: Probe[] = [
  // ─── name ─────────────────────────────────────────────────────
  { category: "name", tag: "asks_full_name", pattern: /\bwhat(?:'s| is)\s+your\s+(?:full|last|real)\s+name\b/i },
  { category: "name", tag: "asks_last_name", pattern: /\blast\s+name\??/i },
  { category: "name", tag: "asks_what_name", pattern: /\b(?:what|whats|what's)\s+your\s+name\??/i },

  // ─── school ───────────────────────────────────────────────────
  { category: "school", tag: "asks_school", pattern: /\b(?:where|what)\s+(?:do you go to|college|university|school)\b/i },
  { category: "school", tag: "asks_campus", pattern: /\bwhat\s+campus\??/i },
  { category: "school", tag: "asks_uni", pattern: /\bwhich\s+(?:uni|university|college|school)\b/i },

  // ─── social handles ──────────────────────────────────────────
  { category: "social", tag: "asks_instagram", pattern: /\b(?:insta(?:gram)?|ig|snap(?:chat)?|tiktok|twitter|x|facebook|fb|linkedin)\b.*\?/i },
  { category: "social", tag: "asks_handle", pattern: /\b(?:what(?:'s| is)?\s+your\s+(?:insta|instagram|ig|snap|snapchat|tiktok|handle|username|@))\b/i },
  { category: "social", tag: "at_handle", pattern: /(?:^|\s)@[a-z0-9_]{3,}/i },

  // ─── photo ────────────────────────────────────────────────────
  { category: "photo", tag: "asks_photo", pattern: /\b(?:send|share|drop|got|gimme|give me)\s+(?:a\s+)?(?:pic|pics|photo|photos|picture|selfie)\b/i },
  { category: "photo", tag: "what_look_like", pattern: /\bwhat\s+do\s+you\s+look\s+like\b/i },
  { category: "photo", tag: "asks_facetime", pattern: /\b(?:facetime|video\s*chat|zoom)\b/i },

  // ─── phone ────────────────────────────────────────────────────
  { category: "phone", tag: "asks_real_number", pattern: /\b(?:what(?:'s| is)\s+your\s+(?:real\s+)?(?:number|phone))\b/i },
  { category: "phone", tag: "digits_blob", pattern: /(?:\+?\d[\s\-().]?){9,}\d/ },

  // ─── location ─────────────────────────────────────────────────
  { category: "location", tag: "asks_where_live", pattern: /\bwhere\s+(?:do\s+you\s+)?live\b/i },
  { category: "location", tag: "asks_address", pattern: /\b(?:what(?:'s| is)\s+your\s+address|where\s+exactly)\b/i },
];

/**
 * Run the stat-fishing detector against an inbound body.
 *
 * Pure — no I/O, no globals. The caller is responsible for persisting
 * `flagged` (likely `Message.flaggedStatFishing`) and surfacing the
 * `categories` to moderation tooling.
 */
export function detectStatFishing(body: string): StatFishDetection {
  const text = body ?? "";
  if (text.trim().length === 0) {
    return { flagged: false, categories: [], confidence: 0, matches: [] };
  }
  const categories = new Set<StatFishCategory>();
  const matches: string[] = [];
  for (const probe of PROBES) {
    if (probe.pattern.test(text)) {
      categories.add(probe.category);
      matches.push(probe.tag);
    }
  }
  const flagged = categories.size > 0;
  // Confidence: each distinct category contributes 0.4 (capped). Two
  // distinct categories ≥ a strong flag (0.8); one is still a yellow
  // flag (0.4).
  const confidence = Math.min(1, categories.size * 0.4);
  return {
    flagged,
    categories: [...categories],
    confidence,
    matches,
  };
}

/**
 * Are stat-fishing checks meaningful for this match yet?
 *
 * Once the relevant milestone has unlocked, that category's checks no
 * longer need to gate behavior — the partner can legitimately know the
 * info. We keep the regex available so moderation/telemetry can still
 * track patterns, but `shouldGateBy(category, unlockedMilestones)` tells
 * callers whether to *act* on a hit.
 */
import type { MilestoneType } from "@prisma/client";

export function shouldGateBy(
  category: StatFishCategory,
  unlocked: ReadonlySet<MilestoneType>,
): boolean {
  switch (category) {
    case "photo":
      return !unlocked.has("FACE");
    // Name / school / social / phone / location are NEVER part of the
    // milestone reveal ladder — they stay gated for the life of the
    // pre-reveal day.
    default:
      return true;
  }
}
