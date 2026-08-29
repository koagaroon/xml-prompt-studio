use arboard::Clipboard;
#[cfg(target_os = "windows")]
use std::ffi::OsString;
use std::fs;
use std::io::{Read, Write};
#[cfg(target_os = "windows")]
use std::os::windows::ffi::OsStringExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tauri::{LogicalSize, Manager, Size};

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
const STDIN_WRITER_JOIN_TIMEOUT: Duration = Duration::from_secs(1);

#[cfg(target_os = "windows")]
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
    let tenths = (bytes as f64 / 100_000.0).ceil();
    if tenths % 10.0 == 0.0 {
        format!("{} MB", tenths / 10.0)
    } else {
        format!("{:.1} MB", tenths / 10.0)
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
        // clear_poison makes that recovery one-shot; without it std
        // poisoning is sticky, every later copy would re-enter this arm,
        // and the long-lived-instance design would silently degrade to
        // per-call instances.
        CLIPBOARD.clear_poison();
        let mut guard = poisoned.into_inner();
        *guard = None;
        guard
    });
    if guard.is_none() {
        *guard = Some(Clipboard::new().map_err(|error| error.to_string())?);
    }
    // Unreachable by construction — the block above just guaranteed Some.
    // Kept as a typed fallback (not unwrap/expect) so a future reshuffle
    // of the init block degrades to a visible error, not a panic.
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

// Serializes the whole copy operation, native fallback included. The
// arboard path is already serialized by CLIPBOARD's mutex, but the
// fallback child processes (clip.exe / pbcopy / wl-copy / xclip) were
// not: two concurrent invocations that both fall back would race two
// children, both report success, and the clipboard would keep whichever
// wrote last — possibly the OLDER payload under a success report. The
// frontend's copyInFlight guard already prevents concurrency in
// practice; this lock makes the Rust IPC boundary self-sufficient,
// consistent with the NUL / size guards deliberately duplicated on both
// sides.
static COPY_LOCK: Mutex<()> = Mutex::new(());

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
    // Lock data is (), so poison carries no state worth respecting —
    // recover unconditionally.
    let _copy_guard = COPY_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
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
        let clip = windows_system32_helper("clip.exe")?;
        return spawn_and_pipe("clip.exe", &clip, &[], utf16le(xml), true)
            .map_err(HelperRunError::into_message);
    }
    #[cfg(target_os = "macos")]
    {
        // pbcopy chooses its stdin encoding from locale variables. The
        // command wrapper below forces LC_CTYPE to a UTF-8 locale so a GUI
        // launch without Terminal's locale cannot silently garble XML.
        let pbcopy = trusted_helper("pbcopy", &["/usr/bin/pbcopy"])?;
        return spawn_and_pipe("pbcopy", &pbcopy, &[], xml.as_bytes().to_vec(), true)
            .map_err(HelperRunError::into_message);
    }
    #[cfg(target_os = "linux")]
    {
        // Try Wayland's wl-copy first (modern), fall back to X11's xclip
        // (legacy). Use package-managed system locations only; either helper
        // may be missing depending on the distro / session type. If both fail,
        // chain the errors (mirrors the arboard→native
        // chaining above) so the user sees the full failure trail when
        // diagnosing "why doesn't Copy work on this Linux session?". The
        // inner errors already carry their own tool prefixes — no extra
        // wrapping here, or the chain reads "wl-copy: wl-copy: …".
        //
        // spawn_linux_helper iterates candidates: a stat-passing but
        // unspawnable binary at a trusted path (stale FHS compat shim,
        // wrong architecture) advances to the next candidate instead of
        // masking the next trusted absolute candidate that exists for
        // exactly that case.
        let wl_err = match spawn_linux_helper(
            "wl-copy",
            &["/usr/bin/wl-copy", "/bin/wl-copy"],
            &[],
            xml.as_bytes(),
        ) {
            Ok(()) => return Ok(()),
            Err(err) => err,
        };
        return spawn_linux_helper(
            "xclip",
            &["/usr/bin/xclip", "/bin/xclip"],
            &["-selection", "clipboard"],
            xml.as_bytes(),
        )
        .map_err(|xclip_err| format!("{wl_err}; {xclip_err}"));
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = xml; // silence unused-variable warning on unsupported OSes
        return Err("Clipboard fallback not implemented for this operating system.".to_string());
    }
}

#[cfg(target_os = "windows")]
fn windows_system32_helper(exe_name: &str) -> Result<PathBuf, String> {
    let candidate = windows_system_directory()?.join(exe_name);
    trusted_helper(exe_name, &[candidate])
}

#[cfg(target_os = "windows")]
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

fn trusted_helper<I, P>(name: &str, candidates: I) -> Result<PathBuf, String>
where
    I: IntoIterator<Item = P>,
    P: AsRef<Path>,
{
    trusted_helper_candidates(name, candidates).map(|mut candidates| candidates.remove(0))
}

fn trusted_helper_candidates<I, P>(name: &str, candidates: I) -> Result<Vec<PathBuf>, String>
where
    I: IntoIterator<Item = P>,
    P: AsRef<Path>,
{
    let mut checked = Vec::new();
    let mut skipped = Vec::new();
    let mut seen = Vec::new();
    let mut usable = Vec::new();

    for candidate in candidates {
        let path = candidate.as_ref();
        if !path.is_absolute() {
            skipped.push(display_candidate_path(path));
            continue;
        }
        checked.push(path.display().to_string());
        if helper_is_usable(path) {
            push_unique_canonical(path, &mut seen, &mut usable);
        }
    }

    if !usable.is_empty() {
        return Ok(usable);
    }

    let checked_text = if checked.is_empty() {
        "none".to_string()
    } else {
        checked.join(", ")
    };
    let skipped_text = if skipped.is_empty() {
        String::new()
    } else {
        format!("; skipped non-absolute candidates: {}", skipped.join(", "))
    };
    Err(format!(
        "{name}: helper not found in trusted locations: {checked_text}{skipped_text}"
    ))
}

fn push_unique_canonical(path: &Path, seen: &mut Vec<PathBuf>, candidates: &mut Vec<PathBuf>) {
    let canonical = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    if !seen.contains(&canonical) {
        seen.push(canonical);
        candidates.push(path.to_path_buf());
    }
}

fn display_candidate_path(path: &Path) -> String {
    if path.as_os_str().is_empty() {
        "<empty>".to_string()
    } else {
        path.display().to_string()
    }
}

// Ordered candidate list for a Linux clipboard helper: trusted absolute
// helper locations only. We deliberately do not consult inherited PATH:
// absolute PATH entries can still be user-writable or launch-controlled,
// and spawning from them reintroduces helper hijack risk.
#[cfg(any(target_os = "linux", test))]
#[cfg_attr(test, allow(dead_code))]
fn linux_helper_candidates(
    name: &str,
    trusted_candidates: &[&str],
) -> Result<Vec<PathBuf>, String> {
    trusted_helper_candidates(name, trusted_candidates)
}

// Spawn a Linux clipboard helper, advancing through the candidate list
// ONLY on spawn failure (the binary never started) — a helper that ran
// and answered, or a candidate-independent environment failure, is
// authoritative and stops the iteration; retrying a different copy of a
// tool that already executed would re-run identical binaries and
// multiply the 10 s timeout bound. capture_stderr is hardcoded FALSE:
// wl-copy and xclip fork a background process that inherits the stderr
// handle and keeps it open while serving the selection — only the
// foreground parent's exit code is a reliable signal (see
// spawn_and_pipe's doc).
#[cfg(any(target_os = "linux", test))]
#[cfg_attr(test, allow(dead_code))]
fn spawn_linux_helper(
    name: &str,
    trusted_candidates: &[&str],
    args: &[&str],
    payload: &[u8],
) -> Result<(), String> {
    let candidates = linux_helper_candidates(name, trusted_candidates)?;
    let mut errors: Vec<String> = Vec::new();
    for candidate in &candidates {
        match spawn_and_pipe(name, candidate, args, payload.to_vec(), false) {
            Ok(()) => return Ok(()),
            Err(HelperRunError::Spawn(message)) => errors.push(message),
            Err(HelperRunError::Ran(message)) => {
                errors.push(message);
                break;
            }
        }
    }
    Err(errors.join("; "))
}

fn helper_is_usable(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        return match fs::metadata(path) {
            Ok(metadata) => metadata.permissions().mode() & 0o111 != 0,
            Err(_) => false,
        };
    }
    #[cfg(not(unix))]
    {
        true
    }
}

// Two-class error for one helper run, so the Linux candidate iterator
// can tell "the binary never started — try the next candidate" apart
// from "the helper executed and answered — that answer is
// authoritative". Only a spawn failure justifies advancing: retrying a
// DIFFERENT copy of a tool that already ran and failed (or timed out)
// re-runs identical binaries and multiplies the documented 10 s timeout
// bound across candidates.
enum HelperRunError {
    // The binary could not start (missing, EACCES, wrong architecture).
    Spawn(String),
    // The helper executed (non-zero exit, timeout) — or the environment
    // failed in a candidate-independent way (temp-file plumbing).
    Ran(String),
}

impl HelperRunError {
    fn into_message(self) -> String {
        match self {
            HelperRunError::Spawn(message) | HelperRunError::Ran(message) => message,
        }
    }
}

// Shared helper for "spawn a command with payload on stdin, surface
// success/failure as a two-class HelperRunError". The payload is written
// through an anonymous pipe on a writer thread, never through a named
// temp path. The writer is checked after the child settles so a helper
// that exits before consuming the full payload cannot be reported as a
// successful clipboard write.
//
// `capture_stderr: false` is for tools that may fork a background
// process inheriting stderr (wl-copy / xclip). Tools that run to
// completion (clip.exe / pbcopy) pass true and keep bounded stderr in
// the error message.
fn spawn_and_pipe(
    cmd: &str,
    program: &Path,
    args: &[&str],
    payload: Vec<u8>,
    capture_stderr: bool,
) -> Result<(), HelperRunError> {
    let stderr_stdio = if capture_stderr {
        Stdio::piped()
    } else {
        Stdio::null()
    };
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(stderr_stdio);
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
    #[cfg(target_os = "macos")]
    if cmd == "pbcopy" {
        // LOAD-BEARING gate on the `cmd` label: pbcopy picks its stdin
        // encoding from locale variables, and a GUI launch has none —
        // without this forcing, non-ASCII payloads silently garble.
        // Renaming the "pbcopy" label at the callsite would silently
        // drop this fix; the label is a behavior key, not just an error
        // prefix.
        command.env_remove("LC_ALL").env("LC_CTYPE", "en_US.UTF-8");
    }
    let mut child = command
        .spawn()
        .map_err(|error| HelperRunError::Spawn(format!("{cmd}: {}: {error}", program.display())))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| HelperRunError::Ran(format!("{cmd}: child stdin pipe unavailable")))?;
    let writer = spawn_stdin_writer(cmd.to_string(), stdin, payload);

    // Post-spawn errors name the resolved program path: with several
    // candidates per tool, a bare "{cmd}: exited with …" chain would
    // repeat unattributably.
    let label = format!("{cmd} ({})", program.display());

    let status = match wait_for_child(&label, &mut child, FALLBACK_HELPER_TIMEOUT) {
        Ok(status) => status,
        Err(error) => {
            let writer_error = finish_stdin_writer(&label, writer).err();
            let stderr = read_child_stderr(&mut child);
            return Err(HelperRunError::Ran(format_helper_run_error(
                error,
                stderr,
                writer_error,
            )));
        }
    };
    let writer_error = finish_stdin_writer(&label, writer).err();
    if status.success() && writer_error.is_none() {
        return Ok(());
    }
    if let Some(error) = writer_error {
        return Err(HelperRunError::Ran(error));
    }

    // Every error arm carries the `{cmd}:` prefix so the chained
    // "arboard: X; fallback: Y" message names which tool produced Y.
    // The front-end routes a rejected copy IPC into its message strip
    // (showError → stripMessage), so the text must never be empty.
    let stderr = read_child_stderr(&mut child);
    Err(HelperRunError::Ran(if stderr.is_empty() {
        if capture_stderr {
            format!("{label}: exited with {status} and no stderr output.")
        } else {
            // stderr is deliberately not captured on this arm (see the
            // doc above) — say so rather than implying the tool was
            // silent.
            format!("{label}: exited with {status} (stderr not captured for this tool).")
        }
    } else {
        format!("{label}: {stderr}")
    }))
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
        Ok(())
    })
}

fn finish_stdin_writer(label: &str, writer: JoinHandle<Result<(), String>>) -> Result<(), String> {
    let started = Instant::now();
    while !writer.is_finished() {
        if started.elapsed() >= STDIN_WRITER_JOIN_TIMEOUT {
            return Err(format!(
                "{label}: stdin writer did not finish after {} seconds",
                STDIN_WRITER_JOIN_TIMEOUT.as_secs()
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
                    // poll (≤ 25 ms) — on Unix the signal lands on a
                    // zombie harmlessly and wait() still returns the
                    // real status. A genuine success means the clipboard
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

// Read back (a bounded head of) a stderr pipe after the child settled.
// Decoding caveat (Windows-specific but harmless elsewhere): on Chinese
// Windows the OEM codepage is CP936/GBK, not UTF-8, so
// `from_utf8_lossy` may replace non-UTF-8 bytes with U+FFFD. Acceptable
// for this rare failure path. Don't "simplify" this away.
fn read_child_stderr(child: &mut Child) -> String {
    let Some(stderr) = child.stderr.take() else {
        return String::new();
    };
    let mut bytes = Vec::new();
    let mut limited = stderr.take(STDERR_CAPTURE_LIMIT_BYTES);
    if limited.read_to_end(&mut bytes).is_err() {
        return String::new();
    }
    String::from_utf8_lossy(&bytes).trim().to_string()
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
    fn trusted_helper_requires_an_existing_absolute_path() {
        let relative = PathBuf::from("relative-helper-name");
        assert!(trusted_helper("relative", [&relative]).is_err());

        let dir = std::env::temp_dir().join(format!(
            "xml-prompt-studio-helper-test-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("create temp helper dir");
        let helper = dir.join("helper");
        write_test_helper(&helper);

        assert_eq!(
            trusted_helper("helper", [&helper]).expect("absolute helper exists"),
            helper
        );

        std::fs::remove_dir_all(&dir).expect("clean temp helper dir");
    }

    #[test]
    fn linux_helper_candidates_do_not_discover_unlisted_absolute_helpers() {
        let dir = std::env::temp_dir().join(format!(
            "xml-prompt-studio-path-test-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("create temp helper dir");
        let helper = dir.join("wl-copy");
        write_test_helper(&helper);
        let helper_text = helper.display().to_string();

        let error = linux_helper_candidates("wl-copy", &[])
            .expect_err("unlisted helpers must not be discovered through PATH-style lookup");

        assert!(error.contains("helper not found in trusted locations: none"));
        assert!(!error.contains(&helper_text));

        std::fs::remove_dir_all(&dir).expect("clean temp helper dir");
    }

    #[test]
    fn trusted_helper_rejects_an_absolute_but_nonexistent_candidate() {
        // Negative pin for "existing": without it, dropping the
        // helper_is_usable check would pass the whole suite.
        let missing = std::env::temp_dir().join("xml-prompt-studio-definitely-missing-helper");
        let error =
            trusted_helper("missing", [&missing]).expect_err("nonexistent must be rejected");
        assert!(error.contains("helper not found in trusted locations"));
        assert!(error.contains("xml-prompt-studio-definitely-missing-helper"));
    }

    #[test]
    fn linux_helper_candidates_lists_usable_trusted_candidates_in_order() {
        let dir = std::env::temp_dir().join(format!(
            "xml-prompt-studio-candidates-test-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("create temp candidates dir");
        let first = dir.join("first-helper");
        let second = dir.join("second-helper");
        write_test_helper(&first);
        write_test_helper(&second);
        let first_str = first.to_str().expect("temp path is utf-8");
        let second_str = second.to_str().expect("temp path is utf-8");

        // The result is EXACTLY the trusted hits, in declaration order —
        // no [..2] slicing that would also blind the assert to duplicates.
        let candidates =
            linux_helper_candidates("xml-prompt-studio-no-such-helper", &[first_str, second_str])
                .expect("both trusted candidates are usable");
        assert_eq!(candidates, vec![first.clone(), second.clone()]);

        std::fs::remove_dir_all(&dir).expect("clean temp candidates dir");
    }

    #[test]
    fn linux_helper_candidates_dedup_collapses_aliased_candidates() {
        // Pins the canonical-path dedup (usrmerge /bin → /usr/bin class).
        // Literal duplicates exercise the same `seen` mechanism without
        // needing symlink privileges on Windows.
        let dir = std::env::temp_dir().join(format!(
            "xml-prompt-studio-dedup-test-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dedup dir");
        let helper = dir.join("dup-helper");
        write_test_helper(&helper);
        let helper_str = helper.to_str().expect("temp path is utf-8");

        let candidates = linux_helper_candidates("dup-helper", &[helper_str, helper_str])
            .expect("the deduped candidate is usable");
        assert_eq!(candidates, vec![helper.clone()]);

        std::fs::remove_dir_all(&dir).expect("clean temp dedup dir");
    }

    // Cross-platform coverage for the contributed process-management
    // core: the timeout/kill path and the normal fast-exit path.
    fn spawn_sleeper() -> Child {
        #[cfg(target_os = "windows")]
        {
            // `ping -n 6` ≈ 5 s of runtime, no shell needed.
            Command::new("ping")
                .args(["-n", "6", "127.0.0.1"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("spawn sleeper child")
        }
        #[cfg(not(target_os = "windows"))]
        {
            Command::new("sleep")
                .arg("5")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("spawn sleeper child")
        }
    }

    #[test]
    fn wait_for_child_times_out_and_terminates_a_wedged_helper() {
        let mut child = spawn_sleeper();
        let error = wait_for_child("sleeper", &mut child, Duration::from_millis(100))
            .expect_err("a 5 s child must trip a 100 ms timeout");
        assert!(error.contains("timed out"));
        // The kill path must have reaped the child — a still-running or
        // zombie child shows up as Ok(None)/Err here.
        assert!(matches!(child.try_wait(), Ok(Some(_))));
    }

    #[test]
    fn wait_for_child_returns_success_for_a_fast_exit() {
        #[cfg(target_os = "windows")]
        let mut child = Command::new("cmd")
            .args(["/C", "exit 0"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn fast child");
        #[cfg(not(target_os = "windows"))]
        let mut child = Command::new("true")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn fast child");

        let status = wait_for_child("fast", &mut child, Duration::from_secs(10))
            .expect("fast child must not time out");
        assert!(status.success());
    }

    #[test]
    fn spawn_and_pipe_writes_payload_through_anonymous_stdin_pipe() {
        let (program, args) = stdin_drain_command();
        match spawn_and_pipe(
            "stdin-drain",
            &program,
            &args,
            b"<xml>hello</xml>".to_vec(),
            false,
        ) {
            Ok(()) => {}
            Err(error) => panic!("stdin drain helper failed: {}", error.into_message()),
        }
    }

    fn stdin_drain_command() -> (PathBuf, Vec<&'static str>) {
        #[cfg(target_os = "windows")]
        {
            (
                windows_system32_helper("cmd.exe").expect("resolve Windows cmd.exe"),
                vec!["/C", "more > NUL"],
            )
        }
        #[cfg(not(target_os = "windows"))]
        {
            (
                trusted_helper("cat", &["/bin/cat", "/usr/bin/cat"])
                    .expect("resolve stdin-draining cat helper"),
                vec![],
            )
        }
    }

    // Landed-defense contract pin (Unix-only semantics): helper_is_usable's
    // exec-bit requirement could otherwise loosen silently with the suite green.
    #[cfg(unix)]
    #[test]
    fn helper_is_usable_rejects_a_file_without_an_exec_bit() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!(
            "xml-prompt-studio-exec-test-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("create temp exec-test dir");
        let helper = dir.join("helper");
        std::fs::write(&helper, b"data").expect("write non-executable helper");
        let mut permissions = std::fs::metadata(&helper)
            .expect("read helper metadata")
            .permissions();
        permissions.set_mode(0o600);
        std::fs::set_permissions(&helper, permissions).expect("strip exec bits");

        assert!(!helper_is_usable(&helper));

        std::fs::remove_dir_all(&dir).expect("clean temp exec-test dir");
    }

    fn write_test_helper(path: &Path) {
        std::fs::write(path, b"test").expect("write temp helper file");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = std::fs::metadata(path)
                .expect("read temp helper metadata")
                .permissions();
            permissions.set_mode(0o700);
            std::fs::set_permissions(path, permissions).expect("mark temp helper executable");
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_clip_helper_resolves_from_system_directory() {
        let clip = windows_system32_helper("clip.exe").expect("resolve Windows clip.exe");
        assert!(clip.is_absolute());
        assert_eq!(
            clip.file_name().and_then(|name| name.to_str()),
            Some("clip.exe")
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
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u16::from_le_bytes(*pair))
            .collect();
        assert_eq!(String::from_utf16(&units).unwrap(), original);
    }
}
