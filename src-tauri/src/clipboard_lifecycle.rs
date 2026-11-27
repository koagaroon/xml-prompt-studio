use std::sync::{Mutex, MutexGuard};

pub(crate) struct ClipboardLifecycle {
    copy_lock: Mutex<()>,
}

impl ClipboardLifecycle {
    pub(crate) const fn new() -> Self {
        Self {
            copy_lock: Mutex::new(()),
        }
    }

    pub(crate) fn lock_copy(&self) -> MutexGuard<'_, ()> {
        self.copy_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Barrier};
    use std::thread;
    use std::time::Duration;

    #[test]
    fn copy_mutex_serializes_concurrent_writers() {
        let lifecycle = Arc::new(ClipboardLifecycle::new());
        let active_writers = Arc::new(AtomicUsize::new(0));
        let max_concurrent = Arc::new(AtomicUsize::new(0));
        let start = Arc::new(Barrier::new(2));

        let handles: Vec<_> = (0..2)
            .map(|_| {
                let lifecycle = Arc::clone(&lifecycle);
                let active_writers = Arc::clone(&active_writers);
                let max_concurrent = Arc::clone(&max_concurrent);
                let start = Arc::clone(&start);
                thread::spawn(move || {
                    start.wait();
                    let _guard = lifecycle.lock_copy();
                    let now_active = active_writers.fetch_add(1, Ordering::SeqCst) + 1;
                    max_concurrent.fetch_max(now_active, Ordering::SeqCst);
                    thread::sleep(Duration::from_millis(20));
                    active_writers.fetch_sub(1, Ordering::SeqCst);
                })
            })
            .collect();

        for handle in handles {
            handle.join().expect("writer thread panicked");
        }
        assert_eq!(max_concurrent.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn copy_mutex_poison_does_not_prevent_later_copies() {
        let lifecycle = Arc::new(ClipboardLifecycle::new());
        let failed_copy = Arc::clone(&lifecycle);
        assert!(thread::spawn(move || {
            let _copy = failed_copy.lock_copy();
            panic!("simulate a panicking copy");
        })
        .join()
        .is_err());
        drop(lifecycle.lock_copy());
    }
}
