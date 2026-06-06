import { describe, it, expect } from "vitest";
import type { MilestoneType } from "@prisma/client";
import {
  detectStatFishing,
  shouldGateBy,
  type StatFishCategory,
} from "../../src/safety/statFishing.js";

// Contract pins for the anti-doxxing stat-fishing detector.
//
// `tests/safety/statFishing.test.ts` already pins behavioural categories and
// the single-category confidence value, but several silent-regression paths
// remain. This file targets those — each test is written so that the most
// plausible refactor that would otherwise pass the existing suite breaks here.

describe("statFishing contract — matches[] surfaces probe tags (telemetry contract)", () => {
  it("a name probe hit produces a name-shaped tag in matches[]", () => {
    const det = detectStatFishing("what's your last name?");
    expect(det.matches.length).toBeGreaterThanOrEqual(1);
    expect(det.matches).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^asks_(full|last|what)_name$/),
      ]),
    );
  });

  it("photo and location probes emit their exact telemetry tags", () => {
    // If `matches.push(probe.tag)` were dropped, these would empty out.
    expect(detectStatFishing("send a pic").matches).toContain("asks_photo");
    expect(detectStatFishing("where do you live?").matches).toContain(
      "asks_where_live",
    );
  });

  it("benign and empty inputs yield matches:[] (no stray tags)", () => {
    expect(detectStatFishing("how was your weekend?").matches).toEqual([]);
    expect(detectStatFishing("").matches).toEqual([]);
    expect(detectStatFishing("   ").matches).toEqual([]);
  });
});

describe("statFishing contract — confidence is per-CATEGORY, not per-match", () => {
  it("multiple probe hits in ONE category stay at one category and confidence 0.4", () => {
    // 'what's your name' triggers asks_what_name; 'what's your last name'
    // additionally triggers asks_full_name and asks_last_name — all three
    // share category "name". A refactor swapping `categories.size * 0.4`
    // for `matches.length * 0.4` would raise this to >= 0.8.
    const det = detectStatFishing(
      "what's your name? what's your last name?",
    );
    expect(det.categories).toEqual(["name"]);
    expect(det.matches.length).toBeGreaterThanOrEqual(2);
    expect(det.confidence).toBeCloseTo(0.4, 5);
  });

  it("confidence is capped at exactly 1.0 when categories.size * 0.4 would exceed 1", () => {
    // 4 distinct categories → uncapped contribution would be 1.6.
    const det = detectStatFishing(
      "what's your name, what's your insta, where do you live, send a pic",
    );
    expect(det.confidence).toBe(1);
    expect(det.categories.length).toBeGreaterThanOrEqual(3);
  });
});

describe("statFishing contract — flagged is the categories.length > 0 invariant", () => {
  it("a single-category hit sets flagged=true (no hidden confidence threshold)", () => {
    // Pins against a `flagged = confidence >= 0.5` refactor — single-category
    // hits have confidence 0.4 and would silently flip to flagged=false.
    const det = detectStatFishing("what's your name?");
    expect(det.categories.length).toBe(1);
    expect(det.confidence).toBeCloseTo(0.4, 5);
    expect(det.flagged).toBe(true);
  });

  it("empty categories ↔ flagged=false (no flagged-without-categories states)", () => {
    const det = detectStatFishing("how was your weekend?");
    expect(det.categories).toEqual([]);
    expect(det.flagged).toBe(false);
  });
});

describe("statFishing contract — case insensitivity holds across categories", () => {
  it("ALL-CAPS name asks still flag", () => {
    expect(detectStatFishing("WHAT'S YOUR NAME?").categories).toContain("name");
  });
  it("Mixed-case photo asks still flag", () => {
    expect(detectStatFishing("Send A Pic").categories).toContain("photo");
  });
});

describe("statFishing contract — @handle requires whitespace OR string start before @", () => {
  it("@handle preceded by whitespace flags social", () => {
    expect(detectStatFishing("ping @joebloggs there").categories).toContain(
      "social",
    );
  });
  it("@handle at the start of the message flags social", () => {
    expect(detectStatFishing("@joebloggs is my handle").categories).toContain(
      "social",
    );
  });
  it("user@domain inside email-shaped text does NOT false-flag social", () => {
    // The (?:^|\s) anchor on the @-handle probe is what protects emails.
    // Dropping it would silently flag every email in a message.
    const det = detectStatFishing(
      "contact me at user@example.com if needed",
    );
    expect(det.categories).not.toContain("social");
    expect(det.flagged).toBe(false);
  });
});

describe("statFishing contract — social platform keyword probes require a question mark", () => {
  it("a statement mentioning 'instagram' does NOT flag social", () => {
    // Pins the `.*\?` requirement on the explicit social-platform regex —
    // distinguishes 'are you on insta?' from 'I love instagram'.
    expect(detectStatFishing("I love instagram").categories).not.toContain(
      "social",
    );
  });
  it("a question mentioning 'insta' DOES flag social", () => {
    expect(detectStatFishing("are you on insta?").categories).toContain(
      "social",
    );
  });
});

describe("statFishing contract — shouldGateBy unlock semantics", () => {
  const allMilestones = new Set<MilestoneType>([
    "AGE",
    "PROFESSION",
    "HEIGHT",
    "FACE",
  ]);
  const allCategories: StatFishCategory[] = [
    "name",
    "school",
    "social",
    "photo",
    "phone",
    "location",
  ];

  it("gates every category when no milestones are unlocked", () => {
    const empty = new Set<MilestoneType>();
    for (const c of allCategories) {
      expect(shouldGateBy(c, empty)).toBe(true);
    }
  });

  it("FACE specifically — not any unlock — releases the photo gate", () => {
    // Refactor risk: a 'any unlocked milestone releases the photo gate'
    // change would silently break the contract.
    const noFace = new Set<MilestoneType>(["AGE", "PROFESSION", "HEIGHT"]);
    expect(shouldGateBy("photo", noFace)).toBe(true);
    expect(shouldGateBy("photo", allMilestones)).toBe(false);
  });

  it("name / school / social / phone / location stay gated even after every milestone unlock", () => {
    const persistent: StatFishCategory[] = [
      "name",
      "school",
      "social",
      "phone",
      "location",
    ];
    for (const c of persistent) {
      expect(shouldGateBy(c, allMilestones)).toBe(true);
    }
  });
});
