use arboard::Clipboard;
use std::io::Write;
use std::process::{Command, Stdio};
use tauri::{LogicalSize, Manager, Size};

// Hard cap on the size of any XML payload sent through the IPC. Tauri's
// channel can carry arbitrarily large strings; without a cap, a runaway
// pasted blob in Text Content would force arboard + utf16le_with_bom to
// allocate gigabytes. 50_000_000 bytes ≈ 47.7 MiB of UTF-8, which is far
// beyond any realistic prompt-engineering payload.
const MAX_XML_BYTES: usize = 50_000_000;

#[tauri::command]
fn copy_xml_to_clipboard(xml: String) -> Result<(), String> {
    // Check the UTF-8 size up front. Also implicitly bounds the
    // utf16le_with_bom path: at 50 MB UTF-8, the worst-case UTF-16
    // expansion is at most 2× (4-byte non-BMP chars become 4 bytes via
    // surrogate pairs; ASCII becomes 2 bytes). The fallback's allocation
    // is therefore ≤ ~100 MB even in the pessimal case.
    if xml.len() > MAX_XML_BYTES {
        return Err(format!(
            "XML payload too large to copy ({} bytes; limit {} bytes).",
            xml.len(),
            MAX_XML_BYTES
        ));
    }
    // Try arboard with a borrowed slice first — `set_text` accepts
    // `Into<Cow<str>>` so a borrow is enough. Only fall back if arboard
    // fails. Saves a 50 MB clone on the happy path.
    //
    // When arboard fails AND the native fallback also fails, surface both
    // error messages — diagnosing "why does Copy fail on this machine?"
    // wants both signals (e.g., "arboard: clipboard busy; fallback:
    // clip.exe stderr"), not just the last one. When the fallback
    // succeeds, the arboard error is intentionally dropped: the user got
    // their clipboard content, no need to spam them.
    match Clipboard::new().and_then(|mut clipboard| clipboard.set_text(xml.as_str())) {
        Ok(()) => Ok(()),
        Err(arb_err) => fallback_copy_native(&xml)
            .map_err(|fb_err| format!("arboard: {arb_err}; fallback: {fb_err}")),
    }
}

// Cross-platform fallback when arboard fails. Each OS has a built-in
// command-line clipboard tool; we shell out as a last resort. This whole
// path triggers rarely (arboard failure is the trigger) but matters when
// it does — RDP sessions on Windows, sandboxed Wayland on Linux, etc.
//
// `#[allow(clippy::needless_return)]` — the cfg-gated branches each end
// with an explicit `return` for readability. Removing them works on the
// active branch but leaves the source asymmetric across the four arms.
#[allow(clippy::needless_return)]
fn fallback_copy_native(xml: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // clip.exe expects UTF-16 LE + BOM via stdin; without the BOM,
        // CJK characters end up garbled.
        return spawn_and_pipe("clip", &[], &utf16le_with_bom(xml));
    }
    #[cfg(target_os = "macos")]
    {
        // pbcopy reads UTF-8 from stdin by default.
        return spawn_and_pipe("pbcopy", &[], xml.as_bytes());
    }
    #[cfg(target_os = "linux")]
    {
        // Try Wayland's wl-copy first (modern), fall back to X11's xclip
        // (legacy). Either may be missing depending on the distro / session
        // type; the user gets a coherent error if both fail.
        if spawn_and_pipe("wl-copy", &[], xml.as_bytes()).is_ok() {
            return Ok(());
        }
        return spawn_and_pipe("xclip", &["-selection", "clipboard"], xml.as_bytes());
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = xml; // silence unused-variable warning on unsupported OSes
        return Err("Clipboard fallback not implemented for this operating system.".to_string());
    }
}

// Shared helper for "spawn a command, write payload to its stdin, surface
// success/failure as Result<(), String>". All three native fallbacks share
// the same shape; centralizing the error handling keeps the per-OS branches
// short and consistent.
fn spawn_and_pipe(cmd: &str, args: &[&str], payload: &[u8]) -> Result<(), String> {
    let mut child = Command::new(cmd)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("{}: {}", cmd, error))?;

    // If stdin handle is missing (rare but possible if the child process
    // failed to plumb its pipe), bail with an explicit error rather than
    // silently writing nothing — the child would otherwise report success
    // on empty input and the user would see a bloom on an empty clipboard.
    let stdin = child
        .stdin
        .as_mut()
        .ok_or_else(|| format!("{} stdin handle missing", cmd))?;
    stdin
        .write_all(payload)
        .map_err(|error| format!("{}: {}", cmd, error))?;

    let output = child
        .wait_with_output()
        .map_err(|error| error.to_string())?;
    if output.status.success() {
        return Ok(());
    }

    // Stderr decoding caveat (Windows-specific but harmless elsewhere):
    // on Chinese Windows the OEM codepage is CP936/GBK, not UTF-8, so
    // `from_utf8_lossy` may replace non-UTF-8 bytes with U+FFFD.
    // Acceptable for this rare failure path. Don't "simplify" this away.
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.is_empty() {
        // Empty stderr → surface a non-empty fallback so the front-end
        // error strip (which renders only on truthy errorMessage) shows
        // *something* instead of staying invisible.
        Err(format!("{} failed with no stderr output.", cmd))
    } else {
        Err(stderr)
    }
}

#[cfg(target_os = "windows")]
fn utf16le_with_bom(value: &str) -> Vec<u8> {
    // Pre-allocate the output buffer to avoid the ~25 reallocations that
    // happen as Vec grows from 0 to ~50 MB. UTF-16 of UTF-8 input is at
    // most `value.len() * 2` bytes (worst case ASCII → each byte becomes
    // 2 bytes) plus the 2-byte BOM. Slight over-estimate for non-BMP
    // input, but bounded.
    let mut bytes = Vec::with_capacity(2 + value.len() * 2);
    bytes.extend_from_slice(&[0xFF, 0xFE]);
    for code_unit in value.encode_utf16() {
        bytes.extend_from_slice(&code_unit.to_le_bytes());
    }
    bytes
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![copy_xml_to_clipboard])
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let monitor = window
                    .current_monitor()
                    .ok()
                    .flatten()
                    .or_else(|| window.primary_monitor().ok().flatten());

                if let Some(monitor) = monitor {
                    let scale_factor = monitor.scale_factor();
                    let monitor_size = monitor.size().to_logical::<f64>(scale_factor);
                    let area_ratio = (1.0_f64 / 3.0_f64).sqrt();
                    let width = (monitor_size.width * area_ratio).clamp(820.0, 1600.0);
                    let height = (monitor_size.height * area_ratio).clamp(560.0, 1100.0);
                    window.set_size(Size::Logical(LogicalSize::new(width, height)))?;
                }

                window.center()?;
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
