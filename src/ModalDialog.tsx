import { useEffect, useRef, type RefObject } from "react";
import { cx } from "./helpers";
import { containModalTab } from "./modal-focus";
import type { ModalState } from "./types";

type ModalDialogProps = {
  modal: ModalState;
  noticesText: string | null;
  noticesError: boolean;
  ribbonRef: RefObject<HTMLElement | null>;
  bodyRef: RefObject<HTMLElement | null>;
  fallbackFocusId: string;
  onClose: () => void;
  onConfirm: () => void;
  onRetryNotices: () => void;
};

function canRestoreFocusTo(element: HTMLElement | null): element is HTMLElement {
  if (!element || !element.isConnected) {
    return false;
  }
  if (element === document.body || element === document.documentElement) {
    return false;
  }
  return !element.matches(":disabled");
}

// Shared modal surface for destructive confirmations and offline license text.
// Marks the background shell inert, wraps Tab inside active controls, handles
// Escape and full left-button press+release outside clicks, resets safe initial
// focus across modal replacements, and restores focus on close.
export function ModalDialog({
  modal,
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
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const isOpen = modal !== null;
  const modalId = modal?.id ?? null;
  const noticesOpen = modal?.kind === "notices";
  const confirmRequest = modal?.kind === "confirm" ? modal.request : null;

  useEffect(() => {
    overlayPressedRef.current = false;
    overlayReleasedRef.current = false;
    if (modalId !== null) {
      cancelButtonRef.current?.focus();
    }
  }, [modalId]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const active = document.activeElement;
    if (!dialogRef.current?.contains(active)) {
      cancelButtonRef.current?.focus();
    }
  });

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const ribbon = ribbonRef.current;
    const body = bodyRef.current;
    if (ribbon) ribbon.inert = true;
    if (body) body.inert = true;
    const handleKey = (event: KeyboardEvent) => {
      if (dialogRef.current) {
        containModalTab(event, dialogRef.current);
      }
      if (event.key === "Escape" && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault();
        onCloseRef.current();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("keydown", handleKey);
      overlayPressedRef.current = false;
      overlayReleasedRef.current = false;
      if (ribbon) ribbon.inert = false;
      if (body) body.inert = false;
      if (canRestoreFocusTo(previouslyFocused)) {
        previouslyFocused.focus();
      } else {
        document.getElementById(fallbackFocusId)?.focus();
      }
    };
  }, [isOpen, ribbonRef, bodyRef, fallbackFocusId]);

  if (!isOpen) {
    return null;
  }

  return (
    <div
      className="modal-overlay"
      onMouseDown={(event) => {
        overlayPressedRef.current = event.button === 0 && event.target === event.currentTarget;
        overlayReleasedRef.current = false;
      }}
      onMouseUp={(event) => {
        overlayReleasedRef.current = event.button === 0 && event.target === event.currentTarget;
      }}
      onClick={(event) => {
        const shouldClose =
          event.target === event.currentTarget &&
          overlayPressedRef.current &&
          overlayReleasedRef.current;
        overlayPressedRef.current = false;
        overlayReleasedRef.current = false;
        if (shouldClose) {
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
