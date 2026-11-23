import { afterEach, describe, expect, it, vi } from "vitest";
import { createNode } from "./document";
import {
  DEFAULT_PRESET_CHIPS,
  PRESET_CHIPS_STORAGE_KEY,
  applyPresetToElementMemory,
  clearElementLastAppliedPreset,
  forgetPresetChipInMemory,
  persistPresetChips,
  readInitialPresetChips,
  sweepDeletedSubtreeFromMemory,
  type ElementPresetMemory,
} from "./presets";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("preset element memory", () => {
  it("allocates the lowest suffix, blocks immediate repeat clicks, and restores prior names on return", () => {
    const first = createNode("feedback_1");
    const active = createNode();
    const siblings = [first, active];
    const memory = new Map<string, ElementPresetMemory>();

    const firstApply = applyPresetToElementMemory(memory, active.id, "feedback", siblings);
    expect(firstApply).toEqual({ alreadyApplied: false, tagName: "feedback_2" });

    const repeatApply = applyPresetToElementMemory(memory, active.id, "feedback", siblings);
    expect(repeatApply).toEqual({ alreadyApplied: true });

    const switchChip = applyPresetToElementMemory(memory, active.id, "question", siblings);
    expect(switchChip).toEqual({ alreadyApplied: false, tagName: "question_1" });

    // Even if another sibling now uses feedback_2, returning to "feedback" on
    // this element restores its remembered name rather than allocating _3.
    const updatedSiblings = [first, createNode("feedback_2"), { ...active, tagName: "question_1" }];
    const restored = applyPresetToElementMemory(memory, active.id, "feedback", updatedSiblings);
    expect(restored).toEqual({ alreadyApplied: false, tagName: "feedback_2" });
  });

  it("clears lastApplied on manual edit while keeping remembered chip history", () => {
    const active = createNode();
    const memory = new Map<string, ElementPresetMemory>();

    applyPresetToElementMemory(memory, active.id, "feedback", [active]);
    clearElementLastAppliedPreset(memory, active.id);

    const reapplied = applyPresetToElementMemory(memory, active.id, "feedback", [
      createNode("feedback_1"),
      active,
    ]);
    expect(reapplied).toEqual({ alreadyApplied: false, tagName: "feedback_1" });
  });

  it("forgets renamed/removed chips and sweeps deleted subtrees", () => {
    const child = createNode("question_1");
    const parent = { ...createNode("feedback_1"), children: [child] };
    const survivor = createNode("feedback_2");
    const memory = new Map<string, ElementPresetMemory>();

    applyPresetToElementMemory(memory, parent.id, "feedback", [parent, survivor]);
    applyPresetToElementMemory(memory, child.id, "question", [child]);
    applyPresetToElementMemory(memory, survivor.id, "feedback", [parent, survivor]);

    forgetPresetChipInMemory(memory, "feedback");
    expect(memory.get(survivor.id)?.lastApplied).toBeNull();
    expect(memory.get(survivor.id)?.history.has("feedback")).toBe(false);

    sweepDeletedSubtreeFromMemory(memory, parent);
    expect(memory.has(parent.id)).toBe(false);
    expect(memory.has(child.id)).toBe(false);
    expect(memory.has(survivor.id)).toBe(true);
  });
});

describe("preset localStorage persistence", () => {
  it("reads salvaged chips and falls back to defaults on corrupt or missing storage", () => {
    const getItem = vi
      .fn()
      .mockReturnValueOnce(JSON.stringify(["context", "two words", "goal"]))
      .mockReturnValueOnce("{broken-json");
    vi.stubGlobal("window", {});
    vi.stubGlobal("localStorage", { getItem, setItem: vi.fn() });

    expect(readInitialPresetChips()).toEqual(["context", "goal"]);
    expect(getItem).toHaveBeenCalledWith(PRESET_CHIPS_STORAGE_KEY);
    expect(readInitialPresetChips()).toEqual([...DEFAULT_PRESET_CHIPS]);
  });

  it("returns false instead of throwing when storage writes fail", () => {
    const setItem = vi
      .fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("QuotaExceededError");
      });
    vi.stubGlobal("localStorage", { getItem: vi.fn(), setItem });

    expect(persistPresetChips(["context"])).toBe(true);
    expect(persistPresetChips(["context"])).toBe(false);
  });
});
