import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
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
  MAX_PRESET_CHIPS,
  MAX_PRESET_NAME_LENGTH,
  MAX_XML_BYTES,
  buildElementLabel,
  capCodePoints,
  collectSubtreeIds,
  exceedsByteCap,
  formatMegabytes,
  getCopyReadiness,
  insertAfter,
  nextAvailableSuffix,
  nextSelectionAfterDelete,
  salvagePresetChips,
  validatePresetName,
} from "./helpers";
import { containModalTab } from "./modal-focus";
import { copyXmlToClipboard, requestMainWindowShowAfterFirstPaint } from "./tauri";
import type { NodeOutlineItem, XmlNode } from "./types";
import { buildPreview, validateDocument } from "./xml";

// Default preset chip list. Becomes the starting state, and the target of
// the Reset action. The list is editable at runtime in the UI (cog button
// → edit mode), persisted to localStorage between sessions.
const DEFAULT_PRESET_CHIPS = ["feedback", "question", "instruction", "extra"] as const;

// MAX_PRESET_CHIPS lives in helpers.ts with the salvage logic that
// enforces it on the storage read path.

// localStorage key for the persisted theme. Written ONLY on user toggle
// (see toggleTheme) — a user who never toggles keeps following the OS
// preference on every launch instead of having the first launch's
// fallback frozen in. public/theme-bootstrap.js reads the same key but
// can't import this constant (it's a pre-bundle external script) — keep
// the literal there in sync.
const THEME_STORAGE_KEY = "theme";

// localStorage key for the persisted chip list. Same shape as the theme
// key just above — read on first render, written on every change.
const PRESET_CHIPS_STORAGE_KEY = "presetChips";

// Soft cap on tree depth. Past this the recursive walkers in document.ts /
// xml.ts risk a "Maximum call stack size exceeded" RangeError on render.
// Semantics: the root element is at depth 0; the deepest reachable element
// is at depth MAX_DEPTH, so a path from root to leaf can have up to
// MAX_DEPTH + 1 nodes. In practice no document needs anywhere near this;
// the guard exists so runaway "Add Child" clicks can't crash the app.
const MAX_DEPTH = 256;

// Soft cap on direct sibling count under any single parent. addSibling
// allocates a freshly cloned tree + runs four useMemo walkers per click;
// with no breadth bound, scripted/holdable clicks grow work as O(N²) and
// freeze the UI around N≈10k. 1000 is far above any plausible authored
// sibling count and well below the freeze. Symmetric to MAX_DEPTH for the
// breadth axis.
const MAX_SIBLINGS = 1000;

// Per-field byte cap for text content. Without it, pasting hundreds of MB
// into the field locks typing because the validation, preview, and outline
// derivations re-run on every keystroke. The total
// MAX_XML_BYTES = 50 MB cap is enforced at copy time, but the typing-lag
// surface hits well before that when one field gets oversized.
//
// Cap is in UTF-8 bytes for parity with MAX_XML_BYTES. 10 MB allows large
// prompt bodies (~5–10 M ASCII chars). It does NOT bound the total tree
// (enough maxed-out fields exceed 50 MB) — the copy-time exceedsByteCap
// check in copyPreview is the actual total-size defense; don't remove
// that check on the assumption per-field caps cover it.
const MAX_TEXT_CONTENT_BYTES = 10_000_000;

// Cap on tag-name codepoint length. MUST stay ≥ MAX_PRESET_NAME_LENGTH
// plus suffix headroom ("_" + digits): chip apply writes names like
// `<chip>_<N>`, and if a max-length chip name plus its suffix exceeded
// this cap, the NEXT keystroke in the Tag Name field would truncate the
// suffix away (silently renaming the element to the bare chip name).
// 32 = 24 (chip cap) + 1 ("_") + 4 digits + margin — nextAvailableSuffix
// is bounded by the sibling count, which MAX_SIBLINGS caps at 1000, so
// the largest suffix is 1001 (4 digits). Existing tag
// names that exceed this aren't truncated; new typing past it is
// truncated by setActiveTagName with an amber notice. The cap also
// bounds tag-name memory (≤ 4 bytes per codepoint in UTF-8, ≤ 128
// bytes) — no separate byte cap is needed.
const MAX_TAG_NAME_LENGTH = 32;

// Stable element IDs for the form fields in the Input column. Earlier these
// were per-active-node and churned on every selection, confusing autofill
// and a11y caches even though there's only one of each on screen.
const TAG_NAME_INPUT_ID = "tag-name-input";
const TEXT_CONTENT_INPUT_ID = "text-content-input";

type Theme = "dark" | "light";

// The message strip at the bottom of the Input column. One object atom
// (not separate text/severity/forNodeId atoms) for two reasons: the
// fields are one logical value, and a FRESH object on every set means
// React can never bail out of a rejection-path commit — repeating an
// identical rejection (e.g. pasting the same oversized blob twice)
// still re-renders, so the controlled inputs always resync to state.
// `severity`: red = action failed/blocked, amber = action succeeded
// with a side effect worth noting. `forNodeId`: non-null scopes the
// message to one element (hidden elsewhere, cleared for good when the
// user navigates away — see selectNode); null = global.
type StripMessage = {
  text: string;
  severity: "error" | "warning";
  forNodeId: string | null;
};

// Field-level message: renders just below its own form field (not in
// the column-bottom strip) and is always element-scoped — `forNodeId`
// is non-null BY TYPE, a deliberate contrast with StripMessage's
// nullable forNodeId (which supports global messages). A render-time
// check shows the message only while its element stays selected, so
// switching elements hides it without an effect+setState dance. No
// severity field: every field message today is an amber warning
// (errors live in the strip) — add severity back only when a red
// field message actually exists.
type FieldMessage = {
  text: string;
  forNodeId: string;
};

// Chip-editor message (rendered below the chip row in edit mode). Not a
// FieldMessage: chip editing is not element-scoped, so there is no
// forNodeId — but it carries severity because both red (rejected
// commit) and amber (typing-time truncation notice) cases exist, per
// the app-wide discipline: red = blocked, amber = succeeded with a
// side effect.
type ChipEditMessage = {
  text: string;
  severity: "error" | "warning";
};

// Generic confirmation-modal request. Destructive replace/reset actions
// share this primitive instead of each owning a separate showFoo flag. The
// `confirmKind` controls the styling of the confirm button — "danger"
// gets the red `danger-button` treatment, omitted stays neutral.
type ConfirmRequest = {
  title: string;
  description: string;
  confirmLabel: string;
  confirmKind?: "danger";
  onConfirm: () => void;
};

// State for an in-flight chip edit (rename or add). `index` is the chip's
// position in presetChips (or `presetChips.length` for a new chip).
// `isNew` flags add-vs-rename so commit knows which mutation to do.
type EditingChip = {
  index: number;
  draft: string;
  isNew: boolean;
};

// Per-element preset state. `lastApplied` is the chip name most recently
// applied to this element; clicking the same chip again is a no-op while
// this matches. `history` records, for each chip ever used on this
// element, the exact tag name that was written — so clicking chip A
// (yields A_3), then chip B (yields B_1), then A again restores A_3
// rather than recomputing a fresh A_4. Manual edits to the tag name
// clear `lastApplied` (so the next chip click applies) but preserve
// `history` (so a subsequent chip click restores its prior name). This
// comment is the local maintenance contract; external design notes may
// repeat it, but the product repo must remain understandable alone.
type ElementPresetMemory = {
  lastApplied: string | null;
  history: Map<string, string>;
};

// Read the persisted preset chip list (if any) and validate it before
// trusting localStorage. Anything that fails the shape/validity check
// quietly falls back to the defaults — better than carrying a corrupt
// list forward across sessions.
function readInitialPresetChips(): string[] {
  if (typeof window === "undefined") {
    return [...DEFAULT_PRESET_CHIPS];
  }
  try {
    const stored = localStorage.getItem(PRESET_CHIPS_STORAGE_KEY);
    if (stored) {
      // All salvage semantics (valid-subset keep, empty-list
      // preservation, over-count trim, all-invalid → null) live in
      // salvagePresetChips — pure and unit-tested in helpers.ts.
      const salvaged = salvagePresetChips(JSON.parse(stored));
      if (salvaged !== null) {
        return salvaged;
      }
    }
  } catch {
    // localStorage unavailable or JSON parse failed — fall through to
    // defaults.
  }
  return [...DEFAULT_PRESET_CHIPS];
}

// Read the initial theme from the same source the external bootstrap
// script (public/theme-bootstrap.js, loaded from index.html) uses, so
// React state and the DOM data-theme attribute agree from the very first
// render. Falls back to system preference, then dark.
function readInitialTheme(): Theme {
  if (typeof window === "undefined") {
    return "dark";
  }
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "dark" || stored === "light") {
      return stored;
    }
  } catch {
    // localStorage unavailable — fall through to system preference.
  }
  try {
    if (window.matchMedia?.("(prefers-color-scheme: light)").matches) {
      return "light";
    }
  } catch {
    // matchMedia can throw in some sandboxed embeds. theme-bootstrap.js
    // guards this same probe — the two readers claim to mirror each
    // other, so the exception coverage must match too.
  }
  return "dark";
}

export default function App() {
  // The document is a forest: top-level sections are siblings with no
  // wrapper element. The invariant "roots is never empty" is maintained
  // by the delete handler (deleting the last section resets to blank).
  const [roots, setRoots] = useState<XmlNode[]>(createBlankDocument);
  // Lazy initializer reads roots[0].id only on first render. Without
  // the wrapper, the property access fires on every render even though
  // React ignores the value after mount.
  const [selectedNodeId, setSelectedNodeId] = useState(() => roots[0].id);
  // Message strip state — see the StripMessage type for the full
  // semantics (single-object-atom rationale, severity, node scoping).
  const [stripMessage, setStripMessage] = useState<StripMessage | null>(null);
  // Increments on each successful Copy XML; used as a key on the bloom overlay
  // to force remount and replay the CSS animation each time.
  const [copyToken, setCopyToken] = useState(0);
  // Generic confirmation modal state. `null` = closed; an object request =
  // open with the given title/description/buttons. Destructive replace/reset
  // actions surface their confirm dialog through this single primitive
  // rather than each owning a separate showFoo flag.
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  const [noticesOpen, setNoticesOpen] = useState(false);
  const [noticesText, setNoticesText] = useState<string | null>(null);
  const [noticesError, setNoticesError] = useState(false);
  const noticesLoadingRef = useRef(false);
  const [theme, setTheme] = useState<Theme>(readInitialTheme);

  // User-customizable preset chip list, persisted to localStorage. The
  // initial value is read from storage (with shape validation); a useEffect
  // below writes back on every change.
  const [presetChips, setPresetChips] = useState<string[]>(readInitialPresetChips);

  useEffect(() => {
    requestMainWindowShowAfterFirstPaint();
  }, []);

  // Edit-mode toggle for the preset chip row. When false: the row shows
  // chips and a cog button; clicking a chip fills the active tag name
  // (the normal "use" behavior). When true: chips also show × delete
  // buttons, a + button appears at the end (when count < MAX_PRESET_CHIPS)
  // for adding new chips, a Reset button appears for restoring defaults,
  // and clicking a chip's text becomes the rename trigger.
  const [editMode, setEditMode] = useState(false);

  // The chip currently being renamed or newly added. `null` when no edit
  // is in flight. `index` is the position in `presetChips` (or one past
  // the end for a new chip); `draft` holds the in-flight text; `isNew`
  // distinguishes add (commit creates a new entry) from rename (commit
  // overwrites the existing one).
  const [editingChip, setEditingChip] = useState<EditingChip | null>(null);

  // Per-edit validation message shown below the chip row when a commit
  // is rejected (empty / too long / invalid XML name / case-insensitive
  // duplicate) or a typing-time truncation occurs — see ChipEditMessage
  // for the severity split. Cleared on successful commit or cancel.
  const [chipEditMessage, setChipEditMessage] = useState<ChipEditMessage | null>(null);

  // Field-level message attached to the Tag Name input. Scoping and
  // render-time gating semantics live on the FieldMessage type.
  const [tagNameMessage, setTagNameMessage] = useState<FieldMessage | null>(null);

  // Field-level message for the preset chip row. Today carries one
  // case: the user clicked an already-applied chip (lastApplied lock),
  // which is a no-op — the warning explains why nothing happened.
  const [presetMessage, setPresetMessage] = useState<FieldMessage | null>(null);

  // In-flight guard for Copy XML. Without it, rapid clicks queue concurrent
  // IPC calls and arboard's global Windows clipboard handle races between
  // them. Single boolean ref prevents re-entry until the active call settles.
  const copyInFlight = useRef(false);

  // Cancel-button focus target for the New Blank confirmation modal.
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Whether the modal overlay's last mousedown / mouseup each landed on
  // the overlay itself (not inside the dialog) — consumed by the
  // overlay's onClick. Both ends are tracked because the click event
  // alone can't decide: a press and release on DIFFERENT elements
  // dispatches click at their common ancestor, which IS the overlay, so
  // target === currentTarget passes there even when one end of the
  // gesture was inside the dialog.
  const overlayPressedRef = useRef(false);
  const overlayReleasedRef = useRef(false);

  // Refs on the ribbon and body so the modal's focus trap can mark them
  // inert while the dialog is open (see the confirmRequest effect below).
  // Using the DOM .inert property directly avoids depending on @types/react's
  // inert prop typing, which shifts across minor versions.
  const ribbonRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLElement>(null);

  // Per-element preset state, keyed by node id. Tracks which chip was last
  // applied (to make repeat clicks of the same chip a no-op) and what tag
  // name each chip last produced on this element (so switching to another
  // chip and back restores the original suffix instead of recomputing a
  // fresh one). Lives in a ref because none of this state drives rendering
  // — the visible tag name comes from `roots`, which the chip
  // handlers update via setRoots. Storage cost is tiny: a 100-
  // element doc fully cycled is ~10 KB. Lifecycle: entries are added on
  // first chip use against an element, swept on element delete, scrubbed
  // when visible chips are renamed/deleted/reset, and wiped wholesale on
  // New Blank.
  const presetMemoryRef = useRef<Map<string, ElementPresetMemory>>(new Map());

  const getPresetMemory = (nodeId: string): ElementPresetMemory => {
    let memory = presetMemoryRef.current.get(nodeId);
    if (!memory) {
      memory = { lastApplied: null, history: new Map() };
      presetMemoryRef.current.set(nodeId, memory);
    }
    return memory;
  };

  const forgetPresetMemoryForChip = (chipName: string) => {
    for (const memory of presetMemoryRef.current.values()) {
      memory.history.delete(chipName);
      if (memory.lastApplied === chipName) {
        memory.lastApplied = null;
      }
    }
  };

  // Preview is the slow recompute (string join over textContent that may be
  // large). Deferring its input lets typing in the Tag Name / Text Content
  // inputs stay responsive — React keeps the previous preview frame visible
  // until the new one is ready. Validation, outline, and the input column
  // continue to use the latest roots for immediate feedback.
  const deferredRoots = useDeferredValue(roots);

  // Keep the DOM attribute in sync with state. public/theme-bootstrap.js
  // sets the initial attribute pre-render; this effect handles every
  // change after that. Persistence is NOT here — writing on mount would
  // freeze the system-preference fallback into storage on first launch,
  // so later OS light/dark changes would never be honored again. Storage
  // writes live in toggleTheme: only an explicit user choice persists.
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  // Transient-notice flags: true while the message strip is showing a
  // self-expiring notice, so the matching expiry path can clear it the
  // moment its condition stops holding. copyWaitNoticeRef = "preview is
  // still updating" (expires when the preview catches up);
  // copyBusyNoticeRef = "a copy is already in progress" (expires when
  // the in-flight copy settles). Every other message path resets both
  // flags (in the helpers below), so an expiry clear can never wipe an
  // unrelated message.
  const copyWaitNoticeRef = useRef(false);
  const copyBusyNoticeRef = useRef(false);

  // Message-strip helpers. Centralized so every site that surfaces a
  // user-facing message also sets the right severity, instead of every
  // call having to remember to set both pieces of state. Errors stop or
  // refuse an action; warnings let it proceed but flag a side effect.
  const showError = (text: string, forNodeId: string | null = null) => {
    copyWaitNoticeRef.current = false;
    copyBusyNoticeRef.current = false;
    setStripMessage({ text, severity: "error", forNodeId });
  };
  const showWarning = (text: string, forNodeId: string | null = null) => {
    copyWaitNoticeRef.current = false;
    copyBusyNoticeRef.current = false;
    setStripMessage({ text, severity: "warning", forNodeId });
  };
  // useCallback (unlike its showError / showWarning siblings, which only
  // event handlers call): the preview-catch-up effect lists this as a
  // dependency, so it needs a stable identity. Closes over stable values
  // only (refs + setState).
  const clearMessage = useCallback(() => {
    copyWaitNoticeRef.current = false;
    copyBusyNoticeRef.current = false;
    setStripMessage(null);
  }, []);

  // localStorage write failures (corrupt webview profile, disk full)
  // would otherwise be fully silent: the edit appears to take effect,
  // then reverts next launch with no signal in either session. Amber,
  // not red — the in-session action itself succeeded. One-shot per
  // session: the first failure already says persistence is broken;
  // repeating it on every subsequent edit would be noise. Sets the
  // strip directly instead of calling showWarning so the useCallback
  // closes over stable values only (refs + setState) — the chip-persist
  // effect below can then list it as a dependency without re-running
  // on every render.
  const storageWarningShownRef = useRef(false);
  const warnStorageWriteFailed = useCallback((what: string) => {
    if (storageWarningShownRef.current) {
      return;
    }
    storageWarningShownRef.current = true;
    copyWaitNoticeRef.current = false;
    copyBusyNoticeRef.current = false;
    setStripMessage({
      text: `Couldn't save your ${what} — the change works for this session but will reset on next launch (storage unavailable).`,
      severity: "warning",
      forNodeId: null,
    });
  }, []);

  // Persist preset chips on change. readInitialPresetChips picks them
  // back up next session via the same storage key. The initial array is
  // deliberately NOT written back (reference check below): writing on
  // mount would freeze DEFAULT_PRESET_CHIPS into storage on first-ever
  // launch, so a user who never edits chips would stop receiving updated
  // defaults — the same frozen-first-launch hazard THEME_STORAGE_KEY
  // documents, solved the same way (persist only on user action; every
  // chip edit produces a new array). The reference check also holds
  // under StrictMode's double effect run.
  const initialPresetChipsRef = useRef(presetChips);
  useEffect(() => {
    if (presetChips === initialPresetChipsRef.current) {
      return;
    }
    try {
      localStorage.setItem(PRESET_CHIPS_STORAGE_KEY, JSON.stringify(presetChips));
    } catch {
      // Storage failure must not break chip editing, but it must not be
      // silent either — the edit looks successful and then reverts next
      // launch. Surface it once (see warnStorageWriteFailed).
      warnStorageWriteFailed("preset chips");
    }
  }, [presetChips, warnStorageWriteFailed]);

  const toggleTheme = () => {
    // Compute outside the updater: persisting inside the setState reducer
    // would be a side effect in what StrictMode double-invokes.
    const next = theme === "dark" ? "light" : "dark";
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Same visibility rationale as the chip-persist catch above.
      warnStorageWriteFailed("theme choice");
    }
    setTheme(next);
  };

  const activeNode = useMemo(
    () => findNode(roots, selectedNodeId) ?? roots[0],
    [roots, selectedNodeId]
  );

  const validationIssues = useMemo(() => validateDocument(roots), [roots]);

  const issueNodeIds = useMemo(
    () => new Set(validationIssues.map((issue) => issue.nodeId)),
    [validationIssues]
  );

  // Validation against the deferred roots, used to gate the on-screen
  // preview. The build runs against deferredRoots, so the gate must too —
  // otherwise the live-roots validation could pass while deferredRoots is
  // briefly invalid in a transient frame, and renderNode would emit
  // malformed lines like `<>...</>`.
  const deferredValidationIssues = useMemo(() => validateDocument(deferredRoots), [deferredRoots]);

  // Single buildPreview call serves the on-screen preview lines. Uses
  // deferredRoots so heavy text content doesn't block typing — the input
  // column shows the latest state immediately, the preview catches up.
  const previewBuild = useMemo(() => {
    if (deferredValidationIssues.length > 0) {
      return { xml: "", lines: [] };
    }
    return buildPreview(deferredRoots);
  }, [deferredRoots, deferredValidationIssues]);
  const previewPending = deferredRoots !== roots;
  const xmlPreview = previewBuild.xml;
  const previewLines = previewBuild.lines;

  // Clear the "preview is still updating" copy refusal once the preview
  // catches up — the message's own condition is gone, so leaving it on
  // screen would tell the user Copy XML is unavailable when it works.
  useEffect(() => {
    if (!previewPending && copyWaitNoticeRef.current) {
      clearMessage();
    }
  }, [previewPending, clearMessage]);

  // Selecting an element from the list. Node-scoped messages — the
  // global strip AND the field-level tag-name / preset messages — die on
  // navigate-away, for good, not just visually: without the clear, a
  // stale message ("Sibling count limit reached") would resurface on
  // RESELECTING the node even after the condition stopped holding.
  // Global messages (errorForNodeId === null) survive navigation. Every
  // other selection-changing path (add/delete/new-blank) calls
  // clearMessage + clearFieldMessages unconditionally; the render-time
  // forNodeId gates stay as pure defense.
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

  // For any action that moots both node-scoped field messages at once —
  // selection changes from structural edits (add / delete / new-blank)
  // and a successful chip apply. Clearing outright (not render-gating)
  // matters for the structural cases: a gated-invisible message would
  // resurface on reselecting the original node, or sit forever against
  // a deleted id. The global strip is handled separately by each caller
  // via clearMessage.
  const clearFieldMessages = () => {
    setTagNameMessage(null);
    setPresetMessage(null);
  };

  const elementOutline = useMemo(() => createElementOutline(roots), [roots]);

  // The tag-name field-level message, gated on the element it was
  // raised for. Every selection-changing path clears field messages for
  // good (selectNode conditionally, structural edits via
  // clearFieldMessages); this render gate stays as defense so a message
  // can never show against the wrong element. If the user comes back
  // and is still at the cap, typing a key fires a fresh message.
  const activeTagNameMessage =
    tagNameMessage && tagNameMessage.forNodeId === activeNode.id ? tagNameMessage : null;
  const activePresetMessage =
    presetMessage && presetMessage.forNodeId === activeNode.id ? presetMessage : null;
  const activeStripMessage =
    stripMessage && (stripMessage.forNodeId === null || stripMessage.forNodeId === activeNode.id)
      ? stripMessage
      : null;

  // null parent = top-level section; its sibling list is the forest
  // itself, so Move / Add Sibling / Delete work uniformly at every level.
  const activeParent = useMemo(() => findParent(roots, activeNode.id), [activeNode.id, roots]);
  const activeSiblings = activeParent ? activeParent.children : roots;
  const activeSiblingIndex = activeSiblings.findIndex((child) => child.id === activeNode.id);
  const canMoveUp = activeSiblingIndex > 0;
  const canMoveDown = activeSiblingIndex >= 0 && activeSiblingIndex < activeSiblings.length - 1;
  // Invalid XML names are the only element issue: same-name sibling tags
  // are normal Claude prompt structure and do not surface warnings.
  const tagNameHasIssue = issueNodeIds.has(activeNode.id);
  const trimmedTag = activeNode.tagName.trim();
  const lineTitle = trimmedTag ? `<${trimmedTag}>` : "(empty tag)";
  // Depth of the currently active element. Read from the already-computed
  // outline rather than walking the tree again. The find() should never
  // miss — activeNode falls back to roots[0], which is always at
  // outline[0]. Fail closed (?? MAX_DEPTH) rather than open (?? 0) so
  // a missed lookup refuses Add Child instead of silently bypassing the
  // depth guard. The "Element nesting depth limit reached" message in
  // that path is technically misleading, but the alternative is unbounded
  // recursion if the invariant ever breaks.
  const activeDepth = elementOutline.find((item) => item.id === activeNode.id)?.depth ?? MAX_DEPTH;

  const closeConfirm = () => {
    setConfirmRequest(null);
    setNoticesOpen(false);
  };

  const openNotices = async () => {
    setNoticesOpen(true);
    if (noticesText !== null || noticesLoadingRef.current) return;
    noticesLoadingRef.current = true;
    setNoticesError(false);
    try {
      const response = await fetch("./third-party-notices.txt");
      if (!response.ok) throw new Error("Bundled notices unavailable");
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
    if (!confirmRequest) {
      return;
    }
    confirmRequest.onConfirm();
    setConfirmRequest(null);
  };

  const requestNewBlank = () => {
    setConfirmRequest({
      title: "Discard current document?",
      description: "This will replace the document with a fresh blank.",
      confirmLabel: "Confirm",
      confirmKind: "danger",
      onConfirm: () => {
        const nextRoots = createBlankDocument();
        setRoots(nextRoots);
        setSelectedNodeId(nextRoots[0].id);
        clearMessage();
        clearFieldMessages();
        // New document means every old node ID is gone — wipe the entire
        // memory map so it doesn't accumulate orphan entries across many
        // "new blank" cycles.
        presetMemoryRef.current.clear();
      },
    });
  };

  const requestResetPresets = () => {
    setConfirmRequest({
      title: "Restore default preset chips?",
      description: `This will replace your current chips with ${DEFAULT_PRESET_CHIPS.join(" / ")}.`,
      confirmLabel: "Restore",
      onConfirm: () => {
        setPresetChips([...DEFAULT_PRESET_CHIPS]);
        setEditMode(false);
        setEditingChip(null);
        setChipEditMessage(null);
        setPresetMessage(null);
        // Wholesale wipe is deliberate, not laziness: node IDs all
        // survive a chips-only reset, but per-element history maps
        // chip NAMES to applied tag names — after the chip set swaps
        // back to defaults, surviving same-named chips (an unrenamed
        // "feedback") carrying pre-reset history would restore stale
        // suffixes. Resetting the chip system resets its memory.
        presetMemoryRef.current.clear();
      },
    });
  };

  // === Chip edit-mode helpers ===
  // The cog button toggles edit mode. Ordering with an edit in flight:
  // the cog's mousedown blurs the edit input, and blur commits the draft
  // (onBlur={commitChipEdit}) BEFORE the click reaches this handler — a
  // valid half-typed draft is therefore saved, not discarded. The
  // cleanup below only clears an edit left open by a failed blur-commit
  // (invalid draft plus its error text).
  const toggleEditMode = () => {
    setPresetMessage(null);
    // Branch on the render-closure editMode, NOT inside a setEditMode
    // updater: updaters must be pure (StrictMode double-invokes them),
    // so sibling setState calls don't belong in one — same discipline
    // toggleTheme documents for its storage write.
    if (editMode) {
      setEditingChip(null);
      setChipEditMessage(null);
    }
    setEditMode(!editMode);
  };

  const removeChip = (index: number) => {
    const removedName = presetChips[index];
    if (removedName) {
      forgetPresetMemoryForChip(removedName);
    }
    setPresetMessage(null);
    // Drop any in-flight edit error: it may name the chip being deleted
    // ("X is already in your preset list" — false once X is gone), and
    // even when it doesn't, the edit input stays open and its next
    // commit re-validates against the updated list anyway.
    setChipEditMessage(null);
    setPresetChips((chips) => chips.filter((_, i) => i !== index));
    // An in-flight edit can coexist with this delete only as a RENAME of
    // a DIFFERENT chip or as the trailing NEW-chip input (neither edit
    // form renders a × button on itself). Renames shift their index when
    // an earlier chip disappears; a pending add keeps its stale
    // one-past-the-end index harmlessly — commit indexes by it for
    // renames only and appends for adds.
    setEditingChip((current) => {
      if (current && !current.isNew && current.index > index) {
        return { ...current, index: current.index - 1 };
      }
      return current;
    });
  };

  const startAddChip = () => {
    // Position is one past the end — the new chip lives there if commit
    // succeeds. The + button is hidden while any edit is in flight, so
    // there's no risk of two pending adds clashing on the same index.
    setEditingChip({
      index: presetChips.length,
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

  const updateEditingChipDraft = (draft: string) => {
    if (!editingChip) {
      return;
    }
    // Same cap + visible-signal pattern as the Tag Name field: silent
    // truncation would let a pasted overlong name commit as an
    // unnoticed prefix. The message self-clears on the next
    // non-truncating keystroke (and on commit/cancel as before).
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
    // Validation only at commit per user spec — typing doesn't surface
    // validation messages. Pre-trim so trailing whitespace doesn't
    // produce a "looks identical to chip X" duplicate that the user
    // can't see.
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
      forgetPresetMemoryForChip(trimmed);
      setPresetChips((chips) => [...chips, trimmed]);
    } else {
      const previousName = presetChips[editingChip.index];
      if (previousName && previousName !== trimmed) {
        forgetPresetMemoryForChip(previousName);
        forgetPresetMemoryForChip(trimmed);
      }
      setPresetChips((chips) => chips.map((c, i) => (i === editingChip.index ? trimmed : c)));
    }
    setEditingChip(null);
    setChipEditMessage(null);
    setPresetMessage(null);
  };

  const addChild = () => {
    // Soft depth guard — refuse rather than risk stack overflow on render.
    if (activeDepth >= MAX_DEPTH) {
      showError(`Element nesting depth limit reached (${MAX_DEPTH}).`, activeNode.id);
      return;
    }
    // Sibling-count guard, symmetric with addSibling. Add Child grows
    // activeNode.children which addSibling would also grow; without this
    // guard, holding Add Child reproduces the same O(N²) UI freeze the
    // breadth cap was added to prevent.
    if (activeNode.children.length >= MAX_SIBLINGS) {
      // "Child count" in the user's vocabulary — the cap is the same
      // MAX_SIBLINGS breadth axis, but the user is adding a child.
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
    // Top-level sections are siblings in the forest, so Add Sibling is
    // legal at every level — a null parent means "insert a new top-level
    // section after the active one". The MAX_SIBLINGS breadth cap applies
    // to the forest the same as to any children array.
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

  const removeSelectedNode = () => {
    // Min-one-section invariant: deleting the LAST remaining top-level
    // section would empty the forest, so this path resets to the blank
    // starter instead. This reaches the same "replace document" outcome
    // as New Blank, so it uses the same confirmation primitive instead
    // of becoming a one-click irreversible wipe.
    if (!activeParent && roots.length === 1) {
      setConfirmRequest({
        title: "Clear the only section?",
        description: "This will replace the current section with a fresh blank.",
        confirmLabel: "Clear",
        confirmKind: "danger",
        onConfirm: () => {
          const nextRoots = createBlankDocument();
          setRoots(nextRoots);
          setSelectedNodeId(nextRoots[0].id);
          clearMessage();
          clearFieldMessages();
          // Every old node ID is gone — wipe the whole memory map, same as
          // the New Blank path.
          presetMemoryRef.current.clear();
        },
      });
      return;
    }

    // Mixed pattern: closure reads for activeParent / activeSiblings /
    // roots[0].id, functional updater for the tree mutation. Safe because
    // nothing else replaces the forest between this render's closure and
    // the updater run. Other handlers in this file commit to functional
    // updaters; the closure reads here are intentional, not an oversight.
    //
    // Pick the next selection BEFORE deletion so sibling indices are
    // stable. Preference: previous sibling > next sibling > parent.
    // Matches list-editor convention (file managers, table row deletes)
    // where focus collapses toward the nearest neighbor, not up a level.
    const target = nextSelectionAfterDelete(
      activeSiblings,
      activeNode.id,
      activeParent?.id ?? null,
      roots[0].id
    );

    // Sweep presetMemory for the deleted node and all its descendants —
    // those IDs no longer exist anywhere in the forest, so leaving entries
    // keyed by them is a small per-delete leak. Only the deleted subtree
    // is swept; siblings' memories are untouched. The "freed-suffix slot
    // flows into sibling chip behavior" extension was discussed and
    // skipped — that rabbit hole has no bottom.
    const deletedIds = collectSubtreeIds(activeNode);
    for (const id of deletedIds) {
      presetMemoryRef.current.delete(id);
    }

    setRoots((current) => deleteNode(current, activeNode.id));
    setSelectedNodeId(target);
    clearMessage();
    clearFieldMessages();
  };

  const moveSelectedNode = (direction: -1 | 1) => {
    const canMove = direction === -1 ? canMoveUp : canMoveDown;
    // Boundary siblings have no swap target; skip the work so the
    // visible disabled-state contract matches the mutation path.
    if (!canMove) {
      return;
    }
    setRoots((current) => moveNode(current, activeNode.id, direction));
    clearMessage();
  };

  const setActiveTagName = (rawTagName: string) => {
    // Cap via capCodePoints (helpers.ts) — code-point walk that stops at
    // the cap, so a multi-MB paste into this field (which deliberately
    // has no maxLength) costs O(MAX_TAG_NAME_LENGTH), and supplementary-
    // plane chars don't get split. The equality check below is the
    // truncation detector; the notice routes to tagNameMessage (rendered
    // immediately below the input) instead of the global bottom strip —
    // the alert is about THIS field, so the cue lives next to it.
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
    // Clear any stale GLOBAL message (depth/sibling/validation/copy) on
    // tag-name edit. The field-level message above is independent.
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
    const memory = getPresetMemory(activeNode.id);

    // Same-chip rapid click → no-op. lastApplied is cleared whenever the
    // tag name is manually edited (see the Tag Name input's onChange), so
    // this only blocks repeat clicks on a chip we just applied or restored.
    // Surface a warning strip explaining why nothing changed; without it
    // the click is silent and the user thinks the app is broken.
    if (memory.lastApplied === chipName) {
      setPresetMessage({
        text: `"${chipName}" is already applied to this element — clicking it won't change the tag name.`,
        forNodeId: activeNode.id,
      });
      return;
    }

    // Decide which name to apply. activeSiblings covers top-level
    // sections too (their sibling list is the forest itself), so chip
    // suffix generation works the same at every level.
    //   - If this chip has been used on this element before, restore the
    //     exact name we wrote last time. Lets the user switch between
    //     chips without losing the original suffix on either side.
    //   - First time the chip touches this element, compute the next-free
    //     `<chip>_<N>` suffix among siblings.
    const previous = memory.history.get(chipName);
    let nameToApply: string;
    if (previous !== undefined) {
      // Restoring a prior same-name tag is fine: repeated tags are valid
      // prompt structure, and the chip memory promise is more useful than
      // forcing a new suffix.
      nameToApply = previous;
    } else {
      const suffix = nextAvailableSuffix(activeSiblings, chipName);
      nameToApply = `${chipName}_${suffix}`;
    }

    // Apply the name directly (skipping setActiveTagName, which would
    // clearMessage and force us to re-set the warning afterward — one
    // extra render). Byte-cap check is unnecessary here: chip names are
    // bounded short by construction, and history values came from a
    // prior valid apply.
    setRoots((current) =>
      updateNode(current, activeNode.id, (node) => ({
        ...node,
        tagName: nameToApply,
      }))
    );

    // Record the apply in memory. lastApplied prevents repeat clicks; the
    // history entry lets a subsequent chip switch restore back here.
    memory.history.set(chipName, nameToApply);
    memory.lastApplied = chipName;

    clearMessage();
    // A successful apply moots both field messages: chip-applied names
    // are bounded by construction (chip ≤ 24 codepoints + "_" + digits,
    // within MAX_TAG_NAME_LENGTH — see that constant's comment), so any
    // stale "reached the limit" warning no longer applies, and we just
    // changed which chip is lastApplied.
    clearFieldMessages();
  };

  const copyPreview = async () => {
    // Re-entry guard. Refusing with a VISIBLE notice instead of a silent
    // drop: if a fallback clipboard tool ever wedges the in-flight copy,
    // the silent version turns every later click into "nothing happens"
    // with zero diagnostic signal. The notice self-expires when the
    // in-flight copy settles (see the finally block).
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
          // Set AFTER showWarning — the helper resets the flag as part
          // of "any other message moots the catch-up clear".
          copyWaitNoticeRef.current = true;
          return;
        case "validation":
          showError("Fix validation issues before copying XML.");
          return;
        case "too-large": {
          // The byte count is recomputed only for this message;
          // getCopyReadiness already paid one encode pass to decide, so
          // the worst case is two passes — acceptable on an error path.
          const liveBytes = new TextEncoder().encode(xmlPreview).length;
          showError(
            `XML payload too large to copy (${formatMegabytes(liveBytes)}; limit ${formatMegabytes(MAX_XML_BYTES)}).`
          );
          return;
        }
        default: {
          // Exhaustiveness pin: a new CopyReadiness reason must add a
          // case here or this assignment fails to compile. Falling
          // through to a successful copy would invert the helper's
          // purpose, so unknown reasons refuse loudly instead.
          const exhausted: never = copyReadiness.reason;
          showError(`Copy blocked: ${String(exhausted)}.`);
          return;
        }
      }
    }

    // Reaching here means every gate passed. The previewPending refusal
    // above guarantees deferredRoots === roots in this render, so the
    // validationIssues / previewBuild memos ARE the live document's —
    // no fresh validate + build needed. Reusing them also ties the
    // copied payload to the exact build on screen: preview == clipboard
    // by construction. (Stale-copy worry doesn't apply: rapid
    // type-then-click lands in the previewPending refusal, never here.)
    const liveXml = xmlPreview;

    // Clear any stale pre-click message BEFORE awaiting, not on success:
    // an error raised by other input WHILE the copy is in flight (e.g. an
    // oversized paste into Text Content) must survive the copy settling.
    clearMessage();
    copyInFlight.current = true;
    try {
      await copyXmlToClipboard(liveXml);
      // Increment token → bloom overlay remounts → CSS animation replays.
      // Q5 locked: green is reserved for Copy XML success only.
      setCopyToken((t) => t + 1);
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
      showError(message);
    } finally {
      copyInFlight.current = false;
      // The "copy already in progress" notice (raised by overlapping
      // clicks above) has expired now that this copy settled. showError
      // in the catch arm resets the flag, so a failure message is never
      // wiped here.
      if (copyBusyNoticeRef.current) {
        clearMessage();
      }
    }
  };

  // Keep initial focus, background blocking, Escape, and focus restoration
  // together. The modal key handler also wraps Tab: inert alone does not
  // prevent keyboard focus from leaving the webview at the last control.
  useEffect(() => {
    if (!confirmRequest && !noticesOpen) {
      return;
    }
    // Capture the element that triggered the modal so focus can return
    // there on close. Falls back to null if active element is something
    // other than HTMLElement (e.g., SVG elements aren't focusable here).
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelButtonRef.current?.focus();
    const ribbon = ribbonRef.current;
    const body = bodyRef.current;
    if (ribbon) ribbon.inert = true;
    if (body) body.inert = true;
    const handleKey = (event: KeyboardEvent) => {
      if (dialogRef.current) {
        containModalTab(event, dialogRef.current);
      }
      if (event.key === "Escape") {
        // Route through closeConfirm — the single close idiom shared
        // with Cancel and overlay-dismiss, so future close-time cleanup
        // can't miss the Escape path.
        closeConfirm();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("keydown", handleKey);
      if (ribbon) ribbon.inert = false;
      if (body) body.inert = false;
      // Restore focus AFTER un-inerting — focusing an inert element is a
      // silent no-op, so order matters here.
      if (previouslyFocused?.isConnected) {
        previouslyFocused.focus();
      } else {
        document.getElementById(TAG_NAME_INPUT_ID)?.focus();
      }
    };
  }, [confirmRequest, noticesOpen]);

  return (
    <div className="app-shell">
      <header className="ribbon" ref={ribbonRef}>
        {/* Three-zone layout: anchor-left | cluster (centered, flex: 1) |
            anchor-right. New Blank and Copy XML are the two anchor actions
            — the things the user is most likely to do — and read as equal
            visual weight. The five per-element operations sit in the center
            cluster as a visually compact group with no internal divider.
            All ribbon buttons carry `tabIndex={-1}` so the keyboard tab
            cycle is just Tag Name ↔ Text Content (per user spec). They
            stay mouse-clickable as before. */}
        <button type="button" className="new-blank-button" tabIndex={-1} onClick={requestNewBlank}>
          New Blank
        </button>

        <div className="ribbon-cluster">
          <button type="button" tabIndex={-1} onClick={addChild}>
            Add Child
          </button>
          <button type="button" tabIndex={-1} onClick={addSibling}>
            Add Sibling
          </button>
          <button
            type="button"
            tabIndex={-1}
            onClick={() => moveSelectedNode(-1)}
            disabled={!canMoveUp}
          >
            Move Up
          </button>
          <button
            type="button"
            tabIndex={-1}
            onClick={() => moveSelectedNode(1)}
            disabled={!canMoveDown}
          >
            Move Down
          </button>
          {/* Always enabled — deleting the last remaining top-level
              section resets to the blank starter (min-one invariant). */}
          <button
            type="button"
            className="danger-button"
            tabIndex={-1}
            onClick={removeSelectedNode}
          >
            Delete
          </button>
        </div>

        <div className="ribbon-right">
          <button type="button" onClick={openNotices} aria-label="Third-party licenses">
            Licenses
          </button>
          {/* Theme toggle is a meta/settings control, not a document action,
              so it sits with the Copy XML anchor on the right. The icon
              shown is the destination (sun = "click to go light", moon =
              "click to go dark"). */}
          <button
            type="button"
            className="theme-toggle"
            tabIndex={-1}
            onClick={toggleTheme}
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          >
            {theme === "dark" ? <SunIcon /> : <MoonIcon />}
          </button>
          <button type="button" className="copy-button" tabIndex={-1} onClick={copyPreview}>
            Copy XML
          </button>
        </div>
      </header>

      <main className="body" ref={bodyRef}>
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
                  className={cx(
                    "element-row",
                    `depth-${Math.min(item.depth, 12)}`,
                    isActive && "is-active",
                    hasIssue && "has-issue"
                  )}
                  aria-current={isActive ? "true" : undefined}
                  tabIndex={-1}
                  // Depth indentation is applied via the `depth-N` class,
                  // not via inline `style={{ "--depth": ... }}`. The
                  // earlier inline-CSS-variable approach silently
                  // collapsed to 0 in production builds: React emits
                  // the `style={{...}}` prop as a parser-time
                  // `style="..."` attribute string in some commit paths
                  // (observed in this app's production builds), which is
                  // governed by CSP `style-src 'self'` and gets
                  // stripped by Chromium. Dev mode (Vite HMR) is more
                  // permissive about CSP, which is why the bug was
                  // invisible until the production exe was inspected.
                  // Class-based padding goes through `class=""` parsing
                  // and is unaffected by `style-src`.
                  //
                  // The cap at 12 mirrors styles.css — there are
                  // `.depth-0` through `.depth-12` rules; rows deeper
                  // than 12 reuse `.depth-12`'s indent (rare in practice;
                  // typical trees are 4–6 deep).
                  onClick={() => selectNode(item.id)}
                >
                  <span className="element-label">{item.label}</span>
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
          <input
            id={TAG_NAME_INPUT_ID}
            name="tagName"
            value={activeNode.tagName}
            className={cx("tag-name-input", tagNameHasIssue && "input-error")}
            // No `maxLength` here on purpose — letting the browser
            // silently truncate would hide the cap from the user.
            // setActiveTagName below truncates AND fires an amber
            // warning so the user knows the cap was hit.
            onChange={(event) => {
              setActiveTagName(event.target.value);
              // Manual typing clears `lastApplied` so the next chip
              // click applies (vs. staying a no-op). `history` is
              // preserved — clicking a previously-used chip afterward
              // still restores its prior tag name on this element.
              const memory = presetMemoryRef.current.get(activeNode.id);
              if (memory) {
                memory.lastApplied = null;
              }
              // Manual typing also moots any stale "already applied"
              // warning — the tag name is no longer "set by chip X".
              setPresetMessage(null);
            }}
          />
          {/* Field-level message anchored to the Tag Name input. Lives
              here (not in the global bottom strip) because it's about
              THIS field's value — the user looks at the input, the cue
              should be next to it. Always amber (see FieldMessage). */}
          {activeTagNameMessage && (
            <div className="field-message is-warning" role="alert">
              {activeTagNameMessage.text}
            </div>
          )}

          <div className="preset-chips">
            <span className="preset-label">Preset:</span>
            <div className="preset-chip-list">
              {presetChips.map((name, index) => {
                const isEditingThis =
                  editingChip !== null && !editingChip.isNew && editingChip.index === index;
                if (isEditingThis) {
                  return (
                    <input
                      // Key namespaces are kept disjoint from chip names:
                      // chip names are user-controlled valid XML Names, so
                      // an unprefixed name key could literally collide
                      // with a sibling's structural key.
                      key={`edit:${index}`}
                      className="chip chip-editing"
                      value={editingChip.draft}
                      autoFocus
                      aria-label={`Rename preset ${name}`}
                      // Active edits stay tabbable so a failed blur commit
                      // never leaves the keyboard user unable to return.
                      tabIndex={0}
                      onChange={(event) => updateEditingChipDraft(event.target.value)}
                      onBlur={commitChipEdit}
                      onKeyDown={(event) => {
                        // Enter/Escape can belong to the IME candidate window.
                        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
                          return;
                        }
                        if (event.key === "Enter") {
                          event.preventDefault();
                          commitChipEdit();
                        } else if (event.key === "Escape") {
                          event.preventDefault();
                          cancelChipEdit();
                        }
                      }}
                    />
                  );
                }
                return (
                  // The pill chrome (background, border, max-width) lives on
                  // the outer span; both the text and × buttons sit *inside*
                  // the pill perimeter so the × visually belongs to the
                  // chip rather than dangling next to it. The "this preset
                  // is already applied" cue is rendered as a warning strip
                  // below the chip row when the user clicks an
                  // already-applied chip — see presetMessage in insertPreset.
                  <span key={`chip:${name}`} className="chip">
                    <button
                      type="button"
                      className="chip-label"
                      tabIndex={-1}
                      onClick={() => {
                        if (editMode) {
                          // Same protection as the + button: with a
                          // rename/add in flight, the blur-commit has
                          // already run — if it FAILED, starting another
                          // rename here would silently discard the
                          // failed draft and its error. Ignore the click
                          // so the user sees the error instead.
                          if (editingChip) {
                            return;
                          }
                          startRenameChip(index);
                        } else {
                          insertPreset(name);
                        }
                      }}
                    >
                      {name}
                    </button>
                    {editMode && (
                      <button
                        type="button"
                        className="chip-delete"
                        aria-label={`Remove preset ${name}`}
                        title={`Remove ${name}`}
                        tabIndex={-1}
                        onClick={() => removeChip(index)}
                      >
                        ×
                      </button>
                    )}
                  </span>
                );
              })}
              {editMode && editingChip?.isNew && (
                <input
                  key="new:chip"
                  className="chip chip-editing"
                  value={editingChip.draft}
                  autoFocus
                  placeholder="new chip name"
                  aria-label="Name the new preset chip"
                  tabIndex={0}
                  onChange={(event) => updateEditingChipDraft(event.target.value)}
                  onBlur={commitChipEdit}
                  onKeyDown={(event) => {
                    // Some IMEs end composition before the final keydown (229).
                    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
                      return;
                    }
                    if (event.key === "Enter") {
                      event.preventDefault();
                      commitChipEdit();
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      cancelChipEdit();
                    }
                  }}
                />
              )}
              {/* Hidden during ANY in-flight edit (add or rename) —
                  clicking + mid-rename would replace editingChip and
                  silently discard the rename's draft and error state. */}
              {editMode && !editingChip && presetChips.length < MAX_PRESET_CHIPS && (
                <button
                  type="button"
                  className="chip-add"
                  aria-label="Add preset chip"
                  title="Add preset chip"
                  tabIndex={-1}
                  onClick={startAddChip}
                >
                  +
                </button>
              )}
            </div>
            <div className="preset-controls">
              {editMode && (
                <button
                  type="button"
                  className="preset-reset"
                  tabIndex={-1}
                  onClick={requestResetPresets}
                >
                  Reset
                </button>
              )}
              <button
                type="button"
                className={cx("preset-cog", editMode && "is-active")}
                onClick={toggleEditMode}
                aria-label={editMode ? "Exit chip edit mode" : "Edit preset chips"}
                aria-pressed={editMode}
                title={editMode ? "Exit chip edit mode" : "Edit preset chips"}
                tabIndex={-1}
              >
                <CogIcon />
              </button>
            </div>
          </div>
          {editMode && chipEditMessage && (
            <div className={`field-message is-${chipEditMessage.severity}`} role="alert">
              {chipEditMessage.text}
            </div>
          )}
          {!editMode && activePresetMessage && (
            <div className="field-message is-warning" role="alert">
              {activePresetMessage.text}
            </div>
          )}

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

          {/* Strip text can include raw child-process stderr forwarded
              from the Rust clipboard fallback — safe ONLY because it
              renders as a React text node. Never switch this (or the
              field messages) to HTML rendering. */}
          {activeStripMessage && (
            <div
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

        <section className="column preview">
          <h2 className="column-title">Preview</h2>
          <div className="preview-pane" aria-busy={previewPending}>
            <div className="preview-scroll">
              {xmlPreview ? (
                previewLines.map((line) => {
                  // Separator lines carry the preceding section's id only
                  // for React-key stability — they belong to no section
                  // visually, so they never paint as active.
                  const isActive = line.kind !== "separator" && line.nodeId === activeNode.id;
                  // Stable per-(node, kind) key — each node produces at most
                  // three lines (open / text / close) or a single self-closing
                  // / single-line, all with distinct kinds. So nodeId+kind is
                  // unique and survives sibling reordering / inserts without
                  // forcing React to rebuild every preview row.
                  return (
                    <div
                      key={`${line.nodeId}-${line.kind}`}
                      className={cx("preview-line", isActive && "is-active")}
                    >
                      <span className="preview-indicator" aria-hidden="true">
                        {isActive && line.primary ? ">" : ""}
                      </span>
                      <span>{line.text}</span>
                    </div>
                  );
                })
              ) : (
                <div className="preview-empty">Fix validation issues to see the preview.</div>
              )}
            </div>
            {previewPending && (
              <div className="preview-updating-note" role="status">
                Preview updating...
              </div>
            )}
            {/* Key on copyToken forces this overlay to remount on each copy,
                replaying the bloom animation. Pointer-events: none ensures it
                doesn't intercept clicks. */}
            {copyToken > 0 && <div key={copyToken} className="bloom-overlay" aria-hidden="true" />}
          </div>
        </section>
      </main>

      {(confirmRequest || noticesOpen) && (
        // Overlay has no explicit role — the inner div carries
        // role="dialog" + aria-modal="true". Keeping a click handler on
        // the overlay for click-outside-to-cancel; AT users have Escape
        // and the focused Cancel button (see useEffect for focus mgmt).
        // The press+release target checks below are the SINGLE dismiss
        // mechanism — the dialog deliberately has no stopPropagation,
        // since target === currentTarget already rejects bubbled clicks.
        <div
          className="modal-overlay"
          onMouseDown={(event) => {
            overlayPressedRef.current = event.target === event.currentTarget;
          }}
          onMouseUp={(event) => {
            overlayReleasedRef.current = event.target === event.currentTarget;
          }}
          onClick={() => {
            // Dismiss only when BOTH press and release landed on the
            // overlay — each end recorded by its own event above. The
            // click target can't decide this alone: press and release
            // on different elements dispatch click at their common
            // ancestor, which is this overlay.
            if (overlayPressedRef.current && overlayReleasedRef.current) {
              closeConfirm();
            }
          }}
        >
          <div
            ref={dialogRef}
            className={cx("confirm-dialog", noticesOpen && "notices-dialog")}
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
            aria-describedby="confirm-desc"
            tabIndex={-1}
          >
            <h3 id="confirm-title">
              {noticesOpen ? "Third-party licenses" : confirmRequest?.title}
            </h3>
            <p id="confirm-desc">
              {noticesOpen
                ? "License and attribution texts for bundled components. Available offline."
                : confirmRequest?.description}
            </p>
            {noticesOpen &&
              (noticesText !== null ? (
                <pre className="license-text" role="region" aria-label="License texts" tabIndex={0}>
                  {noticesText}
                </pre>
              ) : noticesError ? (
                <p role="alert">The bundled license texts could not be loaded. Please try again.</p>
              ) : (
                <p role="status">Loading license texts...</p>
              ))}
            <div className="dialog-buttons">
              {noticesOpen && noticesError && (
                <button type="button" onClick={openNotices}>
                  Retry
                </button>
              )}
              <button type="button" ref={cancelButtonRef} onClick={closeConfirm}>
                {noticesOpen ? "Close" : "Cancel"}
              </button>
              {confirmRequest && (
                <button
                  type="button"
                  className={confirmRequest.confirmKind === "danger" ? "danger-button" : undefined}
                  onClick={handleConfirm}
                >
                  {confirmRequest.confirmLabel}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function createElementOutline(roots: XmlNode[]): NodeOutlineItem[] {
  const items: NodeOutlineItem[] = [];

  const walk = (node: XmlNode, depth: number) => {
    items.push({
      id: node.id,
      depth,
      label: buildElementLabel(node),
    });
    node.children.forEach((child) => walk(child, depth + 1));
  };

  roots.forEach((root) => walk(root, 0));
  return items;
}

// Compose a className from base + conditional class names. Same shape as
// the React community's clsx / classnames libraries — falsy values drop
// out, the rest joins with spaces. Used at every site where we conditionally
// add `is-active` / `has-issue` / `input-error` etc.
function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(" ");
}

function CogIcon() {
  // Minimal cog: outer 8-tooth gear ring + inner circle. Small enough at
  // 1.05rem that detail is read as "settings/edit" without heavy ink.
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
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
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
