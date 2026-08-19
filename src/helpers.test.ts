import { describe, expect, it } from "vitest";
import { createNode } from "./document";
import {
  ELEMENT_LABEL_PREVIEW_LENGTH,
  MAX_PRESET_CHIPS,
  MAX_PRESET_NAME_LENGTH,
  MAX_XML_BYTES,
  buildElementLabel,
  capCodePoints,
  collectSubtreeIds,
  exceedsByteCap,
  formatMegabytes,
  getCopyReadiness,
  hasLoneSurrogate,
  insertAfter,
  nextAvailableSuffix,
  nextSelectionAfterDelete,
  salvagePresetChips,
  truncate,
  validatePresetName,
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
    expect(nextAvailableSuffix(siblings("feedback_1", "feedback_3"), "feedback")).toBe(2);
  });

  it("advances past a contiguous run", () => {
    expect(
      nextAvailableSuffix(siblings("feedback_1", "feedback_2", "feedback_3"), "feedback")
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
    expect(validatePresetName("a".repeat(MAX_PRESET_NAME_LENGTH), chips, -1)).toBeNull();
    expect(validatePresetName("a".repeat(MAX_PRESET_NAME_LENGTH + 1), chips, -1)).toBe(
      `Chip name too long (limit ${MAX_PRESET_NAME_LENGTH} characters).`
    );
  });

  it("counts supplementary-plane XML names by code point, not UTF-16 units", () => {
    const extBNameChar = "\u{20000}";
    expect(validatePresetName(extBNameChar.repeat(MAX_PRESET_NAME_LENGTH), chips, -1)).toBeNull();
    expect(validatePresetName(extBNameChar.repeat(MAX_PRESET_NAME_LENGTH + 1), chips, -1)).toBe(
      `Chip name too long (limit ${MAX_PRESET_NAME_LENGTH} characters).`
    );
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
  });

  it("still rejects a rename that collides with a DIFFERENT chip", () => {
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
    expect(truncate("anything", -3)).toBe("");
  });

  it("yields a bare ellipsis at maxLength 1 — cap minus the reserved slot is zero", () => {
    expect(truncate("ab", 1)).toBe("…");
  });
});

describe("capCodePoints", () => {
  it("caps by code point without splitting supplementary characters", () => {
    expect(capCodePoints("𠀀𠀁𠀂", 2)).toBe("𠀀𠀁");
  });

  it("passes a value exactly at the cap through unchanged", () => {
    expect(capCodePoints("𠀀𠀁", 2)).toBe("𠀀𠀁");
  });

  it("returns the input unchanged when it is within the cap", () => {
    expect(capCodePoints("feedback", MAX_PRESET_NAME_LENGTH)).toBe("feedback");
  });

  it("degrades to empty for maxLength <= 0", () => {
    expect(capCodePoints("anything", 0)).toBe("");
    expect(capCodePoints("anything", -3)).toBe("");
  });

  it("still caps under a non-integer maxLength — >= guard, not strict equality", () => {
    // A 2.5 cap can never be hit by === since count is integral; the
    // >= comparison makes the helper degrade like truncate instead of
    // returning the input uncapped.
    expect(capCodePoints("abcdef", 2.5)).toBe("abc");
  });
});

describe("hasLoneSurrogate", () => {
  it("accepts plain text and well-formed surrogate pairs", () => {
    expect(hasLoneSurrogate("")).toBe(false);
    expect(hasLoneSurrogate("plain ascii")).toBe(false);
    expect(hasLoneSurrogate("中🦀中")).toBe(false);
  });

  it("flags a lone high surrogate in every position — including trailing", () => {
    expect(hasLoneSurrogate("\uD800")).toBe(true);
    expect(hasLoneSurrogate("a\uD800b")).toBe(true);
    // The trailing case pins the charCodeAt(length) → NaN reliance:
    // NaN fails the low-surrogate range check, so a final high
    // surrogate must still be flagged.
    expect(hasLoneSurrogate("ab\uD800")).toBe(true);
  });

  it("flags a lone low surrogate — leading, mid, and after a valid pair", () => {
    expect(hasLoneSurrogate("\uDC00ab")).toBe(true);
    expect(hasLoneSurrogate("a\uDC00b")).toBe(true);
    expect(hasLoneSurrogate("🦀\uDC00")).toBe(true);
  });

  it("flags doubled high surrogates (high followed by high)", () => {
    expect(hasLoneSurrogate("\uD800𐀀")).toBe(true);
  });
});

describe("salvagePresetChips", () => {
  it("returns a fully valid list as-is, order preserved", () => {
    expect(salvagePresetChips(["feedback", "reply"])).toEqual(["feedback", "reply"]);
  });

  it("preserves a stored empty list — the user's deliberate empty state", () => {
    expect(salvagePresetChips([])).toEqual([]);
  });

  it("returns null for non-array shapes", () => {
    expect(salvagePresetChips(null)).toBeNull();
    expect(salvagePresetChips("feedback")).toBeNull();
    expect(salvagePresetChips({ 0: "feedback" })).toBeNull();
  });

  it("skips invalid entries and keeps the valid subset in order", () => {
    expect(salvagePresetChips(["feedback", "two words", 42, "reply"])).toEqual([
      "feedback",
      "reply",
    ]);
  });

  it("drops case-insensitive duplicates of earlier accepted chips", () => {
    expect(salvagePresetChips(["feedback", "FEEDBACK", "reply"])).toEqual(["feedback", "reply"]);
  });

  it("returns null when a non-empty list salvages to nothing", () => {
    expect(salvagePresetChips(["two words", ""])).toBeNull();
  });

  it("keeps the first MAX_PRESET_CHIPS valid entries on over-count", () => {
    // A past app version with a HIGHER chip cap is exactly the salvage
    // rationale — over-count must trim, not discard the whole list.
    const stored = ["a", "b", "c", "d", "e", "f", "g", "h"];
    expect(salvagePresetChips(stored)).toEqual(stored.slice(0, MAX_PRESET_CHIPS));
  });

  it("rejects entries over the UTF-16 pre-check bound", () => {
    expect(salvagePresetChips(["a".repeat(MAX_PRESET_NAME_LENGTH * 2 + 1)])).toBeNull();
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
    expect(insertAfter([a, b], a.id, fresh).map((n) => n.tagName)).toEqual(["a", "fresh", "b"]);
  });

  it("inserts at the end when the anchor is the last element", () => {
    // Pins the index + 1 === length seam (found-anchor append), distinct
    // from the missing-anchor fallback below.
    const [a, b] = siblings("a", "b");
    const fresh = createNode("fresh");
    expect(insertAfter([a, b], b.id, fresh).map((n) => n.tagName)).toEqual(["a", "b", "fresh"]);
  });

  it("appends when the anchor is missing — the defensive fallback", () => {
    const [a, b] = siblings("a", "b");
    const fresh = createNode("fresh");
    expect(insertAfter([a, b], "missing", fresh).map((n) => n.tagName)).toEqual([
      "a",
      "b",
      "fresh",
    ]);
  });
});

describe("collectSubtreeIds", () => {
  it("returns the node itself and every descendant, nothing else", () => {
    const grandchild = createNode("g");
    const child = { ...createNode("c"), children: [grandchild] };
    const root = { ...createNode("r"), children: [child] };
    expect(collectSubtreeIds(root).sort()).toEqual([root.id, child.id, grandchild.id].sort());
  });
});

describe("nextSelectionAfterDelete", () => {
  const parentId = "parent-id";
  const fallbackId = "fallback-id";

  it("prefers the previous sibling", () => {
    const [a, b, c] = siblings("a", "b", "c");
    expect(nextSelectionAfterDelete([a, b, c], b.id, parentId, fallbackId)).toBe(a.id);
  });

  it("falls to the next sibling when deleting the first", () => {
    const [a, b] = siblings("a", "b");
    expect(nextSelectionAfterDelete([a, b], a.id, parentId, fallbackId)).toBe(b.id);
  });

  it("falls to the parent when deleting an only child", () => {
    const [only] = siblings("only");
    expect(nextSelectionAfterDelete([only], only.id, parentId, fallbackId)).toBe(parentId);
  });

  it("falls to fallbackId for an only child with no parent (null)", () => {
    const [only] = siblings("only");
    expect(nextSelectionAfterDelete([only], only.id, null, fallbackId)).toBe(fallbackId);
  });

  it("returns fallbackId when the deleted id is not in the list", () => {
    const [a] = siblings("a");
    expect(nextSelectionAfterDelete([a], "missing", parentId, fallbackId)).toBe(fallbackId);
  });
});

describe("buildElementLabel", () => {
  it("renders <tag> plus a truncated text preview", () => {
    const node = { ...createNode("reply"), textContent: "  hello world  " };
    expect(buildElementLabel(node)).toBe("<reply> hello world");
  });

  it("passes a preview exactly at the cap through unchanged", () => {
    const node = {
      ...createNode("reply"),
      textContent: "x".repeat(ELEMENT_LABEL_PREVIEW_LENGTH),
    };
    expect(buildElementLabel(node)).toBe(`<reply> ${"x".repeat(ELEMENT_LABEL_PREVIEW_LENGTH)}`);
  });

  it("truncates an over-cap preview to the cap with an ellipsis", () => {
    const node = { ...createNode("reply"), textContent: "x".repeat(40) };
    expect(buildElementLabel(node)).toBe(
      `<reply> ${"x".repeat(ELEMENT_LABEL_PREVIEW_LENGTH - 1)}…`
    );
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

  it("rounds fractional values UP to the next 0.1 MB — never down", () => {
    // One byte over a limit must display over it, not equal to it.
    expect(formatMegabytes(50_000_001)).toBe("50.1 MB");
    // 1.44 MB → 1.5, distinguishing ceil from round-to-nearest (1.4)
    // and truncation (1.4).
    expect(formatMegabytes(1_440_000)).toBe("1.5 MB");
  });

  it("keeps exact tenths as-is and handles sub-0.1-MB values", () => {
    expect(formatMegabytes(1_200_000)).toBe("1.2 MB");
    expect(formatMegabytes(1)).toBe("0.1 MB");
    expect(formatMegabytes(0)).toBe("0 MB");
  });
});

describe("getCopyReadiness", () => {
  const readyInput = {
    copyInFlight: false,
    previewPending: false,
    validationIssueCount: 0,
    xml: "<feedback/>",
    maxBytes: 100,
  };

  it("refuses stale preview before considering validation or payload size", () => {
    expect(
      getCopyReadiness({
        ...readyInput,
        previewPending: true,
        validationIssueCount: 1,
        xml: "x".repeat(101),
      })
    ).toEqual({ ready: false, reason: "preview-pending" });
  });

  it("refuses overlapping copy before stale-preview checks", () => {
    expect(
      getCopyReadiness({
        ...readyInput,
        copyInFlight: true,
        previewPending: true,
      })
    ).toEqual({ ready: false, reason: "busy" });
  });

  it("refuses validation issues and oversize payloads after preview is current", () => {
    expect(getCopyReadiness({ ...readyInput, validationIssueCount: 1 })).toEqual({
      ready: false,
      reason: "validation",
    });
    expect(getCopyReadiness({ ...readyInput, xml: "x".repeat(101) })).toEqual({
      ready: false,
      reason: "too-large",
    });
  });

  it("reports validation before too-large when both apply", () => {
    // Pins the relative priority of the last two gates — a reorder
    // would pass every single-gate fixture above.
    expect(
      getCopyReadiness({
        ...readyInput,
        validationIssueCount: 1,
        xml: "x".repeat(101),
      })
    ).toEqual({ ready: false, reason: "validation" });
  });

  it("defaults maxBytes to MAX_XML_BYTES when omitted — both verdicts", () => {
    const omitted = {
      copyInFlight: false,
      previewPending: false,
      validationIssueCount: 0,
    };
    expect(getCopyReadiness({ ...omitted, xml: "<feedback/>" })).toEqual({
      ready: true,
    });
    // The over-limit counter-fixture pins that the default is the real
    // shared cap, not something looser (e.g. MAX_SAFE_INTEGER). One
    // 50 MB ASCII string, single-shot — acceptable test cost.
    expect(getCopyReadiness({ ...omitted, xml: "x".repeat(MAX_XML_BYTES + 1) })).toEqual({
      ready: false,
      reason: "too-large",
    });
  });

  it("allows copy only when no guard blocks it", () => {
    expect(getCopyReadiness(readyInput)).toEqual({ ready: true });
  });
});
