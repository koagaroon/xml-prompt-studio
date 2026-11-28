import { afterEach, describe, expect, it, vi } from "vitest";

const { invokeMock, isTauriMock, channelInstances } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  isTauriMock: vi.fn(),
  channelInstances: [] as Array<{
    id: number;
    send: (payload: unknown) => void;
  }>,
}));

vi.mock("@tauri-apps/api/core", () => {
  let nextChannelId = 100;
  return {
    invoke: invokeMock,
    isTauri: isTauriMock,
    Channel: class MockChannel {
      id: number;
      onmessage: (payload: unknown) => void;
      constructor(onmessage?: (payload: unknown) => void) {
        this.id = ++nextChannelId;
        this.onmessage = onmessage ?? (() => {});
        channelInstances.push({
          id: this.id,
          send: (payload: unknown) => this.onmessage(payload),
        });
      }
    },
  };
});

import { MAX_XML_BYTES } from "./helpers";
import {
  confirmMainWindowClose,
  copyXmlToClipboard,
  registerMainWindowCloseGuard,
  setMainWindowUnsavedWork,
} from "./tauri";

function stubTauriWindow(overrides: Record<string, unknown> = {}): {
  triggerBeforeUnload: () => { preventDefault: ReturnType<typeof vi.fn> };
  removeEventListener: ReturnType<typeof vi.fn>;
} {
  let beforeUnloadHandler: ((event: BeforeUnloadEvent) => void) | undefined;
  const addEventListener = vi.fn((type: string, handler: (event: BeforeUnloadEvent) => void) => {
    if (type === "beforeunload") {
      beforeUnloadHandler = handler;
    }
  });
  const removeEventListener = vi.fn();
  vi.stubGlobal("window", {
    addEventListener,
    removeEventListener,
    ...overrides,
  });
  return {
    removeEventListener,
    triggerBeforeUnload: () => {
      const event = { preventDefault: vi.fn() };
      beforeUnloadHandler?.(event as unknown as BeforeUnloadEvent);
      return event;
    },
  };
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
  channelInstances.length = 0;
  vi.useRealTimers();
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
  it("registers a sequenced Tauri Channel, acknowledges delivery, guards F5 reload, and unregisters on cleanup", async () => {
    const { triggerBeforeUnload, removeEventListener } = stubTauriWindow();
    isTauriMock.mockReturnValue(true);
    invokeMock.mockResolvedValue(undefined);

    const onCloseRequested = vi.fn();
    const cleanup = registerMainWindowCloseGuard(onCloseRequested);
    const channel = channelInstances[0]!;
    expect(invokeMock).toHaveBeenCalledWith("register_close_guard", {
      seq: expect.any(Number),
      onCloseRequested: expect.objectContaining({ id: channel.id }),
    });

    channel.send(true);
    expect(onCloseRequested).toHaveBeenCalledOnce();
    expect(invokeMock).toHaveBeenCalledWith("ack_close_requested");

    setMainWindowUnsavedWork(true);
    expect(invokeMock).toHaveBeenCalledWith("set_has_unsaved_work", {
      seq: expect.any(Number),
      hasUnsavedWork: true,
    });
    expect(triggerBeforeUnload().preventDefault).toHaveBeenCalledOnce();

    await confirmMainWindowClose();
    expect(invokeMock).toHaveBeenCalledWith("confirm_close_window");
    // Confirmed close clears beforeunload so teardown is not double-prompted.
    expect(triggerBeforeUnload().preventDefault).not.toHaveBeenCalled();

    cleanup();
    expect(removeEventListener).toHaveBeenCalledOnce();
    expect(invokeMock).toHaveBeenCalledWith("unregister_close_guard", {
      seq: expect.any(Number),
      channelId: channel.id,
    });

    // Post-cleanup channel messages are ignored.
    channel.send(true);
    expect(onCloseRequested).toHaveBeenCalledOnce();
  });

  it("restores beforeunload state if confirm_close_window fails or browser window.close is ignored", async () => {
    const tauriView = stubTauriWindow();
    isTauriMock.mockReturnValue(true);
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "confirm_close_window"
        ? Promise.reject(new Error("close blocked"))
        : Promise.resolve()
    );

    registerMainWindowCloseGuard(vi.fn());
    setMainWindowUnsavedWork(true);
    await expect(confirmMainWindowClose()).rejects.toThrow("close blocked");
    expect(tauriView.triggerBeforeUnload().preventDefault).toHaveBeenCalledOnce();

    // Outside Tauri: when window.close() leaves window.closed === false, beforeunload stays armed.
    isTauriMock.mockReturnValue(false);
    const closeWindow = vi.fn();
    const browserView = stubTauriWindow({ close: closeWindow, closed: false });
    const cleanup = registerMainWindowCloseGuard(vi.fn());
    setMainWindowUnsavedWork(true);

    await confirmMainWindowClose();
    expect(closeWindow).toHaveBeenCalledOnce();
    expect(browserView.triggerBeforeUnload().preventDefault).toHaveBeenCalledOnce();

    cleanup();
    expect(browserView.removeEventListener).toHaveBeenCalledOnce();
  });
});

describe("requestMainWindowShowAfterFirstPaint", () => {
  it("shows after double-rAF, deduplicates against the 100ms fallback, and retries only if show_main_window rejects", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const { requestMainWindowShowAfterFirstPaint: requestShow } = await import("./tauri");

    const rafCallbacks: FrameRequestCallback[] = [];
    stubTauriWindow({
      requestAnimationFrame: vi.fn((cb: FrameRequestCallback) => {
        rafCallbacks.push(cb);
        return rafCallbacks.length;
      }),
      setTimeout: globalThis.setTimeout,
    });
    isTauriMock.mockReturnValue(true);
    invokeMock
      .mockRejectedValueOnce(new Error("transient IPC failure"))
      .mockResolvedValue(undefined);

    requestShow();
    // Second call while scheduled is a StrictMode no-op.
    requestShow();
    expect(rafCallbacks).toHaveLength(1);

    // First rAF schedules second rAF; advance 2 frames.
    rafCallbacks.shift()!(16);
    expect(rafCallbacks).toHaveLength(1);
    rafCallbacks.shift()!(32);
    await Promise.resolve();
    await Promise.resolve();

    expect(invokeMock).toHaveBeenCalledExactlyOnceWith("show_main_window");
    // 100ms timer firing afterwards does not re-run the same attempt.
    vi.advanceTimersByTime(150);
    expect(invokeMock).toHaveBeenCalledOnce();

    // Because the first show_main_window rejected, a subsequent call can retry and lock on success.
    requestShow();
    vi.advanceTimersByTime(100);
    await Promise.resolve();
    expect(invokeMock).toHaveBeenCalledTimes(2);

    requestShow();
    vi.advanceTimersByTime(100);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to setTimeout(0) when requestAnimationFrame is absent", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const { requestMainWindowShowAfterFirstPaint: requestShow } = await import("./tauri");

    stubTauriWindow({ setTimeout: globalThis.setTimeout });
    isTauriMock.mockReturnValue(true);
    invokeMock.mockResolvedValue(undefined);

    requestShow();
    vi.advanceTimersByTime(0);
    expect(invokeMock).toHaveBeenCalledExactlyOnceWith("show_main_window");
  });
});
