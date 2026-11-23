import type { RefObject } from "react";
import { MoonIcon, SunIcon } from "./Icons";
import type { Theme } from "./theme";

type RibbonProps = {
  ribbonRef: RefObject<HTMLElement | null>;
  canMoveUp: boolean;
  canMoveDown: boolean;
  theme: Theme;
  onNewBlank: () => void;
  onAddChild: () => void;
  onAddSibling: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
  onOpenNotices: () => void;
  onToggleTheme: () => void;
  onCopyPreview: () => void;
};

// Three-zone top bar: New Blank anchor (left) | per-element cluster (center) |
// Licenses + Theme + Copy XML anchor (right). Action buttons carry tabIndex={-1}
// so keyboard Tab cycles strictly between Tag Name and Text Content, while
// Licenses remains keyboard-reachable.
export function Ribbon({
  ribbonRef,
  canMoveUp,
  canMoveDown,
  theme,
  onNewBlank,
  onAddChild,
  onAddSibling,
  onMoveUp,
  onMoveDown,
  onDelete,
  onOpenNotices,
  onToggleTheme,
  onCopyPreview,
}: RibbonProps) {
  return (
    <header className="ribbon" ref={ribbonRef}>
      <button type="button" className="new-blank-button" tabIndex={-1} onClick={onNewBlank}>
        New Blank
      </button>

      <div className="ribbon-cluster">
        <button type="button" tabIndex={-1} onClick={onAddChild}>
          Add Child
        </button>
        <button type="button" tabIndex={-1} onClick={onAddSibling}>
          Add Sibling
        </button>
        <button type="button" tabIndex={-1} onClick={onMoveUp} disabled={!canMoveUp}>
          Move Up
        </button>
        <button type="button" tabIndex={-1} onClick={onMoveDown} disabled={!canMoveDown}>
          Move Down
        </button>
        <button type="button" className="danger-button" tabIndex={-1} onClick={onDelete}>
          Delete
        </button>
      </div>

      <div className="ribbon-right">
        <button type="button" onClick={onOpenNotices} aria-label="Third-party licenses">
          Licenses
        </button>
        <button
          type="button"
          className="theme-toggle"
          tabIndex={-1}
          onClick={onToggleTheme}
          aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        >
          {theme === "dark" ? <SunIcon /> : <MoonIcon />}
        </button>
        <button type="button" className="copy-button" tabIndex={-1} onClick={onCopyPreview}>
          Copy XML
        </button>
      </div>
    </header>
  );
}
