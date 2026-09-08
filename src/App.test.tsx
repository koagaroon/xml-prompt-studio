import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import App from "./App";

// Exercise the handlers attached by App itself without adding a DOM emulator.
// Effects and browser layout are outside this harness; state survives explicit renders.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
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
    useEffect: () => {},
  };
});
vi.mock("./tauri", () => ({
  copyXmlToClipboard: vi.fn(),
  requestMainWindowShowAfterFirstPaint: vi.fn(),
}));

type ElementProps = {
  children?: ReactNode;
  "aria-label"?: string;
  className?: string;
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
  return [node, ...elements(node.props.children)];
}

function render() {
  hooks.cursor = 0;
  return elements(App());
}

function labeled(label: string) {
  const element = render().find((entry) => entry.props["aria-label"] === label);
  expect(element, label).toBeDefined();
  return element!;
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
    render().find((entry) => entry.props.children === "Close")!.props.onClick!();
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
    await render().find((entry) => entry.props.children === "Retry")!.props.onClick!();
    expect(labeled("License texts").props.children).toBe("Full license");
    expect(render().some((entry) => entry.props.role === "alert")).toBe(false);
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
