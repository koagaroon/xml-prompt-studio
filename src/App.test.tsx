import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactNode } from "react";

// Fiber-keyed React + lightweight DOM harness (zero external DOM package bloat).
// Gives every component instance isolated hook slots, real Object.is dependency
// caching on useMemo/useCallback/useEffect, automatic effect + cleanup execution
// (including StrictMode double-mount), controllable useDeferredValue lag, host
// ref attachment, focus/inert tracking, and parent-bubbling mouse/keyboard events.

type EffectRecord = {
  deps: readonly unknown[] | undefined;
  cleanup?: () => void;
};

type ComponentFiber = {
  values: unknown[];
  memos: Array<{ value: unknown; deps: readonly unknown[] | undefined }>;
  effects: EffectRecord[];
  deferred?: unknown;
};

type PendingEffect = {
  fiber: ComponentFiber;
  slot: number;
  create: () => void | (() => void);
  deps: readonly unknown[] | undefined;
};

const runtime = vi.hoisted(() => ({
  fibers: new Map<string, ComponentFiber>(),
  seenPaths: new Set<string>(),
  currentFiber: null as ComponentFiber | null,
  stateCursor: 0,
  memoCursor: 0,
  effectCursor: 0,
  pendingEffects: [] as PendingEffect[],
  deferring: false,
  scheduleRerender: () => {},
}));

function depsEqual(
  prev: readonly unknown[] | undefined,
  next: readonly unknown[] | undefined
): boolean {
  if (!prev || !next || prev.length !== next.length) {
    return false;
  }
  for (let i = 0; i < prev.length; i++) {
    if (!Object.is(prev[i], next[i])) {
      return false;
    }
  }
  return true;
}

const tauriMocks = vi.hoisted(() => ({
  confirmMainWindowClose: vi.fn(),
  copyXmlToClipboard: vi.fn(),
  registerMainWindowCloseGuard: vi.fn<(onClose: () => void) => () => void>(() => () => {}),
  requestMainWindowShowAfterFirstPaint: vi.fn(),
  setMainWindowUnsavedWork: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const fiber = runtime.currentFiber!;
      const slot = runtime.stateCursor++;
      if (!(slot in fiber.values)) {
        fiber.values[slot] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      }
      return [
        fiber.values[slot],
        (next: unknown) => {
          const prev = fiber.values[slot];
          const resolved =
            typeof next === "function" ? (next as (p: unknown) => unknown)(prev) : next;
          if (!Object.is(prev, resolved)) {
            fiber.values[slot] = resolved;
            runtime.scheduleRerender();
          }
        },
      ];
    },
    useRef: (initial: unknown) => {
      const fiber = runtime.currentFiber!;
      const slot = runtime.stateCursor++;
      if (!(slot in fiber.values)) {
        fiber.values[slot] = { current: initial };
      }
      return fiber.values[slot];
    },
    useMemo: (compute: () => unknown, deps?: readonly unknown[]) => {
      const fiber = runtime.currentFiber!;
      const slot = runtime.memoCursor++;
      const prev = fiber.memos[slot];
      if (prev && depsEqual(prev.deps, deps)) {
        return prev.value;
      }
      const value = compute();
      fiber.memos[slot] = { value, deps };
      return value;
    },
    useCallback: (callback: unknown, deps?: readonly unknown[]) => {
      const fiber = runtime.currentFiber!;
      const slot = runtime.memoCursor++;
      const prev = fiber.memos[slot];
      if (prev && depsEqual(prev.deps, deps)) {
        return prev.value;
      }
      fiber.memos[slot] = { value: callback, deps };
      return callback;
    },
    useDeferredValue: (value: unknown) => {
      const fiber = runtime.currentFiber!;
      if (!("deferred" in fiber)) {
        fiber.deferred = value;
      } else if (!runtime.deferring) {
        fiber.deferred = value;
      }
      return fiber.deferred;
    },
    useEffect: (create: () => void | (() => void), deps?: readonly unknown[]) => {
      const fiber = runtime.currentFiber!;
      const slot = runtime.effectCursor++;
      runtime.pendingEffects.push({ fiber, slot, create, deps });
    },
  };
});

vi.mock("./tauri", () => tauriMocks);

import App from "./App";
import { DEFAULT_PRESET_CHIPS, PRESET_CHIPS_STORAGE_KEY } from "./presets";
import { THEME_STORAGE_KEY } from "./theme";

type HostProps = Record<string, unknown> & {
  children?: ReactNode;
  id?: string;
  name?: string;
  className?: string;
  role?: string;
  value?: string;
  disabled?: boolean;
  tabIndex?: number;
  "aria-label"?: string;
  "aria-invalid"?: boolean;
  "aria-current"?: string;
  "aria-busy"?: boolean;
  ref?: { current: unknown } | ((instance: unknown) => void);
  onClick?: (event: unknown) => unknown;
  onMouseDown?: (event: unknown) => void;
  onMouseUp?: (event: unknown) => void;
  onFocus?: (event: unknown) => void;
  onBlur?: (event: unknown) => void;
  onChange?: (event: unknown) => void;
  onCompositionStart?: (event: unknown) => void;
  onCompositionEnd?: (event: unknown) => void;
  onKeyDown?: (event: unknown) => void;
  onDragOver?: (event: unknown) => void;
  onDrop?: (event: unknown) => void;
};

class TestElement {
  tagName: string;
  props: HostProps;
  parent: TestElement | null = null;
  children: TestElement[] = [];
  textParts: string[] = [];
  inert = false;
  isConnected = true;
  ownerDocument: TestDocument;

  constructor(tagName: string, props: HostProps, ownerDocument: TestDocument) {
    this.tagName = tagName.toUpperCase();
    this.props = props;
    this.ownerDocument = ownerDocument;
  }

  get id(): string {
    return typeof this.props.id === "string" ? this.props.id : "";
  }

  get className(): string {
    return typeof this.props.className === "string" ? this.props.className : "";
  }

  get disabled(): boolean {
    return Boolean(this.props.disabled);
  }

  get tabIndex(): number {
    if (typeof this.props.tabIndex === "number") {
      return this.props.tabIndex;
    }
    if (["BUTTON", "INPUT", "TEXTAREA", "SELECT", "A"].includes(this.tagName)) {
      return 0;
    }
    return -1;
  }

  get value(): string {
    return typeof this.props.value === "string" ? this.props.value : "";
  }

  get textContent(): string {
    const childText = this.children.map((child) => child.textContent).join("");
    return `${this.textParts.join("")}${childText}`;
  }

  focus(): void {
    if (!this.isConnected || this.disabled) {
      return;
    }
    const previous = this.ownerDocument.activeElement;
    if (previous && previous !== this && previous !== this.ownerDocument.body) {
      this.ownerDocument.activeElement = this;
      previous.props.onBlur?.({
        target: previous,
        currentTarget: previous,
        relatedTarget: this,
      });
    } else {
      this.ownerDocument.activeElement = this;
    }
  }

  blur(): void {
    if (this.ownerDocument.activeElement === this) {
      this.ownerDocument.activeElement = this.ownerDocument.body;
      this.props.onBlur?.({
        target: this,
        currentTarget: this,
        relatedTarget: null,
      });
    }
  }

  contains(other: unknown): boolean {
    let cursor = other instanceof TestElement ? other : null;
    while (cursor) {
      if (cursor === this) {
        return true;
      }
      cursor = cursor.parent;
    }
    return false;
  }

  matches(selector: string): boolean {
    if (selector === ":disabled") {
      return this.disabled;
    }
    return false;
  }

  getClientRects(): Array<{ width: number; height: number }> {
    return this.isConnected ? [{ width: 100, height: 24 }] : [];
  }

  querySelectorAll(selector: string): TestElement[] {
    const tokens = selector.split(",").map((part) => part.trim());
    const results: TestElement[] = [];
    const visit = (el: TestElement) => {
      for (const child of el.children) {
        const matched = tokens.some((token) => {
          if (token === "[tabindex]") {
            return typeof child.props.tabIndex === "number";
          }
          if (token === "a[href]") {
            return child.tagName === "A" && typeof child.props.href === "string";
          }
          return child.tagName === token.toUpperCase();
        });
        if (matched) {
          results.push(child);
        }
        visit(child);
      }
    };
    visit(this);
    return results;
  }
}

class TestDocument {
  body: TestElement;
  documentElement: TestElement & {
    attributes: Map<string, string>;
    setAttribute: (name: string, value: string) => void;
    getAttribute: (name: string) => string | null;
  };
  activeElement: TestElement;
  rootNodes: TestElement[] = [];

  constructor() {
    const docEl = new TestElement("html", {}, this) as TestElement & {
      attributes: Map<string, string>;
      setAttribute: (name: string, value: string) => void;
      getAttribute: (name: string) => string | null;
    };
    docEl.attributes = new Map();
    docEl.setAttribute = (name: string, value: string) => {
      docEl.attributes.set(name, value);
    };
    docEl.getAttribute = (name: string) => docEl.attributes.get(name) ?? null;

    this.documentElement = docEl;
    this.body = new TestElement("body", {}, this);
    this.activeElement = this.body;
  }

  getElementById(id: string): TestElement | null {
    const search = (nodes: TestElement[]): TestElement | null => {
      for (const node of nodes) {
        if (node.id === id) {
          return node;
        }
        const nested = search(node.children);
        if (nested) {
          return nested;
        }
      }
      return null;
    };
    return search(this.rootNodes);
  }
}

function createHarness(options: { strictMode?: boolean } = {}) {
  const doc = new TestDocument();
  const windowListeners = new Map<string, Set<(event: KeyboardEvent) => void>>();

  vi.stubGlobal("document", doc);
  vi.stubGlobal("HTMLElement", TestElement);
  const existingWindow =
    typeof globalThis.window === "object" && globalThis.window !== null ? globalThis.window : {};
  vi.stubGlobal("window", {
    ...existingWindow,
    addEventListener: (type: string, listener: (event: KeyboardEvent) => void) => {
      if (!windowListeners.has(type)) {
        windowListeners.set(type, new Set());
      }
      windowListeners.get(type)!.add(listener);
    },
    removeEventListener: (type: string, listener: (event: KeyboardEvent) => void) => {
      windowListeners.get(type)?.delete(listener);
    },
  });

  let attachedRefs = new Map<string, { refObj: { current: unknown }; element: TestElement }>();
  let allNodes: TestElement[] = [];
  let isRendering = false;
  let dirtyDuringRender = false;
  let unmounted = false;

  const buildTree = (
    node: ReactNode,
    path: string,
    parent: TestElement | null,
    nextRefs: Map<string, { refObj: { current: unknown }; element: TestElement }>,
    collected: TestElement[]
  ): TestElement[] => {
    if (node === null || node === undefined || typeof node === "boolean") {
      return [];
    }
    if (typeof node === "string" || typeof node === "number") {
      if (parent) {
        parent.textParts.push(String(node));
      }
      return [];
    }
    if (Array.isArray(node)) {
      return node.flatMap((child, index) =>
        buildTree(child, `${path}.${index}`, parent, nextRefs, collected)
      );
    }
    if (!isValidElement<HostProps>(node)) {
      return [];
    }
    const keyPart = node.key !== null ? String(node.key) : path;
    if (typeof node.type === "function") {
      const fn = node.type as (props: HostProps) => ReactNode;
      const fiberKey = `${keyPart}:${fn.name || "Component"}`;
      runtime.seenPaths.add(fiberKey);
      let fiber = runtime.fibers.get(fiberKey);
      if (!fiber) {
        fiber = { values: [], memos: [], effects: [] };
        runtime.fibers.set(fiberKey, fiber);
      }
      const prevFiber = runtime.currentFiber;
      const prevState = runtime.stateCursor;
      const prevMemo = runtime.memoCursor;
      const prevEffect = runtime.effectCursor;

      runtime.currentFiber = fiber;
      runtime.stateCursor = 0;
      runtime.memoCursor = 0;
      runtime.effectCursor = 0;
      const rendered = fn(node.props);
      runtime.currentFiber = prevFiber;
      runtime.stateCursor = prevState;
      runtime.memoCursor = prevMemo;
      runtime.effectCursor = prevEffect;

      return buildTree(rendered, `${fiberKey}>`, parent, nextRefs, collected);
    }
    if (typeof node.type === "symbol") {
      // React.Fragment
      return buildTree(node.props.children, `${keyPart}:frag`, parent, nextRefs, collected);
    }

    const hostTag = String(node.type);
    const existing = attachedRefs.get(keyPart)?.element;
    const element =
      existing && existing.tagName === hostTag.toUpperCase()
        ? existing
        : new TestElement(hostTag, node.props, doc);
    element.props = node.props;
    element.parent = parent;
    element.children = [];
    element.textParts = [];
    element.isConnected = true;
    collected.push(element);

    if (node.props.ref && typeof node.props.ref === "object" && "current" in node.props.ref) {
      nextRefs.set(keyPart, {
        refObj: node.props.ref as { current: unknown },
        element,
      });
    } else {
      nextRefs.set(keyPart, { refObj: { current: null }, element });
    }

    const childElements = buildTree(
      node.props.children,
      `${keyPart}/${hostTag}`,
      element,
      nextRefs,
      collected
    );
    element.children = childElements;
    return [element];
  };

  const flushPendingEffects = () => {
    const batch = runtime.pendingEffects.splice(0);
    for (const item of batch) {
      const prev = item.fiber.effects[item.slot];
      if (prev && item.deps !== undefined && depsEqual(prev.deps, item.deps)) {
        continue;
      }
      prev?.cleanup?.();
      const cleanup = item.create();
      item.fiber.effects[item.slot] = {
        deps: item.deps,
        cleanup: typeof cleanup === "function" ? cleanup : undefined,
      };
    }
  };

  const commitRender = () => {
    if (unmounted) {
      return;
    }
    if (isRendering) {
      dirtyDuringRender = true;
      return;
    }
    isRendering = true;
    try {
      let guard = 0;
      do {
        dirtyDuringRender = false;
        if (++guard > 25) {
          throw new Error("Exceeded maximum synchronous re-render depth in test harness");
        }
        runtime.seenPaths.clear();
        runtime.pendingEffects = [];
        const nextRefs = new Map<string, { refObj: { current: unknown }; element: TestElement }>();
        const collected: TestElement[] = [];
        const prevElementSet = new Set(allNodes);

        const roots = buildTree(<App />, "root", null, nextRefs, collected);
        const nextElementSet = new Set(collected);

        for (const oldEl of prevElementSet) {
          if (!nextElementSet.has(oldEl)) {
            oldEl.isConnected = false;
            if (doc.activeElement === oldEl) {
              doc.activeElement = doc.body;
            }
          }
        }

        for (const [oldKey, binding] of attachedRefs.entries()) {
          if (!nextRefs.has(oldKey)) {
            binding.refObj.current = null;
          }
        }
        for (const binding of nextRefs.values()) {
          binding.refObj.current = binding.element;
        }

        for (const [fiberKey, fiber] of runtime.fibers.entries()) {
          if (!runtime.seenPaths.has(fiberKey)) {
            for (const eff of fiber.effects) {
              eff?.cleanup?.();
            }
            runtime.fibers.delete(fiberKey);
          }
        }

        attachedRefs = nextRefs;
        allNodes = collected;
        doc.rootNodes = roots;
        for (const el of collected) {
          if (!prevElementSet.has(el) && Boolean(el.props.autoFocus)) {
            el.focus();
          }
        }
        flushPendingEffects();
      } while (dirtyDuringRender);
    } finally {
      isRendering = false;
    }
  };

  runtime.scheduleRerender = commitRender;
  commitRender();

  if (options.strictMode) {
    // Simulate React 19 StrictMode initial effect cleanup -> re-setup cycle.
    for (const fiber of runtime.fibers.values()) {
      for (let i = 0; i < fiber.effects.length; i++) {
        const eff = fiber.effects[i];
        eff?.cleanup?.();
        fiber.effects[i] = { deps: undefined };
      }
    }
    commitRender();
  }

  const bubble = (
    start: TestElement,
    propName: "onMouseDown" | "onMouseUp" | "onClick" | "onDragOver" | "onDrop",
    extra: Record<string, unknown> = {}
  ) => {
    let defaultPrevented = false;
    let cursor: TestElement | null = start;
    while (cursor) {
      const handler = cursor.props[propName];
      if (typeof handler === "function") {
        handler({
          target: start,
          currentTarget: cursor,
          button: 0,
          defaultPrevented,
          preventDefault: () => {
            defaultPrevented = true;
          },
          ...extra,
        });
      }
      cursor = cursor.parent;
    }
    return { defaultPrevented };
  };

  return {
    doc,
    get nodes() {
      return allNodes;
    },
    setDeferring(value: boolean) {
      runtime.deferring = value;
    },
    flushDeferred() {
      runtime.deferring = false;
      commitRender();
    },
    unmount() {
      unmounted = true;
      for (const binding of attachedRefs.values()) {
        binding.refObj.current = null;
      }
      for (const el of allNodes) {
        el.isConnected = false;
      }
      for (const fiber of runtime.fibers.values()) {
        for (const eff of fiber.effects) {
          eff?.cleanup?.();
        }
      }
      runtime.fibers.clear();
    },
    byLabel(label: string): TestElement {
      const found = allNodes.find((el) => el.props["aria-label"] === label);
      expect(found, `element with aria-label="${label}"`).toBeDefined();
      return found!;
    },
    byName(name: string): TestElement {
      const found = allNodes.find((el) => el.props.name === name);
      expect(found, `element with name="${name}"`).toBeDefined();
      return found!;
    },
    button(text: string): TestElement {
      const matches = allNodes.filter((el) => el.tagName === "BUTTON" && el.textContent === text);
      expect(matches.length, `button "${text}"`).toBeGreaterThan(0);
      return matches[matches.length - 1]!;
    },
    buttons(text: string): TestElement[] {
      return allNodes.filter((el) => el.tagName === "BUTTON" && el.textContent === text);
    },
    byClass(token: string): TestElement[] {
      return allNodes.filter((el) => el.className.split(/\s+/u).includes(token));
    },
    async click(target: TestElement, button = 0) {
      if (target.disabled) {
        return;
      }
      const down = bubble(target, "onMouseDown", { button });
      if (button === 0 && !down.defaultPrevented) {
        if (["BUTTON", "INPUT", "TEXTAREA"].includes(target.tagName)) {
          target.focus();
        } else if (doc.activeElement !== doc.body) {
          doc.activeElement.blur();
        }
      }
      bubble(target, "onMouseUp", { button });
      if (button === 0) {
        let cursor: TestElement | null = target;
        while (cursor) {
          if (typeof cursor.props.onClick === "function") {
            void cursor.props.onClick({
              target,
              currentTarget: cursor,
              button: 0,
              preventDefault: () => {},
            });
          }
          cursor = cursor.parent;
        }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
      }
    },
    async activateViaKeyboard(target: TestElement) {
      if (target.disabled) {
        return;
      }
      target.focus();
      let cursor: TestElement | null = target;
      while (cursor) {
        if (typeof cursor.props.onClick === "function") {
          void cursor.props.onClick({
            target,
            currentTarget: cursor,
            button: 0,
            detail: 0,
            preventDefault: () => {},
          });
        }
        cursor = cursor.parent;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    },
    type(target: TestElement, value: string, isComposing = false) {
      target.focus();
      target.props.onChange?.({
        target: { value },
        currentTarget: { value },
        nativeEvent: { isComposing },
      });
    },
    composeStart(target: TestElement) {
      target.focus();
      target.props.onCompositionStart?.({ target, currentTarget: target });
    },
    composeEnd(target: TestElement, value: string) {
      target.props.onCompositionEnd?.({
        target: { value },
        currentTarget: { value },
      });
    },
    keyDown(
      target: TestElement,
      key: string,
      options: {
        shiftKey?: boolean;
        ctrlKey?: boolean;
        altKey?: boolean;
        metaKey?: boolean;
        isComposing?: boolean;
        keyCode?: number;
      } = {}
    ) {
      let defaultPrevented = false;
      const nativeEvent = {
        key,
        shiftKey: Boolean(options.shiftKey),
        ctrlKey: Boolean(options.ctrlKey),
        altKey: Boolean(options.altKey),
        metaKey: Boolean(options.metaKey),
        isComposing: Boolean(options.isComposing),
        keyCode: options.keyCode ?? 0,
        preventDefault: () => {
          defaultPrevented = true;
        },
      };
      target.props.onKeyDown?.({
        key,
        nativeEvent,
        preventDefault: nativeEvent.preventDefault,
      });
      for (const listener of windowListeners.get("keydown") ?? []) {
        listener(nativeEvent as unknown as KeyboardEvent);
      }
      return { defaultPrevented };
    },
    dispatchWindowDrag(kind: "onDragOver" | "onDrop", types: string[]) {
      const shell = this.byClass("app-shell")[0]!;
      return bubble(shell, kind, { dataTransfer: { types } });
    },
    mouseGesture(downTarget: TestElement, upTarget: TestElement, button = 0) {
      bubble(downTarget, "onMouseDown", { button });
      bubble(upTarget, "onMouseUp", { button });
      if (downTarget === upTarget && button === 0) {
        bubble(upTarget, "onClick", { button });
      }
    },
  };
}

function installMemoryStorage(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  const getItem = vi.fn((key: string) => store.get(key) ?? null);
  const setItem = vi.fn((key: string, value: string) => {
    store.set(key, value);
  });
  vi.stubGlobal("localStorage", { getItem, setItem });
  return { store, getItem, setItem };
}

beforeEach(() => {
  runtime.fibers.clear();
  runtime.seenPaths.clear();
  runtime.pendingEffects = [];
  runtime.deferring = false;
  tauriMocks.confirmMainWindowClose.mockReset().mockResolvedValue(undefined);
  tauriMocks.copyXmlToClipboard.mockReset().mockResolvedValue(undefined);
  tauriMocks.registerMainWindowCloseGuard.mockReset().mockImplementation(() => () => {});
  tauriMocks.requestMainWindowShowAfterFirstPaint.mockReset();
  tauriMocks.setMainWindowUnsavedWork.mockReset();
  installMemoryStorage();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("startup, StrictMode, and close-guard lifecycle", () => {
  it("runs startup show, syncs theme/unsaved state, survives StrictMode remount, and cleans up on unmount", () => {
    const cleanupSpies: Array<ReturnType<typeof vi.fn>> = [];
    let triggerCloseRequest: (() => void) | undefined;
    tauriMocks.registerMainWindowCloseGuard.mockImplementation((handler: () => void) => {
      triggerCloseRequest = handler;
      const cleanup = vi.fn(() => {});
      cleanupSpies.push(cleanup);
      return cleanup;
    });

    const view = createHarness({ strictMode: true });

    expect(tauriMocks.requestMainWindowShowAfterFirstPaint).toHaveBeenCalledTimes(2);
    expect(view.doc.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(tauriMocks.setMainWindowUnsavedWork).toHaveBeenLastCalledWith(false);
    // StrictMode ran cleanup on mount #1 and kept mount #2 active.
    expect(cleanupSpies).toHaveLength(2);
    expect(cleanupSpies[0]).toHaveBeenCalledOnce();
    expect(cleanupSpies[1]).not.toHaveBeenCalled();

    // Renaming the single empty root keeps unsaved work false; adding text marks it true.
    view.type(view.byName("tagName"), "instructions");
    expect(tauriMocks.setMainWindowUnsavedWork).toHaveBeenLastCalledWith(false);
    view.type(view.byName("textContent"), "Write concise XML.");
    expect(tauriMocks.setMainWindowUnsavedWork).toHaveBeenLastCalledWith(true);

    // Close request opens confirmation; Cancel preserves document; Close invokes confirmMainWindowClose.
    triggerCloseRequest!();
    expect(view.nodes.some((el) => el.textContent === "Discard current prompt and close?")).toBe(
      true
    );
    void view.click(view.button("Cancel"));
    expect(view.nodes.some((el) => el.props.role === "dialog")).toBe(false);
    expect(tauriMocks.confirmMainWindowClose).not.toHaveBeenCalled();

    triggerCloseRequest!();
    void view.click(view.button("Close"));
    expect(tauriMocks.confirmMainWindowClose).toHaveBeenCalledOnce();

    view.unmount();
    expect(cleanupSpies[1]).toHaveBeenCalledOnce();
  });

  it("surfaces confirmMainWindowClose failures in the error strip without losing them", async () => {
    let triggerCloseRequest: (() => void) | undefined;
    tauriMocks.registerMainWindowCloseGuard.mockImplementation((handler: () => void) => {
      triggerCloseRequest = handler;
      return () => {};
    });
    tauriMocks.confirmMainWindowClose.mockRejectedValueOnce("native close failed");

    const view = createHarness();
    triggerCloseRequest!();
    await view.click(view.button("Close"));
    await Promise.resolve();

    const strip = view.byClass("message-strip")[0];
    expect(strip?.textContent).toBe("native close failed");
  });
});

describe("offline license surface", () => {
  it("opens bundled notice text, preserves literal characters, and caches across reopen", async () => {
    const text = "Copyright holder\nPermission text <literal> & complete";
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(text, { headers: { "content-type": "text/plain" } }));
    vi.stubGlobal("fetch", fetchMock);

    const view = createHarness();
    await view.click(view.byLabel("Third-party licenses"));

    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("./third-party-notices.txt");
    expect(view.byLabel("License texts").textContent).toBe(text);

    await view.click(view.button("Close"));
    expect(view.nodes.some((el) => el.props.role === "dialog")).toBe(false);

    await view.click(view.byLabel("Third-party licenses"));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(view.byLabel("License texts").textContent).toBe(text);
  });

  it("rejects HTTP 404, empty bodies, and HTML fallback responses, then recovers on Retry", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValueOnce(new Response("   \n  ", { status: 200 }))
      .mockResolvedValueOnce(
        new Response("<!doctype html><title>SPA</title>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        })
      )
      .mockResolvedValueOnce(new Response("Verified offline license text"));
    vi.stubGlobal("fetch", fetchMock);

    const view = createHarness();
    await view.click(view.byLabel("Third-party licenses"));
    expect(view.nodes.some((el) => el.props.role === "alert")).toBe(true);

    // Retry #1 -> whitespace body rejected
    await view.click(view.button("Retry"));
    expect(view.nodes.some((el) => el.props.role === "alert")).toBe(true);

    // Retry #2 -> text/html SPA fallback rejected
    await view.click(view.button("Retry"));
    expect(view.nodes.some((el) => el.props.role === "alert")).toBe(true);

    // Retry #3 -> valid plain text succeeds
    await view.click(view.button("Retry"));
    expect(view.byLabel("License texts").textContent).toBe("Verified offline license text");
    expect(view.nodes.some((el) => el.props.role === "alert")).toBe(false);
  });
});

describe("ModalDialog focus management, backdrop gestures, and modal replacement", () => {
  it("sets background inert, focuses Cancel, handles Escape (except IME), and restores focus cleanly", async () => {
    const view = createHarness();
    const tagInput = view.byName("tagName");
    tagInput.focus();
    expect(view.doc.activeElement).toBe(tagInput);

    await view.click(view.button("New Blank"));
    const ribbon = view.byClass("ribbon")[0]!;
    const body = view.byClass("body")[0]!;
    expect(ribbon.inert).toBe(true);
    expect(body.inert).toBe(true);
    expect(view.doc.activeElement).toBe(view.button("Cancel"));

    // IME Escape (isComposing / keyCode 229) must NOT dismiss the modal.
    view.keyDown(view.button("Cancel"), "Escape", { isComposing: true, keyCode: 27 });
    view.keyDown(view.button("Cancel"), "Escape", { isComposing: false, keyCode: 229 });
    expect(view.nodes.some((el) => el.props.role === "dialog")).toBe(true);

    // Normal Escape closes the modal, clears inert, and restores focus to tagInput.
    const esc = view.keyDown(view.button("Cancel"), "Escape", { keyCode: 27 });
    expect(esc.defaultPrevented).toBe(true);
    expect(ribbon.inert).toBe(false);
    expect(body.inert).toBe(false);
    expect(view.doc.activeElement).toBe(tagInput);

    // When opened with document.body focused, closing falls back to #tag-name-input.
    view.doc.activeElement = view.doc.body;
    await view.click(view.button("New Blank"));
    // Actually test body-focused open by triggering close-guard directly:
    await view.click(view.button("Cancel"));
    view.doc.activeElement = view.doc.body;
    await view.click(view.byLabel("Third-party licenses"));
    await view.click(view.button("Close"));
    expect(view.doc.activeElement.id).toBe("tag-name-input");
  });

  it("closes only on full left-button backdrop clicks and never slams Licenses shut on keyboard Retry", async () => {
    let resolveSecondTry!: (res: Response) => void;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("err", { status: 500 }))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveSecondTry = resolve;
          })
      );
    vi.stubGlobal("fetch", fetchMock);

    const view = createHarness();

    // 1. Open New Blank and dismiss it via a real backdrop click.
    await view.click(view.button("New Blank"));
    const overlay = view.byClass("modal-overlay")[0]!;
    const dialog = view.byClass("confirm-dialog")[0]!;

    // Dragging inside -> outside or right-clicking backdrop must NOT close.
    view.mouseGesture(dialog, overlay, 0);
    expect(view.nodes.some((el) => el.props.role === "dialog")).toBe(true);
    await view.click(overlay, 2);
    expect(view.nodes.some((el) => el.props.role === "dialog")).toBe(true);

    // Full left-click on backdrop closes cleanly.
    await view.click(overlay, 0);
    expect(view.nodes.some((el) => el.props.role === "dialog")).toBe(false);

    // 2. Open Licenses (fails -> Retry shown) and activate Retry via keyboard (no mouse events!).
    await view.click(view.byLabel("Third-party licenses"));
    const retryBtn = view.button("Retry");
    await view.activateViaKeyboard(retryBtn);

    // Regression pin: modal MUST stay open in loading state and move focus to Close when Retry unmounts!
    expect(view.nodes.some((el) => el.props.role === "dialog")).toBe(true);
    expect(view.doc.activeElement).toBe(view.button("Close"));

    resolveSecondTry(new Response("Recovered license text"));
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(view.byLabel("License texts").textContent).toBe("Recovered license text");
  });

  it("resets focus safely to Cancel when OS CloseRequested replaces an open modal", async () => {
    let triggerCloseRequest: (() => void) | undefined;
    tauriMocks.registerMainWindowCloseGuard.mockImplementation((handler: () => void) => {
      triggerCloseRequest = handler;
      return () => {};
    });

    const view = createHarness();
    await view.click(view.button("New Blank"));
    // User focuses the right-side Confirm danger button:
    const confirmBtn = view.button("Confirm");
    confirmBtn.focus();
    expect(view.doc.activeElement).toBe(confirmBtn);

    // OS window close request arrives while New Blank dialog is open:
    triggerCloseRequest!();
    expect(view.nodes.some((el) => el.textContent === "Discard current prompt and close?")).toBe(
      true
    );
    // Focus MUST reset to Cancel, never stay on the danger button whose action just changed!
    expect(view.doc.activeElement).toBe(view.button("Cancel"));
  });
});

describe("tree authoring, delete confirmations, selection messages, and ceilings", () => {
  it("supports Add Sibling, Add Child, Move Up/Down, empty-stub instant delete, confirmed subtree delete, and Clear-only-section", async () => {
    const view = createHarness();
    expect(view.button("Move Up").disabled).toBe(true);
    expect(view.button("Move Down").disabled).toBe(true);

    // Delete on the sole root opens "Clear the only section?" and resets to <feedback>.
    view.type(view.byName("textContent"), "Initial body");
    await view.click(view.button("Delete"));
    expect(view.nodes.some((el) => el.textContent === "Clear the only section?")).toBe(true);
    await view.click(view.button("Clear"));
    expect(view.byName("tagName").value).toBe("feedback");
    expect(view.byName("textContent").value).toBe("");

    // Empty non-final sibling deletes immediately without dialog.
    await view.click(view.button("Add Sibling"));
    expect(view.byClass("element-row")).toHaveLength(2);
    expect(view.byName("tagName").props["aria-invalid"]).toBe(true);
    await view.click(view.button("Delete"));
    expect(view.nodes.some((el) => el.props.role === "dialog")).toBe(false);
    expect(view.byClass("element-row")).toHaveLength(1);

    // Non-empty subtree requires confirmation; Move Up reorders sections.
    await view.click(view.button("Add Sibling"));
    view.type(view.byName("tagName"), "context");
    view.type(view.byName("textContent"), "Important context");
    expect(view.button("Move Up").disabled).toBe(false);
    await view.click(view.button("Move Up"));
    expect(view.byClass("element-row")[0]?.textContent).toContain("<context>");

    await view.click(view.button("Add Child"));
    view.type(view.byName("tagName"), "detail");
    await view.click(view.byClass("element-row")[0]!);
    await view.click(view.button("Delete"));
    expect(view.nodes.some((el) => el.textContent === "Delete <context>?")).toBe(true);
    await view.click(view.buttons("Delete")[1]!);
    expect(view.byClass("element-row")).toHaveLength(1);
  });

  it("enforces MAX_TAG_NAME_LENGTH (code points), MAX_TEXT_CONTENT_BYTES, and node-scoped message clearing", async () => {
    const view = createHarness();
    const astralName = "𠀀".repeat(35);
    view.type(view.byName("tagName"), astralName);
    expect(Array.from(view.byName("tagName").value)).toHaveLength(32);
    expect(
      view.nodes.some((el) => el.textContent === "Tag name reached the 32-character limit.")
    ).toBe(true);

    // Oversized text content (> 10 MB UTF-8) is refused with node-scoped error.
    view.type(view.byName("textContent"), "中".repeat(3_400_000));
    expect(view.byName("textContent").value).toBe("");
    expect(view.byClass("message-strip")[0]?.textContent).toBe(
      "Text content too long (limit 10 MB)."
    );

    // Adding/selecting another element clears node-scoped field & strip messages.
    await view.click(view.button("Add Sibling"));
    expect(view.byClass("message-strip")).toHaveLength(0);
    expect(
      view.nodes.some((el) => el.textContent === "Tag name reached the 32-character limit.")
    ).toBe(false);
  });
});

describe("IME composition preedit safety and preset chip workflows", () => {
  it("preserves Pinyin preedit beyond the code-point cap during active composition in Tag Name and Preset inputs", async () => {
    const view = createHarness();
    const tagInput = view.byName("tagName");

    // 30 CJK chars + 8 Pinyin preedit letters = 38 code points during composition (> 32),
    // settling to 32 CJK chars on compositionend with zero false truncation mid-session.
    const base30 = "反".repeat(30);
    view.composeStart(tagInput);
    view.type(tagInput, `${base30}shuoming`, true);
    expect(tagInput.value).toBe(`${base30}shuoming`);
    expect(
      view.nodes.some((el) => el.textContent === "Tag name reached the 32-character limit.")
    ).toBe(false);
    view.composeEnd(tagInput, `${base30}说明`);
    expect(tagInput.value).toBe(`${base30}说明`);
    expect(
      view.nodes.some((el) => el.textContent === "Tag name reached the 32-character limit.")
    ).toBe(false);

    // Preset chip editor: 22 CJK chars + 8 Pinyin preedit letters = 30 (> 24) during composition,
    // settling to 24 CJK chars on compositionend and ignoring Enter/Escape while composing.
    await view.click(view.byLabel("Edit preset chips"));
    await view.click(view.byLabel("Add preset chip"));
    const chipInput = view.byLabel("Name the new preset chip");
    const chipBase22 = "问".repeat(22);
    view.composeStart(chipInput);
    view.type(chipInput, `${chipBase22}shuoming`, true);
    expect(chipInput.value).toBe(`${chipBase22}shuoming`);

    for (const imeKey of [
      { key: "Enter", isComposing: true, keyCode: 13 },
      { key: "Escape", isComposing: true, keyCode: 27 },
      { key: "Enter", isComposing: false, keyCode: 229 },
      { key: "Escape", isComposing: false, keyCode: 229 },
    ]) {
      expect(view.keyDown(chipInput, imeKey.key, imeKey).defaultPrevented).toBe(false);
    }

    view.composeEnd(chipInput, `${chipBase22}说明`);
    expect(chipInput.value).toBe(`${chipBase22}说明`);
    expect(view.keyDown(chipInput, "Enter", { keyCode: 13 }).defaultPrevented).toBe(true);
    expect(view.nodes.some((el) => el.textContent === `${chipBase22}说明`)).toBe(true);
  });

  it("handles preset memory, silent cancel on empty + blur, and non-destructive Reset / Cog / × clicks", async () => {
    const storage = installMemoryStorage();
    const view = createHarness();

    // First launch does NOT write DEFAULT_PRESET_CHIPS to localStorage.
    expect(storage.setItem).not.toHaveBeenCalled();

    // Apply preset, repeat click warns, switch and return restores suffix.
    const chipButtons = () => view.byClass("chip-label");
    await view.click(chipButtons()[0]!); // feedback -> feedback_1
    expect(view.byName("tagName").value).toBe("feedback_1");
    await view.click(chipButtons()[0]!);
    expect(view.nodes.some((el) => el.textContent.includes('"feedback" is already applied'))).toBe(
      true
    );

    // Enter edit mode: clicking + then clicking Tag Name (empty blur) cancels silently with NO error.
    await view.click(view.byLabel("Edit preset chips"));
    await view.click(view.byLabel("Add preset chip"));
    await view.click(view.byName("tagName"));
    expect(view.nodes.some((el) => el.props["aria-label"] === "Name the new preset chip")).toBe(
      false
    );
    expect(view.nodes.some((el) => el.textContent === "Chip name cannot be empty.")).toBe(false);

    // Pressing Enter on an empty + input explicitly shows validation error.
    await view.click(view.byLabel("Add preset chip"));
    view.keyDown(view.byLabel("Name the new preset chip"), "Enter", { keyCode: 13 });
    expect(view.nodes.some((el) => el.textContent === "Chip name cannot be empty.")).toBe(true);
    view.keyDown(view.byLabel("Name the new preset chip"), "Escape", { keyCode: 27 });

    // Editing "feedback" -> "temp" and clicking Reset -> Cancel MUST NOT commit "temp" or wipe history!
    await view.click(chipButtons()[0]!);
    const renameInput = view.byLabel("Rename preset feedback");
    view.type(renameInput, "temp");
    await view.click(view.button("Reset"));
    expect(view.nodes.some((el) => el.textContent === "Restore default preset chips?")).toBe(true);
    await view.click(view.button("Cancel"));
    expect(storage.store.get(PRESET_CHIPS_STORAGE_KEY)).toBeUndefined();
    expect(view.byLabel("Rename preset feedback").value).toBe("temp");

    // Clicking Cog exits edit mode and discards the uncommitted rename cleanly.
    await view.click(view.byLabel("Exit chip edit mode"));
    expect(chipButtons().map((el) => el.textContent)).toEqual([...DEFAULT_PRESET_CHIPS]);

    // Removing a sibling chip while editing keeps the active rename input and shifts its index.
    await view.click(view.byLabel("Edit preset chips"));
    await view.click(chipButtons()[1]!); // rename "question" (index 1)
    view.type(view.byLabel("Rename preset question"), "prompt_goal");
    await view.click(view.byLabel("Remove preset feedback")); // remove index 0
    view.keyDown(view.byLabel("Rename preset question"), "Enter", { keyCode: 13 });
    expect(JSON.parse(storage.store.get(PRESET_CHIPS_STORAGE_KEY)!)).toEqual([
      "prompt_goal",
      "instruction",
      "extra",
    ]);
  });
});

describe("Copy XML pipeline, deferred preview pending guard, and theme/storage resilience", () => {
  it("blocks stale copies while deferred preview is pending, auto-clears the warning, snapshots in-flight XML, and handles concurrent copies", async () => {
    const view = createHarness();
    view.type(view.byName("textContent"), "First version");

    // 1. Simulate deferred preview lag: urgent edit arrives while deferredRoots lags behind.
    view.setDeferring(true);
    view.type(view.byName("textContent"), "Second version");
    expect(view.byClass("preview-pane")[0]?.props["aria-busy"]).toBe(true);
    expect(view.nodes.some((el) => el.textContent === "Preview updating...")).toBe(true);

    await view.click(view.button("Copy XML"));
    expect(tauriMocks.copyXmlToClipboard).not.toHaveBeenCalled();
    expect(view.byClass("message-strip")[0]?.textContent).toContain("Preview is still updating.");

    // As soon as deferred preview catches up, the wait warning auto-clears!
    view.flushDeferred();
    expect(view.byClass("preview-pane")[0]?.props["aria-busy"]).toBe(false);
    expect(view.byClass("message-strip")).toHaveLength(0);

    // 2. Concurrent copy + live-snapshot immutability:
    let finishCopy!: () => void;
    tauriMocks.copyXmlToClipboard.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishCopy = resolve;
        })
    );

    const firstCopyPromise = view.click(view.button("Copy XML"));
    expect(tauriMocks.copyXmlToClipboard).toHaveBeenCalledExactlyOnceWith(
      "<feedback>Second version</feedback>"
    );

    // Second click while in-flight warns without calling copyXmlToClipboard again.
    await view.click(view.button("Copy XML"));
    expect(tauriMocks.copyXmlToClipboard).toHaveBeenCalledOnce();
    expect(view.byClass("message-strip")[0]?.textContent).toBe(
      "A copy is already in progress — one moment."
    );

    // Editing while in-flight does not alter the captured payload.
    view.type(view.byName("textContent"), "Edited during copy");
    finishCopy();
    await firstCopyPromise;

    expect(view.byClass("bloom-overlay")).toHaveLength(1);
    expect(view.byClass("message-strip")).toHaveLength(0);

    // 3. If an in-flight copy rejects after a concurrent click, the error survives finally!
    let rejectCopy!: (reason: unknown) => void;
    tauriMocks.copyXmlToClipboard.mockImplementationOnce(
      () =>
        new Promise<void>((_, reject) => {
          rejectCopy = reject;
        })
    );
    const failingCopy = view.click(view.button("Copy XML"));
    await view.click(view.button("Copy XML"));
    rejectCopy("arboard: clipboard busy");
    await failingCopy;
    expect(view.byClass("message-strip")[0]?.textContent).toBe("arboard: clipboard busy");
  });

  it("toggles dark/light themes, surfaces independent storage write warnings, and prevents file-drop navigation", async () => {
    const setItem = vi.fn(() => {
      throw new Error("QuotaExceededError");
    });
    vi.stubGlobal("localStorage", { getItem: vi.fn(() => null), setItem });

    const view = createHarness();
    await view.click(view.byLabel("Switch to light mode"));
    expect(view.doc.documentElement.getAttribute("data-theme")).toBe("light");
    expect(setItem).toHaveBeenCalledWith(THEME_STORAGE_KEY, "light");
    expect(view.byClass("message-strip")[0]?.textContent).toContain("theme choice");

    // Clear strip by typing, then trigger preset storage failure — independent feature still warns!
    view.type(view.byName("textContent"), "ok");
    expect(view.byClass("message-strip")).toHaveLength(0);

    await view.click(view.byLabel("Edit preset chips"));
    await view.click(view.byLabel("Remove preset extra"));
    expect(view.byClass("message-strip")[0]?.textContent).toContain("preset chips");

    // File drag/drop is prevented while plain-text drag is allowed.
    expect(view.dispatchWindowDrag("onDragOver", ["Files"]).defaultPrevented).toBe(true);
    expect(view.dispatchWindowDrag("onDrop", ["Files"]).defaultPrevented).toBe(true);
    expect(view.dispatchWindowDrag("onDragOver", ["text/plain"]).defaultPrevented).toBe(false);
  });
});
