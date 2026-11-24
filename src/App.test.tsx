import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import App from "./App";

// Exercise the handlers attached by App and its child components without adding
// a DOM emulator. Effects and browser layout are outside this harness; state
// survives explicit renders.
const hooks = vi.hoisted(() => ({
  values: [] as unknown[],
  cursor: 0,
  effects: [] as Array<() => void | (() => void)>,
}));
const tauriMocks = vi.hoisted(() => ({
  confirmMainWindowClose: vi.fn(),
  copyXmlToClipboard: vi.fn(),
  registerMainWindowCloseGuard: vi.fn(() => () => {}),
  requestMainWindowShowAfterFirstPaint: vi.fn(),
  setMainWindowUnsavedWork: vi.fn(),
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const slot = hooks.cursor++;
      if (!(slot in hooks.values)) {
        hooks.values[slot] = typeof initial === "function" ? initial() : initial;
      }
      return [
        hooks.values[slot],
        (next: unknown) => {
          hooks.values[slot] = typeof next === "function" ? next(hooks.values[slot]) : next;
        },
      ];
    },
    useRef: (initial: unknown) => {
      const slot = hooks.cursor++;
      if (!(slot in hooks.values)) hooks.values[slot] = { current: initial };
      return hooks.values[slot];
    },
    useMemo: (compute: () => unknown) => compute(),
    useCallback: (callback: unknown) => callback,
    useDeferredValue: (value: unknown) => value,
    useEffect: (effect: () => void | (() => void)) => {
      hooks.effects.push(effect);
    },
  };
});
vi.mock("./tauri", () => tauriMocks);

type ElementProps = {
  children?: ReactNode;
  "aria-label"?: string;
  className?: string;
  name?: string;
  role?: string;
  value?: string;
  onClick?: () => void | Promise<void>;
  onChange?: (event: { target: { value: string } }) => void;
  onKeyDown?: (event: {
    key: string;
    nativeEvent: { isComposing: boolean; keyCode: number };
    preventDefault: () => void;
  }) => void;
};

function elements(node: ReactNode): ReactElement<ElementProps>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<ElementProps>(node)) return [];
  if (typeof node.type === "function") {
    const Component = node.type as (props: ElementProps) => ReactNode;
    return elements(Component(node.props));
  }
  return [node, ...elements(node.props.children)];
}

function render() {
  hooks.cursor = 0;
  hooks.effects = [];
  return elements(App());
}

function labeled(label: string) {
  const element = render().find((entry) => entry.props["aria-label"] === label);
  expect(element, label).toBeDefined();
  return element!;
}

function buttonWithText(text: string) {
  const button = render().find((entry) => entry.type === "button" && entry.props.children === text);
  expect(button, text).toBeDefined();
  return button!;
}

function beginChipEdit(mode: "rename" | "add") {
  labeled("Edit preset chips").props.onClick!();
  if (mode === "add") labeled("Add preset chip").props.onClick!();
  else {
    render().find(
      (entry) => entry.props.className === "chip-label" && entry.props.children === "feedback"
    )!.props.onClick!();
  }
  const label = mode === "add" ? "Name the new preset chip" : "Rename preset feedback";
  labeled(label).props.onChange!({ target: { value: "问题" } });
  return label;
}

beforeEach(() => {
  hooks.values = [];
  hooks.cursor = 0;
  hooks.effects = [];
  tauriMocks.confirmMainWindowClose.mockReset().mockResolvedValue(undefined);
  tauriMocks.copyXmlToClipboard.mockReset();
  tauriMocks.registerMainWindowCloseGuard.mockReset().mockImplementation(() => () => {});
  tauriMocks.requestMainWindowShowAfterFirstPaint.mockReset();
  tauriMocks.setMainWindowUnsavedWork.mockReset();
});

afterEach(() => vi.unstubAllGlobals());

describe("offline license surface", () => {
  it("opens the bundled notice text, preserves literal content, and reuses it after closing", async () => {
    const text = "Copyright holder\nPermission text <literal> & complete";
    const fetchMock = vi.fn().mockResolvedValue(new Response(text));
    vi.stubGlobal("fetch", fetchMock);
    await labeled("Third-party licenses").props.onClick!();
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("./third-party-notices.txt");
    expect(labeled("License texts").props.children).toBe(text);
    buttonWithText("Close").props.onClick!();
    expect(render().some((entry) => entry.props.role === "dialog")).toBe(false);
    await labeled("Third-party licenses").props.onClick!();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(labeled("License texts").props.children).toBe(text);
  });

  it("shows a failed local load and permits retry instead of displaying an empty license", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValueOnce(new Response("Full license"));
    vi.stubGlobal("fetch", fetchMock);
    await labeled("Third-party licenses").props.onClick!();
    expect(render().some((entry) => entry.props.role === "alert")).toBe(true);
    await buttonWithText("Retry").props.onClick!();
    expect(labeled("License texts").props.children).toBe("Full license");
    expect(render().some((entry) => entry.props.role === "alert")).toBe(false);
  });
});

describe("delete confirmation for non-empty elements", () => {
  it("deletes an empty non-final sibling immediately without opening a dialog", () => {
    buttonWithText("Add Sibling").props.onClick!();
    expect(render().filter((entry) => entry.props.className?.includes("element-row"))).toHaveLength(
      2
    );

    buttonWithText("Delete").props.onClick!();
    expect(render().some((entry) => entry.props.role === "dialog")).toBe(false);
    expect(render().filter((entry) => entry.props.className?.includes("element-row"))).toHaveLength(
      1
    );
  });

  it("asks for confirmation before deleting an element with text or children, and honors Cancel vs Delete", () => {
    buttonWithText("Add Sibling").props.onClick!();
    render().find((entry) => entry.props.name === "tagName")!.props.onChange!({
      target: { value: "context" },
    });
    render().find((entry) => entry.props.name === "textContent")!.props.onChange!({
      target: { value: "Important prompt body" },
    });
    buttonWithText("Add Child").props.onClick!();
    // Re-select <context> (the second top-level row, index 1) to delete the parent subtree.
    render().filter((entry) => entry.props.className?.includes("element-row"))[1]!.props.onClick!();

    // Ribbon Delete opens the confirmation dialog instead of deleting right away.
    buttonWithText("Delete").props.onClick!();
    expect(render().some((entry) => entry.props.role === "dialog")).toBe(true);
    expect(render().some((entry) => entry.props.children === "Delete <context>?")).toBe(true);

    // Cancel keeps the subtree intact.
    buttonWithText("Cancel").props.onClick!();
    expect(render().some((entry) => entry.props.role === "dialog")).toBe(false);
    expect(render().filter((entry) => entry.props.className?.includes("element-row"))).toHaveLength(
      3
    );

    // Confirming Delete removes <context> and its child element.
    buttonWithText("Delete").props.onClick!();
    const deleteButtons = render().filter(
      (entry) => entry.type === "button" && entry.props.children === "Delete"
    );
    expect(deleteButtons).toHaveLength(2);
    deleteButtons[1]!.props.onClick!();
    expect(render().some((entry) => entry.props.role === "dialog")).toBe(false);
    expect(render().filter((entry) => entry.props.className?.includes("element-row"))).toHaveLength(
      1
    );
  });
});

describe("window close confirmation", () => {
  it("opens the close confirmation dialog when requested, canceling cleanly or confirming close", () => {
    let triggerCloseRequest: (() => void) | undefined;
    tauriMocks.registerMainWindowCloseGuard.mockImplementation(((handler: () => void) => {
      triggerCloseRequest = handler;
      return () => {};
    }) as () => () => void);

    vi.stubGlobal("document", { documentElement: { setAttribute: vi.fn() } });
    render();
    for (const effect of hooks.effects) {
      effect();
    }
    expect(tauriMocks.setMainWindowUnsavedWork).toHaveBeenCalledWith(false);
    expect(triggerCloseRequest).toBeTypeOf("function");

    triggerCloseRequest!();
    expect(
      render().some((entry) => entry.props.children === "Discard current prompt and close?")
    ).toBe(true);

    buttonWithText("Cancel").props.onClick!();
    expect(render().some((entry) => entry.props.role === "dialog")).toBe(false);
    expect(tauriMocks.confirmMainWindowClose).not.toHaveBeenCalled();

    triggerCloseRequest!();
    buttonWithText("Close").props.onClick!();
    expect(tauriMocks.confirmMainWindowClose).toHaveBeenCalledOnce();
  });
});

describe.each(["rename", "add"] as const)("preset %s keyboard handling", (mode) => {
  it.each([
    { key: "Enter", isComposing: true, keyCode: 13 },
    { key: "Escape", isComposing: true, keyCode: 27 },
    { key: "Enter", isComposing: false, keyCode: 229 },
    { key: "Escape", isComposing: false, keyCode: 229 },
  ])("leaves IME $key ($isComposing/$keyCode) to the candidate window", (nativeEvent) => {
    const label = beginChipEdit(mode);
    const preventDefault = vi.fn();
    labeled(label).props.onKeyDown!({ key: nativeEvent.key, nativeEvent, preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(labeled(label).props.value).toBe("问题");
    expect(render().filter((entry) => entry.props.className === "chip-label")).toHaveLength(
      mode === "add" ? 4 : 3
    );

    labeled(label).props.onKeyDown!({
      key: "Enter",
      nativeEvent: { isComposing: false, keyCode: 13 },
      preventDefault,
    });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(render().some((entry) => entry.props["aria-label"] === label)).toBe(false);
    expect(render().some((entry) => entry.props.children === "问题")).toBe(true);
  });

  it("cancels a normal Escape without changing the preset list", () => {
    const label = beginChipEdit(mode);
    const preventDefault = vi.fn();
    labeled(label).props.onKeyDown!({
      key: "Escape",
      nativeEvent: { isComposing: false, keyCode: 27 },
      preventDefault,
    });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(render().some((entry) => entry.props["aria-label"] === label)).toBe(false);
    expect(
      render()
        .filter((entry) => entry.props.className === "chip-label")
        .map((entry) => entry.props.children)
    ).toEqual(["feedback", "question", "instruction", "extra"]);
  });
});
