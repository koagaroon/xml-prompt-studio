import type { XmlNode } from "./types";
import { isValidXmlName } from "./xml";

// Pure, React-free helpers extracted from App.tsx so their contracts are
// unit-testable (see helpers.test.ts). UI composition stays in App.tsx
// per the single-file-App constraint — this module is data logic only,
// the same standing document.ts and xml.ts already have.

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
// MAX_TEXT_CONTENT_BYTES (10 MB). This helper runs per node on every
// roots edit via the live (non-deferred) outline rebuild, so eager
// materialization reaches tens-of-MB per keystroke before the truncation
// even happens. Short-circuit at maxLength+1 keeps work O(maxLength).
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

// Cheap UTF-8 byte-count check: UTF-8 byte count is at most 3 × string
// length (BMP-heavy worst case), so if `length * 3 ≤ cap` we know we're
// under without running TextEncoder. Only encode-and-measure when the
// cheap bound doesn't decide it.
export function exceedsByteCap(value: string, cap: number): boolean {
  if (value.length * 3 <= cap) {
    return false;
  }
  return new TextEncoder().encode(value).length > cap;
}

// Render a byte count as MB for user-facing messages — "10 MB" beats
// "10000000 bytes" for scanability. Fractional values round UP to the
// next 0.1 MB: a payload one byte over a limit must never display as
// equal to it ("50.0 MB; limit 50 MB" reads as a contradiction).
// Integral tenths drop the trailing zero decimal. The Rust side
// formats its size errors the same way; change both or neither.
export function formatMegabytes(bytes: number): string {
  const tenths = Math.ceil(bytes / 100_000);
  return tenths % 10 === 0 ? `${tenths / 10} MB` : `${(tenths / 10).toFixed(1)} MB`;
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
// one, or a low surrogate not preceded by a high one. A plain code-unit
// walk, NOT a regex: the regex formulation needs lookbehind, which is a
// PARSE-TIME hard dependency — on webview engines without it (older
// WKWebView / WebKitGTK) the literal throws SyntaxError at module load,
// killing the entire frontend before React mounts. charCodeAt works on
// UTF-16 code units, which is exactly the level surrogate pairing lives
// at; at the string's end charCodeAt(length) returns NaN, which fails
// the low-surrogate comparison and correctly flags a trailing high
// surrogate as lone (pinned by test).
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

// Label for an Elements-column row: tag name in angle brackets plus a
// truncated text preview. The empty-tag placeholder is "(empty tag)" —
// same vocabulary as the Input column's title for the same state, and
// unbracketed so it can't be misread as a literal tag named "empty-tag".
export function buildElementLabel(node: XmlNode): string {
  const trimmedTag = node.tagName.trim();
  const tagLabel = trimmedTag ? `<${trimmedTag}>` : "(empty tag)";
  const previewText = node.textContent.trim();
  const suffix = previewText ? ` ${truncate(previewText, ELEMENT_LABEL_PREVIEW_LENGTH)}` : "";
  return `${tagLabel}${suffix}`;
}
