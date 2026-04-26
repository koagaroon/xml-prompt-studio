// Tauri 2 publishes `window.isTauri` as a boolean for environment detection.
// This is a stable public API; previously this code probed the internal
// `__TAURI_INTERNALS__` object, which was undocumented and subject to silent
// rename across Tauri versions.

import { invoke } from "@tauri-apps/api/core";

declare global {
  interface Window {
    isTauri?: boolean;
  }
}

function isTauriEnvironment(): boolean {
  return typeof window !== "undefined" && window.isTauri === true;
}

export async function copyXmlToClipboard(xml: string): Promise<void> {
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
