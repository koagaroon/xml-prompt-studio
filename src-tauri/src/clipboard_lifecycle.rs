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
    use std::sync::Arc;
    use std::thread;

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
