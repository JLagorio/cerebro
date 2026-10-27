//! Fixed native import bundle. No IPC field selects a backend or authority.
use super::{NativeOwnerState, credential_cancel::CancellationRegistration};
use crate::connections::{ConnectionError, CredentialAcquisition};
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
static OCCUPIED: AtomicBool = AtomicBool::new(false);
struct Permit;
impl Permit {
    fn acquire() -> Result<Self, ConnectionError> {
        OCCUPIED.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| Self).map_err(|_| ConnectionError::Unavailable)
    }
}
impl Drop for Permit { fn drop(&mut self) { OCCUPIED.store(false, Ordering::Release); } }

pub(super) fn run(
    owner: &Arc<NativeOwnerState>, ticket: &CredentialAcquisition,
    registration: &CancellationRegistration,
    #[cfg(test)] fixture: Option<super::native_account_worker_fixture::CredentialImportFixture>,
) -> Result<(), ConnectionError> {
    if registration.flag.stopped() || !owner.registration.live.load(Ordering::SeqCst) {
        return Err(ConnectionError::Cancelled);
    }
    #[cfg(test)]
    {
        // The worker captures this explicit test boundary at creation. Absent
        // injection refuses; no ordinary test can consult installed gh/accounts.
        // This entire block is absent from normal/packaged builds.
        let fixture = fixture.ok_or(ConnectionError::Unavailable)?;
        let _permit = Permit::acquire()?;
        owner.import_account(ticket, &fixture, &fixture, &fixture).map(|_| ())
    }
    #[cfg(not(test))]
    {
        let _permit = Permit::acquire()?;
        if registration.flag.stopped() || !owner.registration.live.load(Ordering::SeqCst) {
            return Err(ConnectionError::Cancelled);
        }
        let process_flag = registration.flag.clone();
        let process_window = owner.registration.clone();
        let identity_flag = registration.flag.clone();
        let identity_window = owner.registration.clone();
        let process = crate::connections::gh_native::NativeGhProcess::new(move ||
            process_flag.stopped() || !process_window.live.load(Ordering::SeqCst));
        let identity = crate::connections::github_identity::native_reader(move ||
            identity_flag.stopped() || !identity_window.live.load(Ordering::SeqCst));
        let store = crate::connections::secrets::platform_secret_store();
        owner.import_account(ticket, &process, identity.as_ref(), store.as_ref()).map(|_| ())
    }
}
#[cfg(test)]
thread_local! {
    static FIXTURE: std::cell::RefCell<Option<super::native_account_worker_fixture::CredentialImportFixture>> = const { std::cell::RefCell::new(None) };
}
#[cfg(test)]
pub(super) fn fixture() -> Option<super::native_account_worker_fixture::CredentialImportFixture> {
    FIXTURE.with(|slot| slot.borrow().clone())
}
#[cfg(test)]
pub(super) fn with_fixture<T>(fixture: super::native_account_worker_fixture::CredentialImportFixture, work: impl FnOnce() -> T) -> T {
    struct Reset(Option<super::native_account_worker_fixture::CredentialImportFixture>);
    impl Drop for Reset { fn drop(&mut self) { FIXTURE.with(|slot| { slot.replace(self.0.take()); }); } }
    let previous = FIXTURE.with(|slot| slot.replace(Some(fixture)));
    let _reset = Reset(previous);
    work()
}
