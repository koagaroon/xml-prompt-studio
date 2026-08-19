import { describe, expect, it } from "vitest";
import {
  createBlankDocument,
  createNode,
  deleteNode,
  findNode,
  findParent,
  moveNode,
  updateNode,
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
  const grandchild = createNode("grandchild");
  const childA = createNode("child_a");
  const childB = { ...createNode("child_b"), children: [grandchild] };
  const alpha = { ...createNode("alpha"), children: [childA, childB] };
  const beta = createNode("beta");
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
      tagName: "renamed",
    }));
    expect(findNode(next, beta.id)?.tagName).toBe("renamed");
  });

  it("applies the updater to a nested node without touching siblings", () => {
    const { roots, grandchild, childA } = fixtureForest();
    const next = updateNode(roots, grandchild.id, (node) => ({
      ...node,
      textContent: "hello",
    }));
    expect(findNode(next, grandchild.id)?.textContent).toBe("hello");
    expect(findNode(next, childA.id)?.textContent).toBe("");
  });

  it("returns a fully cloned structural no-op when the id matches nothing", () => {
    // Pins the clone-always shape moveNode's missing-id test cites as
    // its reference contract — without this, a short-circuit refactor
    // here would break that citation with zero failures.
    const { roots } = fixtureForest();
    const next = updateNode(roots, "missing-id", (node) => ({
      ...node,
      tagName: "never-applied",
    }));
    expect(next).not.toBe(roots);
    expect(next[0]).not.toBe(roots[0]);
    expect(next).toEqual(roots);
  });
});

describe("deleteNode", () => {
  it("deletes a top-level section, leaving the rest of the forest", () => {
    const { roots, alpha, beta } = fixtureForest();
    const next = deleteNode(roots, alpha.id);
    expect(next).toHaveLength(1);
    expect(next[0].id).toBe(beta.id);
  });

  it("deletes a nested node including its subtree, leaving siblings intact", () => {
    const { roots, alpha, beta, childA, childB, grandchild } = fixtureForest();
    const next = deleteNode(roots, childB.id);
    expect(findNode(next, childB.id)).toBeNull();
    expect(findNode(next, grandchild.id)).toBeNull();
    // Survivor integrity: only the targeted subtree disappears.
    expect(next.map((root) => root.id)).toEqual([alpha.id, beta.id]);
    expect(findNode(next, alpha.id)?.children.map((child) => child.id)).toEqual([childA.id]);
  });

  it("returns a fully cloned structural no-op when the id matches nothing", () => {
    // Same clone-always contract as updateNode — see that test's note.
    const { roots } = fixtureForest();
    const next = deleteNode(roots, "missing-id");
    expect(next).not.toBe(roots);
    expect(next[0]).not.toBe(roots[0]);
    expect(next).toEqual(roots);
  });
});

describe("moveNode", () => {
  it("reorders top-level sections", () => {
    const { roots, alpha, beta } = fixtureForest();
    const next = moveNode(roots, beta.id, -1);
    expect(next.map((root) => root.id)).toEqual([beta.id, alpha.id]);
  });

  it("reorders top-level sections downward (+1)", () => {
    // The -1 tests alone leave reorder's splice pair unpinned in the
    // down direction — an off-by-one would live exactly there.
    const { roots, alpha, beta } = fixtureForest();
    const next = moveNode(roots, alpha.id, 1);
    expect(next.map((root) => root.id)).toEqual([beta.id, alpha.id]);
  });

  it("returns the SAME array reference when a top-level move hits the boundary", () => {
    const { roots, alpha } = fixtureForest();
    // alpha is first — moving it up has no swap target.
    expect(moveNode(roots, alpha.id, -1)).toBe(roots);
  });

  it("preserves the containing parent's reference when a nested move hits the boundary", () => {
    const { roots, childB } = fixtureForest();
    // childB is the last child — moving it down has no swap target.
    // toBe (reference identity), not toEqual: moveNodeInTree returns the
    // containing parent unchanged on a no-op, pinning the subtree
    // short-circuit. Scope of the contract: sibling roots ARE cloned by
    // the top-level map, and App's canMove guard prevents no-op calls
    // from reaching setRoots — so only the containing parent's identity
    // is promised here, not the whole forest's.
    const next = moveNode(roots, childB.id, 1);
    expect(next[0]).toBe(roots[0]);
  });

  it("reorders nested siblings", () => {
    const { roots, alpha, childA, childB } = fixtureForest();
    const next = moveNode(roots, childB.id, -1);
    const movedParent = findNode(next, alpha.id);
    expect(movedParent?.children.map((child) => child.id)).toEqual([childB.id, childA.id]);
  });

  it("reorders nested siblings downward (+1)", () => {
    const { roots, alpha, childA, childB } = fixtureForest();
    const next = moveNode(roots, childA.id, 1);
    const movedParent = findNode(next, alpha.id);
    expect(movedParent?.children.map((child) => child.id)).toEqual([childB.id, childA.id]);
  });

  it("returns a fully cloned structural no-op when the id matches nothing", () => {
    const { roots } = fixtureForest();
    const next = moveNode(roots, "missing-id", -1);
    // Pins the documented fall-through contract in document.ts: the
    // missing-id case keeps the clone-always shape of updateNode /
    // deleteNode — deliberately NOT reorder's same-reference boundary
    // contract. A refactor "harmonizing" it to return roots unchanged
    // must fail here.
    expect(next).not.toBe(roots);
    expect(next[0]).not.toBe(roots[0]);
    expect(next).toEqual(roots);
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
