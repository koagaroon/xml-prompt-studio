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
// "10000000 bytes" for scanability. Integral values drop the decimal.
// The Rust side formats its size errors the same way; change both or
// neither.
export function formatMegabytes(bytes: number): string {
  const mb = bytes / 1_000_000;
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
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
export function nextAvailableSuffix(
  siblings: XmlNode[],
  baseName: string
): number {
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

// Inserts `node` immediately after the item with `anchorId`; appends when
// the anchor isn't found (defensive — callers pass the active node's id,
// which is always in the list). Shared by both addSibling levels: a
// parent's children array and the top-level roots array.
export function insertAfter(
  list: XmlNode[],
  anchorId: string,
  node: XmlNode
): XmlNode[] {
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

// Label for an Elements-column row: tag name in angle brackets plus a
// truncated text preview. The empty-tag placeholder is "(empty tag)" —
// same vocabulary as the Input column's title for the same state, and
// unbracketed so it can't be misread as a literal tag named "empty-tag".
export function buildElementLabel(node: XmlNode): string {
  const trimmedTag = node.tagName.trim();
  const tagLabel = trimmedTag ? `<${trimmedTag}>` : "(empty tag)";
  const previewText = node.textContent.trim();
  const suffix = previewText ? ` ${truncate(previewText, 26)}` : "";
  return `${tagLabel}${suffix}`;
}
