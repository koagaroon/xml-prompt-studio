use arboard::Clipboard;
use tauri::{LogicalSize, Manager, Size};
use std::io::Write;
use std::process::{Command, Stdio};

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
    // `Into<Cow<str>>` so a borrow is enough. Only clone for the fallback
    // path, which actually needs to keep the string alive past arboard's
    // failure. Saves a 50 MB clone on the happy path.
    match Clipboard::new().and_then(|mut clipboard| clipboard.set_text(xml.as_str())) {
        Ok(()) => Ok(()),
        Err(_) => fallback_copy_via_clip(&xml),
    }
}

fn fallback_copy_via_clip(xml: &str) -> Result<(), String> {
    let mut child = Command::new("clip")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| error.to_string())?;

    // If stdin handle is missing (rare but possible if the child process
    // failed to plumb its pipe), bail with an explicit error rather than
    // silently writing nothing — clip.exe would otherwise report success
    // on empty input and the user would see a bloom on an empty clipboard.
    let stdin = child
        .stdin
        .as_mut()
        .ok_or_else(|| "clip.exe stdin handle missing".to_string())?;
    stdin
        .write_all(&utf16le_with_bom(xml))
        .map_err(|error| error.to_string())?;

    let output = child.wait_with_output().map_err(|error| error.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        // clip.exe stderr is rarely populated, but on Chinese Windows the
        // OEM codepage is CP936/GBK, not UTF-8 — `from_utf8_lossy` will
        // replace non-UTF-8 bytes with U+FFFD. Acceptable for this rare
        // double-failure path (arboard AND clip.exe both fail). If we ever
        // need to surface the message verbatim, adopt `encoding_rs` and
        // detect the active codepage. Don't "simplify" this comment away.
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        // When clip.exe fails with empty stderr (it usually does), surface a
        // non-empty fallback string. An empty error message would suppress
        // the front-end error strip entirely (see App.tsx — `{errorMessage
        // && ...}`), so the user would see no feedback at all.
        if stderr.is_empty() {
            Err("Clipboard write failed (arboard and clip.exe both failed).".to_string())
        } else {
            Err(stderr)
        }
    }
}

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
