import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import {
  createBlankDocument,
  createNode,
  deleteNode,
  findNode,
  findParent,
  moveNode,
  updateNode
} from "./document";
import {
  MAX_PRESET_NAME_LENGTH,
  buildElementLabel,
  collectSubtreeIds,
  exceedsByteCap,
  formatMegabytes,
  insertAfter,
  nextAvailableSuffix,
  nextSelectionAfterDelete,
  validatePresetName
} from "./helpers";
import {
  copyXmlToClipboard,
  requestMainWindowShowAfterFirstPaint
} from "./tauri";
import type { NodeOutlineItem, XmlNode } from "./types";
import {
  buildPreview,
  findDuplicateNodes,
  isValidXmlName,
  validateDocument
} from "./xml";

// Default preset chip list. Becomes the starting state, and the target of
// the Reset action. The list is editable at runtime in the UI (cog button
// → edit mode), persisted to localStorage between sessions.
const DEFAULT_PRESET_CHIPS = [
  "feedback",
  "question",
  "instruction",
  "extra"
] as const;

// Hard cap on chip count. Any code that iterates or counts presets reads
// off `presetChips.length` / iterates the array — bumping this constant
// only requires adjusting CSS layout tolerances; nothing else hardcodes 6.
const MAX_PRESET_CHIPS = 6;

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

// Hard cap on copy-able XML payload, counted in UTF-8 bytes to match the
// Rust-side MAX_XML_BYTES exactly. Earlier we used JS string length (UTF-16
// code units), which diverged by up to 3× for CJK / emoji content — a 50M
// char Chinese payload would pass the JS check (50M code units) but fail
// the Rust check (~150 MB UTF-8). Bytes on both sides keeps the cap
// meaningful.
const MAX_XML_BYTES = 50_000_000;

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
// into the field locks typing because the four useMemo walkers (validate /
// duplicate / preview / outline) re-run on every keystroke. The total
// MAX_XML_BYTES = 50 MB cap is enforced at copy time, but the typing-lag
// surface hits well before that when one field gets oversized.
//
// Cap is in UTF-8 bytes for parity with MAX_XML_BYTES. 10 MB allows large
// prompt bodies (~5–10 M ASCII chars) but keeps the total tree below
// 50 MB even with multiple maxed-out leaves.
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
const TEXT_CONTENT_INPUT_ID = "text-content-area";

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

// Field-level messages render just below their own form field (not in
// the column-bottom strip) and are always element-scoped: `forNodeId`
// is non-null BY TYPE, a deliberate contrast with StripMessage's
// nullable forNodeId (which supports global messages). A render-time
// check shows the message only while its element stays selected, so
// switching elements hides it without an effect+setState dance.
type TagNameMessage = {
  text: string;
  severity: "error" | "warning";
  forNodeId: string;
};

// Preset-row variant. No severity field: only one message kind exists
// today (clicking an already-applied chip is a no-op warning).
type PresetMessage = {
  text: string;
  forNodeId: string;
};

// Generic confirmation-modal request. Two confirmations exist today (New
// Blank discard, Reset presets); both go through this same primitive. The
// `confirmKind` controls the styling of the confirm button — destructive
// actions get the red `danger-button` treatment, others stay neutral.
type ConfirmRequest = {
  title: string;
  description: string;
  confirmLabel: string;
  confirmKind?: "danger" | "primary";
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
// `history` (so a subsequent chip click restores its prior name). See
// docs/architecture/xml_prompt_studio_design.md for the full semantics.
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
      const parsed: unknown = JSON.parse(stored);
      // An EMPTY list is valid persisted state — the user can delete
      // every chip in edit mode, and that choice must survive a restart
      // instead of silently resurrecting the defaults.
      //
      // Length is checked in codepoints (not UTF-16 units) to match
      // validatePresetName's commit-time semantics; the cheap `length`
      // pre-check bounds Array.from against oversized hand-edited
      // values (each codepoint is at most 2 UTF-16 units).
      if (
        Array.isArray(parsed) &&
        parsed.length <= MAX_PRESET_CHIPS &&
        parsed.every(
          (item) =>
            typeof item === "string" &&
            item.length > 0 &&
            item.length <= MAX_PRESET_NAME_LENGTH * 2 &&
            Array.from(item).length <= MAX_PRESET_NAME_LENGTH &&
            isValidXmlName(item)
        )
      ) {
        const chips = parsed as string[];
        // Enforce the same case-insensitive uniqueness the chip editor
        // does — hand-edited storage with twins would produce duplicate
        // React keys and chips the editor itself would refuse to create.
        const lowered = new Set(chips.map((chip) => chip.toLowerCase()));
        if (lowered.size === chips.length) {
          return chips;
        }
      }
    }
  } catch {
    // localStorage unavailable, JSON parse failed, or the stored shape
    // is corrupt — fall through to defaults.
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
  if (window.matchMedia?.("(prefers-color-scheme: light)").matches) {
    return "light";
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
  // open with the given title/description/buttons. Both New Blank and the
  // Reset-presets action surface their confirm dialog through this single
  // primitive rather than each owning a separate showFoo flag — adding a
  // third confirmation in the future is one new helper, not new state.
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(
    null
  );
  const [theme, setTheme] = useState<Theme>(readInitialTheme);

  // User-customizable preset chip list, persisted to localStorage. The
  // initial value is read from storage (with shape validation); a useEffect
  // below writes back on every change.
  const [presetChips, setPresetChips] = useState<string[]>(
    readInitialPresetChips
  );

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
  // duplicate). Cleared on successful commit or cancel.
  const [chipEditError, setChipEditError] = useState("");

  // Field-level message attached to the Tag Name input. Scoping and
  // render-time gating semantics live on the TagNameMessage type.
  const [tagNameMessage, setTagNameMessage] = useState<TagNameMessage | null>(
    null
  );

  // Field-level message for the preset chip row. Today carries one
  // case: the user clicked an already-applied chip (lastApplied lock),
  // which is a no-op — the warning explains why nothing happened.
  const [presetMessage, setPresetMessage] = useState<PresetMessage | null>(
    null
  );

  // In-flight guard for Copy XML. Without it, rapid clicks queue concurrent
  // IPC calls and arboard's global Windows clipboard handle races between
  // them. Single boolean ref prevents re-entry until the active call settles.
  const copyInFlight = useRef(false);

  // Cancel-button focus target for the New Blank confirmation modal.
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

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
  const clearMessage = () => {
    copyWaitNoticeRef.current = false;
    copyBusyNoticeRef.current = false;
    setStripMessage(null);
  };

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
      text: `Couldn't save your ${what} — it works for this session but will reset on next launch (storage unavailable).`,
      severity: "warning",
      forNodeId: null
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
      localStorage.setItem(
        PRESET_CHIPS_STORAGE_KEY,
        JSON.stringify(presetChips)
      );
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

  const duplicateIssues = useMemo(
    () => findDuplicateNodes(roots),
    [roots]
  );

  const validationIssues = useMemo(
    () => validateDocument(roots),
    [roots]
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

  // Validation against the deferred roots, used to gate the on-screen
  // preview. The build runs against deferredRoots, so the gate must too —
  // otherwise the live-roots validation could pass while deferredRoots is
  // briefly invalid in a transient frame, and renderNode would emit
  // malformed lines like `<>...</>`.
  const deferredValidationIssues = useMemo(
    () => validateDocument(deferredRoots),
    [deferredRoots]
  );

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
  }, [previewPending]);

  // Selecting an element from the list. Node-scoped messages — the
  // global strip AND the field-level tag-name / preset messages — die on
  // navigate-away, for good, not just visually: without the clear, a
  // stale message ("Sibling count limit reached") would resurface on
  // RESELECTING the node even after the condition stopped holding.
  // Global messages (errorForNodeId === null) survive navigation. Every
  // other selection-changing path (add/delete/new-blank) already calls
  // clearMessage unconditionally; the render-time forNodeId gates stay
  // as defense for those paths' field messages.
  const selectNode = (nodeId: string) => {
    if (
      stripMessage &&
      stripMessage.forNodeId !== null &&
      stripMessage.forNodeId !== nodeId
    ) {
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

  const elementOutline = useMemo(
    () => createElementOutline(roots, duplicateNodeIds),
    [roots, duplicateNodeIds]
  );

  // The tag-name field-level message, gated on the element it was
  // raised for. selectNode clears it for good on navigate-away; this
  // render gate covers the other selection-changing paths (delete
  // fallback, add) so a message never shows against the wrong element.
  // If the user comes back and is still at the cap, typing a key fires
  // a fresh message.
  const activeTagNameMessage =
    tagNameMessage && tagNameMessage.forNodeId === activeNode.id
      ? tagNameMessage
      : null;
  const activePresetMessage =
    presetMessage && presetMessage.forNodeId === activeNode.id
      ? presetMessage
      : null;
  const activeStripMessage =
    stripMessage &&
    (stripMessage.forNodeId === null ||
      stripMessage.forNodeId === activeNode.id)
      ? stripMessage
      : null;

  // null parent = top-level section; its sibling list is the forest
  // itself, so Move / Add Sibling / Delete work uniformly at every level.
  const activeParent = useMemo(
    () => findParent(roots, activeNode.id),
    [activeNode.id, roots]
  );
  const activeSiblings = activeParent ? activeParent.children : roots;
  const activeSiblingIndex = activeSiblings.findIndex(
    (child) => child.id === activeNode.id
  );
  const canMoveUp = activeSiblingIndex > 0;
  const canMoveDown =
    activeSiblingIndex >= 0 &&
    activeSiblingIndex < activeSiblings.length - 1;
  const tagNameInvalid = issueNodeIds.has(activeNode.id);
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
  const activeDepth =
    elementOutline.find((item) => item.id === activeNode.id)?.depth ??
    MAX_DEPTH;

  const closeConfirm = () => {
    setConfirmRequest(null);
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
        // New document means every old node ID is gone — wipe the entire
        // memory map so it doesn't accumulate orphan entries across many
        // "new blank" cycles.
        presetMemoryRef.current.clear();
      }
    });
  };

  const requestResetPresets = () => {
    setConfirmRequest({
      title: "Restore default preset chips?",
      description: `This will replace your current chips with ${DEFAULT_PRESET_CHIPS.join(
        " / "
      )}.`,
      confirmLabel: "Restore",
      onConfirm: () => {
        setPresetChips([...DEFAULT_PRESET_CHIPS]);
        setEditMode(false);
        setEditingChip(null);
        setChipEditError("");
        setPresetMessage(null);
        presetMemoryRef.current.clear();
      }
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
    setEditMode((current) => {
      if (current) {
        setEditingChip(null);
        setChipEditError("");
      }
      return !current;
    });
  };

  const removeChip = (index: number) => {
    const removedName = presetChips[index];
    if (removedName) {
      forgetPresetMemoryForChip(removedName);
    }
    setPresetMessage(null);
    // A failed in-flight rename's error may name the chip being deleted
    // ("X is already in your preset list") — deleting X makes that text
    // false, so drop it. The rename input itself stays open; its next
    // commit re-validates against the updated list.
    setChipEditError("");
    setPresetChips((chips) => chips.filter((_, i) => i !== index));
    // An in-flight RENAME can coexist with this delete only for a
    // DIFFERENT chip (the chip being renamed renders as the editing
    // input, which has no × button) — so the only adjustment needed is
    // shifting the rename's index when an earlier chip disappears.
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
      isNew: true
    });
    setChipEditError("");
  };

  const startRenameChip = (index: number) => {
    setEditingChip({
      index,
      draft: presetChips[index],
      isNew: false
    });
    setChipEditError("");
  };

  const updateEditingChipDraft = (draft: string) => {
    if (!editingChip) {
      return;
    }
    setEditingChip({ ...editingChip, draft });
  };

  const cancelChipEdit = () => {
    setEditingChip(null);
    setChipEditError("");
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
      setChipEditError(error);
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
      setPresetChips((chips) =>
        chips.map((c, i) => (i === editingChip.index ? trimmed : c))
      );
    }
    setEditingChip(null);
    setChipEditError("");
    setPresetMessage(null);
  };

  const addChild = () => {
    // Soft depth guard — refuse rather than risk stack overflow on render.
    if (activeDepth >= MAX_DEPTH) {
      showError(
        `Element nesting depth limit reached (${MAX_DEPTH}).`,
        activeNode.id
      );
      return;
    }
    // Sibling-count guard, symmetric with addSibling. Add Child grows
    // activeNode.children which addSibling would also grow; without this
    // guard, holding Add Child reproduces the same O(N²) UI freeze the
    // breadth cap was added to prevent.
    if (activeNode.children.length >= MAX_SIBLINGS) {
      showError(`Sibling count limit reached (${MAX_SIBLINGS}).`, activeNode.id);
      return;
    }
    const child = createNode();
    setRoots((current) =>
      updateNode(current, activeNode.id, (node) => ({
        ...node,
        children: [...node.children, child]
      }))
    );
    setSelectedNodeId(child.id);
    clearMessage();
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
          children: insertAfter(node.children, activeNode.id, sibling)
        }))
      );
    } else {
      setRoots((current) => insertAfter(current, activeNode.id, sibling));
    }
    setSelectedNodeId(sibling.id);
    clearMessage();
  };

  const removeSelectedNode = () => {
    // Min-one-section invariant: deleting the LAST remaining top-level
    // section would empty the forest, so this path resets to the blank
    // starter instead. No confirm — Delete on the sole section IS the
    // explicit wipe gesture, same outcome as a confirmed New Blank.
    if (!activeParent && roots.length === 1) {
      const nextRoots = createBlankDocument();
      setRoots(nextRoots);
      setSelectedNodeId(nextRoots[0].id);
      clearMessage();
      // Every old node ID is gone — wipe the whole memory map, same as
      // the New Blank path.
      presetMemoryRef.current.clear();
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

  const setActiveTagName = (tagName: string) => {
    // Capped for-of codepoint walk, same discipline as truncate() in
    // helpers.ts:
    // Array.from on the raw value would materialize one string object per
    // codepoint BEFORE the cap applies — a multi-MB paste into this field
    // (which deliberately has no maxLength) reaches hundreds of MB of
    // transient allocation. The walk stops at the cap, keeping work
    // O(MAX_TAG_NAME_LENGTH) regardless of paste size. for-of yields
    // codepoints, so emoji / supplementary-plane chars don't get split.
    //
    // The truncation notice routes to tagNameMessage (rendered immediately
    // below the input) instead of the global bottom strip — the alert is
    // about THIS field, so the cue lives next to it.
    let limitWarning: string | null = null;
    const codepoints: string[] = [];
    let truncated = false;
    for (const cp of tagName) {
      if (codepoints.length === MAX_TAG_NAME_LENGTH) {
        truncated = true;
        break;
      }
      codepoints.push(cp);
    }
    if (truncated) {
      limitWarning = `Tag name reached the ${MAX_TAG_NAME_LENGTH}-character limit.`;
      tagName = codepoints.join("");
    }
    setRoots((current) =>
      updateNode(current, activeNode.id, (node) => ({ ...node, tagName }))
    );
    if (limitWarning) {
      setTagNameMessage({
        text: limitWarning,
        severity: "warning",
        forNodeId: activeNode.id
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
    setRoots((current) =>
      updateNode(current, activeNode.id, (node) => ({ ...node, textContent }))
    );
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
        forNodeId: activeNode.id
      });
      return;
    }

    // Decide which name to apply. activeSiblings covers top-level
    // sections too (their sibling list is the forest itself), so chip
    // suffixes and collision checks work the same at every level.
    //   - If this chip has been used on this element before, restore the
    //     exact name we wrote last time. Lets the user switch between
    //     chips without losing the original suffix on either side.
    //   - First time the chip touches this element, compute the next-free
    //     `<chip>_<N>` suffix among siblings.
    let nameToApply: string;
    let collisionWarning = false;

    const previous = memory.history.get(chipName);
    if (previous !== undefined) {
      nameToApply = previous;
      // Restoration may collide with a sibling that has taken the slot
      // since we last used this chip here. We restore anyway (keeps the
      // promise that this chip → this name on this element), but flag
      // the collision so the user knows why a duplicate badge just
      // appeared on the row.
      const collidingSibling = activeSiblings.find(
        (c) => c.id !== activeNode.id && c.tagName.trim() === nameToApply
      );
      collisionWarning = collidingSibling !== undefined;
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
        tagName: nameToApply
      }))
    );

    // Record the apply in memory. lastApplied prevents repeat clicks; the
    // history entry lets a subsequent chip switch restore back here.
    memory.history.set(chipName, nameToApply);
    memory.lastApplied = chipName;

    if (collisionWarning) {
      showWarning(
        `Restored "${nameToApply}" — a sibling already uses that name, so it now shows as a duplicate.`,
        activeNode.id
      );
    } else {
      clearMessage();
    }
    // Chip-applied names are bounded by construction: chip name (≤ 24
    // codepoints) + "_" + digits, which MAX_TAG_NAME_LENGTH (32) is sized
    // to accommodate — see that constant's comment. A stale "reached the
    // limit" warning from prior typing in this element no longer applies.
    setTagNameMessage(null);
    // Successful chip apply also moots any "already applied" warning
    // (we just changed which chip is the lastApplied one).
    setPresetMessage(null);
  };

  const copyPreview = async () => {
    // Re-entry guard. Refusing with a VISIBLE notice instead of a silent
    // drop: if a fallback clipboard tool ever wedges the in-flight copy,
    // the silent version turns every later click into "nothing happens"
    // with zero diagnostic signal. The notice self-expires when the
    // in-flight copy settles (see the finally block).
    if (copyInFlight.current) {
      showWarning("A copy is already in progress — one moment.");
      copyBusyNoticeRef.current = true;
      return;
    }

    if (previewPending) {
      showWarning(
        "Preview is still updating. Copy XML will be available once it matches the document."
      );
      // Set AFTER showWarning — the helper resets the flag as part of
      // "any other message moots the catch-up clear".
      copyWaitNoticeRef.current = true;
      return;
    }

    // Build from the LIVE roots, not the deferred ones. Copy XML is
    // an explicit user action that must capture the latest state — the
    // useDeferredValue trick is only for keystroke-smoothness on the
    // on-screen preview. Using deferredRoots here would silently copy
    // stale text after rapid type-then-click.
    const liveIssues = validateDocument(roots);
    if (liveIssues.length > 0) {
      showError("Fix validation issues before copying XML.");
      return;
    }
    const liveXml = buildPreview(roots).xml;

    // Reuse the same length × 3 short-circuit + TextEncoder fallback as the
    // per-field caps via exceedsByteCap. The actual byte count is only
    // needed for the user-facing error message, so it's computed inside
    // the failure branch (one TextEncoder pass total in the worst case).
    if (exceedsByteCap(liveXml, MAX_XML_BYTES)) {
      const liveBytes = new TextEncoder().encode(liveXml).length;
      showError(
        `XML payload too large to copy (${formatMegabytes(liveBytes)}; limit ${formatMegabytes(MAX_XML_BYTES)}).`
      );
      return;
    }

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

  // Modal accessibility: focus the Cancel button when the confirmation
  // dialog opens, mark the rest of the app inert so Tab focus is trapped
  // inside the dialog, let Escape cancel, and restore focus to the
  // triggering element on close. Without this the originating ribbon
  // button keeps focus while the modal opens, Tab can escape behind the
  // overlay, screen readers don't announce the dialog, and on close the
  // keyboard user lands on <body> with no anchor back to where they were.
  useEffect(() => {
    if (!confirmRequest) {
      return;
    }
    // Capture the element that triggered the modal so focus can return
    // there on close. Falls back to null if active element is something
    // other than HTMLElement (e.g., SVG elements aren't focusable here).
    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    cancelButtonRef.current?.focus();
    const ribbon = ribbonRef.current;
    const body = bodyRef.current;
    if (ribbon) ribbon.inert = true;
    if (body) body.inert = true;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setConfirmRequest(null);
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
  }, [confirmRequest]);

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
        <button
          type="button"
          className="new-blank-button"
          tabIndex={-1}
          onClick={requestNewBlank}
        >
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
          {/* Theme toggle is a meta/settings control, not a document action,
              so it sits with the Copy XML anchor on the right. The icon
              shown is the destination (sun = "click to go light", moon =
              "click to go dark"). */}
          <button
            type="button"
            className="theme-toggle"
            tabIndex={-1}
            onClick={toggleTheme}
            aria-label={
              theme === "dark" ? "Switch to light mode" : "Switch to dark mode"
            }
            title={
              theme === "dark"
                ? "Switch to light mode"
                : "Switch to dark mode"
            }
          >
            {theme === "dark" ? <SunIcon /> : <MoonIcon />}
          </button>
          <button
            type="button"
            className="copy-button"
            tabIndex={-1}
            onClick={copyPreview}
            title="Copy XML"
          >
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
          <input
            id={TAG_NAME_INPUT_ID}
            name="tagName"
            value={activeNode.tagName}
            className={cx("tag-name-input", tagNameInvalid && "input-error")}
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
              should be next to it. Carries severity for color (amber
              warning vs red error). */}
          {activeTagNameMessage && (
            <div
              className={cx(
                "field-message",
                `is-${activeTagNameMessage.severity}`
              )}
              role="alert"
            >
              {activeTagNameMessage.text}
            </div>
          )}

          <div className="preset-chips">
            <span className="preset-label">Preset:</span>
            <div className="preset-chip-list">
              {presetChips.map((name, index) => {
                const isEditingThis =
                  editingChip !== null &&
                  !editingChip.isNew &&
                  editingChip.index === index;
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
                      maxLength={MAX_PRESET_NAME_LENGTH}
                      aria-label={`Rename preset ${name}`}
                      // Active edits stay tabbable so a failed blur commit
                      // never leaves the keyboard user unable to return.
                      tabIndex={0}
                      onChange={(event) =>
                        updateEditingChipDraft(event.target.value)
                      }
                      onBlur={commitChipEdit}
                      onKeyDown={(event) => {
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
                  className="chip chip-editing chip-new"
                  value={editingChip.draft}
                  autoFocus
                  maxLength={MAX_PRESET_NAME_LENGTH}
                  placeholder="new chip name"
                  aria-label="Name the new preset chip"
                  tabIndex={0}
                  onChange={(event) =>
                    updateEditingChipDraft(event.target.value)
                  }
                  onBlur={commitChipEdit}
                  onKeyDown={(event) => {
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
              {editMode &&
                !editingChip &&
                presetChips.length < MAX_PRESET_CHIPS && (
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
                aria-label={
                  editMode ? "Exit chip edit mode" : "Edit preset chips"
                }
                aria-pressed={editMode}
                title={
                  editMode ? "Exit chip edit mode" : "Edit preset chips"
                }
                tabIndex={-1}
              >
                <CogIcon />
              </button>
            </div>
          </div>
          {editMode && chipEditError && (
            <div className="chip-edit-error" role="alert">
              {chipEditError}
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
                  const isActive =
                    line.kind !== "separator" && line.nodeId === activeNode.id;
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
                      <span className="preview-text">{line.text}</span>
                    </div>
                  );
                })
              ) : (
                <div className="preview-empty">
                  Fix validation issues to see the preview.
                </div>
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

      {confirmRequest && (
        // Overlay has no explicit role — the inner div carries
        // role="dialog" + aria-modal="true". Keeping a click handler on
        // the overlay for click-outside-to-cancel; AT users have Escape
        // and the focused Cancel button (see useEffect for focus mgmt).
        <div className="modal-overlay" onClick={closeConfirm}>
          <div
            className="confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
            aria-describedby="confirm-desc"
            onClick={(event) => event.stopPropagation()}
          >
            <h3 id="confirm-title">{confirmRequest.title}</h3>
            <p id="confirm-desc">{confirmRequest.description}</p>
            <div className="dialog-buttons">
              <button
                type="button"
                ref={cancelButtonRef}
                onClick={closeConfirm}
              >
                Cancel
              </button>
              <button
                type="button"
                className={
                  confirmRequest.confirmKind === "danger"
                    ? "danger-button"
                    : undefined
                }
                onClick={handleConfirm}
              >
                {confirmRequest.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function createElementOutline(
  roots: XmlNode[],
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
