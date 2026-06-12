import { describe, expect, it } from "vitest";
import { createNode } from "./document";
import {
  MAX_PRESET_NAME_LENGTH,
  buildElementLabel,
  collectSubtreeIds,
  exceedsByteCap,
  formatMegabytes,
  insertAfter,
  nextAvailableSuffix,
  nextSelectionAfterDelete,
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

  // Full-equality asserts: the messages are user-facing return values of
  // known shape, so pin the interpolated values too (limit number, the
  // quoted name) — same strength as lib.rs's payload-message assert_eq.
  it("rejects empty", () => {
    expect(validatePresetName("", chips, -1)).toBe("Chip name cannot be empty.");
  });

  it("rejects names over the codepoint cap, at-limit passes", () => {
    expect(
      validatePresetName("a".repeat(MAX_PRESET_NAME_LENGTH), chips, -1)
    ).toBeNull();
    expect(
      validatePresetName("a".repeat(MAX_PRESET_NAME_LENGTH + 1), chips, -1)
    ).toBe(`Chip name too long (limit ${MAX_PRESET_NAME_LENGTH} characters).`);
  });

  it("rejects invalid XML names", () => {
    expect(validatePresetName("two words", chips, -1)).toBe(
      "Chip name must follow XML element naming rules."
    );
  });

  it("rejects case-insensitive duplicates for adds", () => {
    expect(validatePresetName("FEEDBACK", chips, -1)).toBe(
      '"FEEDBACK" is already in your preset list.'
    );
  });

  it("lets a rename keep (or re-case) its own slot via excludeIndex", () => {
    expect(validatePresetName("Feedback", chips, 0)).toBeNull();
    // ...but still rejects colliding with a DIFFERENT chip.
    expect(validatePresetName("question", chips, 0)).toBe(
      '"question" is already in your preset list.'
    );
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

  it("degrades to empty (never over-long output) for maxLength <= 0", () => {
    expect(truncate("anything", 0)).toBe("");
    // maxLength 1 keeps the output within the cap: just the ellipsis.
    expect(truncate("ab", 1)).toBe("…");
  });
});

describe("exceedsByteCap", () => {
  // The first two fixtures are short-circuit-ELIGIBLE (length×3 ≤ cap),
  // but the assertions pin only the boolean verdict — whether the cheap
  // path or TextEncoder produced it is an internal detail the titles
  // deliberately don't claim.
  it("returns false for clearly under-cap values", () => {
    expect(exceedsByteCap("abc", 9)).toBe(false);
  });

  it("returns false when length*3 equals the cap exactly", () => {
    // "中中中中" = 12 UTF-8 bytes, length 4 → 4×3 = 12 ≤ 12.
    expect(exceedsByteCap("中中中中", 12)).toBe(false);
  });

  it("measures precisely when the 3x bound cannot decide — both verdicts", () => {
    // "中中中a" = 10 UTF-8 bytes, length 4 → 4×3 = 12 > cap in both
    // cases, so the TextEncoder path must run and decide.
    expect(exceedsByteCap("中中中a", 10)).toBe(false); // exactly at cap
    expect(exceedsByteCap("中中中a", 9)).toBe(true); // one byte over
  });
});

describe("insertAfter", () => {
  it("inserts immediately after the anchor", () => {
    const [a, b] = siblings("a", "b");
    const fresh = createNode("fresh");
    expect(insertAfter([a, b], a.id, fresh).map((n) => n.tagName)).toEqual([
      "a",
      "fresh",
      "b"
    ]);
  });

  it("appends when the anchor is missing — the defensive fallback", () => {
    const [a, b] = siblings("a", "b");
    const fresh = createNode("fresh");
    expect(
      insertAfter([a, b], "missing", fresh).map((n) => n.tagName)
    ).toEqual(["a", "b", "fresh"]);
  });
});

describe("collectSubtreeIds", () => {
  it("returns the node itself and every descendant, nothing else", () => {
    const grandchild = createNode("g");
    const child = { ...createNode("c"), children: [grandchild] };
    const root = { ...createNode("r"), children: [child] };
    expect(collectSubtreeIds(root).sort()).toEqual(
      [root.id, child.id, grandchild.id].sort()
    );
  });
});

describe("nextSelectionAfterDelete", () => {
  const parentId = "parent-id";
  const fallbackId = "fallback-id";

  it("prefers the previous sibling", () => {
    const [a, b, c] = siblings("a", "b", "c");
    expect(nextSelectionAfterDelete([a, b, c], b.id, parentId, fallbackId)).toBe(
      a.id
    );
  });

  it("falls to the next sibling when deleting the first", () => {
    const [a, b] = siblings("a", "b");
    expect(nextSelectionAfterDelete([a, b], a.id, parentId, fallbackId)).toBe(
      b.id
    );
  });

  it("falls to the parent when deleting an only child", () => {
    const [only] = siblings("only");
    expect(nextSelectionAfterDelete([only], only.id, parentId, fallbackId)).toBe(
      parentId
    );
  });

  it("falls to fallbackId for an only child with no parent (null)", () => {
    const [only] = siblings("only");
    expect(nextSelectionAfterDelete([only], only.id, null, fallbackId)).toBe(
      fallbackId
    );
  });

  it("returns fallbackId when the deleted id is not in the list", () => {
    const [a] = siblings("a");
    expect(nextSelectionAfterDelete([a], "missing", parentId, fallbackId)).toBe(
      fallbackId
    );
  });
});

describe("buildElementLabel", () => {
  it("renders <tag> plus a truncated text preview", () => {
    const node = { ...createNode("reply"), textContent: "  hello world  " };
    expect(buildElementLabel(node)).toBe("<reply> hello world");
  });

  it("truncates long previews at 26 codepoints with an ellipsis", () => {
    const node = { ...createNode("reply"), textContent: "x".repeat(40) };
    expect(buildElementLabel(node)).toBe(`<reply> ${"x".repeat(25)}…`);
  });

  it("uses the unbracketed (empty tag) placeholder — same vocabulary as the Input title", () => {
    expect(buildElementLabel(createNode())).toBe("(empty tag)");
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
