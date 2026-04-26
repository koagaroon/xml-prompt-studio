// Tauri 2 publishes `window.isTauri` as a boolean for environment detection.
// This is a stable public API; previously this code probed the internal
// `__TAURI_INTERNALS__` object, which was undocumented and subject to silent
// rename across Tauri versions.

declare global {
  interface Window {
    isTauri?: boolean;
  }
}

async function loadInvoke() {
  const module = await import("@tauri-apps/api/core");
  return module.invoke;
}

function isTauriEnvironment(): boolean {
  return typeof window !== "undefined" && window.isTauri === true;
}

export async function copyXmlToClipboard(xml: string): Promise<void> {
  if (isTauriEnvironment()) {
    const invoke = await loadInvoke();
    await invoke("copy_xml_to_clipboard", { xml });
    return;
  }

  await navigator.clipboard.writeText(xml);
}
