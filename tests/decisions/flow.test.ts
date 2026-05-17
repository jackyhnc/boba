import { describe, it, expect } from "vitest";
import {
  parseDecisionKeyword,
  replyForOwnDecision,
  resolutionAnnouncement,
  resolve,
} from "../../src/decisions/flow.js";

describe("parseDecisionKeyword", () => {
  it("recognizes canonical keywords (case-insensitive)", () => {
    expect(parseDecisionKeyword("KEEP")).toBe("KEEP");
    expect(parseDecisionKeyword("keep")).toBe("KEEP");
    expect(parseDecisionKeyword("Maybe")).toBe("MAYBE");
    expect(parseDecisionKeyword("discard")).toBe("DISCARD");
  });
  it("recognizes short and synonym forms", () => {
    expect(parseDecisionKeyword("k")).toBe("KEEP");
    expect(parseDecisionKeyword("m")).toBe("MAYBE");
    expect(parseDecisionKeyword("d")).toBe("DISCARD");
    expect(parseDecisionKeyword("pass")).toBe("DISCARD");
    expect(parseDecisionKeyword("nope")).toBe("DISCARD");
  });
  it("rejects multi-word or partial-match phrases", () => {
    expect(parseDecisionKeyword("KEEP talking")).toBeNull();
    expect(parseDecisionKeyword("I think maybe")).toBeNull();
    expect(parseDecisionKeyword("hey")).toBeNull();
    expect(parseDecisionKeyword("")).toBeNull();
  });
  it("trims whitespace", () => {
    expect(parseDecisionKeyword("   keep   ")).toBe("KEEP");
  });
});

describe("resolve", () => {
  it("any DISCARD ends the match", () => {
    expect(resolve("DISCARD", "KEEP").outcome).toBe("ended_by_discard");
    expect(resolve("KEEP", "DISCARD").outcome).toBe("ended_by_discard");
    expect(resolve("DISCARD", "MAYBE").outcome).toBe("ended_by_discard");
    expect(resolve("DISCARD", null).outcome).toBe("ended_by_discard");
    expect(resolve(null, "DISCARD").outcome).toBe("ended_by_discard");
    expect(resolve("DISCARD", "DISCARD").outcome).toBe("ended_by_discard");
  });
  it("continues for non-discard combos", () => {
    expect(resolve("KEEP", "KEEP").outcome).toBe("continue");
    expect(resolve("KEEP", "MAYBE").outcome).toBe("continue");
    expect(resolve("MAYBE", "KEEP").outcome).toBe("continue");
    expect(resolve("MAYBE", "MAYBE").outcome).toBe("continue");
  });
  it("pending until both sides decide", () => {
    expect(resolve(null, null).outcome).toBe("pending");
    expect(resolve("KEEP", null).outcome).toBe("pending");
    expect(resolve(null, "MAYBE").outcome).toBe("pending");
  });
});

describe("copy helpers", () => {
  it("replyForOwnDecision is exhaustive", () => {
    expect(replyForOwnDecision("KEEP")).toMatch(/keep talking/i);
    expect(replyForOwnDecision("MAYBE")).toMatch(/open/i);
    expect(replyForOwnDecision("DISCARD")).toMatch(/match ended/i);
  });
  it("resolutionAnnouncement is exhaustive", () => {
    expect(resolutionAnnouncement("continue")).toMatch(/continues/i);
    expect(resolutionAnnouncement("ended_by_discard")).toMatch(/ended/i);
    expect(resolutionAnnouncement("pending")).toMatch(/ready/i);
  });
});
