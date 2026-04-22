import type { XmlNode } from "./types";

export function createId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createNode(tagName = "element"): XmlNode {
  return {
    id: createId("node"),
    tagName,
    textContent: "",
    children: []
  };
}

export function createBlankDocument(): XmlNode {
  return createNode("prompt");
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
  const movedChildren = root.children.map((child) => moveNode(child, targetId, direction));
  const index = movedChildren.findIndex((child) => child.id === targetId);

  if (index === -1) {
    return {
      ...root,
      children: movedChildren
    };
  }

  const nextIndex = index + direction;
  if (nextIndex < 0 || nextIndex >= movedChildren.length) {
    return {
      ...root,
      children: movedChildren
    };
  }

  const reordered = [...movedChildren];
  const [item] = reordered.splice(index, 1);
  reordered.splice(nextIndex, 0, item);

  return {
    ...root,
    children: reordered
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
