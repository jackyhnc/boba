import { describe, it, expect } from "vitest";
import { advance, COPY, mergeUpdates } from "../../src/onboarding/flow.js";
import { STEP_ORDER } from "../../src/onboarding/types.js";

describe("onboarding/advance — entry & terminal", () => {
  it("null cursor with invites required → invite-welcome + ask_invite_code", () => {
    const r = advance(null, "hello?");
    expect(r.nextStep).toBe("ask_invite_code");
    expect(r.reply).toBe(COPY.welcomeWithInvite);
    expect(r.markActive).toBe(false);
  });

  it("null cursor with invites disabled → classic welcome + ask_display_name", () => {
    const r = advance(null, "hello?", { config: { invitesRequired: false } });
    expect(r.nextStep).toBe("ask_display_name");
    expect(r.reply).toBe(COPY.welcome);
  });

  it("welcome cursor behaves the same as null (invites required)", () => {
    const r = advance("welcome", "anything");
    expect(r.nextStep).toBe("ask_invite_code");
    expect(r.reply).toBe(COPY.welcomeWithInvite);
  });

  it("ask_invite_code with invites disabled passes through", () => {
    const r = advance("ask_invite_code", "irrelevant", {
      config: { invitesRequired: false },
    });
    expect(r.nextStep).toBe("ask_display_name");
    expect(r.updates).toEqual({});
  });

  it("done cursor returns the done copy without flipping state again", () => {
    const r = advance("done", "anything");
    expect(r.nextStep).toBe("done");
    expect(r.reply).toBe(COPY.done);
    expect(r.markActive).toBe(true);
    expect(r.updates).toEqual({});
  });
});

describe("onboarding/advance — invite step", () => {
  it("accepts a well-formed code and emits inviteCodeToRedeem directive", () => {
    const r = advance("ask_invite_code", "abcd-1234");
    expect(r.nextStep).toBe("ask_display_name");
    expect(r.updates.inviteCodeToRedeem).toBe("ABCD1234");
  });
  it("rejects malformed", () => {
    expect(advance("ask_invite_code", "short").nextStep).toBe("ask_invite_code");
    expect(advance("ask_invite_code", "with spaces extra").nextStep).toBe(
      "ask_invite_code",
    );
  });
});

describe("onboarding/advance — photo step", () => {
  it("accepts SKIP without media", () => {
    const r = advance("ask_photo", "skip");
    expect(r.nextStep).toBe("ask_preferred_genders");
    expect(r.updates).toEqual({});
  });
  it("rejects non-skip text without media", () => {
    const r = advance("ask_photo", "ok");
    expect(r.nextStep).toBe("ask_photo");
  });
  it("accepts a JPEG attachment", () => {
    const r = advance("ask_photo", "", {
      media: { url: "https://x.com/p.jpg", contentType: "image/jpeg" },
    });
    expect(r.nextStep).toBe("ask_preferred_genders");
    expect(r.updates.stats?.photoUrl).toBe("https://x.com/p.jpg");
  });
  it("rejects non-image media", () => {
    const r = advance("ask_photo", "", {
      media: { url: "https://x.com/v.mp4", contentType: "video/mp4" },
    });
    expect(r.nextStep).toBe("ask_photo");
  });
});

describe("onboarding/advance — display name", () => {
  it("accepts a reasonable name", () => {
    const r = advance("ask_display_name", "Alice");
    expect(r.nextStep).toBe("ask_age");
    expect(r.updates.user?.displayName).toBe("Alice");
  });
  it("rejects empty", () => {
    const r = advance("ask_display_name", "   ");
    expect(r.nextStep).toBe("ask_display_name");
    expect(r.updates.user?.displayName).toBeUndefined();
  });
  it("rejects numeric-looking", () => {
    const r = advance("ask_display_name", "+15551234567");
    expect(r.nextStep).toBe("ask_display_name");
  });
  it("rejects oversize", () => {
    const r = advance("ask_display_name", "a".repeat(41));
    expect(r.nextStep).toBe("ask_display_name");
  });
});

describe("onboarding/advance — numeric parsers", () => {
  it("age: accepts 18..99", () => {
    expect(advance("ask_age", "18").updates.stats?.age).toBe(18);
    expect(advance("ask_age", "99").updates.stats?.age).toBe(99);
  });
  it("age: rejects 17 and 100", () => {
    expect(advance("ask_age", "17").nextStep).toBe("ask_age");
    expect(advance("ask_age", "100").nextStep).toBe("ask_age");
  });
  it("age: rejects NaN", () => {
    expect(advance("ask_age", "twenty").nextStep).toBe("ask_age");
  });
  it("heightCm: accepts 120..230", () => {
    expect(advance("ask_height_cm", "120").updates.stats?.heightCm).toBe(120);
    expect(advance("ask_height_cm", "230").updates.stats?.heightCm).toBe(230);
  });
  it("heightCm: rejects out-of-range", () => {
    expect(advance("ask_height_cm", "100").nextStep).toBe("ask_height_cm");
    expect(advance("ask_height_cm", "231").nextStep).toBe("ask_height_cm");
  });
});

describe("onboarding/advance — gender + preferred genders", () => {
  it("gender: maps synonyms", () => {
    expect(advance("ask_gender", "f").updates.stats?.gender).toBe("WOMAN");
    expect(advance("ask_gender", "MALE").updates.stats?.gender).toBe("MAN");
    expect(advance("ask_gender", "nb").updates.stats?.gender).toBe("NONBINARY");
    expect(advance("ask_gender", "other").updates.stats?.gender).toBe("OTHER");
  });
  it("gender: rejects gibberish", () => {
    expect(advance("ask_gender", "asdf").nextStep).toBe("ask_gender");
  });
  it("preferred genders: accepts comma-separated list, dedupes", () => {
    const r = advance("ask_preferred_genders", "woman, man, woman");
    expect(r.updates.preferences?.preferredGenders).toEqual(["WOMAN", "MAN"]);
  });
  it("preferred genders: rejects mixed valid + invalid", () => {
    const r = advance("ask_preferred_genders", "woman, dinosaur");
    expect(r.nextStep).toBe("ask_preferred_genders");
  });
});

describe("onboarding/advance — type descriptor + email domain", () => {
  it("type descriptor: requires substance", () => {
    expect(advance("ask_type_descriptor", "x").nextStep).toBe("ask_type_descriptor");
    expect(advance("ask_type_descriptor", "x".repeat(401)).nextStep).toBe(
      "ask_type_descriptor",
    );
    const r = advance("ask_type_descriptor", "someone curious and kind");
    expect(r.nextStep).toBe("ask_campus_email_domain");
    expect(r.updates.preferences?.typeDescriptor).toBe("someone curious and kind");
  });
  it("email domain: accepts a bare domain", () => {
    const r = advance("ask_campus_email_domain", "princeton.edu");
    expect(r.nextStep).toBe("done");
    expect(r.markActive).toBe(true);
    expect(r.updates.user?.campusEmailDomain).toBe("princeton.edu");
  });
  it("email domain: extracts from email", () => {
    const r = advance("ask_campus_email_domain", "jacky@PRINCETON.EDU");
    expect(r.updates.user?.campusEmailDomain).toBe("princeton.edu");
  });
  it("email domain: SKIP is allowed and still finishes", () => {
    const r = advance("ask_campus_email_domain", "skip");
    expect(r.nextStep).toBe("done");
    expect(r.markActive).toBe(true);
    expect(r.updates.user?.campusEmailDomain).toBeUndefined();
  });
  it("email domain: rejects garbage", () => {
    const r = advance("ask_campus_email_domain", "not a domain at all");
    expect(r.nextStep).toBe("ask_campus_email_domain");
  });
});

describe("onboarding — STEP_ORDER", () => {
  it("starts with welcome and ends with done", () => {
    expect(STEP_ORDER[0]).toBe("welcome");
    expect(STEP_ORDER[STEP_ORDER.length - 1]).toBe("done");
  });
});

describe("onboarding — mergeUpdates", () => {
  it("merges nested partials, with b winning", () => {
    const merged = mergeUpdates(
      { user: { displayName: "A" }, stats: { age: 22 } },
      { user: { displayName: "B" }, preferences: { minAge: 20 } },
    );
    expect(merged).toEqual({
      user: { displayName: "B" },
      stats: { age: 22 },
      preferences: { minAge: 20 },
    });
  });
});
