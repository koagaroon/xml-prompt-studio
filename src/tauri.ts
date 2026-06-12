// Environment detection uses the official `isTauri()` helper from
// @tauri-apps/api/core — the API package owns the probe, so it tracks
// whatever internal marker Tauri uses across versions. Earlier versions
// of this file probed `window.isTauri` (and before that the internal
// `__TAURI_INTERNALS__` object) by hand with a local global declaration.

import { invoke, isTauri } from "@tauri-apps/api/core";

function isTauriEnvironment(): boolean {
  return typeof window !== "undefined" && isTauri();
}

let mainWindowShowRequested = false;

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
    // The timer deliberately RACES the double-rAF rather than backstopping
    // it: this code runs while the window is still HIDDEN (visible: false
    // until the show command), and Chromium throttles or suspends rAF in
    // hidden pages — waiting on rAF alone can deadlock (paint signal
    // waits for visibility, visibility waits for the paint signal), with
    // only the Rust 5 s fallback breaking it. Worst case the timer fires
    // ~100 ms before first paint and the user briefly sees the window's
    // configured dark backgroundColor — far better than a 5 s no-show.
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
          `show command failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      });
  });
}

export async function copyXmlToClipboard(xml: string): Promise<void> {
  // Frontend mirror of the Rust-side NUL guard, placed BEFORE the branch
  // so the dev-only browser fallback below can't "successfully" copy a
  // payload that C-string clipboard consumers would silently truncate.
  // The Rust check stays as the IPC-boundary defense.
  if (xml.includes("\0")) {
    throw new Error(
      "XML payload contains a NUL (U+0000) character; paste targets would " +
        "silently truncate at it. Remove the character and copy again."
    );
  }

  if (isTauriEnvironment()) {
    await invoke("copy_xml_to_clipboard", { xml });
    return;
  }

  // Browser fallback: when the frontend runs in a plain browser (e.g.,
  // `npm run dev` opened directly without `tauri dev`), there's no Rust
  // backend to invoke. The browser Clipboard API works for development
  // smoke testing; production builds always go through the Tauri path
  // above for the wider permissions and clip.exe / wl-copy fallbacks.
  await navigator.clipboard.writeText(xml);
}
