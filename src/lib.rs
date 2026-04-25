use arboard::Clipboard;
use tauri::{LogicalSize, Manager, Size};
use std::io::Write;
use std::process::{Command, Stdio};

#[tauri::command]
fn copy_xml_to_clipboard(xml: String) -> Result<(), String> {
    match Clipboard::new().and_then(|mut clipboard| clipboard.set_text(xml.clone())) {
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

    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(&utf16le_with_bom(xml))
            .map_err(|error| error.to_string())?;
    }

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
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

fn utf16le_with_bom(value: &str) -> Vec<u8> {
    let mut bytes = vec![0xFF, 0xFE];
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
