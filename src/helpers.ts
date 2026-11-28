import type { NodeOutlineItem, XmlNode } from "./types";
import { isValidXmlName } from "./xml";

// Pure, React-free helpers shared by App.tsx, UI subcomponents, and tauri.ts
// so product invariants and boundary gates stay unit-testable in isolation
// (see helpers.test.ts).

const SINGLE_WHITESPACE = /^\s$/u;

// Hard cap on chip-name length, in code points. Generous for real chip
// names ("feedback" is 8, "instruction" is 11) but tight enough that no
// chip can sprawl across the input column or look broken in the row. The
// rendered chip pill also gets a CSS `max-width` with ellipsis as a
// belt-and-suspenders against pathological input.
export const MAX_PRESET_NAME_LENGTH = 24;

// `maxLength` is the cap on output length (in code points), not on input.
// The ellipsis counts toward the cap — one code point is reserved for "…".
// for-of yields code points, so supplementary-plane characters (CJK Ext B
// like 𠮷, emoji like 🦀) at the boundary aren't split into orphan
// surrogates. Don't refactor to `Array.from(value)` — that materializes a
// code-point array proportional to the *entire* string, which is up to
// MAX_TEXT_CONTENT_BYTES (10 MB). Short-circuit at maxLength+1 keeps work
// O(maxLength).
export function truncate(value: string, maxLength: number): string {
  // maxLength ≤ 0 would otherwise hit slice(0, negative) below and
  // return output LONGER than the cap — fail to empty instead.
  if (maxLength <= 0) {
    return "";
  }
  const codePoints: string[] = [];
  for (const cp of value) {
    codePoints.push(cp);
    if (codePoints.length > maxLength) {
      return `${codePoints.slice(0, maxLength - 1).join("")}…`;
    }
  }
  return value;
}

// Hard-cap an editable string by code points without adding decoration.
// Browser `maxLength` counts UTF-16 code units, so supplementary-plane
// XML Name characters can be cut too early. Use this for controlled inputs
// whose product contract is code-point based.
export function capCodePoints(value: string, maxLength: number): string {
  if (maxLength <= 0) {
    return "";
  }
  let result = "";
  let count = 0;
  for (const cp of value) {
    // >= (not ===) so a non-integer maxLength still terminates the cap
    // instead of returning the input uncapped — same degradation
    // direction as truncate's `>` guard.
    if (count >= maxLength) {
      break;
    }
    result += cp;
    count += 1;
  }
  return result;
}

// Hard cap on copy-able XML payload, counted in UTF-8 bytes to match the
// Rust-side MAX_XML_BYTES exactly. Earlier we used JS string length (UTF-16
// code units), which diverged by up to 3× for CJK / emoji content — a 50M
// char Chinese payload would pass the JS check (50M code units) but fail
// the Rust check (~150 MB UTF-8). Bytes on both sides keeps the cap
// meaningful. Lives here (not App.tsx) so tauri.ts can mirror the gate on
// the dev-only browser clipboard path.
export const MAX_XML_BYTES = 50_000_000;

// Exact UTF-8 byte length without allocating a TextEncoder Uint8Array
// (which would allocate 50–200+ MB on oversized pastes). Lone surrogates
// count as 3 bytes (U+FFFD replacement), matching TextEncoder byte-for-byte.
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

// Fast UTF-8 byte-count gate:
// - `length * 3 <= cap` is guaranteed under cap (every UTF-16 unit is ≤ 3 bytes,
//   and surrogate pairs are 2 units = 4 bytes < 6);
// - `length > cap` is guaranteed over cap (every UTF-16 unit is ≥ 1 UTF-8 byte);
// - only borderline strings scan code units, exiting as soon as `bytes > cap`
//   with zero heap allocation.
export function exceedsByteCap(value: string, cap: number): boolean {
  if (value.length * 3 <= cap) {
    return false;
  }
  if (value.length > cap) {
    return true;
  }
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
    if (bytes > cap) {
      return true;
    }
  }
  return false;
}

// Render a byte count as MB for user-facing messages — "10 MB" beats
// "10000000 bytes" for scanability. Fractional values round UP to the
// next 0.1 MB: a payload one byte over a limit must never display as
// equal to it ("50.0 MB; limit 50 MB" reads as a contradiction).
// Integral tenths drop the trailing zero decimal. The Rust side
// formats its size errors the same way; change both or neither.
export function formatMegabytes(bytes: number): string {
  const tenths = Math.max(0, Math.ceil(bytes / 100_000));
  return tenths % 10 === 0 ? `${tenths / 10} MB` : `${Math.trunc(tenths / 10)}.${tenths % 10} MB`;
}

// Escape metacharacters before inserting a literal name into a regex.
function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Find the lowest unused integer ≥1 among siblings whose tagName matches
// `<baseName>_<positive-decimal>`. The helper scans whatever list it is
// given; the "active element is included in the scan" contract lives at
// the App.tsx callsite, which passes the FULL sibling list (parent's
// children, or the roots array for top-level sections) unfiltered —
// clicking the preset chip on an element already named e.g. `feedback_3`
// should advance it (siblings + self {1, 2, 3} → next 4), not silently
// rewrite to the same value. Don't filter the active element out before
// calling.
//
// Suffix regex requires `[1-9]\d*` to reject leading zeros, so e.g.
// `feedback_001` does NOT collide with `feedback_1` in the used set.
export function nextAvailableSuffix(siblings: XmlNode[], baseName: string): number {
  const escaped = escapeForRegex(baseName);
  const re = new RegExp(`^${escaped}_([1-9]\\d*)$`);
  const used = new Set<number>();
  for (const child of siblings) {
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

// True when the string contains a high surrogate not followed by a low
// one, or a low surrogate not preceded by a high one. Inspect UTF-16 code
// units directly; a missing next unit is NaN and cannot form a valid pair.
export function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 1; // valid pair — skip its low half
      } else {
        return true;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

// Hard cap on chip count. Any code that iterates or counts presets reads
// off `presetChips.length` / iterates the array — bumping this constant
// only requires adjusting CSS layout tolerances; nothing else hardcodes 6.
export const MAX_PRESET_CHIPS = 6;

// Salvage a persisted chip list read back from storage. Returns the
// usable list, or null when the stored value is unusable and the caller
// should fall back to the defaults. Contract branches:
// - non-array → null (corrupt shape);
// - each item must be a string, pass the cheap UTF-16 length pre-check
//   (bounds the validator's Array.from against oversized hand-edited
//   values), and pass validatePresetName against the chips accepted so
//   far — the SAME canonical validator the chip editor commits through,
//   so the load path can never drift from what the editor accepts;
// - invalid items are SKIPPED, not fatal: the live trigger is a PAST
//   app version having persisted shapes valid under its own rules (a
//   pre-code-point-cap name, or a higher chip-count cap — over-count
//   keeps the first MAX_PRESET_CHIPS valid entries for the same
//   reason), and one such entry must not discard the user's whole list;
// - a non-empty list salvaging to NOTHING is indistinguishable from
//   corruption → null; an empty stored array stays the user's
//   deliberate empty state → [].
export function salvagePresetChips(parsed: unknown): string[] | null {
  if (!Array.isArray(parsed)) {
    return null;
  }
  const chips: string[] = [];
  for (const item of parsed) {
    if (chips.length >= MAX_PRESET_CHIPS) {
      break;
    }
    if (
      typeof item === "string" &&
      item.length <= MAX_PRESET_NAME_LENGTH * 2 &&
      validatePresetName(item, chips, -1) === null
    ) {
      chips.push(item);
    }
  }
  if (chips.length === 0 && parsed.length > 0) {
    return null;
  }
  return chips;
}

// Validates a preset chip name on commit (Enter / blur). Returns null if
// the name is acceptable, or a user-facing error string. Empty / too-long
// / invalid-XML-name / case-insensitive duplicate are all rejected. The
// caller passes `excludeIndex = -1` for adds and the chip's own index
// for renames so a chip doesn't trip the duplicate check against itself.
export function validatePresetName(
  name: string,
  allChips: string[],
  excludeIndex: number
): string | null {
  if (!name) {
    return "Chip name cannot be empty.";
  }
  // Code-point length, not browser maxLength/UTF-16 units. The chip edit
  // inputs are capped through capCodePoints before commit, and this stays
  // as the validation boundary for persisted or hand-edited values.
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

export type CopyReadiness =
  | { ready: true }
  | { ready: false; reason: "busy" | "preview-pending" | "validation" | "too-large" };

export function getCopyReadiness(input: {
  copyInFlight: boolean;
  previewPending: boolean;
  validationIssueCount: number;
  xml: string;
  maxBytes?: number;
}): CopyReadiness {
  if (input.copyInFlight) {
    return { ready: false, reason: "busy" };
  }
  if (input.previewPending) {
    return { ready: false, reason: "preview-pending" };
  }
  if (input.validationIssueCount > 0) {
    return { ready: false, reason: "validation" };
  }
  if (exceedsByteCap(input.xml, input.maxBytes ?? MAX_XML_BYTES)) {
    return { ready: false, reason: "too-large" };
  }
  return { ready: true };
}

// Inserts `node` immediately after the item with `anchorId`; appends when
// the anchor isn't found (defensive — callers pass the active node's id,
// which is always in the list). Shared by both addSibling levels: a
// parent's children array and the top-level roots array.
export function insertAfter(list: XmlNode[], anchorId: string, node: XmlNode): XmlNode[] {
  const index = list.findIndex((item) => item.id === anchorId);
  const insertAt = index === -1 ? list.length : index + 1;
  return [...list.slice(0, insertAt), node, ...list.slice(insertAt)];
}

// Walks a subtree and returns every node ID it contains, including the
// passed-in node. Used by removeSelectedNode to sweep presetMemory for
// every entry that's about to become orphaned by the delete. Iterative
// stack-based walk to match the implicit O(N) deleteNode cost without
// adding recursion depth on top of it.
export function collectSubtreeIds(root: XmlNode): string[] {
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
// previous sibling > next sibling > parent (only-child fallback). For a
// top-level section `parentId` is null, but its only-child case routes
// through the reset-to-blank path before this is called, so the final
// `fallbackId` (kept for totality) should be unreachable.
export function nextSelectionAfterDelete(
  siblings: XmlNode[],
  deletedId: string,
  parentId: string | null,
  fallbackId: string
): string {
  const idx = siblings.findIndex((c) => c.id === deletedId);
  if (idx === -1) {
    return fallbackId;
  }
  if (idx > 0) {
    return siblings[idx - 1].id;
  }
  if (siblings.length > 1) {
    return siblings[idx + 1].id;
  }
  return parentId ?? fallbackId;
}

// Cap on the text-preview portion of an Elements-row label, in code
// points, ellipsis included (truncate's contract). Purely
// presentational — sized so a row with a long tag name plus preview
// stays scannable in the narrow Elements column; no derivation from
// other caps.
export const ELEMENT_LABEL_PREVIEW_LENGTH = 26;

function extractTrimmedPreview(value: string, maxLength: number): string {
  if (maxLength <= 0) {
    return "";
  }
  let start = 0;
  while (start < value.length && SINGLE_WHITESPACE.test(value[start])) {
    start += 1;
  }
  if (start === value.length) {
    return "";
  }
  let end = value.length;
  while (end > start && SINGLE_WHITESPACE.test(value[end - 1])) {
    end -= 1;
  }
  const codePoints: string[] = [];
  for (let i = start; i < end;) {
    const cp = value.codePointAt(i)!;
    codePoints.push(String.fromCodePoint(cp));
    if (codePoints.length > maxLength) {
      return `${codePoints.slice(0, maxLength - 1).join("")}…`;
    }
    i += cp > 0xffff ? 2 : 1;
  }
  return value.slice(start, end);
}

// Label for an Elements-column row: tag name in angle brackets plus a
// truncated text preview. Scans leading/trailing whitespace bounds without
// copying the full up-to-10-MB textContent on every keystroke. The empty-tag
// placeholder is "(empty tag)" — same vocabulary as the Input column's title
// for the same state, and unbracketed so it can't be misread as a literal tag
// named "empty-tag".
export function buildElementLabel(node: XmlNode): string {
  const trimmedTag = node.tagName.trim();
  const tagLabel = trimmedTag ? `<${trimmedTag}>` : "(empty tag)";
  const previewText = extractTrimmedPreview(node.textContent, ELEMENT_LABEL_PREVIEW_LENGTH);
  const suffix = previewText ? ` ${previewText}` : "";
  return `${tagLabel}${suffix}`;
}

export function createElementOutline(roots: XmlNode[]): NodeOutlineItem[] {
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

export type DeleteConfirmationPrompt = {
  title: string;
  description: string;
  confirmLabel: string;
};

// True when closing the window would discard authored prompt content or added
// structure. A single untouched or renamed empty leaf returns false so opening
// and immediately closing the app stays one-click.
export function hasUnsavedPromptWork(roots: XmlNode[]): boolean {
  if (roots.length > 1) {
    return true;
  }
  const onlyRoot = roots[0];
  if (!onlyRoot) {
    return false;
  }
  return onlyRoot.children.length > 0 || onlyRoot.textContent !== "";
}

// Returns null for empty leaf stubs so stray Add Child / Add Sibling clicks
// stay removable in one click; returns a confirmation prompt whenever
// deleting the element would discard text content or nested elements.
export function buildDeleteNodeConfirmation(node: XmlNode): DeleteConfirmationPrompt | null {
  if (node.children.length === 0 && node.textContent === "") {
    return null;
  }

  const trimmedTag = node.tagName.trim();
  const targetLabel = trimmedTag ? `<${trimmedTag}>` : "this unnamed element";
  const descendantCount = collectSubtreeIds(node).length - 1;

  let description: string;
  if (descendantCount > 0 && node.textContent !== "") {
    const childNoun = descendantCount === 1 ? "nested element" : "nested elements";
    description = `This will remove ${targetLabel}, its text content, and ${descendantCount} ${childNoun}.`;
  } else if (descendantCount > 0) {
    const childNoun = descendantCount === 1 ? "nested element" : "nested elements";
    description = `This will remove ${targetLabel} and ${descendantCount} ${childNoun}.`;
  } else {
    description = `This will remove ${targetLabel} and its text content.`;
  }

  return {
    title: `Delete ${targetLabel}?`,
    description,
    confirmLabel: "Delete",
  };
}

const GRAPHEME_SEGMENTER =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;
const FALLBACK_FIRST_CLUSTER = /^\P{White_Space}\p{Mark}*/u;

// Splits leading indentation plus the first extended grapheme cluster from
// the rest of a preview line. Rendering `lead` with `white-space: pre`
// prevents Chromium from breaking between the indent spaces and an overlong
// unbroken token (which otherwise leaves a phantom blank row and drops the
// token's indentation), while Intl.Segmenter keeps skin-tone, ZWJ, and flag
// emoji sequences intact across the span boundary in O(1) time.
export function splitPreviewLineLead(text: string): { lead: string; rest: string } | null {
  let indentEnd = 0;
  while (indentEnd < text.length) {
    const ch = text[indentEnd];
    if (ch !== " " && ch !== "\t") {
      break;
    }
    indentEnd += 1;
  }
  if (indentEnd === 0 || indentEnd >= text.length || SINGLE_WHITESPACE.test(text[indentEnd])) {
    return null;
  }

  const sample = text.slice(indentEnd, indentEnd + 64);
  let firstCluster = "";
  if (GRAPHEME_SEGMENTER) {
    const iterator = GRAPHEME_SEGMENTER.segment(sample)[Symbol.iterator]();
    const first = iterator.next();
    if (!first.done) {
      firstCluster = first.value.segment;
    }
  } else {
    firstCluster = FALLBACK_FIRST_CLUSTER.exec(sample)?.[0] ?? "";
  }
  if (!firstCluster) {
    return null;
  }
  const leadEnd = indentEnd + firstCluster.length;
  return {
    lead: text.slice(0, leadEnd),
    rest: text.slice(leadEnd),
  };
}

// Compose a className from base + conditional class names.
export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(" ");
}
