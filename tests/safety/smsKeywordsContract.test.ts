import { describe, it, expect } from "vitest";
import {
  detectSmsKeyword,
  HELP_REPLY,
  START_ACK,
  STOP_ACK,
  type SmsKeyword,
  type SmsKeywordDetection,
} from "../../src/safety/smsKeywords.js";

// Contract pins for the CTIA/10DLC SMS keyword detector.
//
// `tests/safety/smsKeywords.test.ts` already covers happy-path recognition.
// This file pins the structural invariants that a well-intentioned refactor
// could violate without tripping the existing suite — and that would land
// us in carrier-compliance hot water.
//
// Concretely we pin:
//   - the result shape (always { keyword, token }, both present, both null
//     in lockstep, token always uppercased / cleaned)
//   - the first-token-only rule (only the leading whitespace-delimited
//     token is examined)
//   - the exact punctuation-strip class ([.,!?;:]+ suffix only, not
//     leading, not hyphen, not slash, not asterisk)
//   - the canonical token sets — additions and removals both break this
//     file (e.g. CTIA pulls "OPT-OUT" → we want to know)
//   - the EXACT compliance reply bodies, because carriers reject sub-
//     stituted/abridged copy during 10DLC vetting

// ─── result shape contract ─────────────────────────────────────────────────

describe("smsKeywords contract — detection result shape", () => {
  it("always returns exactly { keyword, token } — no extra fields", () => {
    const r = detectSmsKeyword("STOP");
    expect(Object.keys(r).sort()).toEqual(["keyword", "token"]);
  });

  it("keyword === null ⟺ token === null (never one without the other)", () => {
    // Match path: both populated.
    const hit = detectSmsKeyword("STOP");
    expect(hit.keyword).not.toBeNull();
    expect(hit.token).not.toBeNull();

    // Miss path: both null.
    for (const miss of ["hi how are you", "", "   ", "STOPP", "HELPME"]) {
      const r = detectSmsKeyword(miss);
      expect(r.keyword).toBeNull();
      expect(r.token).toBeNull();
    }
  });

  it("token is the cleaned + UPPERCASED form, exactly", () => {
    // Uppercasing happens after suffix strip; verify both for lowercase
    // input AND a punctuated lowercase input.
    expect(detectSmsKeyword("stop").token).toBe("STOP");
    expect(detectSmsKeyword("stop.").token).toBe("STOP");
    // Hyphenated lowercase opt-out — exercises strip-before-uppercase.
    expect(detectSmsKeyword("opt-out").token).toBe("OPT-OUT");
    expect(detectSmsKeyword("opt-out!").token).toBe("OPT-OUT");
  });

  it("detection is pure: equal input → equal output", () => {
    const a = detectSmsKeyword("STOP");
    const b = detectSmsKeyword("STOP");
    expect(a).toEqual(b);
    // Calling repeatedly does not mutate the source.
    const c = detectSmsKeyword("STOP");
    expect(c).toEqual(a);
  });

  it("keyword is always one of the SmsKeyword union members, or null", () => {
    const allowed = new Set<SmsKeyword | null>(["STOP", "HELP", "START", null]);
    const probes = [
      "STOP",
      "stop.",
      "HELP",
      "info",
      "START",
      "yes",
      "UNSTOP",
      "hi how are you",
      "",
      "STOPP",
    ];
    for (const p of probes) {
      const r: SmsKeywordDetection = detectSmsKeyword(p);
      expect(allowed.has(r.keyword)).toBe(true);
    }
  });
});

// ─── tokenisation contract ─────────────────────────────────────────────────

describe("smsKeywords contract — tokenisation", () => {
  it("only the FIRST whitespace-delimited token is examined", () => {
    // Positive: STOP-first stays a STOP regardless of what follows.
    expect(detectSmsKeyword("STOP texting me").keyword).toBe("STOP");
    expect(detectSmsKeyword("STOP because i said so").keyword).toBe("STOP");
    // Negative: control word later in the sentence does NOT fire.
    expect(detectSmsKeyword("please STOP").keyword).toBeNull();
    expect(detectSmsKeyword("can you HELP me").keyword).toBeNull();
    expect(detectSmsKeyword("ok START now").keyword).toBeNull();
  });

  it("split tolerates tab / newline / multiple spaces (the \\s+ class)", () => {
    expect(detectSmsKeyword("STOP\tnow").keyword).toBe("STOP");
    expect(detectSmsKeyword("STOP\nnow").keyword).toBe("STOP");
    expect(detectSmsKeyword("STOP   now").keyword).toBe("STOP");
    // Leading whitespace is trimmed before split.
    expect(detectSmsKeyword("   STOP").keyword).toBe("STOP");
    expect(detectSmsKeyword("\n\tSTOP").keyword).toBe("STOP");
  });

  it("a body of only-whitespace / only-punctuation returns the null result", () => {
    // Whitespace-only short-circuits at the trim guard.
    expect(detectSmsKeyword("")).toEqual({ keyword: null, token: null });
    expect(detectSmsKeyword("   ")).toEqual({ keyword: null, token: null });
    expect(detectSmsKeyword("\n\t")).toEqual({ keyword: null, token: null });
    // Punctuation-only: trim passes, but the strip empties the cleaned
    // form, so we still return null.
    expect(detectSmsKeyword(".")).toEqual({ keyword: null, token: null });
    expect(detectSmsKeyword("!!!")).toEqual({ keyword: null, token: null });
    expect(detectSmsKeyword(",,,,")).toEqual({ keyword: null, token: null });
  });
});

// ─── punctuation strip contract ────────────────────────────────────────────

describe("smsKeywords contract — punctuation strip class", () => {
  it("strips trailing . , ! ? ; : (greedy)", () => {
    expect(detectSmsKeyword("STOP.").token).toBe("STOP");
    expect(detectSmsKeyword("STOP,").token).toBe("STOP");
    expect(detectSmsKeyword("STOP!").token).toBe("STOP");
    expect(detectSmsKeyword("STOP?").token).toBe("STOP");
    expect(detectSmsKeyword("STOP;").token).toBe("STOP");
    expect(detectSmsKeyword("STOP:").token).toBe("STOP");
    // Greedy: repeated and mixed.
    expect(detectSmsKeyword("STOP...").token).toBe("STOP");
    expect(detectSmsKeyword("STOP!!").token).toBe("STOP");
    expect(detectSmsKeyword("STOP?!.").token).toBe("STOP");
    expect(detectSmsKeyword("STOP,,;:!?.").token).toBe("STOP");
  });

  it("does NOT strip leading punctuation — strip is suffix-only", () => {
    // If someone changes the regex from `$` to `g`-without-anchor, these
    // would start matching and we'd accept ".STOP" as STOP.
    expect(detectSmsKeyword(".STOP").keyword).toBeNull();
    expect(detectSmsKeyword("!STOP").keyword).toBeNull();
    expect(detectSmsKeyword(",STOP").keyword).toBeNull();
  });

  it("does NOT strip other symbols (hyphen, slash, asterisk, paren, hash)", () => {
    // These would silently start matching if someone broadened the class.
    expect(detectSmsKeyword("STOP-").keyword).toBeNull();
    expect(detectSmsKeyword("STOP*").keyword).toBeNull();
    expect(detectSmsKeyword("STOP/").keyword).toBeNull();
    expect(detectSmsKeyword("STOP)").keyword).toBeNull();
    expect(detectSmsKeyword("STOP#").keyword).toBeNull();
    // Mid-token symbol → no split, no match.
    expect(detectSmsKeyword("STOP/HELP").keyword).toBeNull();
  });

  it("only strips punctuation from the FIRST token, not the whole body", () => {
    // Trailing punctuation on a later word must not bleed back.
    expect(detectSmsKeyword("STOP now.").keyword).toBe("STOP");
    expect(detectSmsKeyword("STOP now.").token).toBe("STOP");
  });
});

// ─── canonical token sets ──────────────────────────────────────────────────

describe("smsKeywords contract — canonical token sets", () => {
  // STOP set: every member here must yield keyword "STOP" with the
  // uppercased form as the token. If a carrier drops "OPT-OUT" or we
  // add a new alias, this list is the source of truth to update.
  const STOP_MEMBERS = [
    "STOP",
    "STOPALL",
    "UNSUBSCRIBE",
    "CANCEL",
    "END",
    "QUIT",
    "OPTOUT",
    "OPT-OUT",
  ];
  const HELP_MEMBERS = ["HELP", "INFO"];
  const START_MEMBERS = ["START", "UNSTOP", "YES"];

  it.each(STOP_MEMBERS)("STOP set member %s maps to STOP keyword", (m) => {
    const r = detectSmsKeyword(m);
    expect(r.keyword).toBe("STOP");
    expect(r.token).toBe(m); // already uppercased
  });

  it.each(HELP_MEMBERS)("HELP set member %s maps to HELP keyword", (m) => {
    const r = detectSmsKeyword(m);
    expect(r.keyword).toBe("HELP");
    expect(r.token).toBe(m);
  });

  it.each(START_MEMBERS)("START set member %s maps to START keyword", (m) => {
    const r = detectSmsKeyword(m);
    expect(r.keyword).toBe("START");
    expect(r.token).toBe(m);
  });

  it("near-miss tokens do NOT match (no substring/prefix matching)", () => {
    // These look STOP-ish or HELP-ish but are not exact set members. If a
    // refactor switched the set lookup to `.startsWith` or a regex, these
    // would silently start firing — and we'd opt people out by accident.
    const nearMisses = [
      "STOPP",
      "STOPPED",
      "STOPS",
      "HELPME",
      "HELPS",
      "STARTING",
      "STARTED",
      "STARTS",
      "YESSIR",
      "INFORMATION",
      "ENDS",
      "QUITTING",
      "OPT", // bare prefix
      "OUT", // bare suffix
    ];
    for (const m of nearMisses) {
      expect(detectSmsKeyword(m).keyword).toBeNull();
    }
  });

  it("internal Boba keywords (KEEP / MAYBE / DISCARD / REPORT) are NOT compliance keywords", () => {
    // These are the end-of-day-decision tokens and a safety token. If
    // someone accidentally folded them into the carrier-compliance path
    // we'd reply with the HELP_REPLY copy in place of the real flow.
    expect(detectSmsKeyword("KEEP").keyword).toBeNull();
    expect(detectSmsKeyword("MAYBE").keyword).toBeNull();
    expect(detectSmsKeyword("DISCARD").keyword).toBeNull();
    expect(detectSmsKeyword("REPORT").keyword).toBeNull();
    // And as first-token with descriptive text:
    expect(detectSmsKeyword("REPORT harassment").keyword).toBeNull();
  });
});

// ─── compliance reply copy (10DLC vetting depends on these) ────────────────

describe("smsKeywords contract — compliance reply copy", () => {
  it("STOP_ACK exact body — carriers vet this string verbatim", () => {
    // Pinned EXACT: any change should be a deliberate, reviewed update,
    // not a silent commit. Carriers will reject 10DLC re-vetting if the
    // copy doesn't include the program name + START re-opt-in path.
    expect(STOP_ACK).toBe(
      "Boba: You're opted out and won't receive any more messages. " +
        "Reply START to resume. Need help? support@boba.app",
    );
  });

  it("HELP_REPLY exact body", () => {
    expect(HELP_REPLY).toBe(
      "Boba: conversation-first dating. One match per day via SMS. " +
        "Reply STOP to opt out, START to opt back in. " +
        "Msg & data rates may apply. Questions: support@boba.app",
    );
  });

  it("START_ACK exact body", () => {
    expect(START_ACK).toBe(
      "Boba: You're opted back in. " +
        "Welcome back 🧋 — we'll text you when your next match is ready.",
    );
  });

  it("all three replies start with the program name 'Boba'", () => {
    // CTIA requires the program identifier in every auto-response.
    expect(STOP_ACK.startsWith("Boba")).toBe(true);
    expect(HELP_REPLY.startsWith("Boba")).toBe(true);
    expect(START_ACK.startsWith("Boba")).toBe(true);
  });

  it("HELP_REPLY contains all three required disclosures", () => {
    // Even though the exact-body test pins everything, these targeted
    // assertions make the failure message immediately legible if someone
    // edits one piece. Required by CTIA: opt-out instructions, msg/data
    // rates clause, and contact for questions.
    expect(HELP_REPLY).toMatch(/Reply STOP to opt out/);
    expect(HELP_REPLY).toMatch(/START to opt back in/);
    expect(HELP_REPLY).toMatch(/Msg & data rates may apply/);
    expect(HELP_REPLY).toMatch(/support@boba\.app/);
  });

  it("STOP_ACK provides the re-opt-in path", () => {
    // CTIA requires STOP confirmations mention how to opt back in.
    expect(STOP_ACK).toMatch(/Reply START/);
  });
});
