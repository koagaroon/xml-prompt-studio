import { collectSubtreeIds, nextAvailableSuffix, salvagePresetChips } from "./helpers";
import type { XmlNode } from "./types";

export const DEFAULT_PRESET_CHIPS = ["feedback", "question", "instruction", "extra"] as const;

export const PRESET_CHIPS_STORAGE_KEY = "presetChips";

export type EditingChip = {
  index: number;
  draft: string;
  isNew: boolean;
};

export type ChipEditMessage = {
  text: string;
  severity: "error" | "warning";
};

// Per-element preset state: `lastApplied` turns immediate repeat clicks on the
// same chip into a visible no-op, while `history` remembers the exact suffix a
// chip previously produced on this element when switching chips and returning.
export type ElementPresetMemory = {
  lastApplied: string | null;
  history: Map<string, string>;
};

export function readInitialPresetChips(): string[] {
  if (typeof window === "undefined") {
    return [...DEFAULT_PRESET_CHIPS];
  }
  try {
    const stored = localStorage.getItem(PRESET_CHIPS_STORAGE_KEY);
    if (stored) {
      const salvaged = salvagePresetChips(JSON.parse(stored));
      if (salvaged !== null) {
        return salvaged;
      }
    }
  } catch {
    // localStorage unavailable or invalid JSON — fall back to defaults.
  }
  return [...DEFAULT_PRESET_CHIPS];
}

export function persistPresetChips(chips: string[]): boolean {
  try {
    localStorage.setItem(PRESET_CHIPS_STORAGE_KEY, JSON.stringify(chips));
    return true;
  } catch {
    return false;
  }
}

export type PresetApplyResult =
  { alreadyApplied: true } | { alreadyApplied: false; tagName: string };

export function applyPresetToElementMemory(
  memoryMap: Map<string, ElementPresetMemory>,
  nodeId: string,
  chipName: string,
  siblings: XmlNode[]
): PresetApplyResult {
  let memory = memoryMap.get(nodeId);
  if (!memory) {
    memory = { lastApplied: null, history: new Map() };
    memoryMap.set(nodeId, memory);
  }

  if (memory.lastApplied === chipName) {
    return { alreadyApplied: true };
  }

  const previous = memory.history.get(chipName);
  const tagName =
    previous !== undefined ? previous : `${chipName}_${nextAvailableSuffix(siblings, chipName)}`;

  memory.history.set(chipName, tagName);
  memory.lastApplied = chipName;
  return { alreadyApplied: false, tagName };
}

export function clearElementLastAppliedPreset(
  memoryMap: Map<string, ElementPresetMemory>,
  nodeId: string
): void {
  const memory = memoryMap.get(nodeId);
  if (memory) {
    memory.lastApplied = null;
  }
}

export function forgetPresetChipInMemory(
  memoryMap: Map<string, ElementPresetMemory>,
  chipName: string
): void {
  for (const memory of memoryMap.values()) {
    memory.history.delete(chipName);
    if (memory.lastApplied === chipName) {
      memory.lastApplied = null;
    }
  }
}

export function sweepDeletedSubtreeFromMemory(
  memoryMap: Map<string, ElementPresetMemory>,
  deletedRoot: XmlNode
): void {
  for (const id of collectSubtreeIds(deletedRoot)) {
    memoryMap.delete(id);
  }
}
