async function loadInvoke() {
  const module = await import("@tauri-apps/api/core");
  return module.invoke;
}

function isTauriEnvironment(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

export async function copyXmlToClipboard(xml: string): Promise<void> {
  if (isTauriEnvironment()) {
    const invoke = await loadInvoke();
    await invoke("copy_xml_to_clipboard", { xml });
    return;
  }

  await navigator.clipboard.writeText(xml);
}
