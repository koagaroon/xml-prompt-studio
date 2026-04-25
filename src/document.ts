import type { XmlNode } from "./types";

export function createId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
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

export function findParentId(root: XmlNode, targetId: string): string | null {
  for (const child of root.children) {
    if (child.id === targetId) {
      return root.id;
    }

    const nestedResult = findParentId(child, targetId);
    if (nestedResult) {
      return nestedResult;
    }
  }

  return null;
}
