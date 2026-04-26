import type { XmlNode } from "./types";

// One-shot flag so the Math.random fallback warning fires at most once per
// session — the first occurrence is the diagnostic signal; repetition would
// just spam the console.
let mathRandomFallbackWarned = false;

export function createId(prefix: string): string {
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

// Blank document starts with `<feedback>` as the root tag — matches the most
// common usage of this tool (composing feedback / prompts to send to LLMs).
// Spec §2.1: exactly one root element. Don't seed with multiple roots.
export function createBlankDocument(): XmlNode {
  return createNode("feedback");
}

export function updateNode(
  root: XmlNode,
  targetId: string,
  updater: (node: XmlNode) => XmlNode
): XmlNode {
  if (root.id === targetId) {
    return updater(root);
  }

  return {
    ...root,
    children: root.children.map((child) => updateNode(child, targetId, updater))
  };
}

// Deletes the node with `targetId` from `root`'s subtree. Caller must
// ensure targetId ≠ root.id — root cannot delete itself, and calling with
// the root id returns a clone of root with no deletion. Spec §2.1 (exactly
// one root element) is the reason; "wipe to blank" routes through New
// Blank, not Delete.
export function deleteNode(root: XmlNode, targetId: string): XmlNode {
  return {
    ...root,
    children: root.children
      .filter((child) => child.id !== targetId)
      .map((child) => deleteNode(child, targetId))
  };
}

export function moveNode(root: XmlNode, targetId: string, direction: -1 | 1): XmlNode {
  // First check if the target is a direct child of root — common case for
  // top-level moves. If so, swap locally and return without recursing into
  // grandchildren, saving a tree walk per move.
  const localIndex = root.children.findIndex((child) => child.id === targetId);
  if (localIndex !== -1) {
    const nextIndex = localIndex + direction;
    if (nextIndex < 0 || nextIndex >= root.children.length) {
      return root;
    }
    const reordered = [...root.children];
    const [item] = reordered.splice(localIndex, 1);
    reordered.splice(nextIndex, 0, item);
    return {
      ...root,
      children: reordered
    };
  }

  // Target is not a direct child — recurse into descendants.
  return {
    ...root,
    children: root.children.map((child) => moveNode(child, targetId, direction))
  };
}

export function findNode(root: XmlNode, targetId: string): XmlNode | null {
  if (root.id === targetId) {
    return root;
  }

  for (const child of root.children) {
    const result = findNode(child, targetId);
    if (result) {
      return result;
    }
  }

  return null;
}

// Returns the parent NODE (not just the id), so callers don't need a
// follow-up findNode lookup to read fields off the parent. Returns null
// if `targetId` is the root (root has no parent in the tree) or if no
// node with `targetId` exists.
export function findParent(root: XmlNode, targetId: string): XmlNode | null {
  for (const child of root.children) {
    if (child.id === targetId) {
      return root;
    }

    const result = findParent(child, targetId);
    if (result) {
      return result;
    }
  }

  return null;
}
