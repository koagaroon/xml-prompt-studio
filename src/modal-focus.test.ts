import { describe, expect, it, vi } from "vitest";
import { containModalTab } from "./modal-focus";

// DOM doubles exercise the real handler; browser tab order/layout need UI verification.
function fixture(labels: string[]) {
  const document = { activeElement: null as HTMLElement | null };
  const makeControl = (
    label: string,
    options = { tabIndex: 0, disabled: false, visible: true }
  ) => {
    const element = {
      label,
      tabIndex: options.tabIndex,
      matches: () => options.disabled,
      getClientRects: () => (options.visible ? [{}] : []),
      focus: vi.fn(() => {
        document.activeElement = element as unknown as HTMLElement;
      }),
    };
    return element as unknown as HTMLElement;
  };
  let controls = labels.map((label) => makeControl(label));
  const dialog = {
    ownerDocument: document,
    querySelectorAll: vi.fn(() => controls),
    focus: vi.fn(() => {
      document.activeElement = dialog as unknown as HTMLElement;
    }),
  } as unknown as HTMLElement;
  const tab = (shiftKey = false, key = "Tab", modifiers = {}) => {
    const event = {
      key,
      shiftKey,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      preventDefault: vi.fn(),
      ...modifiers,
    };
    containModalTab(event, dialog);
    return event;
  };
  return {
    document,
    dialog,
    controls,
    makeControl,
    tab,
    replaceControls(next: HTMLElement[]) {
      controls = next;
    },
  };
}

describe.each([
  { state: "confirmation", labels: ["Cancel", "Confirm"] },
  { state: "loading notices", labels: ["Close"] },
  { state: "loaded notices", labels: ["License texts", "Close"] },
  { state: "failed notices", labels: ["Retry", "Close"] },
])("modal tab containment: $state", ({ labels }) => {
  it("wraps Tab from the last control directly to the first", () => {
    const view = fixture(labels);
    view.document.activeElement = view.controls[view.controls.length - 1];
    const event = view.tab();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(view.document.activeElement).toBe(view.controls[0]);
  });

  it("wraps Shift+Tab from the first control directly to the last", () => {
    const view = fixture(labels);
    view.document.activeElement = view.controls[0];
    const event = view.tab(true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(view.document.activeElement).toBe(view.controls[view.controls.length - 1]);
  });
});

describe("modal keyboard boundaries", () => {
  it.each([false, true])(
    "leaves movement inside the dialog to the browser (reverse: %s)",
    (reverse) => {
      const view = fixture(["License texts", "Close"]);
      const active = view.controls[reverse ? 1 : 0];
      view.document.activeElement = active;
      expect(view.tab(reverse).preventDefault).not.toHaveBeenCalled();
      expect(view.document.activeElement).toBe(active);
      expect(active.focus).not.toHaveBeenCalled();
    }
  );

  it("uses the new first control when notices finish loading", () => {
    const view = fixture(["Close"]);
    const close = view.controls[0];
    const text = view.makeControl("License texts");
    view.document.activeElement = close;
    view.tab();
    expect(view.document.activeElement).toBe(close);
    view.replaceControls([text, close]);
    view.tab();
    expect(view.document.activeElement).toBe(text);
  });

  it.each([false, true])(
    "recovers focus outside the current tab order (reverse: %s)",
    (reverse) => {
      const view = fixture(["Retry", "Close"]);
      view.document.activeElement = view.makeControl("Removed license text");
      expect(view.tab(reverse).preventDefault).toHaveBeenCalledOnce();
      expect(view.document.activeElement).toBe(view.controls[reverse ? 1 : 0]);
    }
  );

  it("skips disabled, hidden, and negative-tab-index controls", () => {
    const view = fixture(["Close"]);
    view.replaceControls([
      view.makeControl("Disabled", { tabIndex: 0, disabled: true, visible: true }),
      view.makeControl("Hidden", { tabIndex: 0, disabled: false, visible: false }),
      view.makeControl("Programmatic only", { tabIndex: -1, disabled: false, visible: true }),
      ...view.controls,
    ]);
    view.document.activeElement = view.controls[0];
    expect(view.tab().preventDefault).toHaveBeenCalledOnce();
    expect(view.document.activeElement).toBe(view.controls[0]);
  });

  it("keeps focus on the dialog if no controls are available", () => {
    const view = fixture([]);
    expect(view.tab().preventDefault).toHaveBeenCalledOnce();
    expect(view.document.activeElement).toBe(view.dialog);
  });

  it.each(["Escape", "Enter", "ArrowDown"])("leaves %s to its existing handler", (key) => {
    const view = fixture(["Close"]);
    expect(view.tab(false, key).preventDefault).not.toHaveBeenCalled();
    expect(view.dialog.querySelectorAll).not.toHaveBeenCalled();
  });

  it.each(["ctrlKey", "altKey", "metaKey"])("preserves host Tab shortcuts using %s", (modifier) => {
    const view = fixture(["Close"]);
    expect(view.tab(false, "Tab", { [modifier]: true }).preventDefault).not.toHaveBeenCalled();
    expect(view.dialog.querySelectorAll).not.toHaveBeenCalled();
  });
});
