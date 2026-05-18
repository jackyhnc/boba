import { describe, it, expect } from "vitest";
import {
  detectSmsKeyword,
  HELP_REPLY,
  START_ACK,
  STOP_ACK,
} from "../../src/safety/smsKeywords.js";

describe("detectSmsKeyword", () => {
  describe("STOP tokens", () => {
    const cases = [
      "STOP",
      "stop",
      "Stop",
      "STOPALL",
      "UNSUBSCRIBE",
      "Cancel",
      "END",
      "QUIT",
      "OPTOUT",
      "opt-out",
    ];
    for (const body of cases) {
      it(`recognises "${body}"`, () => {
        const r = detectSmsKeyword(body);
        expect(r.keyword).toBe("STOP");
      });
    }

    it("tolerates trailing punctuation", () => {
      expect(detectSmsKeyword("STOP.").keyword).toBe("STOP");
      expect(detectSmsKeyword("STOP!").keyword).toBe("STOP");
      expect(detectSmsKeyword("stop,").keyword).toBe("STOP");
    });

    it("honours STOP even when followed by descriptive text", () => {
      // CTIA spec: keyword-as-first-token counts.
      expect(detectSmsKeyword("STOP texting me").keyword).toBe("STOP");
      expect(detectSmsKeyword("stop please").keyword).toBe("STOP");
    });

    it("does not fire when STOP isn't the first token", () => {
      expect(detectSmsKeyword("please stop").keyword).toBeNull();
      expect(detectSmsKeyword("Don't stop believing").keyword).toBeNull();
      expect(detectSmsKeyword("I want you to STOP").keyword).toBeNull();
    });
  });

  describe("HELP tokens", () => {
    it("recognises HELP and INFO", () => {
      expect(detectSmsKeyword("HELP").keyword).toBe("HELP");
      expect(detectSmsKeyword("help").keyword).toBe("HELP");
      expect(detectSmsKeyword("Info").keyword).toBe("HELP");
    });

    it("doesn't match HELP inside a sentence", () => {
      expect(detectSmsKeyword("can you help me").keyword).toBeNull();
      expect(detectSmsKeyword("I need some help").keyword).toBeNull();
    });
  });

  describe("START tokens", () => {
    it("recognises START / UNSTOP / YES", () => {
      expect(detectSmsKeyword("START").keyword).toBe("START");
      expect(detectSmsKeyword("unstop").keyword).toBe("START");
      expect(detectSmsKeyword("YES").keyword).toBe("START");
    });

    it("returns the matched token verbatim", () => {
      expect(detectSmsKeyword("UnStop").token).toBe("UNSTOP");
    });
  });

  describe("non-keyword bodies", () => {
    it("returns null for normal conversation", () => {
      expect(detectSmsKeyword("hi how are you").keyword).toBeNull();
      expect(detectSmsKeyword("KEEP").keyword).toBeNull();
      expect(detectSmsKeyword("DISCARD").keyword).toBeNull();
      expect(detectSmsKeyword("REPORT harassment").keyword).toBeNull();
    });

    it("returns null for empty / whitespace bodies", () => {
      expect(detectSmsKeyword("").keyword).toBeNull();
      expect(detectSmsKeyword("   ").keyword).toBeNull();
      expect(detectSmsKeyword("\n\t").keyword).toBeNull();
    });
  });

  describe("compliance reply copy", () => {
    it("STOP_ACK includes the START re-opt-in instruction", () => {
      expect(STOP_ACK).toMatch(/start/i);
    });

    it("HELP_REPLY includes STOP, msg-rates language, and program name", () => {
      expect(HELP_REPLY).toMatch(/stop/i);
      expect(HELP_REPLY).toMatch(/msg.*data rates/i);
      expect(HELP_REPLY).toMatch(/boba/i);
    });

    it("START_ACK confirms opt-in", () => {
      expect(START_ACK).toMatch(/opted back in/i);
    });
  });
});
