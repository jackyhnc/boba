import { describe, it, expect } from "vitest";
import {
  detectHarassment,
  parseReportCommand,
  REPORT_ACK,
  type HarassmentCategory,
  type HarassmentDetection,
  type ReportCommand,
} from "../../src/safety/moderation.js";

// Contract pins for src/safety/moderation.ts.
//
// `tests/safety/moderation.test.ts` exercises happy paths and one or two
// edge cases per public function. This file pins the structural invariants
// that a plausible refactor could silently violate while leaving the
// behavioural suite green:
//
//   - the exact `HarassmentCategory` enum strings (they're persisted on
//     Report rows and queried by analytics — renaming silently breaks both)
//   - the EXACT severe-vs-non-severe partition (severe ⇔ slur/threat/
//     sexual_coercion; profanity is never severe, on its own or alongside
//     other non-severe hits)
//   - the `HarassmentDetection` result shape (four keys, no extras), the
//     `flagged ⇔ categories.length > 0` invariant, and that empty/whitespace
//     input returns the canonical zero-detection object
//   - purity: detectHarassment(x) deep-equals detectHarassment(x) for any x
//   - parseReportCommand's "unspecified" sentinel + the first-token-only
//     enforcement (REPORTING / REPORT: must NOT parse)
//   - the EXACT REPORT_ACK body — it's a user-facing reply, and we want
//     copy drift to break a test, not arrive in someone's inbox.

// ─── HarassmentDetection result shape ─────────────────────────────────────

describe("moderation contract — HarassmentDetection result shape", () => {
  it("always returns exactly { flagged, categories, matches, severe } — no extras", () => {
    const r = detectHarassment("hello");
    expect(Object.keys(r).sort()).toEqual([
      "categories",
      "flagged",
      "matches",
      "severe",
    ]);
  });

  it("empty input returns the canonical zero-detection object (value pin)", () => {
    // Pinned by value, not shape — guards against e.g. a refactor that
    // returns `categories: undefined` or omits `matches` on the early exit.
    expect(detectHarassment("")).toEqual({
      flagged: false,
      categories: [],
      matches: [],
      severe: false,
    });
  });

  it("whitespace-only input takes the empty-input branch", () => {
    expect(detectHarassment("   ")).toEqual({
      flagged: false,
      categories: [],
      matches: [],
      severe: false,
    });
    expect(detectHarassment("\n\t")).toEqual({
      flagged: false,
      categories: [],
      matches: [],
      severe: false,
    });
  });

  it("flagged ⇔ categories.length > 0 (no flagged-without-categories states)", () => {
    // Positive flagged path.
    const hit = detectHarassment("i will kill you");
    expect(hit.flagged).toBe(true);
    expect(hit.categories.length).toBeGreaterThan(0);
    // Negative path.
    const miss = detectHarassment("how was your weekend");
    expect(miss.flagged).toBe(false);
    expect(miss.categories.length).toBe(0);
  });

  it("categories[] contains no duplicates (Set-dedupe contract)", () => {
    // Two probes in the SAME category — fuck_off and stfu both → profanity.
    // If `cats` were swapped from a Set to a plain array, this would land
    // as ["profanity", "profanity"].
    const r = detectHarassment("stfu and fuck off");
    expect(r.categories).toEqual(["profanity"]);
    expect(r.matches.length).toBeGreaterThanOrEqual(2);
  });

  it("is pure: equal input → deep-equal output, repeated calls do not mutate", () => {
    const a = detectHarassment("i will kill you");
    const b = detectHarassment("i will kill you");
    const c = detectHarassment("i will kill you");
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    // Mutating the returned arrays must not leak into the next call.
    a.categories.push("slur");
    a.matches.push("synthetic");
    const d = detectHarassment("i will kill you");
    expect(d).toEqual(b);
  });
});

// ─── canonical HarassmentCategory strings (persisted contract) ────────────

describe("moderation contract — canonical category strings", () => {
  // These strings are persisted onto Report rows / analytics. Renaming any
  // of them is a migration, not a refactor.
  it("'slur' category fires on a slur token, alone", () => {
    // Slur pattern fires on f**got / n-word / tr*nny variants; we use a
    // mild fixture deliberately — the probe just needs to be exercised.
    const r = detectHarassment("you stfu faggot");
    expect(r.categories).toContain<HarassmentCategory>("slur");
  });

  it("'threat' category fires for an explicit kill/dox threat", () => {
    expect(detectHarassment("i will kill you").categories).toContain<HarassmentCategory>(
      "threat",
    );
    expect(detectHarassment("i will expose you").categories).toContain<HarassmentCategory>(
      "threat",
    );
  });

  it("'sexual_coercion' fires for both the demand and the conditional forms", () => {
    expect(
      detectHarassment("send me nudes").categories,
    ).toContain<HarassmentCategory>("sexual_coercion");
    expect(
      detectHarassment("if you don't send nudes i'll be mad").categories,
    ).toContain<HarassmentCategory>("sexual_coercion");
  });

  it("'profanity' fires for the fuck-you and stfu forms", () => {
    expect(detectHarassment("fuck you").categories).toContain<HarassmentCategory>(
      "profanity",
    );
    expect(detectHarassment("stfu").categories).toContain<HarassmentCategory>(
      "profanity",
    );
  });
});

// ─── severe partition (escalation contract) ────────────────────────────────

describe("moderation contract — severe partition", () => {
  // severe is what wakes up moderators / drives auto-blocks; the precise
  // membership is the whole point of the partition.
  it("severe=true for slur ALONE", () => {
    const r = detectHarassment("you faggot");
    expect(r.categories).toEqual(["slur"]);
    expect(r.severe).toBe(true);
  });

  it("severe=true for threat ALONE", () => {
    const r = detectHarassment("i will kill you");
    expect(r.categories).toEqual(["threat"]);
    expect(r.severe).toBe(true);
  });

  it("severe=true for sexual_coercion ALONE", () => {
    const r = detectHarassment("send me nudes");
    expect(r.categories).toEqual(["sexual_coercion"]);
    expect(r.severe).toBe(true);
  });

  it("severe=false for profanity ALONE (the asymmetric one)", () => {
    // This is the most common live case — bystanders shouting STFU at each
    // other shouldn't escalate. If `severe` flipped to OR-everything, this
    // would silently start paging us.
    const r = detectHarassment("stfu");
    expect(r.flagged).toBe(true);
    expect(r.categories).toEqual(["profanity"]);
    expect(r.severe).toBe(false);
  });

  it("severe=true when ANY severe category co-occurs with profanity", () => {
    // Mixed input — threat + profanity. severe must be sticky on the
    // severe member, not diluted by the non-severe one.
    const r = detectHarassment("stfu i will kill you");
    expect(r.categories).toEqual(
      expect.arrayContaining<HarassmentCategory>(["threat", "profanity"]),
    );
    expect(r.severe).toBe(true);
  });

  it("severe is unflagged⇒false (no severe-without-flagged states)", () => {
    const r = detectHarassment("hello there");
    expect(r.flagged).toBe(false);
    expect(r.severe).toBe(false);
  });
});

// ─── parseReportCommand structural contract ───────────────────────────────

describe("moderation contract — parseReportCommand shape & sentinel", () => {
  it("returns null OR exactly { reason, details } — no extras", () => {
    const hit = parseReportCommand("REPORT spam");
    expect(hit).not.toBeNull();
    // Narrow for TS — null already excluded above.
    const r = hit as ReportCommand;
    expect(Object.keys(r).sort()).toEqual(["details", "reason"]);
  });

  it("'unspecified' is the literal sentinel for bare REPORT", () => {
    // The persisted Report.reason column relies on this exact string for
    // grouping. Changing it to e.g. "" or null is a migration.
    expect(parseReportCommand("REPORT")).toEqual({
      reason: "unspecified",
      details: null,
    });
    expect(parseReportCommand("report")).toEqual({
      reason: "unspecified",
      details: null,
    });
  });

  it("'unspecified' also fires when reason is empty but details are present", () => {
    // "REPORT : something" → empty-before-colon falls back to the sentinel.
    expect(parseReportCommand("REPORT : creepy dm")).toEqual({
      reason: "unspecified",
      details: "creepy dm",
    });
  });

  it("trailing-colon-no-details normalises details to null (not empty string)", () => {
    expect(parseReportCommand("REPORT harassment:")).toEqual({
      reason: "harassment",
      details: null,
    });
    expect(parseReportCommand("REPORT harassment:   ")).toEqual({
      reason: "harassment",
      details: null,
    });
  });

  it("splits on the FIRST ':' — additional colons stay in details", () => {
    expect(parseReportCommand("REPORT harassment: ratio 3:1 happened")).toEqual({
      reason: "harassment",
      details: "ratio 3:1 happened",
    });
  });

  it("first-token-only: REPORTING / REPORTS / REPORTED do NOT parse", () => {
    // Pinned against a `\^report` → `\^report\w*` refactor.
    expect(parseReportCommand("REPORTING for duty")).toBeNull();
    expect(parseReportCommand("REPORTS due monday")).toBeNull();
    expect(parseReportCommand("reported him")).toBeNull();
  });

  it("REPORT must be followed by whitespace or end-of-string (no punctuation suffix)", () => {
    // The anchor is `(?:\s+(.+))?$` — `:` / `.` / `,` immediately after
    // REPORT all break the match. If someone broadened the separator to
    // `[\s:]+`, "REPORT:foo" would suddenly start working.
    expect(parseReportCommand("REPORT:")).toBeNull();
    expect(parseReportCommand("REPORT:foo")).toBeNull();
    expect(parseReportCommand("REPORT.")).toBeNull();
    expect(parseReportCommand("REPORT,foo")).toBeNull();
  });

  it("a REPORT later in the body does NOT parse (first-token-only positional)", () => {
    expect(parseReportCommand("please REPORT this")).toBeNull();
    expect(parseReportCommand("hi REPORT spam")).toBeNull();
  });

  it("is pure: equal input → deep-equal output", () => {
    const a = parseReportCommand("REPORT harassment: x");
    const b = parseReportCommand("REPORT harassment: x");
    expect(a).toEqual(b);
  });
});

// ─── REPORT_ACK exact body (user-facing reply, pin verbatim) ──────────────

describe("moderation contract — REPORT_ACK reply copy", () => {
  it("REPORT_ACK exact body — pinned verbatim", () => {
    // The ACK is what the reporter sees IMMEDIATELY after they REPORT.
    // Drift here is a UX bug AND, if BLOCK becomes a real keyword and the
    // copy isn't kept in sync, a stuck-in-match bug.
    expect(REPORT_ACK).toBe(
      "Thanks for the report. We've logged it and our team will follow up. " +
        "If you feel unsafe, reply BLOCK to end this match immediately.",
    );
  });

  it("REPORT_ACK mentions the BLOCK escape hatch", () => {
    // Targeted assertion so a partial copy edit produces a legible failure.
    expect(REPORT_ACK).toMatch(/reply BLOCK/);
  });

  it("REPORT_ACK opens with 'Thanks for the report.'", () => {
    expect(REPORT_ACK.startsWith("Thanks for the report.")).toBe(true);
  });
});

// ─── HarassmentDetection / ReportCommand TS shape compile pins ────────────

describe("moderation contract — TypeScript shape pins", () => {
  it("HarassmentDetection narrows to the four documented fields", () => {
    // This is a compile-time assertion smuggled into a runtime test: if a
    // field is added or removed, the structural assignment below fails to
    // type-check and CI surfaces it. The runtime assertion is incidental.
    const d: HarassmentDetection = {
      flagged: true,
      categories: ["threat"],
      matches: ["kill_threat"],
      severe: true,
    };
    expect(d.severe).toBe(true);
  });

  it("ReportCommand narrows to { reason: string; details: string | null }", () => {
    const r: ReportCommand = { reason: "spam", details: null };
    const s: ReportCommand = { reason: "spam", details: "noisy" };
    expect(r.reason).toBe("spam");
    expect(s.details).toBe("noisy");
  });
});
