// Verbatim COPY pins for `src/twilio/conversation.ts`.
//
// `conversationContract.test.ts` already pins router precedence, RouteResult
// shape, OutboundAction.kind enumeration, hard-flag depth zeroing, and
// substring/regex checks of the COPY surface (the JOIN/RESUME keywords,
// the {{stat}} placeholder form, the prependedWarning prefix). What it
// does NOT pin is the full user-visible body of each constant — the
// existing surface checks would still pass under a rewrite like:
//
//   unknownSenderIntro:
//     "Welcome to Boba — invite-only beta. Send JOIN with your code to start."
//
// The substring assertion on /\bJOIN\b/ stays green, but the SMS the
// user actually receives changes. For a 10DLC campaign that ships these
// strings to the carrier as registered sample messages, silent body
// drift between code and the carrier-registered samples means
// deliverability problems we discover in production.
//
// This file pins each body verbatim, plus the prependedWarning template
// (which lives as inline string literals in conversation.ts, not in COPY
// at all — so even the contract test's regex assertion can't catch a
// rewording). When a real copy change is intended, this file updates
// in the same commit. Drift without an update is the bug we're catching.

import { describe, it, expect } from "vitest";
import {
  COPY,
  renderRevealBody,
  route,
  type RouteInput,
  type RouterActiveMatch,
  type RouterUser,
} from "../../src/twilio/conversation.js";

// ─── 1. Verbatim COPY bodies ──────────────────────────────────────────────

describe("conversation COPY — verbatim user-visible bodies", () => {
  it("unknownSenderIntro is the exact intro shipped to first-time texters", () => {
    expect(COPY.unknownSenderIntro).toBe(
      "Hi! This is Boba — conversation-first dating. We're invite-only right now. Reply JOIN if you have an invite code, or visit boba.app to request one.",
    );
  });

  it("onboardingStub is the exact partial-onboarding holding reply", () => {
    expect(COPY.onboardingStub).toBe(
      "Welcome to Boba! You're partway through onboarding. We'll text you the next question shortly.",
    );
  });

  it("noMatchHolding is the exact between-matches holding body (names 5pm window)", () => {
    // The 5pm window is documented to users and the daily-match scheduler
    // ships at that hour. If the scheduler moves, this string moves with
    // it — pin so the two stay in sync via the same commit.
    expect(COPY.noMatchHolding).toBe(
      "You're all set. Your next match drops today at 5pm — we'll text you here.",
    );
  });

  it("paused is the exact PAUSED-status body (with the RESUME keyword)", () => {
    expect(COPY.paused).toBe(
      "Your account is paused. Reply RESUME to start receiving matches again.",
    );
  });

  it("revealAge is the exact AGE-unlock template (mustache placeholder, em-dash)", () => {
    expect(COPY.revealAge).toBe(
      "✨ Milestone unlocked — your match is {{age}} years old.",
    );
  });

  it("revealProfession is the exact PROFESSION-unlock template", () => {
    expect(COPY.revealProfession).toBe(
      "✨ Milestone unlocked — your match works as {{profession}}.",
    );
  });

  it("revealHeight is the exact HEIGHT-unlock template (cm unit baked in)", () => {
    // The unit suffix ("cm") is part of the template, not the substituted
    // value. A refactor that "helpfully" appends "cm" inside renderRevealBody
    // would double the unit ("174cmcm"). Pin so it stays here.
    expect(COPY.revealHeight).toBe(
      "✨ Milestone unlocked — your match is {{heightCm}}cm tall.",
    );
  });

  it("COPY exposes exactly the documented keys — no orphan strings, no missing ones", () => {
    // A new key landing here without an updated test is the failure mode.
    expect(Object.keys(COPY).sort()).toEqual(
      [
        "noMatchHolding",
        "onboardingStub",
        "paused",
        "revealAge",
        "revealHeight",
        "revealProfession",
        "unknownSenderIntro",
      ].sort(),
    );
  });

  it("every reveal template uses the em-dash (U+2014), not a hyphen or two-dash", () => {
    // Hyphens vs em-dashes visually conflate in some carrier renderings.
    // The convention is em-dash for the milestone-unlock sentence break.
    for (const tpl of [COPY.revealAge, COPY.revealProfession, COPY.revealHeight]) {
      expect(tpl).toContain("—");
      expect(tpl).not.toMatch(/ - /);
      expect(tpl).not.toContain("--");
    }
  });

  it("every reveal template starts with the sparkles glyph (telemetry pattern)", () => {
    // The "milestone_reveal" kind is detected in some metrics by the
    // sparkles glyph as a low-effort dedupe across older log lines.
    for (const tpl of [COPY.revealAge, COPY.revealProfession, COPY.revealHeight]) {
      expect(tpl.startsWith("✨ Milestone unlocked")).toBe(true);
    }
  });
});

// ─── 2. renderRevealBody rendered output (post-substitution) ──────────────

describe("renderRevealBody — verbatim post-substitution output", () => {
  // The IO layer ships these strings to Twilio as-is. The pin is the
  // entire rendered body, not just a substring — a refactor that adds a
  // leading "Boba:" prefix or strips the trailing period would still
  // pass the existing `.toContain("22")` check.

  it("AGE with concrete stat renders the exact SMS body", () => {
    expect(
      renderRevealBody("AGE", { age: 22, profession: null, heightCm: null }),
    ).toBe("✨ Milestone unlocked — your match is 22 years old.");
  });

  it("PROFESSION with concrete stat renders the exact SMS body", () => {
    expect(
      renderRevealBody("PROFESSION", {
        age: null,
        profession: "physics student",
        heightCm: null,
      }),
    ).toBe("✨ Milestone unlocked — your match works as physics student.");
  });

  it("HEIGHT with concrete stat renders the exact SMS body (no double 'cm')", () => {
    expect(
      renderRevealBody("HEIGHT", { age: null, profession: null, heightCm: 174 }),
    ).toBe("✨ Milestone unlocked — your match is 174cm tall.");
  });

  it("FACE (unreachable from router) still renders a sensible standalone body", () => {
    expect(
      renderRevealBody("FACE", { age: null, profession: null, heightCm: null }),
    ).toBe("✨ Milestone unlocked — face reveal.");
  });

  it("missing-stat substitution uses U+2014 em-dash (not hyphen)", () => {
    // The em-dash here is doubly important: it signals "unknown" without
    // colliding with the en-dash inside phone numbers ("+1-555-…") or
    // the hyphen inside profession strings ("ex-banker").
    const aged = renderRevealBody("AGE", { age: null, profession: null, heightCm: null });
    const pro = renderRevealBody("PROFESSION", { age: null, profession: null, heightCm: null });
    const ht = renderRevealBody("HEIGHT", { age: null, profession: null, heightCm: null });
    expect(aged).toBe("✨ Milestone unlocked — your match is — years old.");
    expect(pro).toBe("✨ Milestone unlocked — your match works as —.");
    expect(ht).toBe("✨ Milestone unlocked — your match is —cm tall.");
  });
});

// ─── 3. prependedWarning template (lives as inline strings in conversation.ts)

// `prependedWarning` is not part of COPY — it's an internal helper whose
// template is hard-coded inline. The existing contract test only checks
// the prefix `^⚠ Heads up: this asks about ` (regex) and that the
// multi-category branch contains the literal "personal info". Below
// pins the full string the user receives, including the trailing
// "before the reveal — that's against Boba's flow." segment and the
// exact category tag used per-category.

const PHONE_A = "+15550000001";
const PHONE_B = "+15550000002";

function makeUser(overrides: Partial<RouterUser> = {}): RouterUser {
  return {
    id: "u_alice",
    phone: PHONE_A,
    displayName: "Alice",
    status: "ACTIVE",
    onboardingStep: null,
    smsOptedOut: false,
    ...overrides,
  };
}

function makeMatch(overrides: Partial<RouterActiveMatch> = {}): RouterActiveMatch {
  return {
    id: "m1",
    userAId: "u_alice",
    userBId: "u_bob",
    partner: {
      id: "u_bob",
      phone: PHONE_B,
      isAiBacked: false,
      aiPersonaPrompt: null,
    },
    priorMessages: [],
    unlockedMilestones: new Set(),
    ...overrides,
  };
}

function makeInput(overrides: Partial<RouteInput> = {}): RouteInput {
  return {
    sender: makeUser(),
    fromPhone: PHONE_A,
    body: "hey",
    activeMatch: makeMatch(),
    ...overrides,
  };
}

function warningLineOf(body: string): string {
  // Router builds the relay body as `${warning}\n${original}`.
  return body.split("\n")[0]!;
}

describe("prependedWarning — verbatim per-category and multi-category templates", () => {
  it("single-category 'name' uses the exact warning template with that tag", () => {
    // The category tag is interpolated into the middle of the template.
    // A refactor that pluralised or capitalised the tag ("Name" / "names")
    // would change the user-visible body — pin the exact rendering.
    const out = route(makeInput({ body: "what's your last name?" }));
    const relay = out.outbounds.find((o) => o.kind === "relay")!;
    expect(warningLineOf(relay.body)).toBe(
      "⚠ Heads up: this asks about name before the reveal — that's against Boba's flow.",
    );
  });

  it("single-category 'social' uses the exact warning template with that tag", () => {
    const out = route(makeInput({ body: "what's your insta?" }));
    const relay = out.outbounds.find((o) => o.kind === "relay")!;
    expect(warningLineOf(relay.body)).toBe(
      "⚠ Heads up: this asks about social before the reveal — that's against Boba's flow.",
    );
  });

  it("single-category 'school' uses the exact warning template with that tag", () => {
    const out = route(makeInput({ body: "where do you go to school?" }));
    const relay = out.outbounds.find((o) => o.kind === "relay")!;
    expect(warningLineOf(relay.body)).toBe(
      "⚠ Heads up: this asks about school before the reveal — that's against Boba's flow.",
    );
  });

  it("multi-category collapses to 'personal info' verbatim (no comma-join, no detector tags)", () => {
    // The detector emits internal tags like "asks_last_name" /
    // "asks_handle"; those must NEVER reach the user. The fallback is
    // the literal phrase "personal info". Pin the full body.
    const out = route(
      makeInput({
        body: "what's your last name and what's your instagram?",
      }),
    );
    const relay = out.outbounds.find((o) => o.kind === "relay")!;
    expect(warningLineOf(relay.body)).toBe(
      "⚠ Heads up: this asks about personal info before the reveal — that's against Boba's flow.",
    );
  });

  it("relay body separator is exactly one newline between warning and original", () => {
    // The IO layer ships `relay.body` to Twilio as the SMS body. A change
    // from `\n` to `\n\n` adds a blank line in the rendered SMS — visible
    // to the user, increases segment count, may push past 160-char SMS
    // boundary. Pin the exact separator.
    const original = "what's your last name?";
    const out = route(makeInput({ body: original }));
    const relay = out.outbounds.find((o) => o.kind === "relay")!;
    const parts = relay.body.split("\n");
    expect(parts).toHaveLength(2);
    expect(parts[1]).toBe(original);
    // No trailing or leading whitespace contamination on the original.
    expect(relay.body.endsWith(original)).toBe(true);
  });

  it("warning uses the U+26A0 warning glyph (not :warning: or [!])", () => {
    // The glyph is part of the carrier-registered sample. Pin the exact
    // codepoint — a refactor that switched to "[!]" or a different
    // glyph variant ("⚠️" with VS-16) changes the rendered byte sequence.
    const out = route(makeInput({ body: "what's your last name?" }));
    const relay = out.outbounds.find((o) => o.kind === "relay")!;
    expect(relay.body.startsWith("⚠ ")).toBe(true);
    // Specifically NOT the VS-16 variant (which the carrier may render
    // as a colorful emoji instead of the documented monochrome glyph).
    expect(relay.body.startsWith("⚠️")).toBe(false);
  });

  it("warning uses em-dash (U+2014) before the policy clause, not en-dash or hyphen", () => {
    const out = route(makeInput({ body: "what's your last name?" }));
    const relay = out.outbounds.find((o) => o.kind === "relay")!;
    const line = warningLineOf(relay.body);
    expect(line).toContain("— that's against Boba's flow.");
    expect(line).not.toContain("– that's"); // en-dash
    expect(line).not.toContain("- that's"); // hyphen
  });
});

// ─── 4. Photo-category gating semantics in copy ───────────────────────────

describe("photo category gates via the warning until FACE unlocks", () => {
  // shouldGateBy("photo", ...) returns true only while FACE is locked.
  // Once FACE unlocks (end-of-day reveal), a photo question is no longer
  // hard-flagged — so the warning DISAPPEARS from the relayed body, and
  // the message goes through unmodified. Pin both halves.

  it("with FACE locked, 'send a pic' triggers the warning prefix", () => {
    const out = route(
      makeInput({
        body: "send a pic?",
        activeMatch: makeMatch({ unlockedMilestones: new Set() }),
      }),
    );
    const relay = out.outbounds.find((o) => o.kind === "relay")!;
    expect(warningLineOf(relay.body)).toContain("about photo before the reveal");
  });

  it("with FACE unlocked, 'send a pic' relays clean — no warning prefix at all", () => {
    const out = route(
      makeInput({
        body: "send a pic?",
        activeMatch: makeMatch({ unlockedMilestones: new Set(["FACE"]) }),
      }),
    );
    const relay = out.outbounds.find((o) => o.kind === "relay")!;
    expect(relay.body).toBe("send a pic?");
    expect(relay.body).not.toContain("⚠");
    // And the persistence record is no longer hard-flagged.
    expect(out.persistInbound?.flaggedStatFishing).toBe(false);
  });
});
