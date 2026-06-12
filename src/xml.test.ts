import { describe, expect, it } from "vitest";
import { createNode } from "./document";
import type { XmlNode } from "./types";
import {
  buildPreview,
  findDuplicateNodes,
  isValidXmlName,
  validateDocument
} from "./xml";

function node(tagName: string, overrides: Partial<XmlNode> = {}): XmlNode {
  return { ...createNode(tagName), ...overrides };
}

describe("buildPreview — forest rendering", () => {
  it("renders a single section with no separator", () => {
    const roots = [node("feedback", { textContent: "hi" })];
    const { xml, lines } = buildPreview(roots);
    expect(xml).toBe("<feedback>hi</feedback>");
    expect(lines.some((line) => line.kind === "separator")).toBe(false);
  });

  it("renders a padded tag name trimmed — renderNode's trim is load-bearing", () => {
    // Validation passes " feedback " (it validates the trimmed name),
    // so without renderNode's own trim the output would be the
    // malformed "< feedback >hi</ feedback >" with copy unblocked.
    const roots = [node(" feedback ", { textContent: "hi" })];
    expect(buildPreview(roots).xml).toBe("<feedback>hi</feedback>");
  });

  it("emits exactly one blank separator line between consecutive sections", () => {
    const roots = [node("a"), node("b"), node("c")];
    const { xml, lines } = buildPreview(roots);
    const separators = lines.filter((line) => line.kind === "separator");
    expect(separators).toHaveLength(roots.length - 1);
    expect(separators.every((line) => line.text === "")).toBe(true);
    expect(xml).toBe("<a/>\n\n<b/>\n\n<c/>");
  });

  it("keys each separator to the PRECEDING section's id and never marks it primary", () => {
    const roots = [node("a"), node("b"), node("c")];
    const { lines } = buildPreview(roots);
    const separators = lines.filter((line) => line.kind === "separator");
    expect(separators.map((line) => line.nodeId)).toEqual([
      roots[0].id,
      roots[1].id
    ]);
    expect(separators.every((line) => !line.primary)).toBe(true);
  });

  it("keeps (nodeId, kind) unique across mixed node shapes — the preview React-key contract", () => {
    // Exercises all five renderNode line kinds plus separators:
    // multi-line with text + nested children, single-line, self-closing.
    const roots = [
      node("outer", {
        textContent: "mixed",
        children: [node("inner", { textContent: "leaf" }), node("empty")]
      }),
      node("solo")
    ];
    const { lines } = buildPreview(roots);
    const keys = lines.map((line) => `${line.nodeId}-${line.kind}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("xml stays the join of line texts — the same-source invariant", () => {
    const roots = [node("a", { children: [node("b")] }), node("c")];
    const { xml, lines } = buildPreview(roots);
    expect(xml).toBe(lines.map((line) => line.text).join("\n"));
  });

  it("pins the multi-line shape: 2-space depth indent, text before children, aligned close tag", () => {
    const roots = [
      node("outer", {
        textContent: "lead",
        children: [
          node("inner", { textContent: "leaf" }),
          node("deep", { children: [node("empty")] })
        ]
      })
    ];
    expect(buildPreview(roots).xml).toBe(
      [
        "<outer>",
        "  lead",
        "  <inner>leaf</inner>",
        "  <deep>",
        "    <empty/>",
        "  </deep>",
        "</outer>"
      ].join("\n")
    );
  });
});

describe("validateDocument — forest walk", () => {
  it("accepts a forest of valid names", () => {
    const roots = [node("a", { children: [node("b")] }), node("c")];
    expect(validateDocument(roots)).toEqual([]);
  });

  it("flags invalid names in any tree, including non-first roots", () => {
    const bad = node("");
    const roots = [node("ok"), bad];
    expect(validateDocument(roots).map((issue) => issue.nodeId)).toEqual([
      bad.id
    ]);
  });

  it("flags an invalid name nested under valid ancestors — pins the recursive failure path", () => {
    const bad = node("two words");
    const roots = [node("ok", { children: [node("mid", { children: [bad] })] })];
    expect(validateDocument(roots).map((issue) => issue.nodeId)).toEqual([
      bad.id
    ]);
  });
});

describe("findDuplicateNodes — sibling groups", () => {
  it("flags same-name TOP-LEVEL sections (the roots array is a sibling group)", () => {
    const first = node("section");
    const second = node("section");
    const issues = findDuplicateNodes([first, second, node("other")]);
    expect(issues.map((issue) => issue.nodeId).sort()).toEqual(
      [first.id, second.id].sort()
    );
  });

  it("does not flag same names across levels", () => {
    const roots = [node("reply", { children: [node("reply")] })];
    expect(findDuplicateNodes(roots)).toEqual([]);
  });

  it("skips empty-named siblings (the validator owns those)", () => {
    const roots = [node(""), node("")];
    expect(findDuplicateNodes(roots)).toEqual([]);
  });

  it("flags nested duplicate siblings", () => {
    const twinA = node("twin");
    const twinB = node("twin");
    const roots = [node("parent", { children: [twinA, twinB] })];
    expect(findDuplicateNodes(roots).map((issue) => issue.nodeId).sort()).toEqual(
      [twinA.id, twinB.id].sort()
    );
  });
});

describe("isValidXmlName", () => {
  it("accepts ASCII, CJK, and underscore-led names", () => {
    expect(isValidXmlName("feedback")).toBe(true);
    expect(isValidXmlName("反馈")).toBe(true);
    expect(isValidXmlName("_private")).toBe(true);
  });

  it("accepts colon and mid-name NameChars (- . digits)", () => {
    expect(isValidXmlName("ns:tag")).toBe(true);
    expect(isValidXmlName("a-b.c1")).toBe(true);
  });

  it("accepts combining marks mid-name — the spec-mandated ranges behind the eslint disable", () => {
    // "e" + U+0301 COMBINING ACUTE ACCENT (NameChar via ̀-ͯ).
    expect(isValidXmlName("café")).toBe(true);
  });

  it("accepts supplementary-plane chars — the reason NAME_REGEX needs the u flag", () => {
    // U+20BB7 (CJK Ext B) sits in \u{10000}-\u{EFFFF}; without the u
    // flag the range is a syntax error / mis-parse.
    expect(isValidXmlName("\u{20BB7}tag")).toBe(true);
  });

  it("rejects empty, space-bearing, padded, and digit-led names", () => {
    expect(isValidXmlName("")).toBe(false);
    expect(isValidXmlName("two words")).toBe(false);
    expect(isValidXmlName(" padded ")).toBe(false);
    expect(isValidXmlName("1st")).toBe(false);
  });

  it("rejects a NameChar-only char in leading position", () => {
    // "-" is a NameChar but not a NameStartChar.
    expect(isValidXmlName("-x")).toBe(false);
  });

  it("pins the deliberate Latin-1 exclusion gaps × (U+00D7) and ÷ (U+00F7)", () => {
    // NameStartChar runs [#xC0-#xD6] | [#xD8-#xF6] | [#xF8-...]: the
    // multiplication and division signs are the two holes. Pinning both
    // sides of each hole catches a typo widening Ø-ö to
    // ×-÷, which every ASCII-only fixture would miss. Neither
    // sign is a NameChar mid-name either.
    expect(isValidXmlName("Ö")).toBe(true); // U+00D6 — last before hole 1
    expect(isValidXmlName("×")).toBe(false); // U+00D7 — hole 1
    expect(isValidXmlName("Ø")).toBe(true); // U+00D8 — first after hole 1
    expect(isValidXmlName("ö")).toBe(true); // U+00F6 — last before hole 2
    expect(isValidXmlName("÷")).toBe(false); // U+00F7 — hole 2
    expect(isValidXmlName("ø")).toBe(true); // U+00F8 — first after hole 2
    expect(isValidXmlName("a×b")).toBe(false);
  });

  it("pins the supplementary-plane upper bound at U+EFFFF", () => {
    expect(isValidXmlName("\u{EFFFF}")).toBe(true); // last valid
    expect(isValidXmlName("\u{F0000}")).toBe(false); // one past the range
  });
});
