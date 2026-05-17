import { describe, it, expect } from "vitest";
import {
  detectStatFishing,
  shouldGateBy,
} from "../../src/safety/statFishing.js";

describe("detectStatFishing — categories", () => {
  it("flags name asks", () => {
    expect(detectStatFishing("what's your last name?").categories).toContain("name");
    expect(detectStatFishing("hey, whats your name?").categories).toContain("name");
    expect(detectStatFishing("what is your full name").categories).toContain("name");
  });

  it("flags school / campus / uni asks", () => {
    expect(detectStatFishing("where do you go to school?").categories).toContain("school");
    expect(detectStatFishing("which university?").categories).toContain("school");
    expect(detectStatFishing("what campus?").categories).toContain("school");
  });

  it("flags social handle asks", () => {
    expect(detectStatFishing("what's your insta?").categories).toContain("social");
    expect(detectStatFishing("got snapchat?").categories).toContain("social");
    expect(detectStatFishing("dm me @jacky_hanc on twitter").categories).toContain("social");
  });

  it("flags photo asks", () => {
    expect(detectStatFishing("send a pic").categories).toContain("photo");
    expect(detectStatFishing("what do you look like?").categories).toContain("photo");
    expect(detectStatFishing("wanna facetime?").categories).toContain("photo");
  });

  it("flags phone digit blobs and explicit asks", () => {
    expect(detectStatFishing("what's your real number?").categories).toContain("phone");
    expect(detectStatFishing("call me +1 555 123 4567 ok?").categories).toContain("phone");
  });

  it("flags location asks", () => {
    expect(detectStatFishing("where do you live?").categories).toContain("location");
    expect(detectStatFishing("what's your address?").categories).toContain("location");
  });
});

describe("detectStatFishing — benign", () => {
  it("does not flag normal conversation", () => {
    expect(detectStatFishing("how was your weekend?").flagged).toBe(false);
    expect(detectStatFishing("I love hiking, you?").flagged).toBe(false);
    expect(detectStatFishing("what's your favorite book").flagged).toBe(false);
  });

  it("empty / whitespace is unflagged", () => {
    expect(detectStatFishing("").flagged).toBe(false);
    expect(detectStatFishing("   ").flagged).toBe(false);
  });
});

describe("detectStatFishing — confidence", () => {
  it("scales with distinct categories", () => {
    const one = detectStatFishing("what's your name?");
    expect(one.confidence).toBeCloseTo(0.4, 2);

    const two = detectStatFishing("what's your name and where do you live?");
    expect(two.confidence).toBeGreaterThanOrEqual(0.8);

    const many = detectStatFishing(
      "what's your name, what's your insta, where do you live, send a pic",
    );
    expect(many.confidence).toBe(1);
  });
});

describe("shouldGateBy", () => {
  it("photo asks stop gating once FACE is unlocked", () => {
    expect(shouldGateBy("photo", new Set())).toBe(true);
    expect(shouldGateBy("photo", new Set(["FACE"]))).toBe(false);
  });
  it("name / school / phone stay gated regardless", () => {
    const unlocked = new Set(["FACE", "AGE", "PROFESSION", "HEIGHT"] as const);
    expect(shouldGateBy("name", unlocked)).toBe(true);
    expect(shouldGateBy("school", unlocked)).toBe(true);
    expect(shouldGateBy("social", unlocked)).toBe(true);
    expect(shouldGateBy("phone", unlocked)).toBe(true);
    expect(shouldGateBy("location", unlocked)).toBe(true);
  });
});
