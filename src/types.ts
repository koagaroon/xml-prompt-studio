export type XmlNode = {
  id: string;
  tagName: string;
  textContent: string;
  children: XmlNode[];
};

// `message` was dropped per v2 redesign Q4 — error text is no longer the
// signaling channel. Validation issues now drive the row-level red highlight
// + Tag Name input red border, both keyed off `nodeId`. The struct stays in
// case future per-issue metadata (severity, hint, etc.) is needed.
export type ValidationIssue = {
  nodeId: string;
};

export type NodeOutlineItem = {
  id: string;
  depth: number;
  label: string;
};

// `kind` distinguishes the structural role of each preview line so React
// can use a stable per-node-per-kind key. Without it, line indices renumber
// on every edit and the entire preview re-renders. `primary` is derivable
// from kind ("self-closing" | "single-line" | "open" are primary) but kept
// as a precomputed flag for hot-path checks in App.tsx.
//
// "separator" is the blank line between top-level sections, emitted by
// buildPreview (not renderNode) and keyed to the PRECEDING section's id —
// each section emits at most one trailing separator, preserving the
// (nodeId, kind) key uniqueness. The id is for key stability only; the
// line doesn't belong to that section visually and never paints active.
//
// `nodeId` is non-nullable: every line is tied to a concrete XmlNode
// (separators to the preceding top-level section). The earlier
// `string | null` type was defensive for a code path that doesn't exist.
export type PreviewLine = {
  text: string;
  nodeId: string;
  primary: boolean;
  kind: "self-closing" | "single-line" | "open" | "text" | "close" | "separator";
};
