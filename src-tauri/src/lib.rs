use arboard::Clipboard;
use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;
#[cfg(debug_assertions)]
use std::time::Instant;
use tauri::{LogicalSize, Manager, Size};

// Hard cap on the size of any XML payload sent through the IPC. Tauri's
// channel can carry arbitrarily large strings; without a cap, a runaway
// pasted blob in Text Content would force arboard + utf16le_with_bom to
// allocate gigabytes. 50_000_000 bytes ≈ 47.7 MiB of UTF-8, which is far
// beyond any realistic prompt-engineering payload.
const MAX_XML_BYTES: usize = 50_000_000;
const CONFIG_MIN_WINDOW_WIDTH: f64 = 720.0;
const CONFIG_MIN_WINDOW_HEIGHT: f64 = 520.0;
const MAX_LAUNCH_WINDOW_WIDTH: f64 = 1600.0;
const MAX_LAUNCH_WINDOW_HEIGHT: f64 = 1100.0;
const LAUNCH_AREA_FRACTION: f64 = 2.0 / 3.0;

struct StartupTiming {
    #[cfg(debug_assertions)]
    started_at: Instant,
    main_window_shown: AtomicBool,
}

impl StartupTiming {
    fn new() -> Self {
        Self {
            #[cfg(debug_assertions)]
            started_at: Instant::now(),
            main_window_shown: AtomicBool::new(false),
        }
    }

    #[cfg(debug_assertions)]
    fn elapsed_ms(&self) -> u128 {
        self.started_at.elapsed().as_millis()
    }

    fn is_main_window_shown(&self) -> bool {
        self.main_window_shown.load(Ordering::SeqCst)
    }

    fn mark_main_window_shown(&self) {
        self.main_window_shown.store(true, Ordering::SeqCst);
    }
}

#[cfg(debug_assertions)]
fn log_startup(timing: &StartupTiming, message: &str) {
    eprintln!("[startup +{}ms] {}", timing.elapsed_ms(), message);
}

#[cfg(not(debug_assertions))]
fn log_startup(_timing: &StartupTiming, _message: &str) {}

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

#[tauri::command]
fn show_main_window(
    app_handle: tauri::AppHandle,
    timing: tauri::State<'_, StartupTiming>,
) -> Result<(), String> {
    log_startup(timing.inner(), "frontend show command received");
    show_main_window_with_handle(&app_handle, timing.inner(), "frontend show command")
}

fn show_main_window_with_handle(
    app_handle: &tauri::AppHandle,
    timing: &StartupTiming,
    source: &str,
) -> Result<(), String> {
    if timing.is_main_window_shown() {
        log_startup(timing, &format!("{source}: main window already visible"));
        return Ok(());
    }

    let window = app_handle
        .get_webview_window("main")
        .ok_or_else(|| "main window missing".to_string())?;
    window
        .show()
        .map_err(|error| format!("failed to show main window: {error}"))?;
    timing.mark_main_window_shown();
    log_startup(timing, &format!("{source}: main window shown"));
    Ok(())
}

fn launch_window_size_for_work_area(work_area_size: LogicalSize<f64>) -> LogicalSize<f64> {
    let available_width = work_area_size.width.max(1.0);
    let available_height = work_area_size.height.max(1.0);
    let max_width = MAX_LAUNCH_WINDOW_WIDTH.min(available_width.max(CONFIG_MIN_WINDOW_WIDTH));
    let max_height = MAX_LAUNCH_WINDOW_HEIGHT.min(available_height.max(CONFIG_MIN_WINDOW_HEIGHT));
    let area_ratio = LAUNCH_AREA_FRACTION.sqrt();
    let width = (available_width * area_ratio).clamp(CONFIG_MIN_WINDOW_WIDTH, max_width);
    let height = (available_height * area_ratio).clamp(CONFIG_MIN_WINDOW_HEIGHT, max_height);

    LogicalSize::new(width, height)
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
        // type; if both fail, chain the errors (mirrors the arboard→native
        // chaining above) so the user sees the full failure trail when
        // diagnosing "why doesn't Copy work on this Linux session?".
        let wl_err = match spawn_and_pipe("wl-copy", &[], xml.as_bytes()) {
            Ok(()) => return Ok(()),
            Err(err) => err,
        };
        return spawn_and_pipe("xclip", &["-selection", "clipboard"], xml.as_bytes())
            .map_err(|xclip_err| format!("wl-copy: {wl_err}; xclip: {xclip_err}"));
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
        .manage(StartupTiming::new())
        .invoke_handler(tauri::generate_handler![
            copy_xml_to_clipboard,
            show_main_window
        ])
        .setup(|app| {
            let timing = app.state::<StartupTiming>();
            log_startup(timing.inner(), "setup entered");

            // The JSON size is the hidden pre-setup fallback. When monitor
            // probing succeeds, launch from two-thirds of the work-area
            // area, bounded by the configured minimums and the desktop cap.
            if let Some(window) = app.get_webview_window("main") {
                let monitor = window
                    .current_monitor()
                    .ok()
                    .flatten()
                    .or_else(|| window.primary_monitor().ok().flatten());

                if let Some(monitor) = monitor {
                    let scale_factor = monitor.scale_factor();
                    let work_area_size = monitor.work_area().size.to_logical::<f64>(scale_factor);
                    let launch_size = launch_window_size_for_work_area(work_area_size);
                    match window.set_size(Size::Logical(launch_size)) {
                        Ok(()) => log_startup(timing.inner(), "work-area-derived size applied"),
                        Err(error) => log_startup(
                            timing.inner(),
                            &format!("work-area-derived size failed; using config size: {error}"),
                        ),
                    }
                } else {
                    log_startup(timing.inner(), "monitor unavailable; using config size");
                }

                match window.center() {
                    Ok(()) => log_startup(timing.inner(), "window centered"),
                    Err(error) => log_startup(
                        timing.inner(),
                        &format!("window center failed; continuing uncentered: {error}"),
                    ),
                }
            } else {
                log_startup(timing.inner(), "main window missing during setup");
            }

            let app_handle = app.handle().clone();
            thread::spawn(move || {
                thread::sleep(Duration::from_secs(5));
                let timing = app_handle.state::<StartupTiming>();
                if timing.is_main_window_shown() {
                    return;
                }

                log_startup(timing.inner(), "fallback show fired");
                if let Err(error) =
                    show_main_window_with_handle(&app_handle, timing.inner(), "fallback show")
                {
                    log_startup(timing.inner(), &format!("fallback show failed: {error}"));
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_size_close(actual: LogicalSize<f64>, expected_width: f64, expected_height: f64) {
        assert!(
            (actual.width - expected_width).abs() < 0.001,
            "expected width {expected_width}, got {}",
            actual.width
        );
        assert!(
            (actual.height - expected_height).abs() < 0.001,
            "expected height {expected_height}, got {}",
            actual.height
        );
    }

    #[test]
    fn launch_size_uses_two_thirds_area_on_common_desktop() {
        let size = launch_window_size_for_work_area(LogicalSize::new(1920.0, 1080.0));

        assert_size_close(size, 1567.674, 881.817);
    }

    #[test]
    fn launch_size_caps_large_desktop() {
        let size = launch_window_size_for_work_area(LogicalSize::new(3840.0, 2160.0));

        assert_size_close(size, MAX_LAUNCH_WINDOW_WIDTH, MAX_LAUNCH_WINDOW_HEIGHT);
    }

    #[test]
    fn launch_size_uses_config_minimums_on_small_desktop() {
        let size = launch_window_size_for_work_area(LogicalSize::new(800.0, 600.0));

        assert_size_close(size, CONFIG_MIN_WINDOW_WIDTH, CONFIG_MIN_WINDOW_HEIGHT);
    }

    #[test]
    fn launch_size_never_reintroduces_old_oversized_small_desktop_floor() {
        let size = launch_window_size_for_work_area(LogicalSize::new(800.0, 600.0));

        assert!(
            size.width <= 800.0,
            "launch width should fit available work area when config minimum allows it"
        );
        assert!(
            size.height <= 600.0,
            "launch height should fit available work area when config minimum allows it"
        );
    }
}
