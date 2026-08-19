import type { PreviewLine, ValidationIssue, XmlNode } from "./types";

export function validateDocument(roots: XmlNode[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const walk = (node: XmlNode) => {
    const tagName = node.tagName.trim();
    // isValidXmlName alone decides — it rejects "" itself, so no
    // separate empty pre-check is needed.
    if (!isValidXmlName(tagName)) {
      issues.push({ nodeId: node.id });
    }

    node.children.forEach(walk);
  };

  roots.forEach(walk);
  return issues;
}

// Renders the forest: each top-level section at depth 0, with a blank
// separator line between consecutive sections (the standard multi-section
// prompt shape). The separator participates in `lines`, so the copied XML
// (join of line texts) and the on-screen preview remain projections of the
// same array — the same-source invariant survives the forest model.
export function buildPreview(roots: XmlNode[]): {
  xml: string;
  lines: PreviewLine[];
} {
  const lines: PreviewLine[] = [];

  roots.forEach((root, index) => {
    if (index > 0) {
      // Keyed to the PRECEDING section's id: each section emits at most
      // one trailing separator, so the (nodeId, kind) uniqueness that
      // App.tsx's React keys rely on holds. See PreviewLine in types.ts.
      lines.push({
        text: "",
        nodeId: roots[index - 1].id,
        primary: false,
        kind: "separator"
      });
    }
    lines.push(...renderNode(root, 0));
  });

  return {
    xml: lines.map((line) => line.text).join("\n"),
    lines
  };
}

// Each node emits at most one line per `kind`:
//   - "self-closing" alone (no children, no text)
//   - "single-line"  alone (no children, has text)
//   - "open" + optional "text" + zero or more child lines + "close"
// Invariant: at most one line per (nodeId, kind) tuple. App.tsx uses
// `${nodeId}-${kind}` as the React key for preview rows, so if a future
// change splits text across multiple lines (e.g., paragraph wrapping),
// that key uniqueness must be preserved — add a per-line index to the
// kind, don't just emit two `kind: "text"` lines for the same node.
function renderNode(node: XmlNode, depth: number): PreviewLine[] {
  const indent = "  ".repeat(depth);
  // This trim is LOAD-BEARING, not redundant next to validation:
  // validation passes " feedback " (it validates the trimmed name), so
  // removing it would emit malformed "< feedback >" with copy
  // unblocked. Pinned by test.
  const tagName = node.tagName.trim();
  // WYSIWYG: textContent is emitted verbatim. This is intentional — the tool
  // outputs LLM-prompt markup, not strict XML, so users can write `<` `>` `&`
  // and have them appear literally in the prompt. Don't reintroduce escaping
  // unless adding an explicit "strict mode" toggle.
  //
  // Caveat for future maintainers: a single PreviewLine.text can render
  // across multiple visual rows in two cases — (1) if textContent contains
  // "\n" (preserved by `white-space: pre-wrap` in styles.css), and (2) if
  // the line is long enough to wrap inside the preview column (also from
  // `pre-wrap` + `overflow-wrap: anywhere`). The "1 PreviewLine = 1 visual
  // row" assumption holds for short single-line content but breaks in both
  // cases above. Virtualization (e.g., react-window) can't be wired in
  // without first splitting newline-bearing text into one PreviewLine per
  // physical line and accounting for variable wrap heights, while
  // preserving the (nodeId, kind) key uniqueness above (likely by adding
  // a per-line index to kind).
  const textContent = node.textContent;

  // XML 1.0 §3.1 allows an empty element to use either `<x/>` or `<x></x>`.
  // Keep these branches separate because the app deliberately emits `<x/>`
  // only for nodes without text or children; this is a stable prompt-formatting
  // contract, not a semantic distinction between the two empty XML forms.
  if (node.children.length === 0 && textContent === "") {
    // Empty-element tag (production [44]): `<x/>`
    return [
      {
        text: `${indent}<${tagName}/>`,
        nodeId: node.id,
        primary: true,
        kind: "self-closing"
      }
    ];
  }

  if (node.children.length === 0) {
    // Start-tag + char data + end-tag, single line
    return [
      {
        text: `${indent}<${tagName}>${textContent}</${tagName}>`,
        nodeId: node.id,
        primary: true,
        kind: "single-line"
      }
    ];
  }

  // Start-tag + (optional char data) + child elements + end-tag, multi-line
  const lines: PreviewLine[] = [
    {
      text: `${indent}<${tagName}>`,
      nodeId: node.id,
      primary: true,
      kind: "open"
    }
  ];

  if (textContent !== "") {
    lines.push({
      text: `${indent}  ${textContent}`,
      nodeId: node.id,
      primary: false,
      kind: "text"
    });
  }

  node.children.forEach((child) => {
    lines.push(...renderNode(child, depth + 1));
  });

  lines.push({
    text: `${indent}</${tagName}>`,
    nodeId: node.id,
    primary: false,
    kind: "close"
  });

  return lines;
}

// W3C XML 1.0 Fifth Edition §2.3 Name production. Don't narrow this back to
// ASCII without an explicit product reason — broadening from v1's narrower
// regex was a deliberate decision so users can use Chinese/Greek/etc. tag
// names. Note: ":" is allowed per spec but is reserved for the XML Namespaces
// spec (a separate W3C Rec we explicitly do not parse). The "u" flag is
// required for the \u{10000}-\u{EFFFF} range syntax.
const NAME_START_CHAR =
  ":_A-Za-z" +
  "\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF" +
  "\\u0370-\\u037D\\u037F-\\u1FFF" +
  "\\u200C-\\u200D" +
  "\\u2070-\\u218F\\u2C00-\\u2FEF" +
  "\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD" +
  "\\u{10000}-\\u{EFFFF}";

const NAME_CHAR =
  NAME_START_CHAR + "\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040";

// The combining-mark ranges (̀-ͯ, ‿-⁀) are mandated by
// the W3C XML 1.0 §2.3 NameChar production. ESLint warns because such
// codepoints can produce visually-combined characters in a class; we accept
// that — spec conformance wins.
// eslint-disable-next-line no-misleading-character-class
const NAME_REGEX = new RegExp(`^[${NAME_START_CHAR}][${NAME_CHAR}]*$`, "u");

export function isValidXmlName(value: string): boolean {
  return NAME_REGEX.test(value);
}
