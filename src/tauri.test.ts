import { afterEach, describe, expect, it, vi } from "vitest";

const { invokeMock, isTauriMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  isTauriMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  isTauri: isTauriMock,
}));

import { MAX_XML_BYTES } from "./helpers";
import { copyXmlToClipboard } from "./tauri";

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
