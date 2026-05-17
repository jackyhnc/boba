// Moderation — harassment / profanity detector + REPORT keyword flow.
//
// Two layers:
//   1. `detectHarassment(body)`: regex pass for slurs, threats, sexual
//      coercion, and a small profanity list. We err on the side of
//      flagging; humans can review the row.
//   2. `parseReportCommand(body)`: looks for a REPORT keyword inbound
//      from a user. Variants accepted:
//        REPORT
//        REPORT <reason>
//        REPORT <reason>: <details>
//
// Pure module — Prisma writes happen in prisma-deps.ts.

export type HarassmentCategory =
  | "slur"
  | "threat"
  | "sexual_coercion"
  | "profanity";

export interface HarassmentDetection {
  flagged: boolean;
  categories: HarassmentCategory[];
  matches: string[];
  /** True iff at least one *severe* category fired (slur/threat/coercion). */
  severe: boolean;
}

interface Probe {
  category: HarassmentCategory;
  tag: string;
  pattern: RegExp;
}

// Carefully scoped patterns. The lists are intentionally small (high
// precision, lower recall) — false negatives are the price of avoiding
// the false-positive disasters that come from broad word filters.
//
// Profanity gets its own low-severity bucket so callers can choose to
// soft-flag without escalating to a report.
const PROBES: Probe[] = [
  // slurs — generic gating tokens; we ship a placeholder pattern and
  // leave the operator to extend via configuration later.
  { category: "slur", tag: "slur_token", pattern: /\b(?:f[a4]gg?(?:ot)?|n[i1]gg?(?:er|a)|tr[a@]nn[yi])\b/i },

  // threats
  { category: "threat", tag: "kill_threat", pattern: /\b(?:i(?:'ll| will)\s+(?:kill|hurt|find|stab|shoot)\s+you|i'?m gonna kill you)\b/i },
  { category: "threat", tag: "doxx_threat", pattern: /\b(?:i(?:'ll| will)\s+(?:expose|leak|dox)\b)/i },

  // sexual coercion (intentionally narrow — explicit demands)
  { category: "sexual_coercion", tag: "send_nude_demand", pattern: /\b(?:send\s+(?:me\s+)?(?:nudes?|naked\s+pics?))\b/i },
  { category: "sexual_coercion", tag: "if_you_dont", pattern: /\bif\s+you\s+don'?t\s+(?:send|show).*\b(?:nudes?|pics?|naked)\b/i },

  // profanity (mild)
  { category: "profanity", tag: "fuck_off", pattern: /\bf(?:uck|\*ck)\s+(?:off|you)\b/i },
  { category: "profanity", tag: "stfu", pattern: /\b(?:stfu|shut\s+the\s+fuck\s+up)\b/i },
];

export function detectHarassment(body: string): HarassmentDetection {
  const text = body ?? "";
  if (text.trim().length === 0) {
    return { flagged: false, categories: [], matches: [], severe: false };
  }
  const cats = new Set<HarassmentCategory>();
  const matches: string[] = [];
  for (const p of PROBES) {
    if (p.pattern.test(text)) {
      cats.add(p.category);
      matches.push(p.tag);
    }
  }
  const flagged = cats.size > 0;
  const severe = cats.has("slur") || cats.has("threat") || cats.has("sexual_coercion");
  return { flagged, categories: [...cats], matches, severe };
}

// ─── REPORT keyword ─────────────────────────────────────────────────────────

export interface ReportCommand {
  reason: string;
  details: string | null;
}

/**
 * Parse a REPORT command from an SMS body. Accepts:
 *   REPORT
 *   REPORT <reason>
 *   REPORT <reason>: <details>
 *
 * Returns null if the body is not a report command.
 */
export function parseReportCommand(body: string): ReportCommand | null {
  const trimmed = body.trim();
  // First token must be REPORT (case-insensitive).
  const match = /^report(?:\s+(.+))?$/i.exec(trimmed);
  if (!match) return null;
  const remainder = (match[1] ?? "").trim();
  if (remainder.length === 0) {
    return { reason: "unspecified", details: null };
  }
  // Split on the first ":" — left is reason, right is free-form details.
  const colon = remainder.indexOf(":");
  if (colon === -1) {
    return { reason: remainder, details: null };
  }
  return {
    reason: remainder.slice(0, colon).trim() || "unspecified",
    details: remainder.slice(colon + 1).trim() || null,
  };
}

export const REPORT_ACK =
  "Thanks for the report. We've logged it and our team will follow up. If you feel unsafe, reply BLOCK to end this match immediately.";
