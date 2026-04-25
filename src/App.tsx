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
import type { NodeOutlineItem, ValidationIssue, XmlNode } from "./types";
import { buildPreview, buildXml, findDuplicateNodes, validateDocument } from "./xml";

export default function App() {
  const [documentRoot, setDocumentRoot] = useState<XmlNode>(createBlankDocument);
  const [selectedNodeId, setSelectedNodeId] = useState<string>(documentRoot.id);
  const [statusMessage, setStatusMessage] = useState<string>("Ready.");
  const [errorMessage, setErrorMessage] = useState<string>("");

  const activeNode = useMemo(
    () => findNode(documentRoot, selectedNodeId) ?? documentRoot,
    [documentRoot, selectedNodeId]
  );

  const duplicateIssues = useMemo(
    () => findDuplicateNodes(documentRoot),
    [documentRoot]
  );

  const duplicateNodeIds = useMemo(
    () => new Set(duplicateIssues.map((issue) => issue.nodeId)),
    [duplicateIssues]
  );

  const validationIssues = useMemo(
    () => validateDocument(documentRoot),
    [documentRoot]
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

  const outlineItems = useMemo(
    () => createOutlineItems(documentRoot, duplicateNodeIds),
    [documentRoot, duplicateNodeIds]
  );

  const selectedWarnings = useMemo(
    () => [
      ...validationIssues.filter((issue) => issue.nodeId === activeNode.id),
      ...duplicateIssues.filter((issue) => issue.nodeId === activeNode.id)
    ],
    [activeNode.id, duplicateIssues, validationIssues]
  );

  const resetDocument = () => {
    const nextRoot = createBlankDocument();
    setDocumentRoot(nextRoot);
    setSelectedNodeId(nextRoot.id);
    setStatusMessage("Started a new blank document.");
    setErrorMessage("");
  };

  const addChild = (parentId: string) => {
    const child = createNode();
    setDocumentRoot((currentRoot) =>
      updateNode(currentRoot, parentId, (node) => ({
        ...node,
        children: [...node.children, child]
      }))
    );
    setSelectedNodeId(child.id);
    setStatusMessage("Added a new line.");
    setErrorMessage("");
  };

  const addSibling = (nodeId: string) => {
    const parentId = findParentId(documentRoot, nodeId);
    if (!parentId) {
      setErrorMessage("The root line cannot have a sibling.");
      return;
    }

    const sibling = createNode();
    setDocumentRoot((currentRoot) =>
      updateNode(currentRoot, parentId, (node) => {
        const index = node.children.findIndex((child) => child.id === nodeId);
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
    setStatusMessage("Added a sibling line.");
    setErrorMessage("");
  };

  const removeSelectedNode = () => {
    if (activeNode.id === documentRoot.id) {
      resetDocument();
      return;
    }

    const parentId = findParentId(documentRoot, activeNode.id);
    setDocumentRoot((currentRoot) => deleteNode(currentRoot, activeNode.id));
    setSelectedNodeId(parentId ?? documentRoot.id);
    setStatusMessage("Deleted the selected line.");
    setErrorMessage("");
  };

  const moveSelectedNode = (direction: -1 | 1) => {
    setDocumentRoot((currentRoot) => moveNode(currentRoot, activeNode.id, direction));
  };

  const copyPreview = async () => {
    if (!xmlPreview) {
      setErrorMessage("Fix validation issues before copying XML.");
      return;
    }

    try {
      await copyXmlToClipboard(xmlPreview);
      setStatusMessage("XML copied to the clipboard.");
      setErrorMessage("");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to copy XML to clipboard.";
      setErrorMessage(message);
    }
  };

  return (
    <div className="app-shell">
      <header className="top-bar">
        <div>
          <p className="eyebrow">XML Prompt Studio</p>
        </div>

        <div className="toolbar">
          <button type="button" className="secondary-button" onClick={resetDocument}>
            New Blank
          </button>
          <button type="button" className="secondary-button" onClick={copyPreview}>
            Copy XML
          </button>
        </div>
      </header>

      {(statusMessage || errorMessage) && (
        <div className="status-stack">
          {statusMessage && <div className="status-banner">{statusMessage}</div>}
          {errorMessage && <div className="error-banner">{errorMessage}</div>}
        </div>
      )}

      <main className="workspace">
        <section className="panel editor-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Editor</p>
              <h2>Line List</h2>
            </div>
            <p className="muted-text">
              Pick one line, then edit only that line below.
            </p>
          </div>

          <div className="line-list">
            {outlineItems.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`line-row ${activeNode.id === item.id ? "line-row-active" : ""}`}
                style={{ paddingLeft: `${1 + item.depth * 1.25}rem` }}
                onClick={() => setSelectedNodeId(item.id)}
              >
                <span className="line-label">{item.label}</span>
                {item.duplicate && <span className="line-badge">Duplicate</span>}
              </button>
            ))}
          </div>

          <div className="single-editor">
            <div className="section-row">
              <div>
                <p className="eyebrow">Selected Line</p>
                <h2>{activeNode.tagName.trim() || "(empty tag)"}</h2>
              </div>
              <div className="mini-toolbar">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => addChild(activeNode.id)}
                >
                  Add Child
                </button>
                <button type="button" className="secondary-button" onClick={() => addSibling(activeNode.id)}>
                  Add Sibling
                </button>
                <button type="button" className="secondary-button" onClick={() => moveSelectedNode(-1)}>
                  Up
                </button>
                <button type="button" className="secondary-button" onClick={() => moveSelectedNode(1)}>
                  Down
                </button>
                <button type="button" className="danger-button" onClick={removeSelectedNode}>
                  {activeNode.id === documentRoot.id ? "Reset" : "Delete"}
                </button>
              </div>
            </div>

            <div className="field-grid">
              <label htmlFor={`tag-name-${activeNode.id}`}>
                Tag Name
                <input
                  id={`tag-name-${activeNode.id}`}
                  name="tagName"
                  value={activeNode.tagName}
                  className={!activeNode.tagName.trim() ? "input-error" : ""}
                  onChange={(event) =>
                    setDocumentRoot((currentRoot) =>
                      updateNode(currentRoot, activeNode.id, (node) => ({
                        ...node,
                        tagName: event.target.value
                      }))
                    )
                  }
                />
              </label>

              <label htmlFor={`text-content-${activeNode.id}`}>
                Text Content
                <textarea
                  id={`text-content-${activeNode.id}`}
                  name="textContent"
                  rows={4}
                  value={activeNode.textContent}
                  onChange={(event) =>
                    setDocumentRoot((currentRoot) =>
                      updateNode(currentRoot, activeNode.id, (node) => ({
                        ...node,
                        textContent: event.target.value
                      }))
                    )
                  }
                />
              </label>
            </div>

            {selectedWarnings.length > 0 && (
              <div className="warning-box">
                <strong>Selected line warnings</strong>
                <ul>
                  {selectedWarnings.map((issue, index) => (
                    <li key={`${issue.nodeId}-${index}`}>{issue.message}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </section>

        <section className="panel preview-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Preview</p>
              <h2>Formatted XML</h2>
            </div>
            <p className="muted-text">
              The preview font is intentionally larger so you can read structure fast.
            </p>
          </div>

          {validationIssues.length > 0 ? (
            <div className="validation-box">
              <strong>Fix these issues before copying:</strong>
              <ul>
                {validationIssues.map((issue, index) => (
                  <li key={`${issue.nodeId}-${index}`}>{issue.message}</li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="xml-preview" role="presentation">
              {previewLines.map((line, index) => {
                const isActive = line.nodeId === activeNode.id;
                return (
                  <div
                    key={`${line.nodeId ?? "line"}-${index}`}
                    className={`preview-line ${isActive ? "preview-line-active" : ""}`}
                  >
                    <span className="preview-indicator">
                      {isActive && line.primary ? ">" : ""}
                    </span>
                    <span className="preview-text">{line.text}</span>
                  </div>
                );
              })}
            </div>
          )}

          {duplicateIssues.length > 0 && (
            <div className="duplicate-box">
              <strong>Duplicate detection</strong>
              <ul>
                {duplicateIssues.map((issue, index) => (
                  <li key={`${issue.nodeId}-${index}`}>{issue.message}</li>
                ))}
              </ul>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

function createOutlineItems(root: XmlNode, duplicateNodeIds: Set<string>): NodeOutlineItem[] {
  const items: NodeOutlineItem[] = [];

  const walk = (node: XmlNode, depth: number) => {
    items.push({
      id: node.id,
      depth,
      label: buildLineLabel(node),
      duplicate: duplicateNodeIds.has(node.id)
    });

    node.children.forEach((child) => walk(child, depth + 1));
  };

  walk(root, 0);
  return items;
}

function buildLineLabel(node: XmlNode): string {
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
