// Environment detection uses the official `isTauri()` helper from
// @tauri-apps/api/core — the API package owns the probe, so it tracks
// whatever internal marker Tauri uses across versions.

import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import {
  MAX_XML_BYTES,
  exceedsByteCap,
  formatMegabytes,
  hasLoneSurrogate,
  utf8ByteLength,
} from "./helpers";

function isTauriEnvironment(): boolean {
  return typeof window !== "undefined" && isTauri();
}

let mainWindowShowRequested = false;
let browserHasUnsavedWork = false;
let closeGuardSeq = 0;
let unsavedWorkSeq = 0;

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
        mainWindowShowRequested = false;
        logStartup(
          `show command failed: ${error instanceof Error ? error.message : String(error)}`
        );
      });
  });
}

function attachBeforeUnloadGuard(): () => void {
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

export function registerMainWindowCloseGuard(onCloseRequested: () => void): () => void {
  // Attach `beforeunload` in both browser and Tauri modes so accidental
  // F5 / Ctrl+R reloads in WebView2 cannot silently discard unsaved work.
  // Confirmed window closes clear `browserHasUnsavedWork` beforehand.
  const removeBeforeUnload = attachBeforeUnloadGuard();

  if (isTauriEnvironment()) {
    let disposed = false;
    const seq = ++closeGuardSeq;
    const onCloseChannel = new Channel<boolean>(() => {
      if (disposed) {
        return;
      }
      void invoke("ack_close_requested").catch(() => {});
      onCloseRequested();
    });
    void invoke("register_close_guard", {
      seq,
      onCloseRequested: onCloseChannel,
    }).catch((error: unknown) => {
      logStartup(
        `close-guard registration failed: ${error instanceof Error ? error.message : String(error)}`
      );
    });
    return () => {
      disposed = true;
      onCloseChannel.onmessage = () => {};
      removeBeforeUnload();
      const unregisterSeq = ++closeGuardSeq;
      void invoke("unregister_close_guard", {
        seq: unregisterSeq,
        channelId: onCloseChannel.id,
      }).catch(() => {});
    };
  }

  return removeBeforeUnload;
}

export function setMainWindowUnsavedWork(hasUnsavedWork: boolean): void {
  browserHasUnsavedWork = hasUnsavedWork;
  if (!isTauriEnvironment()) {
    return;
  }
  const seq = ++unsavedWorkSeq;
  void invoke("set_has_unsaved_work", { seq, hasUnsavedWork }).catch((error: unknown) => {
    logStartup(
      `set_has_unsaved_work failed: ${error instanceof Error ? error.message : String(error)}`
    );
  });
}

export async function confirmMainWindowClose(): Promise<void> {
  const previousUnsavedWork = browserHasUnsavedWork;
  browserHasUnsavedWork = false;
  if (isTauriEnvironment()) {
    try {
      await invoke("confirm_close_window");
    } catch (error) {
      browserHasUnsavedWork = previousUnsavedWork;
      throw error;
    }
    return;
  }
  if (typeof window !== "undefined" && typeof window.close === "function") {
    window.close();
    if (!window.closed) {
      browserHasUnsavedWork = previousUnsavedWork;
    }
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
    const bytes = utf8ByteLength(xml);
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
