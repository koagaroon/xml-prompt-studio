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
export type PreviewLineKind =
  "self-closing" | "single-line" | "open" | `text-${number}` | "close" | "separator";

export type PreviewLine = {
  text: string;
  nodeId: string;
  primary: boolean;
  kind: PreviewLineKind;
};

// Message strip shown at the bottom of the Input column. A monotonic `id`
// remounts the `role="alert"` region on repeated identical refusals so
// assistive technology re-announces each blocked action.
// `forNodeId`: non-null scopes the message to one element; null = global.
export type StripMessage = {
  id: number;
  text: string;
  severity: "error" | "warning";
  forNodeId: string | null;
};

// Element-scoped warning rendered directly below its own form control.
export type FieldMessage = {
  text: string;
  forNodeId: string;
};

// Shared confirmation-dialog descriptor for destructive actions.
export type ConfirmRequest = {
  title: string;
  description: string;
  confirmLabel: string;
  confirmKind?: "danger";
  onConfirm: () => void;
};

// Single modal slot so confirmation prompts and the offline license viewer can
// never stay open simultaneously, and modal-to-modal replacements carry a new
// `id` that resets safe initial focus onto Cancel/Close.
export type ModalState =
  { kind: "confirm"; id: number; request: ConfirmRequest } | { kind: "notices"; id: number } | null;
