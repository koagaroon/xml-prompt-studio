import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from "react";
import { ElementsColumn } from "./ElementsColumn";
import { ModalDialog } from "./ModalDialog";
import { PresetChipsBar } from "./PresetChipsBar";
import { PreviewColumn } from "./PreviewColumn";
import { Ribbon } from "./Ribbon";
import {
  createBlankDocument,
  createNode,
  deleteNode,
  findNode,
  findParent,
  moveNode,
  updateNode,
} from "./document";
import {
  MAX_PRESET_NAME_LENGTH,
  MAX_XML_BYTES,
  buildDeleteNodeConfirmation,
  capCodePoints,
  createElementOutline,
  cx,
  exceedsByteCap,
  formatMegabytes,
  getCopyReadiness,
  hasUnsavedPromptWork,
  insertAfter,
  nextSelectionAfterDelete,
  utf8ByteLength,
  validatePresetName,
} from "./helpers";
import {
  DEFAULT_PRESET_CHIPS,
  applyPresetToElementMemory,
  clearElementLastAppliedPreset,
  forgetPresetChipInMemory,
  persistPresetChips,
  readInitialPresetChips,
  sweepDeletedSubtreeFromMemory,
  type ChipEditMessage,
  type EditingChip,
  type ElementPresetMemory,
} from "./presets";
import {
  confirmMainWindowClose,
  copyXmlToClipboard,
  registerMainWindowCloseGuard,
  requestMainWindowShowAfterFirstPaint,
  setMainWindowUnsavedWork,
} from "./tauri";
import { persistTheme, readInitialTheme, type Theme } from "./theme";
import type { ConfirmRequest, FieldMessage, ModalState, StripMessage, XmlNode } from "./types";
import { buildPreview, validateDocument } from "./xml";

// Defensive ceilings keeping recursive walks and keystroke recomputation fast.
const MAX_DEPTH = 256;
const MAX_SIBLINGS = 1000;
const MAX_TEXT_CONTENT_BYTES = 10_000_000;
// 32 = 24 (MAX_PRESET_NAME_LENGTH) + "_" + up to 4 suffix digits + headroom.
const MAX_TAG_NAME_LENGTH = 32;
// Generous preedit slack so Pinyin/Romaji IME composition near the code-point
// cap is never truncated mid-session before `compositionend` settles.
const IME_COMPOSITION_SLACK_MULTIPLIER = 4;

const TAG_NAME_INPUT_ID = "tag-name-input";
const TEXT_CONTENT_INPUT_ID = "text-content-input";

function preventFileDropNavigation(event: DragEvent<HTMLElement>): void {
  const types = event.dataTransfer?.types;
  if (types && Array.from(types).includes("Files")) {
    event.preventDefault();
  }
}

export default function App() {
  const [roots, setRoots] = useState<XmlNode[]>(createBlankDocument);
  const [selectedNodeId, setSelectedNodeId] = useState(() => roots[0].id);
  const [stripMessage, setStripMessage] = useState<StripMessage | null>(null);
  const [copyToken, setCopyToken] = useState(0);
  const [modal, setModal] = useState<ModalState>(null);
  const modalIdRef = useRef(0);
  const modalOpenRef = useRef(false);
  const [noticesText, setNoticesText] = useState<string | null>(null);
  const [noticesError, setNoticesError] = useState(false);
  const noticesLoadingRef = useRef(false);
  const [theme, setTheme] = useState<Theme>(readInitialTheme);
  const [presetChips, setPresetChips] = useState<string[]>(readInitialPresetChips);

  useEffect(() => {
    requestMainWindowShowAfterFirstPaint();
  }, []);

  const [editMode, setEditMode] = useState(false);
  const [editingChip, setEditingChip] = useState<EditingChip | null>(null);
  const [chipEditMessage, setChipEditMessage] = useState<ChipEditMessage | null>(null);
  const [tagNameMessage, setTagNameMessage] = useState<FieldMessage | null>(null);
  const [presetMessage, setPresetMessage] = useState<FieldMessage | null>(null);

  const copyInFlight = useRef(false);
  const ribbonRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLElement>(null);
  const presetMemoryRef = useRef<Map<string, ElementPresetMemory>>(new Map());
  const isTagComposingRef = useRef(false);

  const deferredRoots = useDeferredValue(roots);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  const stripMessageIdRef = useRef(0);
  const copyWaitNoticeRef = useRef(false);
  const copyBusyNoticeRef = useRef(false);

  const showError = useCallback((text: string, forNodeId: string | null = null) => {
    copyWaitNoticeRef.current = false;
    copyBusyNoticeRef.current = false;
    setStripMessage({
      id: ++stripMessageIdRef.current,
      text,
      severity: "error",
      forNodeId,
    });
  }, []);

  const showWarning = useCallback((text: string, forNodeId: string | null = null) => {
    copyWaitNoticeRef.current = false;
    copyBusyNoticeRef.current = false;
    setStripMessage({
      id: ++stripMessageIdRef.current,
      text,
      severity: "warning",
      forNodeId,
    });
  }, []);

  const clearMessage = useCallback(() => {
    copyWaitNoticeRef.current = false;
    copyBusyNoticeRef.current = false;
    setStripMessage(null);
  }, []);

  const storageWarningsShownRef = useRef<Set<string>>(new Set());
  const warnStorageWriteFailed = useCallback(
    (what: string) => {
      if (storageWarningsShownRef.current.has(what)) {
        return;
      }
      storageWarningsShownRef.current.add(what);
      showWarning(
        `Couldn't save your ${what} — the change works for this session but will reset on next launch (storage unavailable).`,
        null
      );
    },
    [showWarning]
  );

  // Skip persisting the initial array on mount so first launch doesn't freeze
  // DEFAULT_PRESET_CHIPS into storage before the user ever edits presets.
  const initialPresetChipsRef = useRef(presetChips);
  useEffect(() => {
    if (presetChips === initialPresetChipsRef.current) {
      return;
    }
    if (!persistPresetChips(presetChips)) {
      warnStorageWriteFailed("preset chips");
    }
  }, [presetChips, warnStorageWriteFailed]);

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    if (!persistTheme(next)) {
      warnStorageWriteFailed("theme choice");
    }
    setTheme(next);
  };

  const activeNode = useMemo(
    () => findNode(roots, selectedNodeId) ?? roots[0],
    [roots, selectedNodeId]
  );

  useEffect(() => {
    isTagComposingRef.current = false;
  }, [activeNode.id]);

  const validationIssues = useMemo(() => validateDocument(roots), [roots]);
  const issueNodeIds = useMemo(
    () => new Set(validationIssues.map((issue) => issue.nodeId)),
    [validationIssues]
  );

  const deferredValidationIssues = useMemo(() => validateDocument(deferredRoots), [deferredRoots]);
  const previewBuild = useMemo(() => {
    if (deferredValidationIssues.length > 0) {
      return { xml: "", lines: [] };
    }
    return buildPreview(deferredRoots);
  }, [deferredRoots, deferredValidationIssues]);

  const previewPending = deferredRoots !== roots;
  const xmlPreview = previewBuild.xml;
  const previewLines = previewBuild.lines;

  useEffect(() => {
    if (!previewPending && copyWaitNoticeRef.current) {
      clearMessage();
    }
  }, [previewPending, clearMessage]);

  const selectNode = (nodeId: string) => {
    if (stripMessage && stripMessage.forNodeId !== null && stripMessage.forNodeId !== nodeId) {
      clearMessage();
    }
    if (tagNameMessage && tagNameMessage.forNodeId !== nodeId) {
      setTagNameMessage(null);
    }
    if (presetMessage && presetMessage.forNodeId !== nodeId) {
      setPresetMessage(null);
    }
    setSelectedNodeId(nodeId);
  };

  const clearFieldMessages = () => {
    setTagNameMessage(null);
    setPresetMessage(null);
  };

  const elementOutline = useMemo(() => createElementOutline(roots), [roots]);
  const depthByNodeId = useMemo(
    () => new Map(elementOutline.map((item) => [item.id, item.depth])),
    [elementOutline]
  );

  const activeTagNameMessage =
    tagNameMessage && tagNameMessage.forNodeId === activeNode.id ? tagNameMessage : null;
  const activePresetMessage =
    presetMessage && presetMessage.forNodeId === activeNode.id ? presetMessage : null;
  const activeStripMessage =
    stripMessage && (stripMessage.forNodeId === null || stripMessage.forNodeId === activeNode.id)
      ? stripMessage
      : null;

  const activeParent = useMemo(() => findParent(roots, activeNode.id), [activeNode.id, roots]);
  const activeSiblings = activeParent ? activeParent.children : roots;
  const activeSiblingIndex = activeSiblings.findIndex((child) => child.id === activeNode.id);
  const canMoveUp = activeSiblingIndex > 0;
  const canMoveDown = activeSiblingIndex >= 0 && activeSiblingIndex < activeSiblings.length - 1;
  const tagNameHasIssue = issueNodeIds.has(activeNode.id);
  const trimmedTag = activeNode.tagName.trim();
  const lineTitle = trimmedTag ? `<${trimmedTag}>` : "(empty tag)";
  const activeDepth = depthByNodeId.get(activeNode.id) ?? MAX_DEPTH;

  const openConfirmModal = useCallback((request: ConfirmRequest) => {
    modalOpenRef.current = true;
    setModal({ kind: "confirm", id: ++modalIdRef.current, request });
  }, []);

  const closeModal = useCallback(() => {
    modalOpenRef.current = false;
    setModal(null);
  }, []);

  const hasUnsavedWork = useMemo(() => hasUnsavedPromptWork(roots), [roots]);

  useEffect(() => {
    setMainWindowUnsavedWork(hasUnsavedWork);
  }, [hasUnsavedWork]);

  const requestCloseWindow = useCallback(() => {
    openConfirmModal({
      title: "Discard current prompt and close?",
      description: "Closing now will discard your current prompt sections and text.",
      confirmLabel: "Close",
      confirmKind: "danger",
      onConfirm: () => {
        void confirmMainWindowClose().catch((error: unknown) => {
          const message =
            typeof error === "string"
              ? error
              : error instanceof Error
                ? error.message
                : "Failed to close window.";
          showError(message);
        });
      },
    });
  }, [openConfirmModal, showError]);

  useEffect(() => {
    return registerMainWindowCloseGuard(requestCloseWindow);
  }, [requestCloseWindow]);

  const openNotices = async () => {
    modalOpenRef.current = true;
    setModal((current) =>
      current?.kind === "notices" ? current : { kind: "notices", id: ++modalIdRef.current }
    );
    if (noticesText !== null || noticesLoadingRef.current) return;
    noticesLoadingRef.current = true;
    setNoticesError(false);
    try {
      const response = await fetch("./third-party-notices.txt");
      if (!response.ok) throw new Error("Bundled notices unavailable");
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (contentType.includes("text/html")) {
        throw new Error("Bundled notices resolved to HTML fallback");
      }
      const text = await response.text();
      if (!text.trim()) throw new Error("Bundled notices are empty");
      setNoticesText(text);
    } catch {
      setNoticesError(true);
    } finally {
      noticesLoadingRef.current = false;
    }
  };

  const handleConfirm = () => {
    if (modal?.kind !== "confirm") {
      return;
    }
    const { onConfirm } = modal.request;
    modalOpenRef.current = false;
    setModal(null);
    onConfirm();
  };

  const resetToBlankDocument = () => {
    const nextRoots = createBlankDocument();
    setRoots(nextRoots);
    setSelectedNodeId(nextRoots[0].id);
    clearMessage();
    clearFieldMessages();
    presetMemoryRef.current.clear();
  };

  const requestNewBlank = () => {
    openConfirmModal({
      title: "Discard current document?",
      description: "This will replace the document with a fresh blank.",
      confirmLabel: "Confirm",
      confirmKind: "danger",
      onConfirm: resetToBlankDocument,
    });
  };

  const requestResetPresets = () => {
    openConfirmModal({
      title: "Restore default preset chips?",
      description: `This will replace your current chips with ${DEFAULT_PRESET_CHIPS.join(" / ")}.`,
      confirmLabel: "Restore",
      onConfirm: () => {
        setPresetChips([...DEFAULT_PRESET_CHIPS]);
        setEditMode(false);
        setEditingChip(null);
        setChipEditMessage(null);
        setPresetMessage(null);
        presetMemoryRef.current.clear();
      },
    });
  };

  const toggleEditMode = () => {
    setPresetMessage(null);
    if (editMode) {
      setEditingChip(null);
      setChipEditMessage(null);
    }
    setEditMode(!editMode);
  };

  const removeChip = (index: number) => {
    const removedName = presetChips[index];
    if (removedName) {
      forgetPresetChipInMemory(presetMemoryRef.current, removedName);
    }
    setPresetMessage(null);
    if (!editingChip) {
      setChipEditMessage(null);
    }
    setPresetChips((chips) => chips.filter((_, i) => i !== index));
    setEditingChip((current) => {
      if (!current || current.isNew) {
        return current;
      }
      if (current.index === index) {
        setChipEditMessage(null);
        return null;
      }
      if (current.index > index) {
        return { ...current, index: current.index - 1 };
      }
      return current;
    });
  };

  const startAddChip = () => {
    setEditingChip({
      draft: "",
      isNew: true,
    });
    setChipEditMessage(null);
  };

  const startRenameChip = (index: number) => {
    setEditingChip({
      index,
      draft: presetChips[index],
      isNew: false,
    });
    setChipEditMessage(null);
  };

  const updateEditingChipDraft = (draft: string, isComposing = false) => {
    if (!editingChip) {
      return;
    }
    if (isComposing) {
      const slackCapped = capCodePoints(
        draft,
        MAX_PRESET_NAME_LENGTH * IME_COMPOSITION_SLACK_MULTIPLIER
      );
      setEditingChip({
        ...editingChip,
        draft: slackCapped,
      });
      return;
    }
    const capped = capCodePoints(draft, MAX_PRESET_NAME_LENGTH);
    setChipEditMessage(
      capped !== draft
        ? {
            text: `Chip name reached the ${MAX_PRESET_NAME_LENGTH}-character limit.`,
            severity: "warning",
          }
        : null
    );
    setEditingChip({
      ...editingChip,
      draft: capped,
    });
  };

  const cancelChipEdit = () => {
    setEditingChip(null);
    setChipEditMessage(null);
  };

  const commitChipEdit = () => {
    if (!editingChip) {
      return;
    }
    const trimmed = editingChip.draft.trim();
    const error = validatePresetName(
      trimmed,
      presetChips,
      editingChip.isNew ? -1 : editingChip.index
    );
    if (error) {
      setChipEditMessage({ text: error, severity: "error" });
      return;
    }
    if (editingChip.isNew) {
      forgetPresetChipInMemory(presetMemoryRef.current, trimmed);
      setPresetChips((chips) => [...chips, trimmed]);
    } else {
      const renameIndex = editingChip.index;
      const previousName = presetChips[renameIndex];
      if (previousName && previousName !== trimmed) {
        forgetPresetChipInMemory(presetMemoryRef.current, previousName);
        forgetPresetChipInMemory(presetMemoryRef.current, trimmed);
      }
      setPresetChips((chips) => chips.map((c, i) => (i === renameIndex ? trimmed : c)));
    }
    setEditingChip(null);
    setChipEditMessage(null);
    setPresetMessage(null);
  };

  const blurChipEdit = () => {
    if (!editingChip) {
      return;
    }
    // Opening a modal moves focus to Cancel/Close; preserve any uncommitted
    // chip draft until the user resolves the modal rather than committing
    // unconfirmed edits behind the dialog.
    if (modalOpenRef.current) {
      return;
    }
    if (editingChip.isNew && editingChip.draft.trim() === "") {
      cancelChipEdit();
      return;
    }
    commitChipEdit();
  };

  const addChild = () => {
    if (activeDepth >= MAX_DEPTH) {
      showError(`Element nesting depth limit reached (${MAX_DEPTH}).`, activeNode.id);
      return;
    }
    if (activeNode.children.length >= MAX_SIBLINGS) {
      showError(`Child count limit reached (${MAX_SIBLINGS}).`, activeNode.id);
      return;
    }
    const child = createNode();
    setRoots((current) =>
      updateNode(current, activeNode.id, (node) => ({
        ...node,
        children: [...node.children, child],
      }))
    );
    setSelectedNodeId(child.id);
    clearMessage();
    clearFieldMessages();
  };

  const addSibling = () => {
    if (activeSiblings.length >= MAX_SIBLINGS) {
      showError(`Sibling count limit reached (${MAX_SIBLINGS}).`, activeNode.id);
      return;
    }

    const sibling = createNode();
    if (activeParent) {
      const parentId = activeParent.id;
      setRoots((current) =>
        updateNode(current, parentId, (node) => ({
          ...node,
          children: insertAfter(node.children, activeNode.id, sibling),
        }))
      );
    } else {
      setRoots((current) => insertAfter(current, activeNode.id, sibling));
    }
    setSelectedNodeId(sibling.id);
    clearMessage();
    clearFieldMessages();
  };

  const executeDeleteSelectedNode = (nodeId: string) => {
    setRoots((current) => {
      const targetNode = findNode(current, nodeId);
      if (!targetNode) {
        return current;
      }
      const parent = findParent(current, nodeId);
      if (!parent && current.length === 1) {
        return current;
      }
      const siblings = parent ? parent.children : current;
      const nextSelected = nextSelectionAfterDelete(
        siblings,
        nodeId,
        parent?.id ?? null,
        current[0].id
      );
      sweepDeletedSubtreeFromMemory(presetMemoryRef.current, targetNode);
      setSelectedNodeId(nextSelected);
      return deleteNode(current, nodeId);
    });
    clearMessage();
    clearFieldMessages();
  };

  const removeSelectedNode = () => {
    if (!activeParent && roots.length === 1) {
      openConfirmModal({
        title: "Clear the only section?",
        description: "This will replace the current section with a fresh blank.",
        confirmLabel: "Clear",
        confirmKind: "danger",
        onConfirm: resetToBlankDocument,
      });
      return;
    }

    const targetNodeId = activeNode.id;
    const confirmation = buildDeleteNodeConfirmation(activeNode);
    if (confirmation) {
      openConfirmModal({
        ...confirmation,
        confirmKind: "danger",
        onConfirm: () => executeDeleteSelectedNode(targetNodeId),
      });
      return;
    }

    executeDeleteSelectedNode(targetNodeId);
  };

  const moveSelectedNode = (direction: -1 | 1) => {
    const canMove = direction === -1 ? canMoveUp : canMoveDown;
    if (!canMove) {
      return;
    }
    setRoots((current) => moveNode(current, activeNode.id, direction));
    clearMessage();
  };

  const setActiveTagName = (rawTagName: string, isComposing = false) => {
    if (isComposing) {
      const slackCapped = capCodePoints(
        rawTagName,
        MAX_TAG_NAME_LENGTH * IME_COMPOSITION_SLACK_MULTIPLIER
      );
      setRoots((current) =>
        updateNode(current, activeNode.id, (node) => ({ ...node, tagName: slackCapped }))
      );
      clearMessage();
      return;
    }
    const tagName = capCodePoints(rawTagName, MAX_TAG_NAME_LENGTH);
    const truncated = tagName !== rawTagName;
    setRoots((current) => updateNode(current, activeNode.id, (node) => ({ ...node, tagName })));
    if (truncated) {
      setTagNameMessage({
        text: `Tag name reached the ${MAX_TAG_NAME_LENGTH}-character limit.`,
        forNodeId: activeNode.id,
      });
    } else {
      setTagNameMessage(null);
    }
    clearMessage();
  };

  const setActiveTextContent = (textContent: string) => {
    if (exceedsByteCap(textContent, MAX_TEXT_CONTENT_BYTES)) {
      showError(
        `Text content too long (limit ${formatMegabytes(MAX_TEXT_CONTENT_BYTES)}).`,
        activeNode.id
      );
      return;
    }
    setRoots((current) => updateNode(current, activeNode.id, (node) => ({ ...node, textContent })));
    clearMessage();
  };

  const insertPreset = (chipName: string) => {
    const result = applyPresetToElementMemory(
      presetMemoryRef.current,
      activeNode.id,
      chipName,
      activeSiblings
    );

    if (result.alreadyApplied) {
      setPresetMessage({
        text: `"${chipName}" is already applied to this element — clicking it won't change the tag name.`,
        forNodeId: activeNode.id,
      });
      return;
    }

    setRoots((current) =>
      updateNode(current, activeNode.id, (node) => ({
        ...node,
        tagName: result.tagName,
      }))
    );
    clearMessage();
    clearFieldMessages();
  };

  const copyPreview = async () => {
    const copyReadiness = getCopyReadiness({
      copyInFlight: copyInFlight.current,
      previewPending,
      validationIssueCount: validationIssues.length,
      xml: xmlPreview,
      maxBytes: MAX_XML_BYTES,
    });

    if (!copyReadiness.ready) {
      switch (copyReadiness.reason) {
        case "busy":
          showWarning("A copy is already in progress — one moment.");
          copyBusyNoticeRef.current = true;
          return;
        case "preview-pending":
          showWarning(
            "Preview is still updating. Copy XML will be available once it matches the document."
          );
          copyWaitNoticeRef.current = true;
          return;
        case "validation":
          showError("Fix validation issues before copying XML.");
          return;
        case "too-large": {
          const liveBytes = utf8ByteLength(xmlPreview);
          showError(
            `XML payload too large to copy (${formatMegabytes(liveBytes)}; limit ${formatMegabytes(MAX_XML_BYTES)}).`
          );
          return;
        }
        default: {
          const exhausted: never = copyReadiness.reason;
          showError(`Copy blocked: ${String(exhausted)}.`);
          return;
        }
      }
    }

    const liveXml = xmlPreview;

    clearMessage();
    copyInFlight.current = true;
    try {
      await copyXmlToClipboard(liveXml);
      setCopyToken((t) => t + 1);
    } catch (error) {
      const message =
        typeof error === "string"
          ? error
          : error instanceof Error
            ? error.message
            : "Failed to copy XML to clipboard.";
      showError(message);
    } finally {
      copyInFlight.current = false;
      if (copyBusyNoticeRef.current) {
        clearMessage();
      }
    }
  };

  return (
    <div
      className="app-shell"
      onDragOver={preventFileDropNavigation}
      onDrop={preventFileDropNavigation}
    >
      <Ribbon
        ribbonRef={ribbonRef}
        canMoveUp={canMoveUp}
        canMoveDown={canMoveDown}
        theme={theme}
        onNewBlank={requestNewBlank}
        onAddChild={addChild}
        onAddSibling={addSibling}
        onMoveUp={() => moveSelectedNode(-1)}
        onMoveDown={() => moveSelectedNode(1)}
        onDelete={removeSelectedNode}
        onOpenNotices={openNotices}
        onToggleTheme={toggleTheme}
        onCopyPreview={copyPreview}
      />

      <main className="body" ref={bodyRef}>
        <ElementsColumn
          items={elementOutline}
          activeNodeId={activeNode.id}
          issueNodeIds={issueNodeIds}
          onSelectNode={selectNode}
        />

        <section className="column input">
          <h2 className="element-title">{lineTitle}</h2>

          <label className="field-label" htmlFor={TAG_NAME_INPUT_ID}>
            Tag Name
          </label>
          <input
            id={TAG_NAME_INPUT_ID}
            name="tagName"
            value={activeNode.tagName}
            aria-invalid={tagNameHasIssue || undefined}
            className={cx("tag-name-input", tagNameHasIssue && "input-error")}
            onCompositionStart={() => {
              isTagComposingRef.current = true;
            }}
            onCompositionEnd={(event) => {
              isTagComposingRef.current = false;
              setActiveTagName(event.currentTarget.value, false);
              clearElementLastAppliedPreset(presetMemoryRef.current, activeNode.id);
              setPresetMessage(null);
            }}
            onBlur={(event) => {
              if (isTagComposingRef.current) {
                isTagComposingRef.current = false;
                setActiveTagName(event.currentTarget.value, false);
              }
            }}
            onChange={(event) => {
              const nativeComposing = Boolean(
                (event.nativeEvent as { isComposing?: boolean } | undefined)?.isComposing
              );
              setActiveTagName(event.target.value, isTagComposingRef.current || nativeComposing);
              clearElementLastAppliedPreset(presetMemoryRef.current, activeNode.id);
              setPresetMessage(null);
            }}
          />
          {activeTagNameMessage && (
            <div className="field-message is-warning" role="alert">
              {activeTagNameMessage.text}
            </div>
          )}

          <PresetChipsBar
            presetChips={presetChips}
            editMode={editMode}
            editingChip={editingChip}
            chipEditMessage={chipEditMessage}
            activePresetMessage={activePresetMessage}
            onInsertPreset={insertPreset}
            onToggleEditMode={toggleEditMode}
            onStartAddChip={startAddChip}
            onStartRenameChip={startRenameChip}
            onUpdateEditingDraft={updateEditingChipDraft}
            onCommitChipEdit={commitChipEdit}
            onBlurChipEdit={blurChipEdit}
            onCancelChipEdit={cancelChipEdit}
            onRemoveChip={removeChip}
            onRequestResetPresets={requestResetPresets}
          />

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

          {/* Strip text can include raw child-process stderr from the Rust
              clipboard fallback — keep it rendered strictly as plain text. */}
          {activeStripMessage && (
            <div
              key={activeStripMessage.id}
              className={cx(
                "message-strip",
                activeStripMessage.severity === "warning" && "is-warning"
              )}
              role="alert"
            >
              {activeStripMessage.text}
            </div>
          )}
        </section>

        <PreviewColumn
          xmlPreview={xmlPreview}
          previewLines={previewLines}
          activeNodeId={activeNode.id}
          previewPending={previewPending}
          copyToken={copyToken}
        />
      </main>

      <ModalDialog
        modal={modal}
        noticesText={noticesText}
        noticesError={noticesError}
        ribbonRef={ribbonRef}
        bodyRef={bodyRef}
        fallbackFocusId={TAG_NAME_INPUT_ID}
        onClose={closeModal}
        onConfirm={handleConfirm}
        onRetryNotices={openNotices}
      />
    </div>
  );
}
