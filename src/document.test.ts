import { describe, expect, it } from "vitest";
import {
  createBlankDocument,
  createNode,
  deleteNode,
  findNode,
  findParent,
  moveNode,
  updateNode
} from "./document";
import type { XmlNode } from "./types";

// Hand-built fixture forest:
//   <alpha>            (top-level)
//     <child_a/>
//     <child_b>
//       <grandchild/>
//     </child_b>
//   <beta/>            (top-level)
function fixtureForest(): {
  roots: XmlNode[];
  alpha: XmlNode;
  beta: XmlNode;
  childA: XmlNode;
  childB: XmlNode;
  grandchild: XmlNode;
} {
  const grandchild = { ...createNode("grandchild") };
  const childA = { ...createNode("child_a") };
  const childB = { ...createNode("child_b"), children: [grandchild] };
  const alpha = { ...createNode("alpha"), children: [childA, childB] };
  const beta = { ...createNode("beta") };
  return { roots: [alpha, beta], alpha, beta, childA, childB, grandchild };
}

describe("createBlankDocument", () => {
  it("is a forest with exactly one <feedback> starter section", () => {
    const roots = createBlankDocument();
    expect(roots).toHaveLength(1);
    expect(roots[0].tagName).toBe("feedback");
    expect(roots[0].children).toEqual([]);
    expect(roots[0].textContent).toBe("");
  });
});

describe("updateNode", () => {
  it("applies the updater to a top-level section", () => {
    const { roots, beta } = fixtureForest();
    const next = updateNode(roots, beta.id, (node) => ({
      ...node,
      tagName: "renamed"
    }));
    expect(findNode(next, beta.id)?.tagName).toBe("renamed");
  });

  it("applies the updater to a nested node without touching siblings", () => {
    const { roots, grandchild, childA } = fixtureForest();
    const next = updateNode(roots, grandchild.id, (node) => ({
      ...node,
      textContent: "hello"
    }));
    expect(findNode(next, grandchild.id)?.textContent).toBe("hello");
    expect(findNode(next, childA.id)?.textContent).toBe("");
  });
});

describe("deleteNode", () => {
  it("deletes a top-level section, leaving the rest of the forest", () => {
    const { roots, alpha, beta } = fixtureForest();
    const next = deleteNode(roots, alpha.id);
    expect(next).toHaveLength(1);
    expect(next[0].id).toBe(beta.id);
  });

  it("deletes a nested node including its subtree", () => {
    const { roots, childB, grandchild } = fixtureForest();
    const next = deleteNode(roots, childB.id);
    expect(findNode(next, childB.id)).toBeNull();
    expect(findNode(next, grandchild.id)).toBeNull();
  });
});

describe("moveNode", () => {
  it("reorders top-level sections", () => {
    const { roots, alpha, beta } = fixtureForest();
    const next = moveNode(roots, beta.id, -1);
    expect(next.map((root) => root.id)).toEqual([beta.id, alpha.id]);
  });

  it("returns the SAME array reference when a top-level move hits the boundary", () => {
    const { roots, alpha } = fixtureForest();
    // alpha is first — moving it up has no swap target.
    expect(moveNode(roots, alpha.id, -1)).toBe(roots);
  });

  it("returns the same node references when a nested move hits the boundary", () => {
    const { roots, childB } = fixtureForest();
    // childB is the last child — moving it down has no swap target.
    const next = moveNode(roots, childB.id, 1);
    expect(next[0].children).toEqual(roots[0].children);
  });

  it("reorders nested siblings", () => {
    const { roots, alpha, childA, childB } = fixtureForest();
    const next = moveNode(roots, childB.id, -1);
    const movedParent = findNode(next, alpha.id);
    expect(movedParent?.children.map((child) => child.id)).toEqual([
      childB.id,
      childA.id
    ]);
  });
});

describe("findNode", () => {
  it("finds nodes in any tree of the forest", () => {
    const { roots, beta, grandchild } = fixtureForest();
    expect(findNode(roots, beta.id)?.id).toBe(beta.id);
    expect(findNode(roots, grandchild.id)?.id).toBe(grandchild.id);
    expect(findNode(roots, "missing")).toBeNull();
  });
});

describe("findParent", () => {
  it("returns null for top-level sections — callers treat the roots array as their sibling list", () => {
    const { roots, alpha, beta } = fixtureForest();
    expect(findParent(roots, alpha.id)).toBeNull();
    expect(findParent(roots, beta.id)).toBeNull();
  });

  it("returns the parent node for nested nodes", () => {
    const { roots, alpha, childB, grandchild } = fixtureForest();
    expect(findParent(roots, grandchild.id)?.id).toBe(childB.id);
    expect(findParent(roots, childB.id)?.id).toBe(alpha.id);
  });

  it("returns null for an unknown id", () => {
    const { roots } = fixtureForest();
    expect(findParent(roots, "missing")).toBeNull();
  });
});
