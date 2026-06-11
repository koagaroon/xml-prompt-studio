import { describe, expect, it } from "vitest";
import { createNode } from "./document";
import {
  MAX_PRESET_NAME_LENGTH,
  exceedsByteCap,
  formatMegabytes,
  nextAvailableSuffix,
  truncate,
  validatePresetName
} from "./helpers";
import type { XmlNode } from "./types";

function siblings(...tagNames: string[]): XmlNode[] {
  return tagNames.map((tagName) => createNode(tagName));
}

describe("nextAvailableSuffix", () => {
  it("returns 1 when no sibling uses the base name", () => {
    expect(nextAvailableSuffix(siblings("other", "misc"), "feedback")).toBe(1);
  });

  it("fills the lowest gap in the used set", () => {
    expect(
      nextAvailableSuffix(
        siblings("feedback_1", "feedback_3"),
        "feedback"
      )
    ).toBe(2);
  });

  it("advances past a contiguous run", () => {
    expect(
      nextAvailableSuffix(
        siblings("feedback_1", "feedback_2", "feedback_3"),
        "feedback"
      )
    ).toBe(4);
  });

  it("rejects leading-zero suffixes — feedback_001 does NOT occupy slot 1", () => {
    expect(nextAvailableSuffix(siblings("feedback_001"), "feedback")).toBe(1);
  });

  it("ignores non-matching shapes (_0, _x, bare name, prefix-only)", () => {
    expect(
      nextAvailableSuffix(
        siblings("feedback_0", "feedback_x", "feedback", "feedback_1extra"),
        "feedback"
      )
    ).toBe(1);
  });

  it("treats regex metacharacters in the base name literally", () => {
    // "a.b" must not match "axb_1" via an unescaped dot.
    expect(nextAvailableSuffix(siblings("axb_1"), "a.b")).toBe(1);
    expect(nextAvailableSuffix(siblings("a.b_1"), "a.b")).toBe(2);
  });

  it("matches against trimmed sibling names", () => {
    expect(nextAvailableSuffix(siblings(" feedback_1 "), "feedback")).toBe(2);
  });
});

describe("validatePresetName", () => {
  const chips = ["feedback", "question"];

  it("accepts a fresh valid name", () => {
    expect(validatePresetName("context", chips, -1)).toBeNull();
  });

  it("rejects empty", () => {
    expect(validatePresetName("", chips, -1)).toMatch(/empty/);
  });

  it("rejects names over the codepoint cap, at-limit passes", () => {
    expect(
      validatePresetName("a".repeat(MAX_PRESET_NAME_LENGTH), chips, -1)
    ).toBeNull();
    expect(
      validatePresetName("a".repeat(MAX_PRESET_NAME_LENGTH + 1), chips, -1)
    ).toMatch(/too long/);
  });

  it("rejects invalid XML names", () => {
    expect(validatePresetName("two words", chips, -1)).toMatch(/naming rules/);
  });

  it("rejects case-insensitive duplicates for adds", () => {
    expect(validatePresetName("FEEDBACK", chips, -1)).toMatch(/already in/);
  });

  it("lets a rename keep (or re-case) its own slot via excludeIndex", () => {
    expect(validatePresetName("Feedback", chips, 0)).toBeNull();
    // ...but still rejects colliding with a DIFFERENT chip.
    expect(validatePresetName("question", chips, 0)).toMatch(/already in/);
  });
});

describe("truncate", () => {
  it("returns short values unchanged", () => {
    expect(truncate("short", 10)).toBe("short");
  });

  it("passes a value exactly at the cap through unchanged", () => {
    expect(truncate("abcde", 5)).toBe("abcde");
  });

  it("truncates one-over-cap to cap length with a trailing ellipsis", () => {
    expect(truncate("abcdef", 5)).toBe("abcd…");
  });

  it("counts codepoints, not UTF-16 units — no orphan surrogates", () => {
    // Five crabs = 5 codepoints (10 UTF-16 units); cap 4 keeps 3 + "…".
    expect(truncate("🦀🦀🦀🦀🦀", 4)).toBe("🦀🦀🦀…");
  });
});

describe("exceedsByteCap", () => {
  it("accepts under-cap values on the cheap short-circuit", () => {
    expect(exceedsByteCap("abc", 9)).toBe(false);
  });

  it("measures precisely when the 3x bound cannot decide", () => {
    // "中" = 3 UTF-8 bytes; 4 chars = 12 bytes. length*3 = 12 > 11, so
    // the TextEncoder path runs and must reject.
    expect(exceedsByteCap("中中中中", 11)).toBe(true);
    // 12 bytes against a 12-byte cap is exactly at the limit — allowed.
    expect(exceedsByteCap("中中中中", 12)).toBe(false);
  });
});

describe("formatMegabytes", () => {
  it("drops the decimal for integral MB values", () => {
    expect(formatMegabytes(50_000_000)).toBe("50 MB");
    expect(formatMegabytes(10_000_000)).toBe("10 MB");
  });

  it("keeps one decimal otherwise", () => {
    expect(formatMegabytes(52_428_801)).toBe("52.4 MB");
  });
});
