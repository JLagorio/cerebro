//! Owned cancellation controls for native action workers, never call authority.
use crate::actions::{
    effect_types::{ConnectionId, InvocationId},
    native_owner::NativeOwnerError,
    native_rules,
};
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, Weak,
    },
};
struct Entry {
    run: String,
    connection: ConnectionId,
    flag: Weak<AtomicBool>,
}
#[derive(Default)]
pub(in crate::actions::native_owner) struct CancellationBook {
    entries: Mutex<BTreeMap<String, Entry>>,
    retired: AtomicBool,
}
pub(in crate::actions::native_owner) struct Registration {
    pub(in crate::actions::native_owner) flag: Arc<AtomicBool>,
    book: Arc<CancellationBook>,
    invocation: String,
}
impl CancellationBook {
    pub(in crate::actions::native_owner) fn register(
        self: &Arc<Self>,
        run: &str,
        connection: &ConnectionId,
        invocation: &InvocationId,
    ) -> Result<Registration, NativeOwnerError> {
        let limit = native_rules::admission_rules().limits.identity_bytes;
        if self.retired.load(Ordering::SeqCst)
            || run.is_empty()
            || run.len() > limit
            || connection.0.is_empty()
            || connection.0.len() > limit
            || invocation.0.len() != 32
            || !invocation
                .0
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(NativeOwnerError::Unavailable);
        }
        let mut entries = self.entries.lock().map_err(|poison| {
            self.retire_locked(&poison.into_inner());
            NativeOwnerError::Unavailable
        })?;
        entries.retain(|_, entry| entry.flag.strong_count() > 0);
        if self.retired.load(Ordering::SeqCst) || entries.contains_key(&invocation.0) {
            return Err(NativeOwnerError::Unavailable);
        }
        let flag = Arc::new(AtomicBool::new(false));
        entries.insert(
            invocation.0.clone(),
            Entry {
                run: run.into(),
                connection: connection.clone(),
                flag: Arc::downgrade(&flag),
            },
        );
        // No registry guard crosses any metadata/current-origin/storage check.
        drop(entries);
        Ok(Registration {
            flag,
            book: self.clone(),
            invocation: invocation.0.clone(),
        })
    }
    #[cfg(test)]
    pub(in crate::actions::native_owner) fn register_fixture(
        self: &Arc<Self>,
        run: &str,
        connection: &ConnectionId,
        invocation: &InvocationId,
    ) -> Result<Registration, NativeOwnerError> {
        self.register(run, connection, invocation)
    }
    fn retire_locked(&self, entries: &BTreeMap<String, Entry>) {
        self.retired.store(true, Ordering::SeqCst);
        for entry in entries.values() {
            if let Some(flag) = entry.flag.upgrade() {
                flag.store(true, Ordering::SeqCst);
            }
        }
    }
    fn cancel_matching(&self, select: impl Fn(&str, &Entry) -> bool) {
        match self.entries.lock() {
            Ok(entries) => {
                for (id, entry) in entries.iter() {
                    if select(id, entry) {
                        if let Some(flag) = entry.flag.upgrade() {
                            flag.store(true, Ordering::SeqCst);
                        }
                    }
                }
            }
            Err(poison) => self.retire_locked(&poison.into_inner()),
        }
    }
    pub(in crate::actions::native_owner) fn cancel_run(&self, run: &str) {
        self.cancel_matching(|_, entry| entry.run == run);
    }
    pub(in crate::actions::native_owner) fn cancel_connection(&self, connection: &ConnectionId) {
        self.cancel_matching(|_, entry| &entry.connection == connection);
    }
    pub(in crate::actions::native_owner) fn cancel_invocation(&self, invocation: &InvocationId) {
        self.cancel_matching(|id, _| id == invocation.0);
    }
    pub(in crate::actions::native_owner) fn stop_all(&self) {
        self.cancel_matching(|_, _| true);
    }
    pub(in crate::actions::native_owner) fn cancel_all(&self) {
        self.retired.store(true, Ordering::SeqCst);
        self.stop_all();
    }
}
impl Registration {
    pub(in crate::actions::native_owner) fn stopped(&self) -> bool {
        self.flag.load(Ordering::SeqCst) || self.book.retired.load(Ordering::SeqCst)
    }
}
impl Drop for Registration {
    fn drop(&mut self) {
        self.flag.store(true, Ordering::SeqCst);
        match self.book.entries.lock() {
            Ok(mut entries) => {
                if entries
                    .get(&self.invocation)
                    .and_then(|entry| entry.flag.upgrade())
                    .is_some_and(|flag| Arc::ptr_eq(&flag, &self.flag))
                {
                    entries.remove(&self.invocation);
                }
            }
            Err(poison) => self.book.retire_locked(&poison.into_inner()),
        }
    }
}
#[cfg(test)]
#[path = "native_action_cancellation_tests.rs"]
mod tests;
