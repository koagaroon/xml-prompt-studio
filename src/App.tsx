import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
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
import { buildPreview, findDuplicateNodes, validateDocument } from "./xml";

// Hard-coded preset chip list. User-configurable presets is a v3 question.
const PRESET_NAMES = ["feedback", "question", "instruction", "extra"];

// Hard cap on copy-able XML payload, counted in UTF-8 bytes to match the
// Rust-side MAX_XML_BYTES exactly. Earlier we used JS string length (UTF-16
// code units), which diverged by up to 3× for CJK / emoji content — a 50M
// char Chinese payload would pass the JS check (50M code units) but fail
// the Rust check (~150 MB UTF-8). Bytes on both sides keeps the cap
// meaningful.
const MAX_XML_BYTES = 50_000_000;

// Soft cap on tree depth. Past this the recursive walkers in document.ts /
// xml.ts risk a "Maximum call stack size exceeded" RangeError on render.
// In practice no document needs anywhere near this; the guard exists so
// runaway "Add Child" clicks can't crash the app.
const MAX_DEPTH = 256;

// Stable element IDs for the form fields in the Input column. Earlier these
// were per-active-node and churned on every selection, confusing autofill
// and a11y caches even though there's only one of each on screen.
const TAG_NAME_INPUT_ID = "tag-name-input";
const TEXT_CONTENT_INPUT_ID = "text-content-area";

type Theme = "dark" | "light";

// Read the initial theme from the same source the inline bootstrap script
// in index.html uses, so React state and the DOM data-theme attribute agree
// from the very first render. Falls back to system preference, then dark.
function readInitialTheme(): Theme {
  if (typeof window === "undefined") {
    return "dark";
  }
  try {
    const stored = localStorage.getItem("theme");
    if (stored === "dark" || stored === "light") {
      return stored;
    }
  } catch {
    // localStorage unavailable — fall through to system preference.
  }
  if (window.matchMedia?.("(prefers-color-scheme: light)").matches) {
    return "light";
  }
  return "dark";
}

export default function App() {
  const [documentRoot, setDocumentRoot] = useState<XmlNode>(createBlankDocument);
  // Lazy initializer reads documentRoot.id only on first render. Without
  // the wrapper, the property access fires on every render even though
  // React ignores the value after mount.
  const [selectedNodeId, setSelectedNodeId] = useState(() => documentRoot.id);
  const [errorMessage, setErrorMessage] = useState("");
  // Increments on each successful Copy XML; used as a key on the bloom overlay
  // to force remount and replay the CSS animation each time.
  const [copyToken, setCopyToken] = useState(0);
  const [showConfirmReset, setShowConfirmReset] = useState(false);
  const [theme, setTheme] = useState<Theme>(readInitialTheme);
  // Increments each time a preset chip overwrites a non-empty tag name.
  // The Tag Name input wrapper renders a transient overlay keyed on this
  // counter, so each increment remounts the overlay and replays the
  // amber-flash animation — letting the user notice "I just overwrote
  // something" without blocking their re-pick flow.
  const [presetOverwriteFlash, setPresetOverwriteFlash] = useState(0);

  // In-flight guard for Copy XML. Without it, rapid clicks queue concurrent
  // IPC calls and arboard's global Windows clipboard handle races between
  // them. Single boolean ref prevents re-entry until the active call settles.
  const copyInFlight = useRef(false);

  // Cancel-button focus target for the New Blank confirmation modal.
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  // Preview is the slow recompute (string join over textContent that may be
  // large). Deferring its input lets typing in the Tag Name / Text Content
  // inputs stay responsive — React keeps the previous preview frame visible
  // until the new one is ready. Validation, outline, and the input column
  // continue to use the latest documentRoot for immediate feedback.
  const deferredRoot = useDeferredValue(documentRoot);

  // Keep DOM and storage in sync with state. The inline script in
  // index.html sets the initial attribute pre-render; this effect handles
  // every change after that.
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("theme", theme);
    } catch {
      /* swallow — storage failure shouldn't break theme toggling */
    }
  }, [theme]);

  const toggleTheme = () => {
    setTheme((current) => (current === "dark" ? "light" : "dark"));
  };

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

  // Single-pass union: duplicateNodeIds is a subset of issueNodeIds, so
  // build them together to avoid scanning duplicateIssues twice.
  const { issueNodeIds, duplicateNodeIds } = useMemo(() => {
    const dup = new Set<string>();
    for (const issue of duplicateIssues) {
      dup.add(issue.nodeId);
    }
    const all = new Set<string>(dup);
    for (const issue of validationIssues) {
      all.add(issue.nodeId);
    }
    return { issueNodeIds: all, duplicateNodeIds: dup };
  }, [validationIssues, duplicateIssues]);

  // Validation against the deferred root, used to gate the on-screen
  // preview. The build runs against deferredRoot, so the gate must too —
  // otherwise the live-root validation could pass while deferredRoot is
  // briefly invalid in a transient frame, and renderNode would emit
  // malformed lines like `<>...</>`.
  const deferredValidationIssues = useMemo(
    () => validateDocument(deferredRoot),
    [deferredRoot]
  );

  // Single buildPreview call serves the on-screen preview lines. Uses
  // deferredRoot so heavy text content doesn't block typing — the input
  // column shows the latest state immediately, the preview catches up.
  const previewBuild = useMemo(() => {
    if (deferredValidationIssues.length > 0) {
      return { xml: "", lines: [] };
    }
    return buildPreview(deferredRoot);
  }, [deferredRoot, deferredValidationIssues]);
  const xmlPreview = previewBuild.xml;
  const previewLines = previewBuild.lines;

  const elementOutline = useMemo(
    () => createElementOutline(documentRoot, duplicateNodeIds),
    [documentRoot, duplicateNodeIds]
  );

  const isRoot = activeNode.id === documentRoot.id;
  const tagNameInvalid = validationIssues.some(
    (issue) => issue.nodeId === activeNode.id
  );
  const trimmedTag = activeNode.tagName.trim();
  const lineTitle = trimmedTag ? `<${trimmedTag}>` : "(empty tag)";
  // Depth of the currently active element. Read from the already-computed
  // outline rather than walking the tree again.
  const activeDepth =
    elementOutline.find((item) => item.id === activeNode.id)?.depth ?? 0;

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
    // Soft depth guard — refuse rather than risk stack overflow on render.
    if (activeDepth >= MAX_DEPTH) {
      setErrorMessage(`Element nesting depth limit reached (${MAX_DEPTH}).`);
      return;
    }
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
    // If the active element already has a non-empty tag name, trigger the
    // amber-flash overlay so the user notices the overwrite. Doesn't block
    // the re-pick flow (no modal, no debounce) — just a visual cue.
    if (activeNode.tagName.trim() !== "") {
      setPresetOverwriteFlash((k) => k + 1);
    }

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
    const suffix = nextAvailableSuffix(parent, baseName);
    setActiveTagName(`${baseName}_${suffix}`);
  };

  const copyPreview = async () => {
    // Re-entry guard — drop overlapping clicks while a copy is in flight.
    if (copyInFlight.current) {
      return;
    }

    // Build from the LIVE documentRoot, not the deferred one. Copy XML is
    // an explicit user action that must capture the latest state — the
    // useDeferredValue trick is only for keystroke-smoothness on the
    // on-screen preview. Using deferredRoot here would silently copy stale
    // text after rapid type-then-click.
    const liveIssues = validateDocument(documentRoot);
    if (liveIssues.length > 0) {
      setErrorMessage("Fix validation issues before copying XML.");
      return;
    }
    const liveXml = buildPreview(documentRoot).xml;

    // Count UTF-8 bytes (matches the Rust-side cap exactly). JS string
    // length is UTF-16 code units which can be up to 3× off for CJK / emoji.
    const liveBytes = new TextEncoder().encode(liveXml).length;
    if (liveBytes > MAX_XML_BYTES) {
      setErrorMessage(
        `XML payload too large to copy (${liveBytes} bytes; limit ${MAX_XML_BYTES} bytes).`
      );
      return;
    }

    copyInFlight.current = true;
    try {
      await copyXmlToClipboard(liveXml);
      // Increment token → bloom overlay remounts → CSS animation replays.
      // Q5 locked: green is reserved for Copy XML success only.
      setCopyToken((t) => t + 1);
      setErrorMessage("");
    } catch (error) {
      // Tauri commands reject with a string (the Err(String) returned by
      // Rust), not an `Error` instance. Branch on the actual runtime shape:
      // string → use it directly; Error → use .message; anything else →
      // generic fallback. The earlier `instanceof Error`-only check was
      // always false for Tauri rejections and swallowed clip.exe stderr.
      const message =
        typeof error === "string"
          ? error
          : error instanceof Error
            ? error.message
            : "Failed to copy XML to clipboard.";
      setErrorMessage(message);
    } finally {
      copyInFlight.current = false;
    }
  };

  // Modal accessibility: focus the Cancel button when the confirmation
  // dialog opens, and let Escape cancel. Without this the originating
  // ribbon button keeps focus and screen readers don't announce the
  // dialog's appearance.
  useEffect(() => {
    if (!showConfirmReset) {
      return;
    }
    cancelButtonRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShowConfirmReset(false);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [showConfirmReset]);

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
        {/* Theme toggle sits between Delete and Copy XML in DOM order. The
            icon shown is the destination (sun = "click to go light", moon =
            "click to go dark"). */}
        <button
          type="button"
          className="theme-toggle"
          onClick={toggleTheme}
          aria-label={
            theme === "dark" ? "Switch to light mode" : "Switch to dark mode"
          }
          title={
            theme === "dark" ? "Switch to light mode" : "Switch to dark mode"
          }
        >
          {theme === "dark" ? <SunIcon /> : <MoonIcon />}
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
              return (
                <button
                  key={item.id}
                  type="button"
                  className={[
                    "element-row",
                    isActive && "is-active",
                    hasIssue && "has-issue"
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  // Depth passed via custom property; styles.css computes
                  // padding-left through calc() so we don't need
                  // 'unsafe-inline' style-src in the CSP for this.
                  style={{ "--depth": item.depth } as React.CSSProperties}
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
          <h2 className="element-title">{lineTitle}</h2>

          <label className="field-label" htmlFor={TAG_NAME_INPUT_ID}>
            Tag Name
          </label>
          <div className="tag-name-wrap">
            <input
              id={TAG_NAME_INPUT_ID}
              name="tagName"
              value={activeNode.tagName}
              className={["tag-name-input", tagNameInvalid && "input-error"]
                .filter(Boolean)
                .join(" ")}
              onChange={(event) => setActiveTagName(event.target.value)}
            />
            {/* Amber pulse on the input border when a preset chip overwrote
                a non-empty tag. Key change forces remount, which replays the
                CSS animation. pointer-events: none so it doesn't intercept
                clicks/focus on the input below. */}
            {presetOverwriteFlash > 0 && (
              <div
                key={presetOverwriteFlash}
                className="preset-overwrite-flash"
                aria-hidden="true"
              />
            )}
          </div>

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

          <label className="field-label" htmlFor={TEXT_CONTENT_INPUT_ID}>
            Text Content
          </label>
          <textarea
            id={TEXT_CONTENT_INPUT_ID}
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
              previewLines.map((line) => {
                const isActive = line.nodeId === activeNode.id;
                // Stable per-(node, kind) key — each node produces at most
                // three lines (open / text / close) or a single self-closing
                // / single-line, all with distinct kinds. So nodeId+kind is
                // unique and survives sibling reordering / inserts without
                // forcing React to rebuild every preview row.
                return (
                  <div
                    key={`${line.nodeId}-${line.kind}`}
                    className={["preview-line", isActive && "is-active"]
                      .filter(Boolean)
                      .join(" ")}
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
        // Overlay has no explicit role — the inner div carries
        // role="dialog" + aria-modal="true". Keeping a click handler on
        // the overlay for click-outside-to-cancel; AT users have Escape
        // and the focused Cancel button (see useEffect for focus mgmt).
        <div className="modal-overlay" onClick={cancelNewBlank}>
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
              <button
                type="button"
                ref={cancelButtonRef}
                onClick={cancelNewBlank}
              >
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

// Find the lowest unused integer ≥1 among siblings whose tagName matches
// `<baseName>_<positive-decimal>`. The active element is included in the
// scan — clicking the preset chip on an element already named e.g.
// `feedback_3` should advance it (siblings + self {1, 2, 3} → next 4),
// not silently rewrite to the same value.
//
// Suffix regex requires `[1-9]\d*` to reject leading zeros, so e.g.
// `feedback_001` does NOT collide with `feedback_1` in the used set.
function nextAvailableSuffix(parent: XmlNode, baseName: string): number {
  const escaped = escapeForRegex(baseName);
  const re = new RegExp(`^${escaped}_([1-9]\\d*)$`);
  const used = new Set<number>();
  for (const child of parent.children) {
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

// Escape regex metacharacters. Both `[` and `]` are explicitly escaped
// inside the character class for cross-engine portability — V8 tolerates
// the unescaped forms but older Safari/JavaScriptCore did not.
function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|\[\]\\]/g, "\\$&");
}

function SunIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <line x1="12" y1="2" x2="12" y2="4" />
      <line x1="12" y1="20" x2="12" y2="22" />
      <line x1="4.93" y1="4.93" x2="6.34" y2="6.34" />
      <line x1="17.66" y1="17.66" x2="19.07" y2="19.07" />
      <line x1="2" y1="12" x2="4" y2="12" />
      <line x1="20" y1="12" x2="22" y2="12" />
      <line x1="4.93" y1="19.07" x2="6.34" y2="17.66" />
      <line x1="17.66" y1="6.34" x2="19.07" y2="4.93" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}
