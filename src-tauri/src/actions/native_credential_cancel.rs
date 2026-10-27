//! Private per-original-owner cancellation hints. Final metadata CAS is authority.
use crate::{actions::ids::{AttemptId, ConnectionId}, connections::{ConnectionError, CredentialAcquisition}};
use std::{collections::BTreeMap, sync::{Arc, Weak, Mutex, atomic::{AtomicBool, Ordering}}};
#[derive(Default)]
pub(super) struct CancellationBook { entries: Mutex<BTreeMap<String, Weak<CancellationFlag>>> }
pub(super) struct CancellationFlag { attempt: AttemptId, connection: ConnectionId, stopped: AtomicBool }
impl CancellationFlag { pub(super) fn stopped(&self) -> bool { self.stopped.load(Ordering::Acquire) } }
pub(super) struct CancellationRegistration { book: Arc<CancellationBook>, pub(super) flag: Arc<CancellationFlag> }
impl CancellationBook {
    pub(super) fn register(self: &Arc<Self>, ticket: &CredentialAcquisition) -> Result<CancellationRegistration, ConnectionError> {
        let mut entries = self.entries.lock().map_err(|_| ConnectionError::Unavailable)?;
        entries.retain(|_, flag| flag.strong_count() > 0);
        if entries.get(&ticket.attempt_id.0).and_then(Weak::upgrade).is_some() { return Err(ConnectionError::Unavailable); }
        let flag = Arc::new(CancellationFlag { attempt: ticket.attempt_id.clone(), connection: ticket.connection_id.clone(), stopped: AtomicBool::new(false) });
        entries.insert(ticket.attempt_id.0.clone(), Arc::downgrade(&flag));
        Ok(CancellationRegistration { book: self.clone(), flag })
    }
    fn cancel_matching(&self, selected: impl Fn(&CancellationFlag) -> bool) {
        let mut entries = match self.entries.lock() { Ok(entries) => entries, Err(poisoned) => poisoned.into_inner() };
        entries.retain(|_, weak| {
            let Some(flag) = weak.upgrade() else { return false; };
            if selected(&flag) { flag.stopped.store(true, Ordering::Release); }
            true
        });
    }
    pub(super) fn cancel_attempt(&self, attempt: &AttemptId) { self.cancel_matching(|flag| &flag.attempt == attempt); }
    pub(super) fn cancel_connection(&self, connection: &ConnectionId) { self.cancel_matching(|flag| &flag.connection == connection); }
    pub(super) fn cancel_all(&self) { self.cancel_matching(|_| true); }
}
impl Drop for CancellationRegistration {
    fn drop(&mut self) {
        // Any surviving adapter clone remains cancelled even after pruning.
        self.flag.stopped.store(true, Ordering::Release);
        let mut entries = match self.book.entries.lock() { Ok(entries) => entries, Err(poisoned) => poisoned.into_inner() };
        if entries.get(&self.flag.attempt.0).is_some_and(|entry| entry.ptr_eq(&Arc::downgrade(&self.flag))) {
            entries.remove(&self.flag.attempt.0);
        }
    }
}
#[cfg(test)]
#[path = "native_credential_cancel_tests.rs"]
mod tests;
