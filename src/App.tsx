import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  createBlankDocument,
  createNode,
  deleteNode,
  findNode,
  findParent,
  moveNode,
  updateNode
} from "./document";
import { copyXmlToClipboard } from "./tauri";
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

// Hard cap on chip-name length, in code points. Generous for real chip
// names ("feedback" is 8, "instruction" is 11) but tight enough that no
// chip can sprawl across the input column or look broken in the row. The
// rendered chip pill also gets a CSS `max-width` with ellipsis as a
// belt-and-suspenders against pathological input.
const MAX_PRESET_NAME_LENGTH = 24;

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

// Per-field byte caps. Without these, pasting hundreds of MB into a single
// field locks typing because the four useMemo walkers (validate / duplicate
// / preview / outline) re-run on every keystroke. The total MAX_XML_BYTES
// = 50 MB cap is enforced at copy time, but the typing-lag surface hits
// well before that when one field gets oversized.
//
// Caps are in UTF-8 bytes for parity with MAX_XML_BYTES. Tag-name cap is
// generous — in practice tag names are short (<50 chars). textContent cap
// at 10 MB allows large prompt bodies (~5–10 M ASCII chars) but keeps the
// total tree below 50 MB even with multiple maxed-out leaves.
const MAX_TAG_NAME_BYTES = 1024;
const MAX_TEXT_CONTENT_BYTES = 10_000_000;

// Soft cap on tag-name codepoint length, separate from MAX_TAG_NAME_BYTES
// (the hard memory ceiling). Aligns with MAX_PRESET_NAME_LENGTH so chip-
// picked names and typed names feel equally bounded — typed input gets
// the same safety/integrity treatment chip editing already had. Existing
// tag names that exceed this aren't truncated; new typing past it is
// rejected by setActiveTagName (and prevented by the input's maxLength
// for typical input flows).
const MAX_TAG_NAME_LENGTH = 24;

// Stable element IDs for the form fields in the Input column. Earlier these
// were per-active-node and churned on every selection, confusing autofill
// and a11y caches even though there's only one of each on screen.
const TAG_NAME_INPUT_ID = "tag-name-input";
const TEXT_CONTENT_INPUT_ID = "text-content-area";

type Theme = "dark" | "light";

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

// Read the initial theme from the same source the inline bootstrap script
// in index.html uses, so React state and the DOM data-theme attribute agree
// from the very first render. Falls back to system preference, then dark.
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
      if (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        parsed.length <= MAX_PRESET_CHIPS &&
        parsed.every(
          (item) =>
            typeof item === "string" &&
            item.length > 0 &&
            item.length <= MAX_PRESET_NAME_LENGTH &&
            isValidXmlName(item)
        )
      ) {
        return parsed as string[];
      }
    }
  } catch {
    // localStorage unavailable, JSON parse failed, or the stored shape
    // is corrupt — fall through to defaults.
  }
  return [...DEFAULT_PRESET_CHIPS];
}

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
  // Severity controls the visual treatment of the message strip — red for
  // errors (something failed or is blocked), amber for warnings (the action
  // succeeded but produced a side effect worth noting, e.g. a preset
  // restore now collides with a sibling). Severity is only read when
  // errorMessage is non-empty, so we don't bother resetting it on clear.
  const [errorSeverity, setErrorSeverity] = useState<"error" | "warning">(
    "error"
  );
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
  // Increments each time a preset chip overwrites a non-empty tag name.
  // The Tag Name input wrapper renders a transient overlay keyed on this
  // counter, so each increment remounts the overlay and replays the
  // amber-flash animation — letting the user notice "I just overwrote
  // something" without blocking their re-pick flow.
  const [presetOverwriteFlash, setPresetOverwriteFlash] = useState(0);

  // User-customizable preset chip list, persisted to localStorage. The
  // initial value is read from storage (with shape validation); a useEffect
  // below writes back on every change.
  const [presetChips, setPresetChips] = useState<string[]>(
    readInitialPresetChips
  );

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

  // In-flight guard for Copy XML. Without it, rapid clicks queue concurrent
  // IPC calls and arboard's global Windows clipboard handle races between
  // them. Single boolean ref prevents re-entry until the active call settles.
  const copyInFlight = useRef(false);

  // Cancel-button focus target for the New Blank confirmation modal.
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  // Refs on the ribbon and body so the modal's focus trap can mark them
  // inert while the dialog is open (see the showConfirmNewBlank effect below).
  // Using the DOM .inert property directly avoids depending on @types/react's
  // inert prop typing, which shifts across minor versions.
  const ribbonRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLElement>(null);

  // Per-element preset state, keyed by node id. Tracks which chip was last
  // applied (to make repeat clicks of the same chip a no-op) and what tag
  // name each chip last produced on this element (so switching to another
  // chip and back restores the original suffix instead of recomputing a
  // fresh one). Lives in a ref because none of this state drives rendering
  // — the visible tag name comes from documentRoot, which the chip
  // handlers update via setDocumentRoot. Storage cost is tiny: a 100-
  // element doc fully cycled is ~10 KB. Lifecycle: entries are added on
  // first chip use against an element, swept on element delete, and
  // wiped wholesale on New Blank.
  const presetMemoryRef = useRef<Map<string, ElementPresetMemory>>(new Map());

  const getPresetMemory = (nodeId: string): ElementPresetMemory => {
    let memory = presetMemoryRef.current.get(nodeId);
    if (!memory) {
      memory = { lastApplied: null, history: new Map() };
      presetMemoryRef.current.set(nodeId, memory);
    }
    return memory;
  };

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

  // Persist preset chips on every change. readInitialPresetChips picks
  // them back up on the next session via the same storage key.
  useEffect(() => {
    try {
      localStorage.setItem(
        PRESET_CHIPS_STORAGE_KEY,
        JSON.stringify(presetChips)
      );
    } catch {
      /* swallow — storage failure shouldn't break chip editing */
    }
  }, [presetChips]);

  const toggleTheme = () => {
    setTheme((current) => (current === "dark" ? "light" : "dark"));
  };

  // Message-strip helpers. Centralized so every site that surfaces a
  // user-facing message also sets the right severity, instead of every
  // call having to remember to set both pieces of state. Errors stop or
  // refuse an action; warnings let it proceed but flag a side effect.
  const showError = (text: string) => {
    setErrorMessage(text);
    setErrorSeverity("error");
  };
  const showWarning = (text: string) => {
    setErrorMessage(text);
    setErrorSeverity("warning");
  };
  const clearMessage = () => {
    setErrorMessage("");
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

  // Which preset chip name (if any) is the lastApplied for the current
  // active element. Used to give that chip a subtle "is-applied"
  // treatment in the row, signaling that clicking it again is a no-op.
  //
  // Reads from the ref during render is intentional: every mutation we
  // do to memory.lastApplied (in insertPreset, the tag-name onChange,
  // removeSelectedNode's sweep, confirmNewBlank's clear) is paired with
  // a setDocumentRoot or setSelectedNodeId call. By the time React
  // renders, the ref already holds the value the new state implies, so
  // mirroring lastApplied into useState would just duplicate the same
  // information. The react-hooks/refs lint rule can't see the pairing
  // invariant, so the disable below is explicit.
  // eslint-disable-next-line react-hooks/refs -- intentional: see comment above
  const activeLastApplied = presetMemoryRef.current.get(activeNode.id)?.lastApplied ?? null;

  const isRoot = activeNode.id === documentRoot.id;
  const tagNameInvalid = validationIssues.some(
    (issue) => issue.nodeId === activeNode.id
  );
  const trimmedTag = activeNode.tagName.trim();
  const lineTitle = trimmedTag ? `<${trimmedTag}>` : "(empty tag)";
  // Depth of the currently active element. Read from the already-computed
  // outline rather than walking the tree again. The find() should never
  // miss — activeNode falls back to documentRoot, which is always at
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
        const nextRoot = createBlankDocument();
        setDocumentRoot(nextRoot);
        setSelectedNodeId(nextRoot.id);
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
      description:
        "This will replace your current chips with feedback / question / instruction / extra.",
      confirmLabel: "Restore",
      onConfirm: () => {
        setPresetChips([...DEFAULT_PRESET_CHIPS]);
        setEditMode(false);
        setEditingChip(null);
        setChipEditError("");
      }
    });
  };

  // === Chip edit-mode helpers ===
  // The cog button toggles edit mode. Exiting edit mode also discards
  // any in-flight edit (rename or add) — accepting a half-typed name on
  // toggle would surprise the user.
  const toggleEditMode = () => {
    setEditMode((current) => {
      if (current) {
        setEditingChip(null);
        setChipEditError("");
      }
      return !current;
    });
  };

  const removeChip = (index: number) => {
    setPresetChips((chips) => chips.filter((_, i) => i !== index));
    // If the deleted chip was being edited, drop the edit state.
    if (editingChip && editingChip.index === index) {
      setEditingChip(null);
      setChipEditError("");
    }
  };

  const startAddChip = () => {
    // Position is one past the end — the new chip lives there if commit
    // succeeds. The + button is hidden while an add is in flight, so
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
      setPresetChips((chips) => [...chips, trimmed]);
    } else {
      setPresetChips((chips) =>
        chips.map((c, i) => (i === editingChip.index ? trimmed : c))
      );
    }
    setEditingChip(null);
    setChipEditError("");
  };

  const addChild = () => {
    // Soft depth guard — refuse rather than risk stack overflow on render.
    if (activeDepth >= MAX_DEPTH) {
      showError(`Element nesting depth limit reached (${MAX_DEPTH}).`);
      return;
    }
    // Sibling-count guard, symmetric with addSibling. Add Child grows
    // activeNode.children which addSibling would also grow; without this
    // guard, holding Add Child reproduces the same O(N²) UI freeze the
    // breadth cap was added to prevent.
    if (activeNode.children.length >= MAX_SIBLINGS) {
      showError(`Sibling count limit reached (${MAX_SIBLINGS}).`);
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
    clearMessage();
  };

  const addSibling = () => {
    // Spec §2.1: exactly one root element. Add Sibling on the root would
    // create a second root, violating well-formedness. The button is also
    // disabled at root level in the UI; this guard is defensive.
    if (isRoot) {
      showError("The root element cannot have a sibling.");
      return;
    }
    const parent = findParent(documentRoot, activeNode.id);
    if (!parent) {
      // Active node is non-root but has no parent in the tree — should be
      // unreachable by construction. Log so a future regression surfaces
      // instead of "Add Sibling does nothing." Same shape as createId's
      // crypto.randomUUID fallback (per principle 3 in the design doc).
      console.warn("addSibling: parent of active node not found");
      return;
    }
    if (parent.children.length >= MAX_SIBLINGS) {
      showError(`Sibling count limit reached (${MAX_SIBLINGS}).`);
      return;
    }

    const sibling = createNode();
    setDocumentRoot((current) =>
      updateNode(current, parent.id, (node) => {
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
    clearMessage();
  };

  const removeSelectedNode = () => {
    // Root cannot be deleted (spec §2.1: root element is mandatory). The
    // Delete button is disabled at root level; this guard is defensive.
    // Path to "wipe to blank": New Blank, not Delete.
    if (isRoot) {
      return;
    }

    // Mixed pattern: closure read for findParent + documentRoot.id
    // fallback, functional updater for the tree mutation. Safe because
    // the root's identity is stable — only confirmNewBlank replaces the
    // root, and that path doesn't reach this function. Other handlers in
    // this file commit to functional updaters; the closure reads here
    // are intentional, not an oversight.
    const parent = findParent(documentRoot, activeNode.id);
    // Pick the next selection BEFORE deletion so child indices are stable.
    // Preference: previous sibling > next sibling > parent. Matches list-
    // editor convention (file managers, table row deletes) where focus
    // collapses toward the nearest neighbor, not jumps up a level.
    const target = nextSelectionAfterDelete(
      parent,
      activeNode.id,
      documentRoot.id
    );

    // Sweep presetMemory for the deleted node and all its descendants —
    // those IDs no longer exist anywhere in the tree, so leaving entries
    // keyed by them is a small per-delete leak. Only the deleted subtree
    // is swept; siblings' memories are untouched. The "freed-suffix slot
    // flows into sibling chip behavior" extension was discussed and
    // skipped — that rabbit hole has no bottom.
    const deletedIds = collectSubtreeIds(activeNode);
    for (const id of deletedIds) {
      presetMemoryRef.current.delete(id);
    }

    setDocumentRoot((current) => deleteNode(current, activeNode.id));
    setSelectedNodeId(target);
    clearMessage();
  };

  const moveSelectedNode = (direction: -1 | 1) => {
    // Root has no siblings to swap with; skip the work to avoid producing a
    // freshly cloned tree that triggers all four useMemo walkers + a render
    // for what is semantically a no-op. Matches the addSibling /
    // removeSelectedNode pattern.
    if (isRoot) {
      return;
    }
    setDocumentRoot((current) => moveNode(current, activeNode.id, direction));
    clearMessage();
  };

  const setActiveTagName = (tagName: string) => {
    // Codepoint check first — gives the tighter, user-intuitive cap. The
    // byte cap below is the safety floor (memory ceiling); the codepoint
    // cap is the UX ceiling. Array.from counts codepoints so emoji /
    // supplementary-plane chars don't get split.
    //
    // On overflow we truncate AND fire an amber warning rather than
    // rejecting silently. With `maxLength` on the input the browser
    // would block past-cap typing without telling the user; explicit
    // truncate-and-warn surfaces the limit. The warning persists past
    // the apply (we don't clearMessage in this branch).
    let limitWarning: string | null = null;
    const codepoints = Array.from(tagName);
    if (codepoints.length > MAX_TAG_NAME_LENGTH) {
      limitWarning = `Tag name reached the ${MAX_TAG_NAME_LENGTH}-character limit.`;
      tagName = codepoints.slice(0, MAX_TAG_NAME_LENGTH).join("");
    }
    if (exceedsByteCap(tagName, MAX_TAG_NAME_BYTES)) {
      // After codepoint truncation, still over byte cap — would only
      // happen with many supplementary-plane chars within 24 codepoints.
      // Reject (the user's last-good value is preserved).
      showError(`Tag name too long (limit ${MAX_TAG_NAME_BYTES} bytes).`);
      return;
    }
    setDocumentRoot((current) =>
      updateNode(current, activeNode.id, (node) => ({ ...node, tagName }))
    );
    // Clear stale error strip on edit, OR show the limit warning if we
    // just truncated. Without this, "Fix validation issues..." /
    // "Sibling count limit reached..." would linger until the next
    // button-driven action. insertPreset reaches this through
    // setActiveTagName so it's covered transitively.
    if (limitWarning) {
      showWarning(limitWarning);
    } else {
      clearMessage();
    }
  };

  const setActiveTextContent = (textContent: string) => {
    if (exceedsByteCap(textContent, MAX_TEXT_CONTENT_BYTES)) {
      showError(
        `Text content too long (limit ${MAX_TEXT_CONTENT_BYTES} bytes).`
      );
      return;
    }
    setDocumentRoot((current) =>
      updateNode(current, activeNode.id, (node) => ({ ...node, textContent }))
    );
    clearMessage();
  };

  const insertPreset = (chipName: string) => {
    const memory = getPresetMemory(activeNode.id);

    // Same-chip rapid click → no-op. lastApplied is cleared whenever the
    // tag name is manually edited (see the Tag Name input's onChange), so
    // this only blocks repeat clicks on a chip we just applied or restored.
    if (memory.lastApplied === chipName) {
      return;
    }

    const parent = findParent(documentRoot, activeNode.id);

    // Decide which name to apply.
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
      if (parent) {
        const collidingSibling = parent.children.find(
          (c) => c.id !== activeNode.id && c.tagName.trim() === nameToApply
        );
        collisionWarning = collidingSibling !== undefined;
      }
    } else if (!parent) {
      // Active element is root (no siblings under spec §2.1's single-root
      // invariant). Just use _1.
      nameToApply = `${chipName}_1`;
    } else {
      const suffix = nextAvailableSuffix(parent, chipName);
      nameToApply = `${chipName}_${suffix}`;
    }

    // Visual cue when overwriting a non-empty tag — same amber flash the
    // prior version used. Skipped for empty → first-fill, since there's
    // nothing being overwritten.
    if (activeNode.tagName.trim() !== "") {
      setPresetOverwriteFlash((k) => k + 1);
    }

    // Apply the name directly (skipping setActiveTagName, which would
    // clearMessage and force us to re-set the warning afterward — one
    // extra render). Byte-cap check is unnecessary here: chip names are
    // bounded short by construction, and history values came from a
    // prior valid apply.
    setDocumentRoot((current) =>
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
        `Restored "${nameToApply}" — a sibling already uses that name, so it now shows as a duplicate.`
      );
    } else {
      clearMessage();
    }
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
      showError("Fix validation issues before copying XML.");
      return;
    }
    const liveXml = buildPreview(documentRoot).xml;

    // Reuse the same length × 3 short-circuit + TextEncoder fallback as the
    // per-field caps via exceedsByteCap. The actual byte count is only
    // needed for the user-facing error message, so it's computed inside
    // the failure branch (one TextEncoder pass total in the worst case).
    if (exceedsByteCap(liveXml, MAX_XML_BYTES)) {
      const liveBytes = new TextEncoder().encode(liveXml).length;
      showError(
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
      clearMessage();
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
      previouslyFocused?.focus();
    };
  }, [confirmRequest]);

  return (
    <div className="app-shell">
      <header className="ribbon" ref={ribbonRef}>
        {/* Three-zone layout: anchor-left | cluster (centered, flex: 1) |
            anchor-right. New Blank and Copy XML are the two anchor actions
            — the things the user is most likely to do — and read as equal
            visual weight. The five per-element operations sit in the center
            cluster as a visually compact group with no internal divider. */}
        <button
          type="button"
          className="new-blank-button"
          onClick={requestNewBlank}
        >
          New Blank
        </button>

        <div className="ribbon-cluster">
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
        </div>

        <div className="ribbon-right">
          {/* Theme toggle is a meta/settings control, not a document action,
              so it sits with the Copy XML anchor on the right. The icon
              shown is the destination (sun = "click to go light", moon =
              "click to go dark"). */}
          <button
            type="button"
            className="theme-toggle"
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
          <button type="button" className="copy-button" onClick={copyPreview}>
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
                  // Depth indentation is applied via the `depth-N` class,
                  // not via inline `style={{ "--depth": ... }}`. The
                  // earlier inline-CSS-variable approach silently
                  // collapsed to 0 in production builds: React 18 emits
                  // the `style={{...}}` prop as a parser-time
                  // `style="..."` attribute string in some commit paths,
                  // which is governed by CSP `style-src 'self'` and gets
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
              }}
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

          <div className={cx("preset-chips", editMode && "edit-mode")}>
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
                      key={`edit-${index}`}
                      className="chip chip-editing"
                      value={editingChip.draft}
                      autoFocus
                      maxLength={MAX_PRESET_NAME_LENGTH}
                      aria-label={`Rename preset ${name}`}
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
                  // chip rather than dangling next to it.
                  // `is-applied` highlights the chip whose tag name is
                  // currently on the active element. Suppressed in edit
                  // mode — clicking a chip there means "rename", not
                  // "apply", so the use-time indicator would mislead.
                  <span
                    key={name}
                    className={cx(
                      "chip",
                      !editMode && name === activeLastApplied && "is-applied"
                    )}
                  >
                    <button
                      type="button"
                      className="chip-label"
                      onClick={() => {
                        if (editMode) {
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
                  key="add-new"
                  className="chip chip-editing chip-new"
                  value={editingChip.draft}
                  autoFocus
                  maxLength={MAX_PRESET_NAME_LENGTH}
                  placeholder="new chip name"
                  aria-label="Name the new preset chip"
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
              {editMode &&
                !editingChip?.isNew &&
                presetChips.length < MAX_PRESET_CHIPS && (
                  <button
                    type="button"
                    className="chip-add"
                    aria-label="Add preset chip"
                    title="Add preset chip"
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
            <div
              className={cx(
                "error-strip",
                errorSeverity === "warning" && "is-warning"
              )}
              role="alert"
            >
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
                className={cx(
                  confirmRequest.confirmKind === "danger" && "danger-button"
                )}
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

// Walks a subtree and returns every node ID it contains, including the
// passed-in node. Used by removeSelectedNode to sweep presetMemory for
// every entry that's about to become orphaned by the delete. Iterative
// stack-based walk to match the implicit O(N) deleteNode cost without
// adding recursion depth on top of it.
function collectSubtreeIds(root: XmlNode): string[] {
  const ids: string[] = [];
  const stack: XmlNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    ids.push(node.id);
    for (const child of node.children) {
      stack.push(child);
    }
  }
  return ids;
}

// Picks which element to select after the active one is deleted. The user-
// expected behavior is "fall to the nearest neighbor", which matches list
// editors elsewhere — file managers, table row deletes, etc. Order:
// previous sibling > next sibling > parent (only-child fallback). The
// `fallbackId` is used when the parent lookup fails, which should be
// unreachable for non-root deletes but keeps the function total.
function nextSelectionAfterDelete(
  parent: XmlNode | null,
  deletedId: string,
  fallbackId: string
): string {
  if (!parent) {
    return fallbackId;
  }
  const idx = parent.children.findIndex((c) => c.id === deletedId);
  if (idx === -1) {
    return fallbackId;
  }
  if (idx > 0) {
    return parent.children[idx - 1].id;
  }
  if (parent.children.length > 1) {
    return parent.children[idx + 1].id;
  }
  return parent.id;
}

function buildElementLabel(node: XmlNode): string {
  const tagName = node.tagName.trim() || "empty-tag";
  const previewText = node.textContent.trim();
  const suffix = previewText ? ` ${truncate(previewText, 26)}` : "";
  return `<${tagName}>${suffix}`;
}

// `maxLength` is the cap on output length (in code points), not on input.
// The ellipsis counts toward the cap — one code point is reserved for "…".
// Iterates by code point via Array.from instead of slicing UTF-16 code
// units, so supplementary-plane characters (CJK Extension B like 𠮷, emoji
// like 🦀) at the boundary aren't split into orphan surrogates.
function truncate(value: string, maxLength: number): string {
  const codePoints = Array.from(value);
  if (codePoints.length <= maxLength) {
    return value;
  }
  return `${codePoints.slice(0, maxLength - 1).join("")}…`;
}

// Cheap UTF-8 byte-count check using the upper-bound trick from copyPreview:
// UTF-8 byte count is at most 3 × string length (BMP-heavy worst case), so
// if `length * 3 ≤ cap` we know we're under without running TextEncoder.
// Only encode-and-measure when the cheap bound doesn't decide it.
function exceedsByteCap(value: string, cap: number): boolean {
  if (value.length * 3 <= cap) {
    return false;
  }
  return new TextEncoder().encode(value).length > cap;
}

// Compose a className from base + conditional class names. Same shape as
// the React community's clsx / classnames libraries — falsy values drop
// out, the rest joins with spaces. Used at every site where we conditionally
// add `is-active` / `has-issue` / `input-error` etc.
function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(" ");
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
  // The explicit `\[` is intentional for older WebKit / JavaScriptCore;
  // modern engines accept it as a no-op so ESLint complains.
  // eslint-disable-next-line no-useless-escape
  return value.replace(/[.*+?^${}()|\[\]\\]/g, "\\$&");
}

// Validates a preset chip name on commit (Enter / blur). Returns null if
// the name is acceptable, or a user-facing error string. Empty / too-long
// / invalid-XML-name / case-insensitive duplicate are all rejected. The
// caller passes `excludeIndex = -1` for adds and the chip's own index
// for renames so a chip doesn't trip the duplicate check against itself.
function validatePresetName(
  name: string,
  allChips: string[],
  excludeIndex: number
): string | null {
  if (!name) {
    return "Chip name cannot be empty.";
  }
  // Code-point length matches the input's `maxLength` (which counts
  // UTF-16 code units, but for in-BMP names they're equivalent and
  // the cap is small enough that supplementary-plane edge cases don't
  // bite). Array.from gives the code-point count for the rare cases.
  if (Array.from(name).length > MAX_PRESET_NAME_LENGTH) {
    return `Chip name too long (limit ${MAX_PRESET_NAME_LENGTH} characters).`;
  }
  if (!isValidXmlName(name)) {
    return "Chip name must follow XML element naming rules.";
  }
  // Case-insensitive duplicate check. excludeIndex skips the chip being
  // renamed (so renaming "Feedback" → "feedback" doesn't trip duplicate
  // against itself).
  const lower = name.toLowerCase();
  for (let i = 0; i < allChips.length; i++) {
    if (i !== excludeIndex && allChips[i].toLowerCase() === lower) {
      return `"${name}" is already in your preset list.`;
    }
  }
  return null;
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
