use arboard::Clipboard;
use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
#[cfg(debug_assertions)]
use std::time::Instant;
use tauri::{LogicalSize, Manager, Size};

// Hard cap on the size of any XML payload sent through the IPC. Tauri's
// channel can carry arbitrarily large strings; without a cap, a runaway
// pasted blob in Text Content would force arboard + utf16le to
// allocate gigabytes. 50_000_000 bytes ≈ 47.7 MiB of UTF-8, which is far
// beyond any realistic prompt-engineering payload.
const MAX_XML_BYTES: usize = 50_000_000;
// Hand-mirrored copies of `minWidth` / `minHeight` in tauri.conf.json —
// the JSON is the source of truth the window system actually enforces;
// these only clamp the computed launch size. Keep the pairs in sync, or
// launch sizing mis-clamps silently.
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

// Size gate for copy_xml_to_clipboard, split out so the boundary is unit-
// testable without touching the real clipboard. Also implicitly bounds the
// utf16le path: at 50 MB UTF-8, the worst-case UTF-16 expansion
// is at most 2× (4-byte non-BMP chars become 4 bytes via surrogate pairs;
// ASCII becomes 2 bytes). The fallback's allocation is therefore ≤ ~100 MB
// even in the pessimal case.
fn check_payload_size(len: usize) -> Result<(), String> {
    if len > MAX_XML_BYTES {
        let payload = format_megabytes(len);
        let limit = format_megabytes(MAX_XML_BYTES);
        return Err(format!(
            "XML payload too large to copy ({payload}; limit {limit})."
        ));
    }
    Ok(())
}

// Render a byte count as MB for user-facing messages — "50 MB" beats
// "50000000 bytes" for scanability. Integral values drop the decimal.
// The frontend's formatMegabytes (helpers.ts) formats its size errors
// the same way; change both or neither.
fn format_megabytes(bytes: usize) -> String {
    let mb = bytes as f64 / 1_000_000.0;
    if mb.fract() == 0.0 {
        format!("{mb:.0} MB")
    } else {
        format!("{mb:.1} MB")
    }
}

// `async` so the command leaves the main thread (sync commands execute
// there in Tauri 2); the body is fully blocking work (arboard, UTF-16
// re-encode, child-process wait), so it is further pushed onto the
// dedicated blocking pool rather than occupying an async-runtime worker
// — a wedged clipboard tool must not starve IPC dispatch.
#[tauri::command]
async fn copy_xml_to_clipboard(xml: String) -> Result<(), String> {
    check_payload_size(xml.len())?;
    tauri::async_runtime::spawn_blocking(move || copy_xml_blocking(&xml))
        .await
        .map_err(|error| format!("clipboard task failed: {error}"))?
}

// Long-lived arboard instance, lazily created on first copy. On Linux
// (X11 and Wayland alike) the clipboard contents are "hosted" by the app
// that set them, and per the arboard docs "when the last Clipboard
// instance is dropped, the contents may become unavailable to other
// apps" — a per-copy temporary would report success (bloom fires) and
// then serve an EMPTY paste on sessions without a clipboard manager.
// Upstream's own recommendation is keeping the instance in persistent
// state. Windows/macOS don't need the persistence but are unharmed.
static CLIPBOARD: Mutex<Option<Clipboard>> = Mutex::new(None);

fn set_text_persistent(xml: &str) -> Result<(), String> {
    let mut guard = CLIPBOARD.lock().unwrap_or_else(|poisoned| {
        // Poison means a panic mid-operation — the instance state is
        // exactly as suspect as on the Err path below, so give it the
        // same treatment: drop it and let this copy reinitialize.
        let mut guard = poisoned.into_inner();
        *guard = None;
        guard
    });
    if guard.is_none() {
        *guard = Some(Clipboard::new().map_err(|error| error.to_string())?);
    }
    let Some(clipboard) = guard.as_mut() else {
        return Err("clipboard handle unavailable".to_string());
    };
    let result = clipboard.set_text(xml).map_err(|error| error.to_string());
    if result.is_err() {
        // Discard a possibly-broken instance (stale display connection
        // etc.) so the next copy attempt reinitializes instead of
        // failing forever — preserves the retry semantics the previous
        // per-call construction had.
        *guard = None;
    }
    result
}

fn copy_xml_blocking(xml: &str) -> Result<(), String> {
    // A NUL would silently truncate the pasted text in most OS clipboard
    // consumers (C-string semantics) while the preview shows the full
    // content — refuse visibly instead of corrupting silently. Runs here
    // (on the blocking pool) because the O(n) scan over up to 50 MB
    // belongs with the rest of the heavy work, not on an async worker.
    if xml.contains('\0') {
        return Err(
            "XML payload contains a NUL (U+0000) character; paste targets would silently \
             truncate at it. Remove the character and copy again."
                .to_string(),
        );
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
    match set_text_persistent(xml) {
        Ok(()) => Ok(()),
        Err(arb_err) => fallback_copy_native(xml)
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
        // clip.exe expects UTF-16 LE via stdin — WITHOUT a BOM. Verified
        // empirically (Windows 11): a leading FF FE BOM is NOT consumed
        // as an encoding marker but lands in the clipboard as a literal
        // U+FEFF prefix character, silently violating the preview ==
        // clipboard contract; BOM-less UTF-16 LE decodes correctly for
        // ASCII-only, CJK, and non-BMP payloads alike.
        return spawn_and_pipe("clip", &[], &utf16le(xml), true);
    }
    #[cfg(target_os = "macos")]
    {
        // pbcopy reads UTF-8 from stdin by default.
        return spawn_and_pipe("pbcopy", &[], xml.as_bytes(), true);
    }
    #[cfg(target_os = "linux")]
    {
        // Try Wayland's wl-copy first (modern), fall back to X11's xclip
        // (legacy). Either may be missing depending on the distro / session
        // type; if both fail, chain the errors (mirrors the arboard→native
        // chaining above) so the user sees the full failure trail when
        // diagnosing "why doesn't Copy work on this Linux session?".
        //
        // capture_stderr is FALSE for both: wl-copy and xclip fork a
        // background process to keep serving the selection, and that
        // process inherits the piped stderr write-end — wait_with_output
        // would then block on stderr EOF indefinitely, leaving the
        // frontend's copy lock stuck for the rest of the session. Exit
        // status of the foreground parent is the only signal we keep.
        let wl_err = match spawn_and_pipe("wl-copy", &[], xml.as_bytes(), false) {
            Ok(()) => return Ok(()),
            Err(err) => err,
        };
        return spawn_and_pipe("xclip", &["-selection", "clipboard"], xml.as_bytes(), false)
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
//
// `capture_stderr: false` is for tools that fork a background process
// inheriting the pipe ends (wl-copy / xclip) — piping stderr there makes
// wait_with_output block on stderr EOF until the daemon exits. Tools that
// run to completion (clip.exe / pbcopy) pass true and keep their stderr in
// the error message.
fn spawn_and_pipe(
    cmd: &str,
    args: &[&str],
    payload: &[u8],
    capture_stderr: bool,
) -> Result<(), String> {
    let mut command = Command::new(cmd);
    command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(if capture_stderr {
            Stdio::piped()
        } else {
            Stdio::null()
        });
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: the parent is windows_subsystem = "windows"
        // (no console), so a console-subsystem child like clip.exe would
        // otherwise get a freshly allocated VISIBLE console — a black
        // window flashing on the RDP path this fallback exists for.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().map_err(|error| format!("{cmd}: {error}"))?;

    // If stdin handle is missing (rare but possible if the child process
    // failed to plumb its pipe), bail with an explicit error rather than
    // silently writing nothing — the child would otherwise report success
    // on empty input and the user would see a bloom on an empty clipboard.
    let Some(stdin) = child.stdin.as_mut() else {
        // Best-effort reap; the child never got its input and is exiting.
        let _ = child.wait();
        return Err(format!("{cmd} stdin handle missing"));
    };
    if let Err(error) = stdin.write_all(payload) {
        // A failed write usually means the child died early (broken pipe);
        // reap it — otherwise it lingers as a zombie on Unix until app
        // exit — and surface its stderr, which says WHY it died, alongside
        // the write error.
        let detail = match child.wait_with_output() {
            Ok(output) => {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                if stderr.is_empty() {
                    String::new()
                } else {
                    format!("; stderr: {stderr}")
                }
            }
            Err(_) => String::new(),
        };
        return Err(format!("{cmd}: {error}{detail}"));
    }

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
        // Empty stderr → surface a non-empty fallback message. The
        // front-end routes a rejected copy IPC into its message strip
        // (showError → stripMessage); an empty error string would render
        // a blank strip instead of a visible failure.
        Err(format!("{cmd} failed with no stderr output."))
    } else {
        Err(stderr)
    }
}

// No BOM on purpose — see the WHY at the clip.exe callsite: clip.exe
// copies a leading FF FE into the clipboard as a literal U+FEFF instead
// of consuming it as an encoding marker.
#[cfg(target_os = "windows")]
fn utf16le(value: &str) -> Vec<u8> {
    // Pre-allocate the output buffer to avoid the ~25 reallocations that
    // happen as Vec grows from 0 to ~50 MB. UTF-16 of UTF-8 input is at
    // most `value.len() * 2` bytes (worst case ASCII → each byte becomes
    // 2 bytes). Slight over-estimate for non-BMP input, but bounded.
    let mut bytes = Vec::with_capacity(value.len() * 2);
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
                // try_state, not state: if the app exits within the 5 s
                // sleep, managed state may already be torn down and
                // state() would panic in this detached thread.
                let Some(timing) = app_handle.try_state::<StartupTiming>() else {
                    return;
                };
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

    // Boundary pair for the copy-size gate: AT the limit passes, ONE BYTE
    // over is rejected. Pins the boundary from both sides so a refactor
    // can't silently loosen the cap in either direction.
    #[test]
    fn payload_size_at_limit_passes() {
        assert!(check_payload_size(MAX_XML_BYTES).is_ok());
    }

    #[test]
    fn payload_size_one_over_limit_is_rejected() {
        let error =
            check_payload_size(MAX_XML_BYTES + 1).expect_err("over-limit payload must be rejected");
        // Full-equality assert pins the message format AND the MB
        // rendering (one decimal for fractional, none for integral).
        assert_eq!(
            error,
            "XML payload too large to copy (50.0 MB; limit 50 MB)."
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn utf16le_emits_no_bom() {
        // Empirically verified: clip.exe copies a leading FF FE into the
        // clipboard as a literal U+FEFF instead of consuming it, breaking
        // the preview == clipboard contract. Pin the absence.
        assert_eq!(utf16le("x"), vec![0x78, 0x00]);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn utf16le_encodes_ascii_cjk_and_non_bmp_little_endian() {
        // 'A' = 0x0041, '中' = 0x4E2D, '🦀' = U+1F980 → surrogate pair
        // D83E DD80; every code unit must land low-byte-first.
        assert_eq!(
            utf16le("A中🦀"),
            vec![0x41, 0x00, 0x2D, 0x4E, 0x3E, 0xD8, 0x80, 0xDD]
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn utf16le_round_trips_mixed_content() {
        let original = "<反馈>hello 🦀</反馈>";
        let bytes = utf16le(original);
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        assert_eq!(String::from_utf16(&units).unwrap(), original);
    }
}
