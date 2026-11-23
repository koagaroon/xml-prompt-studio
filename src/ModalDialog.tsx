import { useEffect, useRef, type RefObject } from "react";
import { cx } from "./helpers";
import { containModalTab } from "./modal-focus";
import type { ConfirmRequest } from "./types";

type ModalDialogProps = {
  confirmRequest: ConfirmRequest | null;
  noticesOpen: boolean;
  noticesText: string | null;
  noticesError: boolean;
  ribbonRef: RefObject<HTMLElement | null>;
  bodyRef: RefObject<HTMLElement | null>;
  fallbackFocusId: string;
  onClose: () => void;
  onConfirm: () => void;
  onRetryNotices: () => void;
};

// Shared modal surface for destructive confirmations and offline license text.
// Marks the background shell inert, wraps Tab inside active controls, handles
// Escape and full press+release outside clicks, and restores focus on close.
export function ModalDialog({
  confirmRequest,
  noticesOpen,
  noticesText,
  noticesError,
  ribbonRef,
  bodyRef,
  fallbackFocusId,
  onClose,
  onConfirm,
  onRetryNotices,
}: ModalDialogProps) {
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const overlayPressedRef = useRef(false);
  const overlayReleasedRef = useRef(false);

  const isOpen = Boolean(confirmRequest || noticesOpen);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
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
        onClose();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("keydown", handleKey);
      if (ribbon) ribbon.inert = false;
      if (body) body.inert = false;
      if (previouslyFocused?.isConnected) {
        previouslyFocused.focus();
      } else {
        document.getElementById(fallbackFocusId)?.focus();
      }
    };
  }, [isOpen, ribbonRef, bodyRef, fallbackFocusId, onClose]);

  if (!isOpen) {
    return null;
  }

  return (
    <div
      className="modal-overlay"
      onMouseDown={(event) => {
        overlayPressedRef.current = event.target === event.currentTarget;
      }}
      onMouseUp={(event) => {
        overlayReleasedRef.current = event.target === event.currentTarget;
      }}
      onClick={() => {
        if (overlayPressedRef.current && overlayReleasedRef.current) {
          onClose();
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
        <h3 id="confirm-title">{noticesOpen ? "Third-party licenses" : confirmRequest?.title}</h3>
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
            <button type="button" onClick={onRetryNotices}>
              Retry
            </button>
          )}
          <button type="button" ref={cancelButtonRef} onClick={onClose}>
            {noticesOpen ? "Close" : "Cancel"}
          </button>
          {confirmRequest && (
            <button
              type="button"
              className={confirmRequest.confirmKind === "danger" ? "danger-button" : undefined}
              onClick={onConfirm}
            >
              {confirmRequest.confirmLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
