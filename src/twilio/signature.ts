// Twilio request-signature verification.
//
// Per https://www.twilio.com/docs/usage/webhooks/webhooks-security:
//
//   1. Take the full URL Twilio requested, exactly as configured in the
//      Twilio console (scheme + host + path + query).
//   2. If the request is application/x-www-form-urlencoded, sort the POST
//      parameters by key (lexicographic) and append each key+value
//      concatenation to the URL (no separators).
//   3. Compute HMAC-SHA1 over that string using the account auth token as
//      the key. The expected signature is the base64-encoded digest.
//   4. Compare to the X-Twilio-Signature header in constant time.
//
// JSON-bodied webhooks are signed differently (SHA256 over the raw body)
// but Twilio's SMS webhooks are always form-urlencoded, so we only
// implement v1 here.

import { createHmac, timingSafeEqual } from "node:crypto";

export interface SignatureCheckInput {
  /** Twilio Auth Token (Account or Subaccount). */
  authToken: string;
  /** Full request URL, exactly as Twilio was configured to call. */
  url: string;
  /** Parsed application/x-www-form-urlencoded body. */
  params: Readonly<Record<string, string | string[]>>;
  /** Value of the X-Twilio-Signature header on the inbound request. */
  signatureHeader: string;
}

/**
 * Compute the expected v1 signature for a Twilio webhook request.
 * Exported for tests and for debug logging.
 */
export function computeTwilioSignature(
  authToken: string,
  url: string,
  params: Readonly<Record<string, string | string[]>>,
): string {
  // Twilio sorts keys lexicographically, then appends key+value for each.
  // Repeated keys (rare for SMS but legal in form bodies) are concatenated
  // in the order they were submitted; we accept either string or string[]
  // because @fastify/formbody emits the latter for duplicates.
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) {
    const raw = params[key];
    if (raw === undefined) continue;
    if (Array.isArray(raw)) {
      for (const v of raw) data += key + v;
    } else {
      data += key + raw;
    }
  }
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

/**
 * Constant-time verify the X-Twilio-Signature header against the expected
 * signature computed from `authToken`, `url`, and `params`. Returns true
 * on a match, false on any mismatch (including malformed input).
 */
export function verifyTwilioSignature(input: SignatureCheckInput): boolean {
  if (!input.authToken || !input.signatureHeader) return false;
  const expected = computeTwilioSignature(input.authToken, input.url, input.params);
  return safeEqualBase64(expected, input.signatureHeader);
}

function safeEqualBase64(a: string, b: string): boolean {
  // base64 strings are ASCII-safe; equal-length comparison is required by
  // timingSafeEqual. We compare on Buffer<utf8> rather than decoded bytes
  // to avoid leaking length through decode errors.
  if (a.length !== b.length) return false;
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return timingSafeEqual(ba, bb);
}
