export type XmlNode = {
  id: string;
  tagName: string;
  textContent: string;
  children: XmlNode[];
};

export type ValidationIssue = {
  nodeId: string;
  message: string;
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
