// Invite-code helpers.
//
// `normalizeCode` strips noise and uppercases — codes are displayed
// in groups of 4 chars (e.g. "ABCD-EFGH") but accepted from users
// in any reasonable shape.
//
// `generateCode` produces a fresh 8-character base32-style code from
// the Crockford alphabet (no `I`, `L`, `O`, `U` — fewer mis-types).

import { randomInt } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32

export const INVITE_CODE_LENGTH = 8;

/**
 * Lift a user-typed code into canonical form: uppercase, alphanumeric
 * only. Hyphens, spaces, and other separators are stripped.
 */
export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Returns true iff `code` parses to the right length + alphabet. */
export function isWellFormed(code: string): boolean {
  if (code.length !== INVITE_CODE_LENGTH) return false;
  for (const ch of code) {
    if (!ALPHABET.includes(ch)) return false;
  }
  return true;
}

/** Generate a fresh random invite code. Caller persists. */
export function generateCode(): string {
  let out = "";
  for (let i = 0; i < INVITE_CODE_LENGTH; i++) {
    out += ALPHABET[randomInt(ALPHABET.length)];
  }
  return out;
}

/** Pretty form for display: groups of 4. "ABCD1234" → "ABCD-1234". */
export function formatForDisplay(code: string): string {
  const n = normalizeCode(code);
  if (n.length !== INVITE_CODE_LENGTH) return n;
  return `${n.slice(0, 4)}-${n.slice(4)}`;
}
