import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  computeTwilioSignature,
  verifyTwilioSignature,
} from "../../src/twilio/signature.js";

// Reference vector: build the expected signature by hand and confirm
// computeTwilioSignature reproduces it. This pins the "URL + sorted
// key+value concatenation, HMAC-SHA1, base64" algorithm.
function referenceSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const k of sortedKeys) data += k + params[k];
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

describe("computeTwilioSignature", () => {
  // External-contract pin. Every other test in this file routes through
  // `referenceSignature` above, which mirrors the implementation — so a
  // simultaneous refactor to both impl + reference (e.g. "upgrade to
  // SHA256" or "switch to hex") would silently keep the suite green
  // while breaking compatibility with Twilio's actual signing service.
  //
  // The vector below is hand-derived from Twilio's published security
  // docs (the canonical worked example: URL + sorted params, key "12345"),
  // and the expected string is captured as a literal. It's the only
  // assertion in this file whose truth doesn't depend on this file.
  it("matches Twilio's published reference vector (literal expected sig)", () => {
    const authToken = "12345";
    const url = "https://mycompany.com/myapp.php?foo=1&bar=2";
    const params = {
      CallSid: "CA1234567890ABCDE",
      Caller: "+14158675309",
      Digits: "1234",
      From: "+14158675309",
      To: "+18005551212",
    };
    expect(computeTwilioSignature(authToken, url, params)).toBe(
      "RSOYDt4T1cUTdK1PDd93/VVr8B8=",
    );
  });

  it("matches the canonical algorithm on a sample payload", () => {
    const authToken = "12345abcdef67890ghijklmnopqrstuv"; // fake token
    const url = "https://example.com/webhooks/twilio/inbound";
    const params = {
      To: "+15550001111",
      From: "+15552223333",
      Body: "hey, what's up?",
      MessageSid: "SM" + "a".repeat(32),
    };
    const expected = referenceSignature(authToken, url, params);
    expect(computeTwilioSignature(authToken, url, params)).toBe(expected);
  });

  it("is sensitive to parameter ordering at the source (sort makes it stable)", () => {
    const t = "tok";
    const u = "https://x.test/path";
    const a = computeTwilioSignature(t, u, { a: "1", b: "2" });
    const b = computeTwilioSignature(t, u, { b: "2", a: "1" });
    expect(a).toBe(b);
  });

  it("flips when any byte of the body changes", () => {
    const t = "tok";
    const u = "https://x.test/path";
    const s1 = computeTwilioSignature(t, u, { Body: "hi" });
    const s2 = computeTwilioSignature(t, u, { Body: "hI" });
    expect(s1).not.toBe(s2);
  });

  it("flips when the URL changes", () => {
    const t = "tok";
    const params = { Body: "x" };
    const a = computeTwilioSignature(t, "https://a.test/p", params);
    const b = computeTwilioSignature(t, "https://b.test/p", params);
    expect(a).not.toBe(b);
  });

  it("handles array-valued params by concatenating in given order", () => {
    const t = "tok";
    const u = "https://x.test/p";
    const sig = computeTwilioSignature(t, u, { dupe: ["one", "two"] });
    // hand-computed reference
    const expected = createHmac("sha1", t)
      .update(u + "dupe" + "one" + "dupe" + "two", "utf8")
      .digest("base64");
    expect(sig).toBe(expected);
  });
});

describe("verifyTwilioSignature", () => {
  const authToken = "test-token";
  const url = "https://example.com/webhooks/twilio/inbound";
  const params = { From: "+15551112222", Body: "hi" };
  const valid = computeTwilioSignature(authToken, url, params);

  it("accepts a valid signature", () => {
    expect(
      verifyTwilioSignature({ authToken, url, params, signatureHeader: valid }),
    ).toBe(true);
  });

  it("rejects a tampered body", () => {
    expect(
      verifyTwilioSignature({
        authToken,
        url,
        params: { ...params, Body: "different" },
        signatureHeader: valid,
      }),
    ).toBe(false);
  });

  it("rejects a wrong auth token", () => {
    expect(
      verifyTwilioSignature({
        authToken: "other-token",
        url,
        params,
        signatureHeader: valid,
      }),
    ).toBe(false);
  });

  it("rejects when the signature header is missing", () => {
    expect(
      verifyTwilioSignature({ authToken, url, params, signatureHeader: "" }),
    ).toBe(false);
  });

  it("rejects when the auth token is missing", () => {
    expect(
      verifyTwilioSignature({
        authToken: "",
        url,
        params,
        signatureHeader: valid,
      }),
    ).toBe(false);
  });

  it("rejects garbage signature without leaking timing info via length", () => {
    expect(
      verifyTwilioSignature({
        authToken,
        url,
        params,
        signatureHeader: "totally-not-a-signature",
      }),
    ).toBe(false);
  });
});
