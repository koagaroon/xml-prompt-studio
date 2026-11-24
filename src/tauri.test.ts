import { afterEach, describe, expect, it, vi } from "vitest";

const { invokeMock, isTauriMock, channelListeners } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  isTauriMock: vi.fn(),
  channelListeners: [] as Array<(payload: unknown) => void>,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  isTauri: isTauriMock,
  Channel: class MockChannel {
    onmessage: (payload: unknown) => void;
    constructor(onmessage?: (payload: unknown) => void) {
      this.onmessage = onmessage ?? (() => {});
      channelListeners.push((payload) => this.onmessage(payload));
    }
  },
}));

import { MAX_XML_BYTES } from "./helpers";
import {
  confirmMainWindowClose,
  copyXmlToClipboard,
  registerMainWindowCloseGuard,
  setMainWindowUnsavedWork,
} from "./tauri";

function stubTauriWindow(): void {
  vi.stubGlobal("window", {});
}

function stubBrowserClipboard(): { writeText: ReturnType<typeof vi.fn> } {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", {
    clipboard: { writeText },
  });
  return { writeText };
}

async function expectRejectedBeforeClipboardBranches(xml: string, message: string): Promise<void> {
  for (const tauri of [true, false]) {
    invokeMock.mockReset();
    isTauriMock.mockReset();
    vi.unstubAllGlobals();

    const { writeText } = stubBrowserClipboard();
    if (tauri) {
      stubTauriWindow();
    }
    isTauriMock.mockReturnValue(tauri);

    await expect(copyXmlToClipboard(xml)).rejects.toThrow(message);

    expect(invokeMock).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  }
}

afterEach(() => {
  invokeMock.mockReset();
  isTauriMock.mockReset();
  channelListeners.length = 0;
  vi.unstubAllGlobals();
});

describe("copyXmlToClipboard", () => {
  it("uses the Tauri command when running inside Tauri", async () => {
    stubTauriWindow();
    isTauriMock.mockReturnValue(true);
    invokeMock.mockResolvedValue(undefined);

    await copyXmlToClipboard("<feedback/>");

    expect(invokeMock).toHaveBeenCalledWith("copy_xml_to_clipboard", {
      xml: "<feedback/>",
    });
  });

  it("uses the browser clipboard fallback outside Tauri", async () => {
    const { writeText } = stubBrowserClipboard();
    isTauriMock.mockReturnValue(false);

    await copyXmlToClipboard("<feedback/>");

    expect(invokeMock).not.toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledWith("<feedback/>");
  });

  it("rejects NUL payloads before both clipboard branches", async () => {
    await expectRejectedBeforeClipboardBranches("<a>\0</a>", "NUL");
  });

  it("rejects lone-surrogate payloads before both clipboard branches", async () => {
    await expectRejectedBeforeClipboardBranches("<a>\uD800</a>", "unpaired surrogate");
  });

  it("rejects oversized payloads before both clipboard branches", async () => {
    await expectRejectedBeforeClipboardBranches("x".repeat(MAX_XML_BYTES + 1), "too large to copy");
  });
});

describe("main-window close guard bridge", () => {
  it("registers a Tauri Channel, forwards unsaved-work state, and invokes confirm_close_window", async () => {
    stubTauriWindow();
    isTauriMock.mockReturnValue(true);
    invokeMock.mockResolvedValue(undefined);

    const onCloseRequested = vi.fn();
    registerMainWindowCloseGuard(onCloseRequested);
    expect(invokeMock).toHaveBeenCalledWith("register_close_guard", {
      onCloseRequested: expect.any(Object),
    });

    channelListeners[0]?.(true);
    expect(onCloseRequested).toHaveBeenCalledOnce();

    setMainWindowUnsavedWork(true);
    expect(invokeMock).toHaveBeenCalledWith("set_has_unsaved_work", { hasUnsavedWork: true });

    await confirmMainWindowClose();
    expect(invokeMock).toHaveBeenCalledWith("confirm_close_window");
  });

  it("uses beforeunload and window.close outside Tauri", async () => {
    let beforeUnloadHandler: ((event: BeforeUnloadEvent) => void) | undefined;
    const addEventListener = vi.fn((type: string, handler: (event: BeforeUnloadEvent) => void) => {
      if (type === "beforeunload") {
        beforeUnloadHandler = handler;
      }
    });
    const removeEventListener = vi.fn();
    const closeWindow = vi.fn();
    vi.stubGlobal("window", {
      addEventListener,
      removeEventListener,
      close: closeWindow,
    });
    isTauriMock.mockReturnValue(false);

    const cleanup = registerMainWindowCloseGuard(vi.fn());
    expect(addEventListener).toHaveBeenCalledOnce();

    const cleanEvent = { preventDefault: vi.fn() } as unknown as BeforeUnloadEvent;
    setMainWindowUnsavedWork(false);
    beforeUnloadHandler?.(cleanEvent);
    expect(cleanEvent.preventDefault).not.toHaveBeenCalled();

    const dirtyEvent = { preventDefault: vi.fn() } as unknown as BeforeUnloadEvent;
    setMainWindowUnsavedWork(true);
    beforeUnloadHandler?.(dirtyEvent);
    expect(dirtyEvent.preventDefault).toHaveBeenCalledOnce();

    await confirmMainWindowClose();
    expect(closeWindow).toHaveBeenCalledOnce();

    cleanup();
    expect(removeEventListener).toHaveBeenCalledOnce();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
