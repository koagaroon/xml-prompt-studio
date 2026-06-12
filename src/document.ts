import type { XmlNode } from "./types";

// One-shot flag so the Math.random fallback warning fires at most once per
// session — the first occurrence is the diagnostic signal; repetition would
// just spam the console.
let mathRandomFallbackWarned = false;

function createId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  if (!mathRandomFallbackWarned) {
    mathRandomFallbackWarned = true;
    // Tauri 2 webview always provides crypto.randomUUID, so reaching this
    // path means an environment-probe regression worth investigating.
    // Math.random gives ~41 bits of entropy — birthday-collision risk
    // emerges around ~1.5M IDs in a single document, at which point
    // findNode / findParent could mis-resolve to the first matching id.
    console.warn(
      "createId: crypto.randomUUID unavailable; using Math.random fallback"
    );
  }
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

// Default tagName is empty for new children/siblings — the user fills it in
// (or clicks a preset chip). Empty tag triggers validation red border, which
// is the intended cue to "name this element".
export function createNode(tagName = ""): XmlNode {
  return {
    id: createId("node"),
    tagName,
    textContent: "",
    children: []
  };
}

// The document is a forest (XmlNode[]): top-level sections are siblings
// with no wrapper element, matching the standard multi-section prompt
// shape (<instructions> / <context> / <input> side by side). A blank
// document starts as a single `<feedback>` section — the familiar starting
// point — and the user adds top-level siblings from there.
export function createBlankDocument(): XmlNode[] {
  return [createNode("feedback")];
}

export function updateNode(
  roots: XmlNode[],
  targetId: string,
  updater: (node: XmlNode) => XmlNode
): XmlNode[] {
  return roots.map((root) => updateNodeInTree(root, targetId, updater));
}

function updateNodeInTree(
  node: XmlNode,
  targetId: string,
  updater: (node: XmlNode) => XmlNode
): XmlNode {
  if (node.id === targetId) {
    return updater(node);
  }

  return {
    ...node,
    children: node.children.map((child) =>
      updateNodeInTree(child, targetId, updater)
    )
  };
}

// Deletes the node with `targetId` anywhere in the forest; top-level
// sections are legal targets. The min-one-section invariant lives in the
// caller — deleting the LAST remaining top-level section routes through
// App's reset-to-blank path and never reaches this function.
export function deleteNode(roots: XmlNode[], targetId: string): XmlNode[] {
  return roots
    .filter((root) => root.id !== targetId)
    .map((root) => deleteNodeInTree(root, targetId));
}

function deleteNodeInTree(node: XmlNode, targetId: string): XmlNode {
  return {
    ...node,
    children: node.children
      .filter((child) => child.id !== targetId)
      .map((child) => deleteNodeInTree(child, targetId))
  };
}

export function moveNode(
  roots: XmlNode[],
  targetId: string,
  direction: -1 | 1
): XmlNode[] {
  // Target is a top-level section — reorder the forest itself.
  const topIndex = roots.findIndex((root) => root.id === targetId);
  if (topIndex !== -1) {
    return reorder(roots, topIndex, direction);
  }

  // An id matching nothing falls through to a fully cloned no-op — the
  // same clone-always shape as updateNode/deleteNode, deliberately NOT
  // reorder's same-reference contract for boundary no-ops. App's canMove
  // guard keeps the missing-id case unreachable in practice.
  return roots.map((root) => moveNodeInTree(root, targetId, direction));
}

function moveNodeInTree(
  node: XmlNode,
  targetId: string,
  direction: -1 | 1
): XmlNode {
  // First check if the target is a direct child — common case. If so, swap
  // locally and return without recursing into grandchildren, saving a tree
  // walk per move.
  const localIndex = node.children.findIndex((child) => child.id === targetId);
  if (localIndex !== -1) {
    const reordered = reorder(node.children, localIndex, direction);
    if (reordered === node.children) {
      return node;
    }
    return {
      ...node,
      children: reordered
    };
  }

  // Target is not a direct child — recurse into descendants.
  return {
    ...node,
    children: node.children.map((child) =>
      moveNodeInTree(child, targetId, direction)
    )
  };
}

// Shifts the item at `index` by one position. Returns the SAME array
// reference when the move would fall off either end — callers use that
// reference equality to skip cloning on no-op moves.
function reorder<T>(items: T[], index: number, direction: -1 | 1): T[] {
  const nextIndex = index + direction;
  if (nextIndex < 0 || nextIndex >= items.length) {
    return items;
  }
  const next = [...items];
  const [item] = next.splice(index, 1);
  next.splice(nextIndex, 0, item);
  return next;
}

export function findNode(roots: XmlNode[], targetId: string): XmlNode | null {
  for (const root of roots) {
    const result = findNodeInTree(root, targetId);
    if (result) {
      return result;
    }
  }

  return null;
}

function findNodeInTree(node: XmlNode, targetId: string): XmlNode | null {
  if (node.id === targetId) {
    return node;
  }

  for (const child of node.children) {
    const result = findNodeInTree(child, targetId);
    if (result) {
      return result;
    }
  }

  return null;
}

// Returns the parent NODE (not just the id), so callers don't need a
// follow-up findNode lookup to read fields off the parent. Returns null
// if `targetId` is a top-level section (no parent in the forest) or if
// no node with `targetId` exists — callers treat null as "top-level"
// and use the roots array as the sibling list.
export function findParent(roots: XmlNode[], targetId: string): XmlNode | null {
  for (const root of roots) {
    const result = findParentInTree(root, targetId);
    if (result) {
      return result;
    }
  }

  return null;
}

function findParentInTree(node: XmlNode, targetId: string): XmlNode | null {
  for (const child of node.children) {
    if (child.id === targetId) {
      return node;
    }

    const result = findParentInTree(child, targetId);
    if (result) {
      return result;
    }
  }

  return null;
}
