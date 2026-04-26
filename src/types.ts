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
  duplicate: boolean;
};

// `kind` distinguishes the structural role of each preview line so React
// can use a stable per-node-per-kind key. Without it, line indices renumber
// on every edit and the entire preview re-renders. `primary` is derivable
// from kind ("self-closing" | "single-line" | "open" are primary) but kept
// as a precomputed flag for hot-path checks in App.tsx.
//
// `nodeId` is non-nullable: every line renderNode emits is tied to a
// concrete XmlNode. The earlier `string | null` type was defensive for
// a code path that doesn't exist.
export type PreviewLine = {
  text: string;
  nodeId: string;
  primary: boolean;
  kind: "self-closing" | "single-line" | "open" | "text" | "close";
};
