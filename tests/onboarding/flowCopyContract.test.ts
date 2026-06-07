// Contract pins for the SMS-visible surface of src/onboarding/flow.ts.
//
// `flowContract.test.ts` already pins the state machine's structural
// invariants (step coverage, walk, markActive, merge semantics).
// `flow.test.ts` covers the parser behaviours but with regex
// substrings — so cosmetic copy drift would still pass.
//
// This file pins the user-visible bytes:
//
//   1. Every entry in `COPY` is sent verbatim over SMS — pin the exact
//      bodies. Boba is registered (or, per USER_TODO.md, will be
//      registered) under a 10DLC campaign whose sample messages match
//      what we actually send. A reviewer-visible drift between the
//      campaign submission and the deployed bodies is the kind of
//      thing that gets a campaign yanked without warning. We catch
//      drift at PR time instead.
//
//   2. `COPY` exposes exactly the documented keys — no orphan strings,
//      no missing strings. Adding a key without a campaign update is a
//      compliance regression; renaming one breaks the wiring.
//
//   3. Every parser-rejection `reason` string is sent over SMS too —
//      pin the exact bodies. There are 14 of them across 12 parsers
//      (askPhotoNeedsImage lives in COPY but the other 13 are inline
//      string literals in parseDisplayName / parseAge / parseGender /
//      ...). Drift here is equally a 10DLC hazard.
//
//   4. `GENDER_MAP` accepted synonyms. Documented in the carrier
//      template as "Reply WOMAN, MAN, NONBINARY, or OTHER" but in
//      practice we also accept W/F/FEMALE → WOMAN, M/MALE → MAN, etc.
//      A refactor that dropped a synonym would silently reject users
//      who answered with the short form the prior agent told them to
//      use.
//
//   5. Numeric boundary semantics. Pinned by black-box probing —
//      ages 18..99 (inclusive both ends), max-age 18..120, height
//      120..230, name 1..40 chars, profession 1..80, type descriptor
//      3..400. Off-by-one drift here is a quiet UX bug that would
//      pass any "accepts 25" / "rejects garbage" smoke test but
//      change whether real edge-case users get through.
//
//   6. Email-domain regex behaviour pinned at the boundary. The regex
//      is `/^[a-z0-9-]+(\.[a-z0-9-]+)+$/` — lowercase-only-after-trim,
//      requires at least one dot, rejects underscores. Pin the
//      boundary so a "let's also allow underscores" tweak doesn't
//      slip in unannounced (underscores in domain labels are valid
//      DNS but invalid SMTP — for campus emails we want the strict
//      reading).

import { describe, it, expect } from "vitest";
import { advance, COPY } from "../../src/onboarding/flow.js";

// ─── 1. Exact COPY body pins (14 strings) ──────────────────────────────────

describe("onboarding/flow contract — COPY exact bodies (SMS-visible)", () => {
  it("welcomeWithInvite — first inbound greeting under invite gate", () => {
    expect(COPY.welcomeWithInvite).toBe(
      "Welcome to Boba 🧋 — conversation-first dating. We're in closed beta. Reply with your invite code to get started (e.g. ABCD-1234).",
    );
  });

  it("welcome — first inbound greeting when invites are disabled", () => {
    expect(COPY.welcome).toBe(
      "Welcome to Boba 🧋 — conversation-first dating. We'll get you set up with a few quick questions. What should we call you? (first name is fine)",
    );
  });

  it("askDisplayName — prompt sent AFTER invite redemption", () => {
    expect(COPY.askDisplayName).toBe(
      "Got it. What should we call you? (first name is fine)",
    );
  });

  it("askAge — age prompt", () => {
    expect(COPY.askAge).toBe("Got it. How old are you?");
  });

  it("askGender — gender prompt enumerates the four canonical tokens", () => {
    expect(COPY.askGender).toBe(
      "What's your gender? Reply WOMAN, MAN, NONBINARY, or OTHER.",
    );
  });

  it("askProfession — profession prompt", () => {
    expect(COPY.askProfession).toBe(
      "What do you do? (job title or 'student' is fine)",
    );
  });

  it("askHeightCm — height prompt (cm, with example)", () => {
    expect(COPY.askHeightCm).toBe("How tall are you in cm? (e.g. 175)");
  });

  it("askPhoto — selfie prompt explaining the end-of-day reveal", () => {
    // This one's load-bearing: the explanation of when the photo is
    // revealed is part of Boba's product positioning ("anti-superficial,
    // pro-conversation"). Any drift here changes the user's expectation
    // about what the system will do with their photo.
    expect(COPY.askPhoto).toBe(
      "Send us a selfie 📸 as an MMS attachment. This is held back from your matches until the very end of the day — they won't see it during your conversation. Reply SKIP if you can't right now.",
    );
  });

  it("askPhotoNeedsImage — rejection when SKIP wasn't sent and no media attached", () => {
    expect(COPY.askPhotoNeedsImage).toBe(
      "We need a photo — send a picture as an MMS, or reply SKIP if you can't.",
    );
  });

  it("askPreferredGenders — multi-select prompt", () => {
    expect(COPY.askPreferredGenders).toBe(
      "Who are you open to matching with? Reply with one or more separated by commas: WOMAN, MAN, NONBINARY, OTHER.",
    );
  });

  it("askMinAge — minimum match age prompt", () => {
    expect(COPY.askMinAge).toBe("Minimum age you'd like to match with?");
  });

  it("askMaxAge — maximum match age prompt", () => {
    expect(COPY.askMaxAge).toBe("Maximum age?");
  });

  it("askTypeDescriptor — free-text 'your type' prompt", () => {
    expect(COPY.askTypeDescriptor).toBe(
      "In one sentence, describe your type — what kind of person are you hoping to meet?",
    );
  });

  it("askCampusEmailDomain — final prompt + SKIP escape hatch", () => {
    expect(COPY.askCampusEmailDomain).toBe(
      "Last one: what's your campus email domain? (e.g. princeton.edu — we use this for university-level matching). Reply SKIP if N/A.",
    );
  });

  it("done — the onboarding-complete acknowledgement", () => {
    // Mentions HELP — required for CTIA compliance. If a refactor
    // drops it, the campaign reviewer's sample-message audit fails.
    expect(COPY.done).toBe(
      "You're all set ✅ Your first match drops today at 5pm. We'll text you here. Reply HELP at any time.",
    );
  });

  it("COPY exposes EXACTLY the documented keys — no orphan strings, no missing", () => {
    // If a key is added without a campaign template update, that's a
    // compliance regression. If one is renamed, the wiring in advance()
    // breaks. Either way the test must fail loudly.
    expect(Object.keys(COPY).sort()).toEqual(
      [
        "welcomeWithInvite",
        "welcome",
        "askDisplayName",
        "askAge",
        "askGender",
        "askProfession",
        "askHeightCm",
        "askPhoto",
        "askPhotoNeedsImage",
        "askPreferredGenders",
        "askMinAge",
        "askMaxAge",
        "askTypeDescriptor",
        "askCampusEmailDomain",
        "done",
      ].sort(),
    );
  });
});

// ─── 2. Parser-rejection reason strings (also SMS-visible) ─────────────────

describe("onboarding/flow contract — parser rejection reasons (SMS-visible)", () => {
  // Each `reason` string flows straight through to the user as the
  // outbound SMS body on a failed parse. They aren't in the COPY object
  // (they're inline literals in each parser) but they're equally a
  // compliance surface. We pin them by triggering the rejection path
  // and asserting the exact `reply`.

  it("invite-code rejection: malformed code body", () => {
    const r = advance("ask_invite_code", "short");
    expect(r.reply).toBe(
      "That doesn't look like a Boba invite code. Try again — they look like ABCD-1234.",
    );
  });

  it("display-name rejection: out-of-length", () => {
    const r = advance("ask_display_name", "");
    expect(r.reply).toBe("Names are 1–40 characters. Try again?");
  });

  it("display-name rejection: looks like a phone number", () => {
    const r = advance("ask_display_name", "+1 (555) 123-4567");
    expect(r.reply).toBe("That looks like a number — what name should we use?");
  });

  it("age rejection: NaN body", () => {
    const r = advance("ask_age", "twenty-five");
    expect(r.reply).toBe("Please reply with a number, e.g. 22.");
  });

  it("age rejection: out-of-range", () => {
    const r = advance("ask_age", "17");
    expect(r.reply).toBe("Age must be 18–99 to use Boba.");
  });

  it("gender rejection: unknown synonym", () => {
    const r = advance("ask_gender", "dinosaur");
    expect(r.reply).toBe("Please reply WOMAN, MAN, NONBINARY, or OTHER.");
  });

  it("profession rejection: empty or over 80 chars", () => {
    const r = advance("ask_profession", "");
    expect(r.reply).toBe("Keep it under 80 characters.");
    const r2 = advance("ask_profession", "x".repeat(81));
    expect(r2.reply).toBe("Keep it under 80 characters.");
  });

  it("height rejection: NaN body", () => {
    const r = advance("ask_height_cm", "tall");
    expect(r.reply).toBe("Height in cm, please — e.g. 175.");
  });

  it("height rejection: out-of-range", () => {
    const r = advance("ask_height_cm", "100");
    expect(r.reply).toBe("Height must be 120–230cm.");
  });

  it("photo rejection: non-SKIP without media → uses the COPY.askPhotoNeedsImage constant", () => {
    // This rejection is the only one in the file that pulls from
    // COPY.* (rather than inlining the string literal). Pin both
    // sides — the reply MUST be the COPY constant (via identity)
    // AND the COPY constant MUST be the exact body we expect.
    const r = advance("ask_photo", "ok");
    expect(r.reply).toBe(COPY.askPhotoNeedsImage);
    expect(r.reply).toBe(
      "We need a photo — send a picture as an MMS, or reply SKIP if you can't.",
    );
  });

  it("preferred-genders rejection: empty after splitting", () => {
    const r = advance("ask_preferred_genders", "");
    expect(r.reply).toBe(
      "Reply with one or more: WOMAN, MAN, NONBINARY, OTHER.",
    );
  });

  it("preferred-genders rejection: unknown synonym is quoted in the reason", () => {
    // The unknown token is interpolated back. Pin the interpolation
    // template too (`"X" isn't one I recognize...`).
    const r = advance("ask_preferred_genders", "WOMAN, dinosaur");
    expect(r.reply).toBe(
      `"dinosaur" isn't one I recognize. Reply WOMAN, MAN, NONBINARY, or OTHER.`,
    );
  });

  it("min-age rejection: NaN body", () => {
    const r = advance("ask_min_age", "old");
    expect(r.reply).toBe("Please send a number.");
  });

  it("min-age rejection: out-of-range", () => {
    const r = advance("ask_min_age", "10");
    expect(r.reply).toBe("Min age must be 18–99.");
  });

  it("max-age rejection: NaN body", () => {
    const r = advance("ask_max_age", "old");
    expect(r.reply).toBe("Please send a number.");
  });

  it("max-age rejection: out-of-range", () => {
    const r = advance("ask_max_age", "9001");
    expect(r.reply).toBe("Max age must be 18–120.");
  });

  it("type-descriptor rejection: too short", () => {
    const r = advance("ask_type_descriptor", "x");
    expect(r.reply).toBe("Tell us a little more — at least a few words.");
  });

  it("type-descriptor rejection: too long", () => {
    const r = advance("ask_type_descriptor", "x".repeat(401));
    expect(r.reply).toBe("Keep it under 400 characters.");
  });

  it("campus-email-domain rejection: not a domain", () => {
    const r = advance("ask_campus_email_domain", "not a domain at all");
    expect(r.reply).toBe(
      "That doesn't look like a domain. Try `princeton.edu`, or SKIP.",
    );
  });
});

// ─── 3. GENDER_MAP accepted synonyms ───────────────────────────────────────

describe("onboarding/flow contract — GENDER_MAP synonym surface", () => {
  // The map is module-private; we probe it via parseGender (the
  // ask_gender step's parser) as a black box. Both case directions
  // are tested — input is upper-cased before lookup so all variants
  // collapse together. The set is closed: anything not listed must
  // hit the "Please reply WOMAN..." rejection.

  const PINNED_SYNONYMS: Record<string, "WOMAN" | "MAN" | "NONBINARY" | "OTHER"> = {
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

  it("accepts every documented synonym, mapping to the canonical Gender enum", () => {
    for (const [token, gender] of Object.entries(PINNED_SYNONYMS)) {
      const r = advance("ask_gender", token);
      expect(r.updates.stats?.gender, `token=${token}`).toBe(gender);
      // Mixed-case must round-trip too.
      const lower = advance("ask_gender", token.toLowerCase());
      expect(lower.updates.stats?.gender, `token=${token.toLowerCase()}`).toBe(gender);
    }
  });

  it("rejects synonyms NOT in the documented set — closed surface", () => {
    // Common candidates a future tweak might add. Each must currently
    // fall through to the rejection reason. If we add one, this list
    // changes in the same commit as the GENDER_MAP edit.
    const negatives = [
      "GUY", "GIRL", "BOY", "LADY", "GENTLEMAN",
      "TRANS", "GENDERQUEER", "AGENDER", "TWO-SPIRIT",
      "X", "Q",
      // CTIA opt-in tokens — must not collide.
      "YES", "Y", "NO", "N",
    ];
    for (const t of negatives) {
      const r = advance("ask_gender", t);
      expect(r.nextStep, `expected rejection for ${t}`).toBe("ask_gender");
      expect(r.updates.stats?.gender).toBeUndefined();
    }
  });
});

// ─── 4. Numeric boundary semantics (black-box probe) ───────────────────────

describe("onboarding/flow contract — numeric boundary semantics", () => {
  // For each parser with a range, probe BOTH ends inclusive and the
  // first value off either end. A regression from "<= 99" to "< 99"
  // would pass the existing accept-25 / reject-twelve tests.

  function accepted(step: Parameters<typeof advance>[0], body: string): boolean {
    return advance(step, body).nextStep !== step;
  }

  it("ask_age: [18, 99] inclusive, off-by-one rejects on both sides", () => {
    expect(accepted("ask_age", "18")).toBe(true);
    expect(accepted("ask_age", "99")).toBe(true);
    expect(accepted("ask_age", "17")).toBe(false);
    expect(accepted("ask_age", "100")).toBe(false);
    // 0 / negative — also rejected.
    expect(accepted("ask_age", "0")).toBe(false);
    expect(accepted("ask_age", "-1")).toBe(false);
  });

  it("ask_min_age: [18, 99] inclusive — same range as ask_age", () => {
    expect(accepted("ask_min_age", "18")).toBe(true);
    expect(accepted("ask_min_age", "99")).toBe(true);
    expect(accepted("ask_min_age", "17")).toBe(false);
    expect(accepted("ask_min_age", "100")).toBe(false);
  });

  it("ask_max_age: [18, 120] inclusive — wider than min on purpose (lets users open up)", () => {
    // Asymmetry note: max-age is [18, 120] but min-age is [18, 99].
    // The product reasoning: a 35-year-old saying "match me with anyone
    // 30-99" is fine; saying "match me with anyone 100+" is a typo.
    // Symmetrically, "match me with anyone up to 120" lets older users
    // open up without a hard ceiling at their own age.
    expect(accepted("ask_max_age", "18")).toBe(true);
    expect(accepted("ask_max_age", "120")).toBe(true);
    expect(accepted("ask_max_age", "17")).toBe(false);
    expect(accepted("ask_max_age", "121")).toBe(false);
  });

  it("ask_height_cm: [120, 230] inclusive", () => {
    expect(accepted("ask_height_cm", "120")).toBe(true);
    expect(accepted("ask_height_cm", "230")).toBe(true);
    expect(accepted("ask_height_cm", "119")).toBe(false);
    expect(accepted("ask_height_cm", "231")).toBe(false);
  });

  it("ask_display_name: length ∈ [1, 40] after trim", () => {
    expect(accepted("ask_display_name", "A")).toBe(true);
    expect(accepted("ask_display_name", "a".repeat(40))).toBe(true);
    expect(accepted("ask_display_name", "")).toBe(false);
    expect(accepted("ask_display_name", "a".repeat(41))).toBe(false);
    // Whitespace-only body trims to "" → rejected.
    expect(accepted("ask_display_name", "   ")).toBe(false);
    // Trim applied: 38 'a's + 2 leading spaces fits in 40 trimmed.
    expect(accepted("ask_display_name", "  " + "a".repeat(38))).toBe(true);
  });

  it("ask_profession: length ∈ [1, 80] after trim", () => {
    expect(accepted("ask_profession", "x")).toBe(true);
    expect(accepted("ask_profession", "x".repeat(80))).toBe(true);
    expect(accepted("ask_profession", "")).toBe(false);
    expect(accepted("ask_profession", "x".repeat(81))).toBe(false);
  });

  it("ask_type_descriptor: length ∈ [3, 400] after trim", () => {
    expect(accepted("ask_type_descriptor", "xxx")).toBe(true);
    expect(accepted("ask_type_descriptor", "x".repeat(400))).toBe(true);
    expect(accepted("ask_type_descriptor", "xx")).toBe(false);
    expect(accepted("ask_type_descriptor", "x".repeat(401))).toBe(false);
  });

  it("parseInt accepts trailing junk — '25abc' becomes 25 (documented JS behaviour)", () => {
    // parseInt is permissive; "25abc" yields 25. The parsers rely on
    // this — a refactor to Number(body) would suddenly reject "25  "
    // with a trailing newline from carriers that append one. Pin the
    // current permissive behaviour for age + height so the swap is
    // a deliberate, visible change.
    expect(accepted("ask_age", "25abc")).toBe(true);
    expect(accepted("ask_height_cm", "175cm")).toBe(true);
  });
});

// ─── 5. Email-domain regex behaviour ───────────────────────────────────────

describe("onboarding/flow contract — campus email domain regex", () => {
  // Regex: /^[a-z0-9-]+(\.[a-z0-9-]+)+$/ applied after lowercase trim.
  // The accept/reject pattern is: at least one dot, alphanumeric +
  // hyphen only (no underscore, no '+', no '@' in the domain part),
  // and we extract the domain when an `@` is present in the input.

  function update(body: string): string | undefined {
    const r = advance("ask_campus_email_domain", body);
    return r.updates.user?.campusEmailDomain;
  }

  it("accepts a bare lowercase domain", () => {
    expect(update("princeton.edu")).toBe("princeton.edu");
  });

  it("uppercases are folded to lowercase before the regex check", () => {
    expect(update("PRINCETON.EDU")).toBe("princeton.edu");
  });

  it("extracts the domain from an email and lowercases it", () => {
    expect(update("jacky@PRINCETON.EDU")).toBe("princeton.edu");
  });

  it("accepts multi-label domains and hyphenated labels", () => {
    expect(update("cs.princeton.edu")).toBe("cs.princeton.edu");
    expect(update("my-school.ac.uk")).toBe("my-school.ac.uk");
  });

  it("rejects domains with no dot — bare TLD-less strings", () => {
    const r = advance("ask_campus_email_domain", "princeton");
    expect(r.nextStep).toBe("ask_campus_email_domain");
    expect(r.updates.user?.campusEmailDomain).toBeUndefined();
  });

  it("rejects underscores in labels — strict DNS-but-stricter reading", () => {
    // Underscores are valid in DNS labels but invalid in SMTP local
    // delivery, and we use these for campus *email* matching. The
    // regex rejects them; pin so a future "match a bit more loosely"
    // tweak is a deliberate, reviewed change.
    const r = advance("ask_campus_email_domain", "campus_school.edu");
    expect(r.nextStep).toBe("ask_campus_email_domain");
  });

  it("rejects spaces and other punctuation", () => {
    expect(
      advance("ask_campus_email_domain", "prince ton.edu").nextStep,
    ).toBe("ask_campus_email_domain");
    expect(
      advance("ask_campus_email_domain", "princeton+club.edu").nextStep,
    ).toBe("ask_campus_email_domain");
  });

  it("SKIP / NONE / N/A are all the accepted opt-out tokens (case-insensitive)", () => {
    // These are pinned because the campus-domain step is the *last*
    // question — a user who can't answer must have an escape hatch
    // that reaches `done`. If we removed e.g. "n/a" tomorrow, a user
    // who typed it would think they finished but actually stall on
    // the regex rejection.
    for (const opt of ["SKIP", "skip", "Skip", "NONE", "none", "N/A", "n/a"]) {
      const r = advance("ask_campus_email_domain", opt);
      expect(r.nextStep, `opt=${opt}`).toBe("done");
      expect(r.markActive).toBe(true);
      expect(r.updates.user?.campusEmailDomain).toBeUndefined();
    }
  });
});
