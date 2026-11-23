import type { KeyboardEvent } from "react";
import { CogIcon } from "./Icons";
import { MAX_PRESET_CHIPS, cx } from "./helpers";
import type { ChipEditMessage, EditingChip } from "./presets";
import type { FieldMessage } from "./types";

type PresetChipsBarProps = {
  presetChips: string[];
  editMode: boolean;
  editingChip: EditingChip | null;
  chipEditMessage: ChipEditMessage | null;
  activePresetMessage: FieldMessage | null;
  onInsertPreset: (chipName: string) => void;
  onToggleEditMode: () => void;
  onStartAddChip: () => void;
  onStartRenameChip: (index: number) => void;
  onUpdateEditingDraft: (draft: string) => void;
  onCommitChipEdit: () => void;
  onCancelChipEdit: () => void;
  onRemoveChip: (index: number) => void;
  onRequestResetPresets: () => void;
};

export function PresetChipsBar({
  presetChips,
  editMode,
  editingChip,
  chipEditMessage,
  activePresetMessage,
  onInsertPreset,
  onToggleEditMode,
  onStartAddChip,
  onStartRenameChip,
  onUpdateEditingDraft,
  onCommitChipEdit,
  onCancelChipEdit,
  onRemoveChip,
  onRequestResetPresets,
}: PresetChipsBarProps) {
  const handleChipInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Leave Enter and Escape to the IME candidate window during composition.
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      onCommitChipEdit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      onCancelChipEdit();
    }
  };

  return (
    <>
      <div className="preset-chips">
        <span className="preset-label">Preset:</span>
        <div className="preset-chip-list">
          {presetChips.map((name, index) => {
            const isEditingThis =
              editingChip !== null && !editingChip.isNew && editingChip.index === index;
            if (isEditingThis) {
              return (
                <input
                  key={`edit:${index}`}
                  className="chip chip-editing"
                  value={editingChip.draft}
                  autoFocus
                  aria-label={`Rename preset ${name}`}
                  tabIndex={0}
                  onChange={(event) => onUpdateEditingDraft(event.target.value)}
                  onBlur={onCommitChipEdit}
                  onKeyDown={handleChipInputKeyDown}
                />
              );
            }
            return (
              <span key={`chip:${name}`} className="chip">
                <button
                  type="button"
                  className="chip-label"
                  tabIndex={-1}
                  onClick={() => {
                    if (editMode) {
                      if (editingChip) {
                        return;
                      }
                      onStartRenameChip(index);
                    } else {
                      onInsertPreset(name);
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
                    onClick={() => onRemoveChip(index)}
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
              onChange={(event) => onUpdateEditingDraft(event.target.value)}
              onBlur={onCommitChipEdit}
              onKeyDown={handleChipInputKeyDown}
            />
          )}
          {editMode && !editingChip && presetChips.length < MAX_PRESET_CHIPS && (
            <button
              type="button"
              className="chip-add"
              aria-label="Add preset chip"
              title="Add preset chip"
              tabIndex={-1}
              onClick={onStartAddChip}
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
              onClick={onRequestResetPresets}
            >
              Reset
            </button>
          )}
          <button
            type="button"
            className={cx("preset-cog", editMode && "is-active")}
            onClick={onToggleEditMode}
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
    </>
  );
}
