use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(any(target_os = "linux", test))]
use std::sync::{mpsc, Arc};
use std::sync::{Mutex, MutexGuard};
#[cfg(any(target_os = "linux", test))]
use std::thread;
#[cfg(any(target_os = "linux", test))]
use std::time::Duration;

pub(crate) struct ClipboardLifecycle {
    closing: AtomicBool,
    copy_lock: Mutex<()>,
}

impl ClipboardLifecycle {
    pub(crate) const fn new() -> Self {
        Self {
            closing: AtomicBool::new(false),
            copy_lock: Mutex::new(()),
        }
    }

    pub(crate) fn ensure_open(&self) -> Result<(), String> {
        if self.closing.load(Ordering::Acquire) {
            return Err("The application is closing; clipboard copy is unavailable.".to_string());
        }
        Ok(())
    }

    pub(crate) fn lock_copy(&self) -> Result<MutexGuard<'_, ()>, String> {
        self.ensure_open()?;
        self.lock_admitted_copy()
    }

    fn lock_admitted_copy(&self) -> Result<MutexGuard<'_, ()>, String> {
        let guard = self
            .copy_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        // A copy admitted before shutdown may have waited behind another copy.
        self.ensure_open()?;
        Ok(guard)
    }

    #[cfg(any(target_os = "linux", test))]
    pub(crate) fn shutdown(
        self: &Arc<Self>,
        timeout: Duration,
        cleanup: impl FnOnce() + Send + 'static,
    ) -> Result<(), String> {
        if self.closing.swap(true, Ordering::AcqRel) {
            return Ok(());
        }

        let lifecycle = Arc::clone(self);
        let (completed_tx, completed_rx) = mpsc::sync_channel(1);
        thread::Builder::new()
            .name("clipboard-shutdown".to_string())
            .spawn(move || {
                {
                    let _copy_guard = lifecycle
                        .copy_lock
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    cleanup();
                }
                let _ = completed_tx.send(());
            })
            .map_err(|error| format!("Could not start clipboard cleanup: {error}"))?;

        match completed_rx.recv_timeout(timeout) {
            Ok(()) => Ok(()),
            Err(mpsc::RecvTimeoutError::Timeout) => Err(format!(
                "Clipboard cleanup exceeded its {} second exit deadline; clipboard persistence after exit is uncertain.",
                timeout.as_secs_f64()
            )),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                Err("Clipboard cleanup stopped unexpectedly.".to_string())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::time::Instant;

    const TEST_TIMEOUT: Duration = Duration::from_secs(5);

    #[test]
    fn completed_shutdown_releases_once_and_rejects_new_copies() {
        let lifecycle = Arc::new(ClipboardLifecycle::new());
        let cleanup_count = Arc::new(AtomicUsize::new(0));
        let count = Arc::clone(&cleanup_count);
        lifecycle
            .shutdown(TEST_TIMEOUT, move || {
                count.fetch_add(1, Ordering::SeqCst);
            })
            .expect("cleanup completes");

        assert!(lifecycle.ensure_open().is_err());
        assert!(lifecycle.lock_copy().is_err());
        lifecycle
            .shutdown(TEST_TIMEOUT, || panic!("cleanup must not repeat"))
            .expect("repeated shutdown is harmless");
        assert_eq!(cleanup_count.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn queued_copy_is_rejected_after_shutdown_begins() {
        let lifecycle = Arc::new(ClipboardLifecycle::new());
        let active_copy = lifecycle.lock_copy().expect("first copy begins");
        let queued_lifecycle = Arc::clone(&lifecycle);
        let (admitted_tx, admitted_rx) = mpsc::sync_channel(1);
        let queued_copy = thread::spawn(move || {
            // Pause between the same two steps used by lock_copy, making the
            // pre-shutdown admission deterministic without timing sleeps.
            queued_lifecycle
                .ensure_open()
                .expect("queued copy admitted");
            admitted_tx.send(()).expect("report admission");
            queued_lifecycle.lock_admitted_copy().is_err()
        });
        admitted_rx
            .recv_timeout(TEST_TIMEOUT)
            .expect("queued copy reaches lock boundary");

        let (cleaned_tx, cleaned_rx) = mpsc::sync_channel(1);
        let error = lifecycle
            .shutdown(Duration::ZERO, move || {
                cleaned_tx.send(()).expect("report cleanup");
            })
            .expect_err("active copy prevents immediate cleanup");
        assert!(error.contains("exit deadline"));
        assert!(cleaned_rx.try_recv().is_err());
        drop(active_copy);

        assert!(queued_copy.join().expect("queued copy worker completes"));
        cleaned_rx
            .recv_timeout(TEST_TIMEOUT)
            .expect("cleanup follows the active copy");
    }

    #[test]
    fn shutdown_deadline_bounds_a_blocked_cleanup() {
        let lifecycle = Arc::new(ClipboardLifecycle::new());
        let (started_tx, started_rx) = mpsc::sync_channel(1);
        let (release_tx, release_rx) = mpsc::sync_channel(1);
        let (finished_tx, finished_rx) = mpsc::sync_channel(1);
        let timeout = Duration::from_millis(30);
        let started_at = Instant::now();
        let result = lifecycle.shutdown(timeout, move || {
            started_tx.send(()).expect("report cleanup start");
            release_rx.recv().expect("release blocked cleanup");
            finished_tx.send(()).expect("report cleanup finish");
        });
        let elapsed = started_at.elapsed();

        started_rx
            .recv_timeout(TEST_TIMEOUT)
            .expect("cleanup worker starts");
        release_tx.send(()).expect("allow worker to finish");
        finished_rx
            .recv_timeout(TEST_TIMEOUT)
            .expect("cleanup worker finishes");
        assert!(result
            .expect_err("blocked cleanup must time out")
            .contains("exit deadline"));
        assert!(elapsed >= timeout);
        assert!(elapsed < TEST_TIMEOUT, "exit wait must remain bounded");
        assert!(lifecycle.lock_copy().is_err());
    }

    #[test]
    fn copy_mutex_poison_does_not_prevent_cleanup() {
        let lifecycle = Arc::new(ClipboardLifecycle::new());
        let failed_copy = Arc::clone(&lifecycle);
        assert!(thread::spawn(move || {
            let _copy = failed_copy.lock_copy().expect("copy starts");
            panic!("simulate a panicking copy");
        })
        .join()
        .is_err());
        drop(lifecycle.lock_copy().expect("copy lock recovers"));
        lifecycle
            .shutdown(TEST_TIMEOUT, || {})
            .expect("cleanup also recovers the copy lock");
    }
}
