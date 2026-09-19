type ModalTabEvent = Pick<
  KeyboardEvent,
  "key" | "shiftKey" | "ctrlKey" | "altKey" | "metaKey" | "preventDefault"
>;

export function containModalTab(event: ModalTabEvent, dialog: HTMLElement): void {
  if (event.key !== "Tab" || event.ctrlKey || event.altKey || event.metaKey) {
    return;
  }

  // Notices can load or fail while the dialog stays open, changing its tab order.
  const controls = Array.from(
    dialog.querySelectorAll<HTMLElement>("button, a[href], input, select, textarea, [tabindex]")
  ).filter(
    (element) =>
      element.tabIndex >= 0 && !element.matches(":disabled") && element.getClientRects().length > 0
  );
  const first = controls[0];
  const last = controls[controls.length - 1];
  if (!first || !last) {
    event.preventDefault();
    dialog.focus();
    return;
  }

  const active = dialog.ownerDocument.activeElement;
  const atBoundary = event.shiftKey ? active === first : active === last;
  const outsideTabOrder = !controls.some((element) => element === active);
  if (atBoundary || outsideTabOrder) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
}
