import { useMemo, useState } from "react";
import {
  createBlankDocument,
  createNode,
  deleteNode,
  findNode,
  findParentId,
  moveNode,
  updateNode
} from "./document";
import { copyXmlToClipboard } from "./tauri";
import type { NodeOutlineItem, XmlNode } from "./types";
import { buildPreview, buildXml, findDuplicateNodes, validateDocument } from "./xml";

// Hard-coded preset chip list. User-configurable presets is a v3 question.
const PRESET_NAMES = ["feedback", "question", "instruction", "extra"];

export default function App() {
  const [documentRoot, setDocumentRoot] = useState<XmlNode>(createBlankDocument);
  const [selectedNodeId, setSelectedNodeId] = useState<string>(documentRoot.id);
  const [errorMessage, setErrorMessage] = useState<string>("");
  // Increments on each successful Copy XML; used as a key on the bloom overlay
  // to force remount and replay the CSS animation each time.
  const [copyToken, setCopyToken] = useState<number>(0);
  const [showConfirmReset, setShowConfirmReset] = useState<boolean>(false);

  const activeNode = useMemo(
    () => findNode(documentRoot, selectedNodeId) ?? documentRoot,
    [documentRoot, selectedNodeId]
  );

  const duplicateIssues = useMemo(
    () => findDuplicateNodes(documentRoot),
    [documentRoot]
  );

  const validationIssues = useMemo(
    () => validateDocument(documentRoot),
    [documentRoot]
  );

  // Set of node ids with any kind of issue (validation OR duplicate).
  // Drives the persistent red highlight on element rows.
  const issueNodeIds = useMemo(() => {
    const ids = new Set<string>();
    validationIssues.forEach((issue) => ids.add(issue.nodeId));
    duplicateIssues.forEach((issue) => ids.add(issue.nodeId));
    return ids;
  }, [validationIssues, duplicateIssues]);

  const duplicateNodeIds = useMemo(
    () => new Set(duplicateIssues.map((issue) => issue.nodeId)),
    [duplicateIssues]
  );

  const xmlPreview = useMemo(() => {
    if (validationIssues.length > 0) {
      return "";
    }
    return buildXml(documentRoot);
  }, [documentRoot, validationIssues]);

  const previewLines = useMemo(() => {
    if (validationIssues.length > 0) {
      return [];
    }
    return buildPreview(documentRoot).lines;
  }, [documentRoot, validationIssues]);

  const elementOutline = useMemo(
    () => createElementOutline(documentRoot, duplicateNodeIds),
    [documentRoot, duplicateNodeIds]
  );

  const isRoot = activeNode.id === documentRoot.id;
  const tagNameInvalid = validationIssues.some(
    (issue) => issue.nodeId === activeNode.id
  );
  const lineTitle = activeNode.tagName.trim()
    ? `<${activeNode.tagName.trim()}>`
    : "(empty tag)";

  const requestNewBlank = () => {
    setShowConfirmReset(true);
  };

  const confirmNewBlank = () => {
    const nextRoot = createBlankDocument();
    setDocumentRoot(nextRoot);
    setSelectedNodeId(nextRoot.id);
    setErrorMessage("");
    setShowConfirmReset(false);
  };

  const cancelNewBlank = () => {
    setShowConfirmReset(false);
  };

  const addChild = () => {
    const child = createNode();
    setDocumentRoot((current) =>
      updateNode(current, activeNode.id, (node) => ({
        ...node,
        children: [...node.children, child]
      }))
    );
    setSelectedNodeId(child.id);
    setErrorMessage("");
  };

  const addSibling = () => {
    // Spec §2.1: exactly one root element. Add Sibling on the root would
    // create a second root, violating well-formedness. The button is also
    // disabled at root level in the UI; this guard is defensive.
    if (isRoot) {
      setErrorMessage("The root element cannot have a sibling.");
      return;
    }
    const parentId = findParentId(documentRoot, activeNode.id);
    if (!parentId) {
      return;
    }

    const sibling = createNode();
    setDocumentRoot((current) =>
      updateNode(current, parentId, (node) => {
        const index = node.children.findIndex((c) => c.id === activeNode.id);
        const insertAt = index === -1 ? node.children.length : index + 1;
        return {
          ...node,
          children: [
            ...node.children.slice(0, insertAt),
            sibling,
            ...node.children.slice(insertAt)
          ]
        };
      })
    );
    setSelectedNodeId(sibling.id);
    setErrorMessage("");
  };

  const removeSelectedNode = () => {
    // Root cannot be deleted (spec §2.1: root element is mandatory). The
    // Delete button is disabled at root level; this guard is defensive.
    // Path to "wipe to blank": New Blank, not Delete.
    if (isRoot) {
      return;
    }

    const parentId = findParentId(documentRoot, activeNode.id);
    setDocumentRoot((current) => deleteNode(current, activeNode.id));
    setSelectedNodeId(parentId ?? documentRoot.id);
    setErrorMessage("");
  };

  const moveSelectedNode = (direction: -1 | 1) => {
    setDocumentRoot((current) => moveNode(current, activeNode.id, direction));
  };

  const setActiveTagName = (tagName: string) => {
    setDocumentRoot((current) =>
      updateNode(current, activeNode.id, (node) => ({ ...node, tagName }))
    );
  };

  const setActiveTextContent = (textContent: string) => {
    setDocumentRoot((current) =>
      updateNode(current, activeNode.id, (node) => ({ ...node, textContent }))
    );
  };

  const insertPreset = (baseName: string) => {
    // B-style suffix: every click writes `<base>_<N>` — even the first one is
    // `_1`, not bare `<base>`. N is the lowest unused integer ≥1 among the
    // active element's siblings whose tagName matches `<base>_<digits>`.
    const parentId = findParentId(documentRoot, activeNode.id);
    if (!parentId) {
      // Active element is root (no siblings under single-root invariant).
      // Just use _1.
      setActiveTagName(`${baseName}_1`);
      return;
    }
    const parent = findNode(documentRoot, parentId);
    if (!parent) {
      return;
    }
    const suffix = nextAvailableSuffix(parent, baseName, activeNode.id);
    setActiveTagName(`${baseName}_${suffix}`);
  };

  const copyPreview = async () => {
    if (!xmlPreview) {
      setErrorMessage("Fix validation issues before copying XML.");
      return;
    }
    try {
      await copyXmlToClipboard(xmlPreview);
      // Increment token → bloom overlay remounts → CSS animation replays.
      // Q5 locked: green is reserved for Copy XML success only.
      setCopyToken((t) => t + 1);
      setErrorMessage("");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to copy XML to clipboard.";
      setErrorMessage(message);
    }
  };

  return (
    <div className="app-shell">
      <header className="ribbon">
        <button type="button" onClick={requestNewBlank}>
          New Blank
        </button>
        <span className="ribbon-divider" aria-hidden="true" />
        <button type="button" onClick={addChild}>
          Add Child
        </button>
        <button type="button" onClick={addSibling} disabled={isRoot}>
          Add Sibling
        </button>
        <button type="button" onClick={() => moveSelectedNode(-1)}>
          Move Up
        </button>
        <button type="button" onClick={() => moveSelectedNode(1)}>
          Move Down
        </button>
        <button
          type="button"
          className="danger-button"
          onClick={removeSelectedNode}
          disabled={isRoot}
        >
          Delete
        </button>
        {/* Copy XML is the app's primary action — pushed to the far right end
            of the ribbon (margin-left: auto on .copy-button) and rendered
            bold to read at a different visual level than the per-element
            operations in the middle. */}
        <button type="button" className="copy-button" onClick={copyPreview}>
          Copy XML
        </button>
      </header>

      <main className="body">
        <section className="column elements">
          <h2 className="column-title">Elements</h2>
          <div className="element-list">
            {elementOutline.map((item) => {
              const hasIssue = issueNodeIds.has(item.id);
              const isActive = activeNode.id === item.id;
              const classes = [
                "element-row",
                isActive ? "is-active" : "",
                hasIssue ? "has-issue" : ""
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <button
                  key={item.id}
                  type="button"
                  className={classes}
                  style={{ paddingLeft: `${0.75 + item.depth * 1.25}rem` }}
                  onClick={() => setSelectedNodeId(item.id)}
                >
                  <span className="element-label">{item.label}</span>
                  {item.duplicate && (
                    <span className="element-badge">Duplicate</span>
                  )}
                </button>
              );
            })}
          </div>
        </section>

        <section className="column input">
          <h2 className="line-title">{lineTitle}</h2>

          <label className="field-label" htmlFor={`tag-name-${activeNode.id}`}>
            Tag Name
          </label>
          <input
            id={`tag-name-${activeNode.id}`}
            name="tagName"
            value={activeNode.tagName}
            className={`tag-name-input ${tagNameInvalid ? "input-error" : ""}`}
            onChange={(event) => setActiveTagName(event.target.value)}
          />

          <div className="preset-chips">
            <span className="preset-label">Quick fill:</span>
            {PRESET_NAMES.map((name) => (
              <button
                key={name}
                type="button"
                className="chip"
                onClick={() => insertPreset(name)}
              >
                {name}
              </button>
            ))}
          </div>

          <label
            className="field-label"
            htmlFor={`text-content-${activeNode.id}`}
          >
            Text Content
          </label>
          <textarea
            id={`text-content-${activeNode.id}`}
            name="textContent"
            className="text-content-area"
            value={activeNode.textContent}
            onChange={(event) => setActiveTextContent(event.target.value)}
          />

          {errorMessage && (
            <div className="error-strip" role="alert">
              {errorMessage}
            </div>
          )}
        </section>

        <section className="column preview">
          <h2 className="column-title">Preview</h2>
          <div className="preview-pane">
            {xmlPreview ? (
              previewLines.map((line, index) => {
                const isActive = line.nodeId === activeNode.id;
                return (
                  <div
                    key={`${line.nodeId ?? "line"}-${index}`}
                    className={`preview-line ${isActive ? "is-active" : ""}`}
                  >
                    <span className="preview-indicator" aria-hidden="true">
                      {isActive && line.primary ? ">" : ""}
                    </span>
                    <span className="preview-text">{line.text}</span>
                  </div>
                );
              })
            ) : (
              <div className="preview-empty">
                Fix validation issues to see the preview.
              </div>
            )}
            {/* Key on copyToken forces this overlay to remount on each copy,
                replaying the bloom animation. Pointer-events: none ensures it
                doesn't intercept clicks. */}
            {copyToken > 0 && (
              <div
                key={copyToken}
                className="bloom-overlay"
                aria-hidden="true"
              />
            )}
          </div>
        </section>
      </main>

      {showConfirmReset && (
        <div
          className="modal-overlay"
          role="presentation"
          onClick={cancelNewBlank}
        >
          <div
            className="confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h3 id="confirm-title">Discard current document?</h3>
            <p>This will replace the document with a fresh blank.</p>
            <div className="dialog-buttons">
              <button type="button" onClick={cancelNewBlank}>
                Cancel
              </button>
              <button
                type="button"
                className="danger-button"
                onClick={confirmNewBlank}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function createElementOutline(
  root: XmlNode,
  duplicateNodeIds: Set<string>
): NodeOutlineItem[] {
  const items: NodeOutlineItem[] = [];

  const walk = (node: XmlNode, depth: number) => {
    items.push({
      id: node.id,
      depth,
      label: buildElementLabel(node),
      duplicate: duplicateNodeIds.has(node.id)
    });
    node.children.forEach((child) => walk(child, depth + 1));
  };

  walk(root, 0);
  return items;
}

function buildElementLabel(node: XmlNode): string {
  const tagName = node.tagName.trim() || "empty-tag";
  const previewText = node.textContent.trim();
  const suffix = previewText ? ` ${truncate(previewText, 26)}` : "";
  return `<${tagName}>${suffix}`;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1)}…`;
}

// Find lowest unused integer ≥1 among siblings whose tagName matches
// `<baseName>_<digits>`. The active element itself is excluded from the
// scan — the caller's intent is to rename the active element to a unique
// suffix, so its current name shouldn't block its own assignment.
function nextAvailableSuffix(
  parent: XmlNode,
  baseName: string,
  excludeNodeId: string
): number {
  const escaped = escapeForRegex(baseName);
  const re = new RegExp(`^${escaped}_(\\d+)$`);
  const used = new Set<number>();
  for (const child of parent.children) {
    if (child.id === excludeNodeId) {
      continue;
    }
    const match = child.tagName.trim().match(re);
    if (match) {
      const n = parseInt(match[1], 10);
      if (Number.isFinite(n) && n > 0) {
        used.add(n);
      }
    }
  }
  let n = 1;
  while (used.has(n)) {
    n += 1;
  }
  return n;
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
