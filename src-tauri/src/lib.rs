#[cfg(not(target_os = "windows"))]
compile_error!("XML Prompt Studio supports Windows only.");

use arboard::Clipboard;
mod clipboard_lifecycle;
use clipboard_lifecycle::ClipboardLifecycle;
use std::ffi::OsString;
use std::io::{Read, Write};
use std::os::windows::ffi::OsStringExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::thread;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tauri::webview::PageLoadEvent;
use tauri::{LogicalSize, Manager, PhysicalPosition, PhysicalSize, Position, Size, WindowEvent};

// Hard cap on the size of any XML payload sent through the IPC. Tauri's
// channel can carry arbitrarily large strings; without a cap, a runaway
// pasted blob in Text Content would force arboard + utf16le to
// allocate gigabytes. 50_000_000 bytes ≈ 47.7 MiB of UTF-8, which is far
// beyond any realistic prompt-engineering payload. Hand-mirrored as
// MAX_XML_BYTES in src/helpers.ts (frontend gate) — change both or
// neither, same discipline as the CONFIG_MIN_WINDOW_* pair below.
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
const FALLBACK_HELPER_TIMEOUT: Duration = Duration::from_secs(10);
const WORKER_JOIN_TIMEOUT: Duration = Duration::from_secs(1);
const CLOSE_ACK_TIMEOUT: Duration = Duration::from_millis(1500);

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetSystemDirectoryW(lp_buffer: *mut u16, size: u32) -> u32;
}

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

    // Record actual success, not an in-flight claim. The frontend path
    // and fallback path may race and both call show(); Tauri show() is
    // idempotent, while a one-shot fallback skipping a failed in-flight
    // show attempt can strand the window hidden.
    fn mark_main_window_shown(&self) {
        self.main_window_shown.store(true, Ordering::SeqCst);
    }
}

struct CloseGuardState {
    latest_registration_seq: u64,
    latest_unsaved_seq: u64,
    has_unsaved_work: bool,
    close_confirmed: bool,
    active_listener_id: Option<u32>,
    on_close_requested: Option<tauri::ipc::Channel<bool>>,
    pending_ack_since: Option<Instant>,
}

impl CloseGuardState {
    fn new() -> Self {
        Self {
            latest_registration_seq: 0,
            latest_unsaved_seq: 0,
            has_unsaved_work: false,
            close_confirmed: false,
            active_listener_id: None,
            on_close_requested: None,
            pending_ack_since: None,
        }
    }
}

struct CloseGuard {
    state: Mutex<CloseGuardState>,
}

impl CloseGuard {
    fn new() -> Self {
        Self {
            state: Mutex::new(CloseGuardState::new()),
        }
    }

    fn lock_state(&self) -> MutexGuard<'_, CloseGuardState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn reset_for_navigation(&self) {
        *self.lock_state() = CloseGuardState::new();
    }

    fn set_has_unsaved_work(&self, seq: u64, has_unsaved_work: bool) {
        let mut state = self.lock_state();
        if seq < state.latest_unsaved_seq {
            return;
        }
        state.latest_unsaved_seq = seq;
        state.has_unsaved_work = has_unsaved_work;
        if !has_unsaved_work {
            state.close_confirmed = false;
            state.pending_ack_since = None;
        }
    }

    fn mark_close_confirmed(&self) {
        let mut state = self.lock_state();
        state.close_confirmed = true;
        state.pending_ack_since = None;
    }

    fn clear_close_confirmed(&self) {
        self.lock_state().close_confirmed = false;
    }

    fn register_listener(&self, seq: u64, channel: tauri::ipc::Channel<bool>) {
        let mut state = self.lock_state();
        if seq < state.latest_registration_seq {
            return;
        }
        state.latest_registration_seq = seq;
        state.active_listener_id = Some(channel.id());
        state.on_close_requested = Some(channel);
        state.close_confirmed = false;
        state.pending_ack_since = None;
    }

    fn unregister_listener(&self, seq: u64, channel_id: u32) {
        let mut state = self.lock_state();
        state.latest_registration_seq = state.latest_registration_seq.max(seq);
        if state.active_listener_id == Some(channel_id) {
            state.active_listener_id = None;
            state.on_close_requested = None;
            state.pending_ack_since = None;
        }
    }

    fn ack_close_requested(&self) {
        self.lock_state().pending_ack_since = None;
    }

    // Returns false when clean, already confirmed, lacking a registered channel,
    // channel send fails, or an earlier close request went unacknowledged past
    // CLOSE_ACK_TIMEOUT — ensuring an unmounted, wedged, or crashed frontend
    // can never trap the native window open.
    fn intercept_close_at(&self, now: Instant) -> bool {
        let mut state = self.lock_state();
        if !state.has_unsaved_work || state.close_confirmed {
            return false;
        }
        if let Some(since) = state.pending_ack_since {
            if now.saturating_duration_since(since) >= CLOSE_ACK_TIMEOUT {
                state.active_listener_id = None;
                state.on_close_requested = None;
                state.pending_ack_since = None;
                return false;
            }
        }
        let Some(channel) = state.on_close_requested.as_ref() else {
            return false;
        };
        if channel.send(true).is_ok() {
            state.pending_ack_since.get_or_insert(now);
            true
        } else {
            state.active_listener_id = None;
            state.on_close_requested = None;
            state.pending_ack_since = None;
            false
        }
    }

    fn intercept_close(&self) -> bool {
        self.intercept_close_at(Instant::now())
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
// "50000000 bytes" for scanability. Fractional values round UP to the
// next 0.1 MB: a payload one byte over the limit must never display as
// equal to it ("50.0 MB; limit 50 MB" reads as a contradiction).
// Integral tenths drop the trailing zero decimal. The frontend's
// formatMegabytes (helpers.ts) formats its size errors the same way;
// change both or neither.
fn format_megabytes(bytes: usize) -> String {
    let tenths = bytes.div_ceil(100_000);
    if tenths.is_multiple_of(10) {
        format!("{} MB", tenths / 10)
    } else {
        format!("{}.{} MB", tenths / 10, tenths % 10)
    }
}

// `async` so the command leaves the main thread (sync commands execute
// there in Tauri 2); the body is fully blocking work (arboard, UTF-16
// re-encode, child-process wait), so it is further pushed onto the
// dedicated blocking pool rather than occupying an async-runtime worker
// — a wedged clipboard tool must not starve IPC dispatch.
#[tauri::command]
async fn copy_xml_to_clipboard(xml: String) -> Result<(), String> {
    // Size gate first (an O(1) length read on the async worker), NUL
    // gate second (an O(n) scan, deferred to the blocking pool below).
    // The frontend mirrors both gates in the opposite order for its own
    // flow; the asymmetry is harmless — both must pass either way.
    check_payload_size(xml.len())?;
    tauri::async_runtime::spawn_blocking(move || copy_xml_blocking(&xml))
        .await
        .map_err(|error| format!("clipboard task failed: {error}"))?
}

// Serialize arboard and clip.exe together so direct IPC calls cannot race
// separate clipboard writers, even without the frontend's copyInFlight guard.
static COPY_LIFECYCLE: ClipboardLifecycle = ClipboardLifecycle::new();

// NUL gate for copy_xml_to_clipboard, split out like check_payload_size
// so the IPC-boundary guard is unit-testable without touching the real
// clipboard. A NUL would silently truncate the pasted text in most OS
// clipboard consumers (C-string semantics) while the preview shows the
// full content — refuse visibly instead of corrupting silently.
fn check_no_nul(xml: &str) -> Result<(), String> {
    if xml.contains('\0') {
        return Err(
            "XML payload contains a NUL (U+0000) character; paste targets would silently \
             truncate at it. Remove the character and copy again."
                .to_string(),
        );
    }
    Ok(())
}

fn copy_xml_blocking(xml: &str) -> Result<(), String> {
    let _copy_guard = COPY_LIFECYCLE.lock_copy();
    // The NUL gate runs here (on the blocking pool) because the O(n)
    // scan over up to 50 MB belongs with the rest of the heavy work,
    // not on an async worker.
    check_no_nul(xml)?;
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
    match Clipboard::new().and_then(|mut clipboard| clipboard.set_text(xml)) {
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

#[tauri::command]
fn register_close_guard(
    seq: u64,
    on_close_requested: tauri::ipc::Channel<bool>,
    close_guard: tauri::State<'_, CloseGuard>,
) {
    close_guard.register_listener(seq, on_close_requested);
}

#[tauri::command]
fn unregister_close_guard(seq: u64, channel_id: u32, close_guard: tauri::State<'_, CloseGuard>) {
    close_guard.unregister_listener(seq, channel_id);
}

#[tauri::command]
fn set_has_unsaved_work(
    seq: u64,
    has_unsaved_work: bool,
    close_guard: tauri::State<'_, CloseGuard>,
) {
    close_guard.set_has_unsaved_work(seq, has_unsaved_work);
}

#[tauri::command]
fn ack_close_requested(close_guard: tauri::State<'_, CloseGuard>) {
    close_guard.ack_close_requested();
}

#[tauri::command]
fn confirm_close_window(
    app_handle: tauri::AppHandle,
    close_guard: tauri::State<'_, CloseGuard>,
) -> Result<(), String> {
    let window = app_handle
        .get_webview_window("main")
        .ok_or_else(|| "main window missing".to_string())?;
    close_guard.mark_close_confirmed();
    if let Err(error) = window.close() {
        close_guard.clear_close_confirmed();
        return Err(format!("failed to close main window: {error}"));
    }
    Ok(())
}

fn show_main_window_with_handle(
    app_handle: &tauri::AppHandle,
    timing: &StartupTiming,
    source: &str,
) -> Result<(), String> {
    if timing.is_main_window_shown() {
        log_startup(
            timing,
            &format!("{source}: main window already shown; skipping"),
        );
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
    let available_width = if work_area_size.width.is_finite() {
        work_area_size.width.max(1.0)
    } else {
        CONFIG_MIN_WINDOW_WIDTH
    };
    let available_height = if work_area_size.height.is_finite() {
        work_area_size.height.max(1.0)
    } else {
        CONFIG_MIN_WINDOW_HEIGHT
    };
    let max_width = MAX_LAUNCH_WINDOW_WIDTH.min(available_width.max(CONFIG_MIN_WINDOW_WIDTH));
    let max_height = MAX_LAUNCH_WINDOW_HEIGHT.min(available_height.max(CONFIG_MIN_WINDOW_HEIGHT));
    let area_ratio = LAUNCH_AREA_FRACTION.sqrt();
    let width = (available_width * area_ratio).clamp(CONFIG_MIN_WINDOW_WIDTH, max_width);
    let height = (available_height * area_ratio).clamp(CONFIG_MIN_WINDOW_HEIGHT, max_height);

    LogicalSize::new(width, height)
}

fn centered_window_position_in_work_area(
    work_area_pos: PhysicalPosition<i32>,
    work_area_size: PhysicalSize<u32>,
    outer_size: PhysicalSize<u32>,
) -> PhysicalPosition<i32> {
    let work_w = i64::from(work_area_size.width);
    let work_h = i64::from(work_area_size.height);
    let win_w = i64::from(outer_size.width);
    let win_h = i64::from(outer_size.height);
    let origin_x = i64::from(work_area_pos.x);
    let origin_y = i64::from(work_area_pos.y);

    let centered_x = origin_x + (work_w - win_w) / 2;
    let centered_y = origin_y + (work_h - win_h) / 2;
    // Clamp against right/bottom first, then enforce >= work_area origin so
    // the title bar and window controls stay reachable on compact high-DPI
    // displays even when outer height exceeds the available work area.
    let max_x = (origin_x + work_w - win_w).max(origin_x);
    let max_y = (origin_y + work_h - win_h).max(origin_y);
    let clamped_x = centered_x.clamp(origin_x, max_x);
    let clamped_y = centered_y.clamp(origin_y, max_y);

    PhysicalPosition::new(
        clamped_x.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32,
        clamped_y.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32,
    )
}

// Windows fallback for sessions where arboard cannot access the clipboard.
fn fallback_copy_native(xml: &str) -> Result<(), String> {
    // clip.exe expects UTF-16 LE via stdin — WITHOUT a BOM. Verified
    // empirically (Windows 11): a leading FF FE BOM is NOT consumed
    // as an encoding marker but lands in the clipboard as a literal
    // U+FEFF prefix character, silently violating the preview ==
    // clipboard contract; BOM-less UTF-16 LE decodes correctly for
    // ASCII-only, CJK, and non-BMP payloads alike.
    let clip = windows_system32_helper("clip.exe")?;
    spawn_and_pipe("clip.exe", &clip, &[], utf16le(xml))
}

fn windows_system32_helper(exe_name: &str) -> Result<PathBuf, String> {
    let candidate = windows_system_directory()?.join(exe_name);
    trusted_helper(exe_name, &candidate)
}

fn windows_system_directory() -> Result<PathBuf, String> {
    // Ask Windows directly instead of trusting inherited SystemRoot/WINDIR.
    // Microsoft documents that success returns the copied length excluding
    // NUL, while too-small buffers return the required length including NUL.
    let mut buffer = vec![0_u16; 260];
    loop {
        let copied = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) };
        if copied == 0 {
            return Err(format!(
                "GetSystemDirectoryW failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        let copied = copied as usize;
        if copied < buffer.len() {
            buffer.truncate(copied);
            return Ok(PathBuf::from(OsString::from_wide(&buffer)));
        }
        let next_len = copied.max(buffer.len() + 1);
        buffer.resize(next_len, 0);
    }
}

fn trusted_helper(name: &str, path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err(format!(
            "{name}: helper path must be absolute: {}",
            path.display()
        ));
    }
    if !path.is_file() {
        return Err(format!(
            "{name}: helper not found at trusted path: {}",
            path.display()
        ));
    }
    Ok(path.to_path_buf())
}

// Write stdin and drain stderr concurrently on worker threads so neither pipe
// can deadlock on a full Win32 buffer and an unkillable child handle can never
// block COPY_LIFECYCLE past WORKER_JOIN_TIMEOUT.
fn spawn_and_pipe(
    cmd: &str,
    program: &Path,
    args: &[&str],
    payload: Vec<u8>,
) -> Result<(), String> {
    use std::os::windows::process::CommandExt;

    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    // Prevent clip.exe from opening a visible console in the GUI app.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
    let mut child = command
        .spawn()
        .map_err(|error| format!("{cmd}: {}: {error}", program.display()))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| format!("{cmd}: child stdin pipe unavailable"))?;
    let stderr_pipe = child.stderr.take();
    let writer = spawn_stdin_writer(cmd.to_string(), stdin, payload);
    let stderr_reader = spawn_stderr_reader(stderr_pipe);
    let label = format!("{cmd} ({})", program.display());

    let status = match wait_for_child(&label, &mut child, FALLBACK_HELPER_TIMEOUT) {
        Ok(status) => status,
        Err(error) => {
            let writer_error = finish_stdin_writer(&label, writer).err();
            let stderr = finish_stderr_reader(stderr_reader);
            return Err(format_helper_run_error(error, stderr, writer_error));
        }
    };
    let writer_error = finish_stdin_writer(&label, writer).err();
    let stderr = finish_stderr_reader(stderr_reader);
    if status.success() && writer_error.is_none() {
        return Ok(());
    }
    if !status.success() {
        let primary = if stderr.is_empty() {
            format!("{label}: exited with {status} and no stderr output.")
        } else {
            format!("{label}: {stderr}")
        };
        return Err(format_helper_run_error(
            primary,
            String::new(),
            writer_error,
        ));
    }
    Err(format_helper_run_error(
        writer_error.unwrap_or_else(|| format!("{label}: helper stdin write failed")),
        stderr,
        None,
    ))
}

fn spawn_stdin_writer(
    cmd: String,
    mut stdin: std::process::ChildStdin,
    payload: Vec<u8>,
) -> JoinHandle<Result<(), String>> {
    thread::spawn(move || {
        stdin
            .write_all(&payload)
            .map_err(|error| format!("{cmd}: failed to write helper stdin: {error}"))?;
        stdin
            .flush()
            .map_err(|error| format!("{cmd}: failed to flush helper stdin: {error}"))?;
        drop(stdin);
        Ok(())
    })
}

fn finish_stdin_writer(label: &str, writer: JoinHandle<Result<(), String>>) -> Result<(), String> {
    let started = Instant::now();
    while !writer.is_finished() {
        if started.elapsed() >= WORKER_JOIN_TIMEOUT {
            return Err(format!(
                "{label}: stdin writer did not finish after {} seconds",
                WORKER_JOIN_TIMEOUT.as_secs()
            ));
        }
        thread::sleep(Duration::from_millis(10));
    }
    match writer.join() {
        Ok(result) => result,
        Err(_) => Err(format!("{label}: stdin writer panicked")),
    }
}

fn format_helper_run_error(
    primary: String,
    stderr: String,
    writer_error: Option<String>,
) -> String {
    let mut parts = vec![primary];
    if !stderr.is_empty() {
        parts.push(format!("stderr: {stderr}"));
    }
    if let Some(error) = writer_error {
        parts.push(error);
    }
    parts.join("; ")
}

fn wait_for_child(cmd: &str, child: &mut Child, timeout: Duration) -> Result<ExitStatus, String> {
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) => {
                if started.elapsed() >= timeout {
                    // Kill, then reap and HONOR the exit status: the
                    // child may have finished in the gap since the last
                    // poll (≤ 25 ms). A genuine success means the clipboard
                    // WAS written; reporting it as "terminated" would
                    // tell the user a successful copy failed.
                    //
                    // The success branch is deliberately unpinned by
                    // tests: it is race-dependent (the child must exit
                    // inside the ≤ 25 ms window), so this comment is the
                    // contract.
                    let reaped = if child.kill().is_ok() {
                        child.wait().ok()
                    } else {
                        child.try_wait().ok().flatten()
                    };
                    return match reaped {
                        Some(status) if status.success() => Ok(status),
                        Some(status) => Err(format!(
                            "{cmd}: timed out after {} seconds; terminated (final status: {status})",
                            timeout.as_secs()
                        )),
                        // kill failed AND no exit status: the helper is
                        // likely still running and unkillable — saying
                        // "terminated" would misdirect diagnosis of
                        // exactly the wedged-helper case. It stays
                        // unreaped until app exit (accepted: this
                        // precondition is essentially unreachable).
                        None => Err(format!(
                            "{cmd}: timed out after {} seconds and could not be terminated — it may still be running",
                            timeout.as_secs()
                        )),
                    };
                }
            }
            Err(error) => {
                // try_wait erring is already exotic — best-effort kill +
                // reap (each a no-op if the child somehow already
                // exited), then surface the original error.
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("{cmd}: {error}"));
            }
        }
        thread::sleep(Duration::from_millis(25));
    }
}

// Cap on how much helper stderr is read back into the error message —
// it is a diagnostic, not a transcript. A helper spewing for the full
// 10 s before the kill could deposit GB-scale bytes; an unbounded read
// would load them all and ship them over IPC into the message strip.
const STDERR_CAPTURE_LIMIT_BYTES: u64 = 4096;

// Concurrently read a bounded head of stderr while draining any remainder so
// a chatty helper (> 4 KiB) never blocks on a full pipe buffer. Decoding
// caveat: on Chinese Windows the OEM codepage is CP936/GBK, not UTF-8, so
// `from_utf8_lossy` may replace non-UTF-8 bytes with U+FFFD.
fn decode_captured_stderr(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).trim().to_string()
}

fn spawn_stderr_reader(stderr: Option<std::process::ChildStderr>) -> JoinHandle<String> {
    thread::spawn(move || {
        let Some(mut stderr) = stderr else {
            return String::new();
        };
        let mut bytes = Vec::new();
        if (&mut stderr)
            .take(STDERR_CAPTURE_LIMIT_BYTES)
            .read_to_end(&mut bytes)
            .is_err()
        {
            return String::new();
        }
        let _ = std::io::copy(&mut stderr, &mut std::io::sink());
        decode_captured_stderr(&bytes)
    })
}

fn finish_stderr_reader(reader: JoinHandle<String>) -> String {
    let started = Instant::now();
    while !reader.is_finished() {
        if started.elapsed() >= WORKER_JOIN_TIMEOUT {
            return String::new();
        }
        thread::sleep(Duration::from_millis(10));
    }
    reader.join().unwrap_or_default()
}

// No BOM on purpose — see the WHY at the clip.exe callsite: clip.exe
// copies a leading FF FE into the clipboard as a literal U+FEFF instead
// of consuming it as an encoding marker.
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
        .manage(CloseGuard::new())
        .invoke_handler(tauri::generate_handler![
            copy_xml_to_clipboard,
            show_main_window,
            register_close_guard,
            unregister_close_guard,
            set_has_unsaved_work,
            ack_close_requested,
            confirm_close_window
        ])
        .on_page_load(|webview, payload| {
            if webview.label() == "main" && matches!(payload.event(), PageLoadEvent::Started) {
                webview.state::<CloseGuard>().reset_for_navigation();
            }
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                let close_guard = window.state::<CloseGuard>();
                if close_guard.intercept_close() {
                    api.prevent_close();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
        })
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
                    if scale_factor.is_finite() && scale_factor > 0.0 {
                        let work_area = monitor.work_area();
                        let work_area_size = work_area.size.to_logical::<f64>(scale_factor);
                        let launch_size = launch_window_size_for_work_area(work_area_size);
                        match window.set_size(Size::Logical(launch_size)) {
                            Ok(()) => log_startup(timing.inner(), "work-area-derived size applied"),
                            Err(error) => log_startup(
                                timing.inner(),
                                &format!(
                                    "work-area-derived size failed; using config size: {error}"
                                ),
                            ),
                        }
                        if let Ok(outer_size) = window.outer_size() {
                            let target_pos = centered_window_position_in_work_area(
                                work_area.position,
                                work_area.size,
                                outer_size,
                            );
                            match window.set_position(Position::Physical(target_pos)) {
                                Ok(()) => log_startup(timing.inner(), "window centered"),
                                Err(error) => log_startup(
                                    timing.inner(),
                                    &format!(
                                        "window center failed; continuing uncentered: {error}"
                                    ),
                                ),
                            }
                        } else if let Err(error) = window.center() {
                            log_startup(
                                timing.inner(),
                                &format!("window center failed; continuing uncentered: {error}"),
                            );
                        }
                    } else {
                        log_startup(
                            timing.inner(),
                            "invalid monitor scale factor; using config size",
                        );
                        let _ = window.center();
                    }
                } else {
                    log_startup(timing.inner(), "monitor unavailable; using config size");
                    let _ = window.center();
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
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {});
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::sync::Arc;

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
    fn launch_size_handles_sub_minimum_zero_and_non_finite_work_areas() {
        for degenerate in [
            LogicalSize::new(500.0, 400.0),
            LogicalSize::new(0.0, 0.0),
            LogicalSize::new(-100.0, -50.0),
            LogicalSize::new(f64::NAN, f64::INFINITY),
        ] {
            let size = launch_window_size_for_work_area(degenerate);
            assert_size_close(size, CONFIG_MIN_WINDOW_WIDTH, CONFIG_MIN_WINDOW_HEIGHT);
        }
    }

    #[test]
    fn centered_window_position_keeps_title_bar_on_screen_for_compact_high_dpi_work_areas() {
        // Normal desktop: centered symmetrically inside work area.
        let pos = centered_window_position_in_work_area(
            PhysicalPosition::new(0, 40),
            PhysicalSize::new(1920, 1040),
            PhysicalSize::new(1520, 840),
        );
        assert_eq!(pos, PhysicalPosition::new(200, 140));

        // 1366x768 @ 150% DPI or 1920x1080 @ 200% DPI where outer height exceeds
        // the work-area height: y must clamp to work_area.top (never negative).
        let compact = centered_window_position_in_work_area(
            PhysicalPosition::new(-1920, 36),
            PhysicalSize::new(1366, 720),
            PhysicalSize::new(1080, 837),
        );
        assert_eq!(compact, PhysicalPosition::new(-1777, 36));
    }

    #[test]
    fn launch_size_clamps_each_axis_independently() {
        // Ultrawide: width hits the desktop cap while height stays on the
        // sqrt(2/3) path — pins that the clamps are per-axis, not coupled.
        let size = launch_window_size_for_work_area(LogicalSize::new(2200.0, 1000.0));

        assert_size_close(size, MAX_LAUNCH_WINDOW_WIDTH, 816.4966);
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
        // rendering: one byte over the limit must display OVER it
        // (50.1, not a contradictory "50.0 MB; limit 50 MB").
        assert_eq!(
            error,
            "XML payload too large to copy (50.1 MB; limit 50 MB)."
        );
    }

    #[test]
    fn format_megabytes_rounds_up_to_next_tenth() {
        // Ceil direction, mirrored by helpers.test.ts on the JS side.
        assert_eq!(format_megabytes(50_000_000), "50 MB");
        assert_eq!(format_megabytes(50_000_001), "50.1 MB");
        // 1.44 MB → 1.5: distinguishes ceil from round-to-nearest.
        assert_eq!(format_megabytes(1_440_000), "1.5 MB");
        assert_eq!(format_megabytes(1), "0.1 MB");
        assert_eq!(format_megabytes(0), "0 MB");
    }

    // Boundary pair for the NUL gate, symmetric with the size-gate pair
    // above — the other IPC-boundary guard with the same
    // silent-corruption rationale.
    #[test]
    fn nul_payload_is_rejected() {
        assert!(check_no_nul("a\0b").is_err());
    }

    #[test]
    fn nul_free_payload_passes() {
        assert!(check_no_nul("a中🦀").is_ok());
    }

    #[test]
    fn startup_timing_marks_shown_only_after_success_marker() {
        let timing = StartupTiming::new();
        assert!(!timing.is_main_window_shown());

        timing.mark_main_window_shown();
        assert!(timing.is_main_window_shown());
    }

    #[test]
    fn close_guard_allows_immediate_close_when_clean_and_intercepts_when_dirty() {
        let guard = CloseGuard::new();
        let delivered = Arc::new(AtomicUsize::new(0));
        let delivered_clone = Arc::clone(&delivered);
        let channel = tauri::ipc::Channel::new(move |_| {
            delivered_clone.fetch_add(1, Ordering::SeqCst);
            Ok(())
        });

        assert!(!guard.intercept_close());

        guard.set_has_unsaved_work(1, true);
        // Without a registered frontend channel, intercept_close returns false
        // so an unmounted/broken frontend never traps the window open.
        assert!(!guard.intercept_close());

        guard.register_listener(1, channel);
        let now = Instant::now();
        assert!(guard.intercept_close_at(now));
        assert_eq!(delivered.load(Ordering::SeqCst), 1);

        // Frontend acknowledges delivery; subsequent close requests continue
        // intercepting until confirmed or cleaned.
        guard.ack_close_requested();
        assert!(guard.intercept_close_at(now + Duration::from_secs(5)));
        assert_eq!(delivered.load(Ordering::SeqCst), 2);

        guard.mark_close_confirmed();
        assert!(!guard.intercept_close());

        guard.clear_close_confirmed();
        assert!(guard.intercept_close());

        guard.set_has_unsaved_work(2, false);
        assert!(!guard.intercept_close());
    }

    #[test]
    fn close_guard_fails_open_on_channel_error_unacked_timeout_or_unmount() {
        let guard = CloseGuard::new();
        guard.set_has_unsaved_work(1, true);

        // 1. Failing channel clears listener and allows close immediately.
        let failing_channel =
            tauri::ipc::Channel::new(|_| Err(tauri::Error::Io(std::io::Error::other("broken"))));
        guard.register_listener(1, failing_channel);
        assert!(!guard.intercept_close());

        // 2. Unacknowledged close request past CLOSE_ACK_TIMEOUT fails open on
        // the user's retry click instead of trapping the window open.
        let silent_channel = tauri::ipc::Channel::new(|_| Ok(()));
        guard.register_listener(2, silent_channel);
        let first_try = Instant::now();
        assert!(guard.intercept_close_at(first_try));
        assert!(!guard.intercept_close_at(first_try + CLOSE_ACK_TIMEOUT));

        // 3. StrictMode / out-of-order unregister does not clobber a newer
        // channel, whereas matching unregister and navigation reset do.
        let first = tauri::ipc::Channel::new(|_| Ok(()));
        let first_id = first.id();
        let second = tauri::ipc::Channel::new(|_| Ok(()));
        let second_id = second.id();
        guard.register_listener(3, first);
        guard.register_listener(4, second);
        guard.unregister_listener(5, first_id);
        assert!(guard.intercept_close_at(first_try));
        guard.ack_close_requested();
        guard.unregister_listener(6, second_id);
        assert!(!guard.intercept_close_at(first_try));

        // 4. Stale sequence numbers are ignored, and navigation resets all state.
        let active = tauri::ipc::Channel::new(|_| Ok(()));
        guard.register_listener(7, active);
        guard.set_has_unsaved_work(0, false);
        assert!(guard.intercept_close_at(first_try));
        guard.reset_for_navigation();
        assert!(!guard.intercept_close_at(first_try));
    }

    #[test]
    fn close_guard_recovers_from_mutex_poison() {
        let guard = Arc::new(CloseGuard::new());
        let poisoned = Arc::clone(&guard);
        assert!(thread::spawn(move || {
            let _lock = poisoned.state.lock().unwrap();
            panic!("simulate panic while holding CloseGuard lock");
        })
        .join()
        .is_err());

        guard.set_has_unsaved_work(1, true);
        assert!(!guard.intercept_close());
    }

    #[test]
    fn trusted_helper_requires_an_existing_absolute_path() {
        let relative = PathBuf::from("relative-helper-name");
        assert!(trusted_helper("relative", &relative).is_err());

        let dir = test_dir();
        let helper = dir.path().join("helper");
        write_test_helper(&helper).expect("write temp helper");

        assert_eq!(
            trusted_helper("helper", &helper).expect("absolute helper exists"),
            helper
        );
    }

    #[test]
    fn trusted_helper_rejects_empty_and_drive_relative_paths() {
        for path in [
            Path::new(""),
            Path::new("C:clip.exe"),
            Path::new(r"\clip.exe"),
        ] {
            let error = trusted_helper("helper", path).expect_err("path must be absolute");
            assert!(error.contains("helper path must be absolute"));
        }
    }

    #[test]
    fn trusted_helper_rejects_an_absolute_but_nonexistent_candidate() {
        let dir = test_dir();
        let missing = dir.path().join("missing-helper");
        let error = trusted_helper("missing", &missing).expect_err("nonexistent must be rejected");
        assert!(error.contains("helper not found at trusted path"));
        assert!(error.contains("missing-helper"));
    }

    #[test]
    fn trusted_helper_rejects_a_directory() {
        let dir = test_dir();
        let error = trusted_helper("directory", dir.path()).expect_err("helper must be a file");
        assert!(error.contains("helper not found at trusted path"));
    }

    fn spawn_sleeper() -> Child {
        use std::os::windows::process::CommandExt;

        // `sort.exe` with a held anonymous stdin pipe blocks directly in
        // ReadFile with zero network sockets and zero child subprocesses.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let sort = windows_system32_helper("sort.exe").expect("resolve Windows sort.exe");
        let mut command = Command::new(sort);
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW);
        command.spawn().expect("spawn sleeper child")
    }

    #[test]
    fn wait_for_child_times_out_and_terminates_a_wedged_helper() {
        let mut child = spawn_sleeper();
        let error = wait_for_child("sleeper", &mut child, Duration::from_millis(100))
            .expect_err("a blocked child must trip a 100 ms timeout");
        assert!(error.contains("timed out"));
        // The kill path must have reaped the child — a still-running or
        // zombie child shows up as Ok(None)/Err here.
        assert!(matches!(child.try_wait(), Ok(Some(_))));
    }

    #[test]
    fn wait_for_child_returns_success_for_a_fast_exit() {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let cmd = windows_system32_helper("cmd.exe").expect("resolve Windows cmd.exe");
        let mut child = Command::new(cmd)
            .args(["/C", "exit 0"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .expect("spawn fast child");

        let status = wait_for_child("fast", &mut child, Duration::from_secs(10))
            .expect("fast child must not time out");
        assert!(status.success());
    }

    #[test]
    fn spawn_and_pipe_writes_payload_through_anonymous_stdin_pipe() {
        let (program, args) = stdin_drain_command();
        match spawn_and_pipe("stdin-drain", &program, &args, b"<xml>hello</xml>".to_vec()) {
            Ok(()) => {}
            Err(error) => panic!("stdin drain helper failed: {error}"),
        }
    }

    #[test]
    fn spawn_and_pipe_rejects_early_zero_exit_when_large_payload_is_not_consumed() {
        let cmd = windows_system32_helper("cmd.exe").expect("resolve Windows cmd.exe");
        let error = spawn_and_pipe(
            "early-zero",
            &cmd,
            &["/C", "exit 0"],
            vec![b'x'; 512 * 1024],
        )
        .expect_err("broken pipe on unconsumed payload must not report success");
        assert!(error.contains("failed to write helper stdin"));
    }

    #[test]
    fn spawn_and_pipe_preserves_primary_stderr_even_when_stdin_breaks_and_caps_chatty_stderr() {
        let cmd = windows_system32_helper("cmd.exe").expect("resolve Windows cmd.exe");

        // Non-zero exit with stderr + >64 KiB unconsumed stdin: primary stderr
        // must survive alongside the secondary stdin write failure.
        let error = spawn_and_pipe(
            "fail-with-stderr",
            &cmd,
            &["/C", "echo clipboard access denied 1>&2 & exit /b 5"],
            vec![b'x'; 256 * 1024],
        )
        .expect_err("non-zero helper exit must fail");
        assert!(
            error.contains("clipboard access denied"),
            "expected stderr in error, got: {error}"
        );

        // Non-zero exit with empty stderr reports exit code explicitly.
        let silent_err = spawn_and_pipe("fail-silent", &cmd, &["/C", "exit /b 7"], Vec::new())
            .expect_err("non-zero helper exit must fail");
        assert!(silent_err.contains("no stderr output"));

        // Chatty stderr (> 4 KiB pipe buffer) must drain without deadlocking
        // and truncate to STDERR_CAPTURE_LIMIT_BYTES.
        let chatty_err = spawn_and_pipe(
            "chatty-stderr",
            &cmd,
            &[
                "/C",
                "for /L %i in (1,1,200) do @echo 0123456789abcdef0123456789abcdef0123456789abcdef 1>&2 & exit /b 3",
            ],
            Vec::new(),
        )
        .expect_err("chatty failing helper must fail promptly");
        assert!(chatty_err.len() <= (STDERR_CAPTURE_LIMIT_BYTES as usize) + 256);

        // Lossy UTF-8 decoding handles non-UTF-8 OEM bytes cleanly.
        assert_eq!(
            decode_captured_stderr(b"  err \xFF\xFE  "),
            "err \u{FFFD}\u{FFFD}"
        );
    }

    fn stdin_drain_command() -> (PathBuf, Vec<&'static str>) {
        (
            windows_system32_helper("cmd.exe").expect("resolve Windows cmd.exe"),
            vec!["/C", "more > NUL"],
        )
    }

    fn test_dir_builder() -> tempfile::Builder<'static, 'static> {
        let mut builder = tempfile::Builder::new();
        builder.prefix("xml-prompt-studio-test-");
        builder
    }

    fn test_dir() -> tempfile::TempDir {
        test_dir_builder()
            .tempdir()
            .expect("create private temp test directory")
    }

    fn write_test_helper(path: &Path) -> std::io::Result<std::fs::File> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        let mut file = options.open(path)?;
        file.write_all(b"test")?;
        Ok(file)
    }

    #[test]
    fn test_fixture_directories_are_isolated_and_cleaned_up() {
        let first = test_dir();
        let second = test_dir();
        let first_path = first.path().to_path_buf();
        let second_path = second.path().to_path_buf();
        assert_ne!(first_path, second_path);
        let helper = second.path().join("helper");
        write_test_helper(&helper).expect("write temp helper");

        drop(first);
        assert!(!first_path.exists());
        assert_eq!(std::fs::read(&helper).unwrap(), b"test");
        assert!(helper.is_file());
        drop(second);
        assert!(!second_path.exists());
    }

    #[test]
    fn test_fixture_directory_collision_preserves_existing_contents() {
        let parent = test_dir();
        let mut builder = test_dir_builder();
        builder.rand_bytes(0);
        let existing = builder.tempdir_in(parent.path()).unwrap();
        let helper = existing.path().join("helper");
        std::fs::write(&helper, b"preserve existing contents").unwrap();

        let error = builder
            .tempdir_in(parent.path())
            .expect_err("an existing directory must never be reused");
        assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(
            std::fs::read(&helper).unwrap(),
            b"preserve existing contents"
        );
    }

    #[test]
    fn test_fixture_writer_preserves_existing_files() {
        let dir = test_dir();
        let sentinel = dir.path().join("sentinel");
        std::fs::write(&sentinel, b"preserve sentinel").unwrap();

        let error =
            write_test_helper(&sentinel).expect_err("existing files must not be overwritten");
        assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(std::fs::read(&sentinel).unwrap(), b"preserve sentinel");
    }

    #[test]
    fn windows_clip_helper_resolves_from_system_directory() {
        let clip = windows_system32_helper("clip.exe").expect("resolve Windows clip.exe");
        assert!(clip.is_absolute());
        assert_eq!(
            clip.file_name().and_then(|name| name.to_str()),
            Some("clip.exe")
        );
    }

    #[test]
    fn utf16le_emits_no_bom() {
        // Empirically verified: clip.exe copies a leading FF FE into the
        // clipboard as a literal U+FEFF instead of consuming it, breaking
        // the preview == clipboard contract. Pin the absence.
        assert_eq!(utf16le("x"), vec![0x78, 0x00]);
    }

    #[test]
    fn utf16le_encodes_ascii_cjk_and_non_bmp_little_endian() {
        // 'A' = 0x0041, '中' = 0x4E2D, '🦀' = U+1F980 → surrogate pair
        // D83E DD80; every code unit must land low-byte-first.
        assert_eq!(
            utf16le("A中🦀"),
            vec![0x41, 0x00, 0x2D, 0x4E, 0x3E, 0xD8, 0x80, 0xDD]
        );
    }

    #[test]
    fn utf16le_round_trips_mixed_content() {
        let original = "<反馈>hello 🦀</反馈>";
        let bytes = utf16le(original);
        let units: Vec<u16> = bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u16::from_le_bytes(*pair))
            .collect();
        assert_eq!(String::from_utf16(&units).unwrap(), original);
    }
}
