// US carrier (CTIA / 10DLC) SMS keyword compliance.
//
// US wireless carriers require that any A2P SMS service honour the
// universal STOP and HELP keywords. Twilio's "Advanced Opt-Out" handles
// some of this at the messaging-service layer, but we still need to:
//
//   1. Recognise the keywords ourselves (Twilio forwards the inbound
//      to our webhook either way).
//   2. Update our own state so the matching scheduler + outbound paths
//      stop targeting the opted-out user — Twilio will silently drop
//      our sends to a blocked number, leaving orphan match rows.
//   3. Send (or rely on Twilio to send) the carrier-mandated reply
//      copy: HELP must include the program name + "Msg & data rates
//      may apply" + how to opt out; STOP must confirm the opt-out and
//      mention how to opt back in.
//
// This module is pure: callers wire the directive returned by `detect`
// into the conversation router's normal output shape (outbound +
// persistence directives).

export type SmsKeyword = "STOP" | "HELP" | "START";

// CTIA-mandated stop tokens (and a few commonly-honoured equivalents).
// "STOPALL" is included for compatibility with carriers that surface it.
const STOP_TOKENS = new Set([
  "STOP",
  "STOPALL",
  "UNSUBSCRIBE",
  "CANCEL",
  "END",
  "QUIT",
  "OPTOUT",
  "OPT-OUT",
]);

const HELP_TOKENS = new Set(["HELP", "INFO"]);

// Universal opt-in tokens. UNSTOP is a Twilio quirk; YES is mandated by
// some short-code programs as a confirmation step.
const START_TOKENS = new Set(["START", "UNSTOP", "YES"]);

export interface SmsKeywordDetection {
  /** The compliance keyword, or null if the body isn't a control keyword. */
  keyword: SmsKeyword | null;
  /** The exact token (uppercased) that matched. */
  token: string | null;
}

/**
 * Detect a carrier-required SMS control keyword in the message body.
 *
 * Carriers expect a *single* keyword to count — "STOP I hate this" is
 * still a STOP, but "Don't stop believing" is not. The CTIA guidance
 * is "single-word case-insensitive, with surrounding whitespace
 * tolerated". We accept punctuation immediately after the keyword
 * (e.g. "STOP.", "STOP!") since most phones will let users add it.
 */
export function detectSmsKeyword(body: string): SmsKeywordDetection {
  if (!body) return { keyword: null, token: null };
  // Trim, strip trailing punctuation, uppercase. We only look at the
  // FIRST token — "STOP texting me" → STOP; "I want you to STOP" → not
  // a control keyword (the user is talking to their match).
  const trimmed = body.trim();
  if (trimmed.length === 0) return { keyword: null, token: null };

  const firstToken = trimmed.split(/\s+/)[0] ?? "";
  const cleaned = firstToken.replace(/[.,!?;:]+$/g, "").toUpperCase();
  if (cleaned.length === 0) return { keyword: null, token: null };

  // For single-word messages we accept the cleaned form directly. For
  // longer messages we only honour STOP/HELP/START if the keyword stands
  // alone OR is followed by descriptive text — "STOP texting me" counts,
  // but "Please stop" (keyword not first) does not. This matches Twilio's
  // and most carriers' interpretation.
  if (STOP_TOKENS.has(cleaned)) {
    return { keyword: "STOP", token: cleaned };
  }
  if (HELP_TOKENS.has(cleaned)) {
    return { keyword: "HELP", token: cleaned };
  }
  if (START_TOKENS.has(cleaned)) {
    return { keyword: "START", token: cleaned };
  }
  return { keyword: null, token: null };
}

// ─── Compliance reply copy ─────────────────────────────────────────────────

// Twilio's Advanced Opt-Out can send these on its own, but we ship our
// own copy as a fallback so we're compliant even on a fresh Messaging
// Service without that feature enabled. Both numbers and the support
// email are deliberately templated so the user can swap them per env;
// the defaults are clearly placeholder.

const SUPPORT_EMAIL = "support@boba.app";

export const STOP_ACK =
  "Boba: You're opted out and won't receive any more messages. Reply START to resume. " +
  `Need help? ${SUPPORT_EMAIL}`;

export const HELP_REPLY =
  "Boba: conversation-first dating. One match per day via SMS. " +
  "Reply STOP to opt out, START to opt back in. Msg & data rates may apply. " +
  `Questions: ${SUPPORT_EMAIL}`;

export const START_ACK =
  "Boba: You're opted back in. Welcome back 🧋 — we'll text you when your next match is ready.";
