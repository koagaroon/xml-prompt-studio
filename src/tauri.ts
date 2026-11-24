// Environment detection uses the official `isTauri()` helper from
// @tauri-apps/api/core — the API package owns the probe, so it tracks
// whatever internal marker Tauri uses across versions.

import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { MAX_XML_BYTES, exceedsByteCap, formatMegabytes, hasLoneSurrogate } from "./helpers";

function isTauriEnvironment(): boolean {
  return typeof window !== "undefined" && isTauri();
}

let mainWindowShowRequested = false;
let browserHasUnsavedWork = false;

function logStartup(message: string): void {
  if (import.meta.env.DEV) {
    console.debug(`[startup] ${message}`);
  }
}

function afterNextPaint(callback: () => void): void {
  let called = false;
  const runOnce = () => {
    if (called) {
      return;
    }
    called = true;
    callback();
  };

  if (typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(runOnce);
    });
    // Race a 100 ms timer against double-rAF because Chromium can throttle rAF
    // while the native window is still hidden (`visible: false`).
    window.setTimeout(runOnce, 100);
    return;
  }

  window.setTimeout(runOnce, 0);
}

export function requestMainWindowShowAfterFirstPaint(): void {
  if (!isTauriEnvironment() || mainWindowShowRequested) {
    return;
  }

  mainWindowShowRequested = true;
  logStartup("main-window show scheduled");
  afterNextPaint(() => {
    logStartup("first paint passed; sending show command");
    void invoke("show_main_window")
      .then(() => {
        logStartup("show command completed");
      })
      .catch((error: unknown) => {
        logStartup(
          `show command failed: ${error instanceof Error ? error.message : String(error)}`
        );
      });
  });
}

export function registerMainWindowCloseGuard(onCloseRequested: () => void): () => void {
  if (isTauriEnvironment()) {
    const onCloseChannel = new Channel<boolean>(() => {
      onCloseRequested();
    });
    void invoke("register_close_guard", { onCloseRequested: onCloseChannel }).catch(
      (error: unknown) => {
        logStartup(
          `close-guard registration failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    );
    return () => {};
  }

  if (typeof window === "undefined" || typeof window.addEventListener !== "function") {
    return () => {};
  }

  const handleBeforeUnload = (event: BeforeUnloadEvent) => {
    if (browserHasUnsavedWork) {
      event.preventDefault();
    }
  };
  window.addEventListener("beforeunload", handleBeforeUnload);
  return () => {
    window.removeEventListener("beforeunload", handleBeforeUnload);
  };
}

export function setMainWindowUnsavedWork(hasUnsavedWork: boolean): void {
  browserHasUnsavedWork = hasUnsavedWork;
  if (!isTauriEnvironment()) {
    return;
  }
  void invoke("set_has_unsaved_work", { hasUnsavedWork }).catch((error: unknown) => {
    logStartup(
      `set_has_unsaved_work failed: ${error instanceof Error ? error.message : String(error)}`
    );
  });
}

export async function confirmMainWindowClose(): Promise<void> {
  browserHasUnsavedWork = false;
  if (isTauriEnvironment()) {
    await invoke("confirm_close_window");
    return;
  }
  if (typeof window !== "undefined" && typeof window.close === "function") {
    window.close();
  }
}

export async function copyXmlToClipboard(xml: string): Promise<void> {
  if (xml.includes("\0")) {
    throw new Error(
      "XML payload contains a NUL (U+0000) character; paste targets would " +
        "silently truncate at it. Remove the character and copy again."
    );
  }

  if (hasLoneSurrogate(xml)) {
    throw new Error(
      "XML payload contains an unpaired surrogate (a corrupted character); " +
        "paste targets could receive garbled text. Remove or retype the " +
        "affected character and copy again."
    );
  }

  if (exceedsByteCap(xml, MAX_XML_BYTES)) {
    const bytes = new TextEncoder().encode(xml).length;
    throw new Error(
      `XML payload too large to copy (${formatMegabytes(bytes)}; limit ${formatMegabytes(MAX_XML_BYTES)}).`
    );
  }

  if (isTauriEnvironment()) {
    await invoke("copy_xml_to_clipboard", { xml });
    return;
  }

  await navigator.clipboard.writeText(xml);
}
