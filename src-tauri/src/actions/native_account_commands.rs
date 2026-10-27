//! Original-owner worker and its public command handoff.
//! The admitted macOS worker owns the fixed credential bundle; injected adapters stay test/fixture-only.
use super::{authenticate, NativeOwnerState};
#[cfg(all(any(test, feature = "native-credential-smoke"), target_os = "macos"))]
use crate::connections::{
    gh_credentials::{GhProcess, IdentityReader},
    secrets::SecretStore,
};
use crate::{
    actions::ids::AttemptId,
    connections::{
        metadata::CredentialAcquisitionView, AcquisitionState, ConnectionError,
        CredentialAcquisition, GhSelection,
    },
};
#[cfg(any(all(test, target_os = "macos"), feature = "native-credential-smoke"))]
use std::sync::mpsc::Receiver;
use std::{
    sync::{
        mpsc::{self, SyncSender},
        Arc,
    },
    thread::JoinHandle,
    time::Duration,
};
use tauri::{AppHandle, WebviewWindow};

#[cfg(all(test, target_os = "macos"))]
#[path = "native_credential_handoff_probe.rs"]
pub(super) mod handoff_probe;

fn launch<T: Send + 'static>(
    name: &str,
    work: impl FnOnce() -> T + Send + 'static,
) -> std::io::Result<JoinHandle<T>> {
    #[cfg(all(test, target_os = "macos"))]
    if handoff_probe::reject_launch(name) {
        return Err(std::io::Error::other(
            "injected credential task launch refusal",
        ));
    }
    std::thread::Builder::new().name(name.into()).spawn(work)
}

// The owned work runs once after the original Pending commit and after all
// native/runtime/SQLite guards are released. Future native adapters can supply
// this same private bundle; no wire value selects or constructs one.
enum CredentialWork {
    #[cfg(feature = "native-credential-smoke")]
    Unavailable,
    #[cfg(target_os = "macos")]
    NativeImport,
    #[cfg(not(target_os = "macos"))]
    Unsupported,
    #[cfg(all(any(test, feature = "native-credential-smoke"), target_os = "macos"))]
    Import {
        process: Box<dyn GhProcess + Send>,
        identity: Box<dyn IdentityReader + Send>,
        store: Box<dyn SecretStore + Send>,
    },
}

enum WorkRelease {
    Run,
    FailUnavailable,
}

/// A one-shot native acquisition task. No person/owner/completion ticket or gate can
/// be serialized or chosen by a web request. Manually held fixture workers join on Drop;
/// a failed public handoff leaves terminalization with the already-owned worker thread.
pub(crate) struct CredentialWorker {
    release: SyncSender<WorkRelease>,
    #[cfg(any(all(test, target_os = "macos"), feature = "native-credential-smoke"))]
    parked: Receiver<()>,
    handle: Option<JoinHandle<Result<CredentialAcquisitionView, ConnectionError>>>,
    join_on_drop: bool,
}
impl CredentialWorker {
    fn start(
        owner: Arc<NativeOwnerState>,
        ticket: CredentialAcquisition,
        work: CredentialWork,
    ) -> Result<Self, ConnectionError> {
        let (release, wait) = mpsc::sync_channel(1);
        #[cfg(any(all(test, target_os = "macos"), feature = "native-credential-smoke"))]
        let (signal, parked) = mpsc::sync_channel(1);
        #[cfg(all(test, target_os = "macos"))]
        let native_fixture = super::native_credential_bundle::fixture();
        let original_owner = owner.clone();
        let original_ticket = ticket.clone();
        #[cfg(all(test, target_os = "macos"))]
        let worker_probe = handoff_probe::current();
        let started = launch("credential-acquisition", move || {
            let completion = (|| {
                // The original Arc/ticket are retained, but no native/runtime/SQLite
                // guard is held while the native-only harness gate waits.
                #[cfg(any(all(test, target_os = "macos"), feature = "native-credential-smoke"))]
                let _ = signal.try_send(());
                let run = matches!(
                    wait.recv_timeout(Duration::from_secs(15)),
                    Ok(WorkRelease::Run)
                );
                let result = if run {
                    match work {
                        #[cfg(not(target_os = "macos"))]
                        CredentialWork::Unsupported => original_owner.acquisition_failed(&original_ticket, ConnectionError::Unsupported),
                        #[cfg(target_os = "macos")]
                        CredentialWork::NativeImport => {
                            let result = (|| {
                                let cancellation = original_owner.credential_cancellation(&original_ticket)?;
                                #[cfg(test)]
                                let result = super::native_credential_bundle::run(&original_owner, &original_ticket, &cancellation, native_fixture);
                                #[cfg(not(test))]
                                let result = super::native_credential_bundle::run(&original_owner, &original_ticket, &cancellation);
                                result
                            })();
                            match result {
                                Ok(()) => Ok(()),
                                Err(error) => original_owner.acquisition_failed(&original_ticket, error),
                            }
                        }
                        #[cfg(feature = "native-credential-smoke")]
                        CredentialWork::Unavailable => original_owner
                            .acquisition_failed(&original_ticket, ConnectionError::Unavailable),
                        #[cfg(all(
                            any(test, feature = "native-credential-smoke"),
                            target_os = "macos"
                        ))]
                        CredentialWork::Import {
                            process,
                            identity,
                            store,
                        } => original_owner
                            .import_account(
                                &original_ticket,
                                process.as_ref(),
                                identity.as_ref(),
                                store.as_ref(),
                            )
                            .map(|_| ()),
                    }
                } else {
                    original_owner
                        .acquisition_failed(&original_ticket, ConnectionError::Unavailable)
                };
                // The original owner remains the only read/commit authority.
                // Cancel/disable may have won before work, while an uncertain
                // commit may have retired this owner. Neither path retries.
                let settled = original_owner.account_acquisition(&original_ticket.attempt_id)?;
                if settled.state == AcquisitionState::Pending {
                    result?;
                    return Err(ConnectionError::Unavailable);
                }
                Ok(CredentialAcquisitionView::from(&settled))
            })();
            #[cfg(all(test, target_os = "macos"))]
            if let Some(probe) = worker_probe {
                probe.worker_finished();
            }
            completion
        });
        match started {
            Ok(handle) => Ok(Self {
                release,
                #[cfg(any(all(test, target_os = "macos"), feature = "native-credential-smoke"))]
                parked,
                handle: Some(handle),
                join_on_drop: true,
            }),
            Err(_) => {
                // An acknowledged Pending must not be abandoned when no task
                // started. This same owner's CAS records the unavailable result.
                owner.acquisition_failed(&ticket, ConnectionError::Unavailable)?;
                Err(ConnectionError::Unavailable)
            }
        }
    }
    #[cfg(any(all(test, target_os = "macos"), feature = "native-credential-smoke"))]
    pub(crate) fn wait_until_parked(&self) -> Result<(), ConnectionError> {
        self.parked
            .recv_timeout(Duration::from_secs(2))
            .map_err(|_| ConnectionError::Unavailable)
    }
    /// Transfer the genuine worker to its own background join before acknowledging
    /// Pending. The IPC task never owns a worker after this returns successfully.
    fn handoff(mut self) -> Result<(), ConnectionError> {
        // A failed launch drops this closure on the IPC blocking task. Do not
        // join there: its existing worker owns the original ticket until it
        // records Unavailable, without starting an adapter.
        self.join_on_drop = false;
        #[cfg(all(test, target_os = "macos"))]
        let probe = handoff_probe::current();
        let joined = launch("credential-acquisition-join", move || {
            self.join_on_drop = true;
            #[cfg(all(test, target_os = "macos"))]
            if let Some(ref probe) = probe {
                if let Err(error) = self.wait_until_parked() {
                    probe.complete(Err(error));
                    return;
                }
                probe.park();
            }
            let result = self.release_and_join();
            #[cfg(all(test, target_os = "macos"))]
            if let Some(probe) = probe {
                probe.complete(result);
            }
            #[cfg(not(all(test, target_os = "macos")))]
            let _ = result;
        });
        // If launch failed, Drop sends FailUnavailable and detaches this exact
        // already-owned task. No Pending is acknowledged, adapter starts, retry
        // or replacement owner is created. The native thread still owns the Arc/ticket.
        joined.map(drop).map_err(|_| ConnectionError::Unavailable)
    }
    pub(crate) fn release_and_join(mut self) -> Result<CredentialAcquisitionView, ConnectionError> {
        let _ = self.release.try_send(WorkRelease::Run);
        self.handle
            .take()
            .ok_or(ConnectionError::Unavailable)?
            .join()
            .map_err(|_| ConnectionError::Unavailable)?
    }
}
impl Drop for CredentialWorker {
    fn drop(&mut self) {
        let release = if self.join_on_drop {
            WorkRelease::Run
        } else {
            WorkRelease::FailUnavailable
        };
        let _ = self.release.try_send(release);
        if let Some(handle) = self.handle.take() {
            if self.join_on_drop {
                let _ = handle.join();
            }
            // Otherwise the original worker thread retains its owner/ticket
            // and terminalizes in the background; this caller never waits.
        }
    }
}

#[cfg(feature = "native-credential-smoke")]
fn begin_with_work(
    app: &AppHandle,
    window: &WebviewWindow,
    selection: &GhSelection,
    expected: u64,
    work: CredentialWork,
) -> Result<(CredentialAcquisitionView, CredentialWorker), ConnectionError> {
    // Capture the real native proof once before storage or worker work. No
    // fixture string, wire field, path or current vault can supply this owner.
    let proof = authenticate(app, window).map_err(|_| ConnectionError::Unavailable)?;
    begin_on_owner(proof.owner, selection, expected, work)
}
fn begin_on_owner(
    owner: Arc<NativeOwnerState>,
    selection: &GhSelection,
    expected: u64,
    work: CredentialWork,
) -> Result<(CredentialAcquisitionView, CredentialWorker), ConnectionError> {
    let ticket = owner.begin_account_acquisition(selection, expected)?;
    let view = CredentialAcquisitionView::from(&ticket);
    // Lost acknowledgement exits before any task launch. The exact ticket and
    // original Arc are the only authorities transferred to the genuine Worker.
    let worker = CredentialWorker::start(owner, ticket, work)?;
    Ok((view, worker))
}
fn begin_owned_with_work(
    owner: Arc<NativeOwnerState>,
    selection: &GhSelection,
    expected: u64,
    work: CredentialWork,
) -> Result<CredentialAcquisitionView, ConnectionError> {
    let (view, worker) = begin_on_owner(owner, selection, expected, work)?;
    worker.handoff()?;
    Ok(view)
}
pub(super) fn begin_owned_on_owner(
    owner: Arc<NativeOwnerState>,
    selection: &GhSelection,
    expected: u64,
) -> Result<CredentialAcquisitionView, ConnectionError> {
    #[cfg(target_os = "macos")]
    let work = CredentialWork::NativeImport;
    #[cfg(not(target_os = "macos"))]
    let work = CredentialWork::Unsupported;
    begin_owned_with_work(owner, selection, expected, work)
}
pub(crate) fn credential_begin_owned(
    app: &AppHandle,
    window: &WebviewWindow,
    selection: &GhSelection,
    expected: u64,
) -> Result<CredentialAcquisitionView, ConnectionError> {
    let proof = authenticate(app, window).map_err(|_| ConnectionError::Unavailable)?;
    begin_owned_on_owner(proof.owner, selection, expected)
}
#[cfg(feature = "native-credential-smoke")]
pub(crate) fn credential_begin(
    app: &AppHandle,
    window: &WebviewWindow,
    selection: &GhSelection,
    expected: u64,
) -> Result<(CredentialAcquisitionView, CredentialWorker), ConnectionError> {
    begin_with_work(
        app,
        window,
        selection,
        expected,
        CredentialWork::Unavailable,
    )
}

pub(crate) fn credential_poll(
    app: &AppHandle,
    window: &WebviewWindow,
    attempt: &AttemptId,
) -> Result<CredentialAcquisitionView, ConnectionError> {
    let proof = authenticate(app, window).map_err(|_| ConnectionError::Unavailable)?;
    let value = proof.owner.account_acquisition(attempt)?;
    Ok(CredentialAcquisitionView::from(&value))
}
pub(crate) fn credential_cancel(
    app: &AppHandle,
    window: &WebviewWindow,
    attempt: &AttemptId,
) -> Result<CredentialAcquisitionView, ConnectionError> {
    let proof = authenticate(app, window).map_err(|_| ConnectionError::Unavailable)?;
    let value = proof.owner.cancel_account_acquisition(attempt)?;
    Ok(CredentialAcquisitionView::from(&value))
}

// This fixed native-only fixture is the sole import bundle constructor. It
// cannot capture a real credential, resolve an OS store or call a provider.
#[cfg(all(feature = "native-credential-smoke", target_os = "macos"))]
pub(crate) fn credential_begin_import_fixture(
    app: &AppHandle,
    window: &WebviewWindow,
    selection: &GhSelection,
    expected: u64,
) -> Result<
    (
        CredentialAcquisitionView,
        CredentialWorker,
        super::native_account_worker_fixture::CredentialImportFixture,
    ),
    ConnectionError,
> {
    let fixture = super::native_account_worker_fixture::CredentialImportFixture::default();
    let work = CredentialWork::Import {
        process: Box::new(fixture.clone()),
        identity: Box::new(fixture.clone()),
        store: Box::new(fixture.clone()),
    };
    let (view, worker) = begin_with_work(app, window, selection, expected, work)?;
    Ok((view, worker, fixture))
}

// Private fixed no-secret work, used only to observe whether cancellation wins
// before the real worker reaches its existing adapter seam. No wire selector.
#[cfg(all(test, target_os = "macos"))]
pub(super) fn begin_owned_import_for_test(
    owner: Arc<NativeOwnerState>,
    selection: &GhSelection,
    expected: u64,
) -> Result<
    (
        CredentialAcquisitionView,
        super::native_account_worker_fixture::CredentialImportFixture,
    ),
    ConnectionError,
> {
    let fixture = super::native_account_worker_fixture::CredentialImportFixture::default();
    let work = CredentialWork::Import {
        process: Box::new(fixture.clone()),
        identity: Box::new(fixture.clone()),
        store: Box::new(fixture.clone()),
    };
    let view = begin_owned_with_work(owner, selection, expected, work)?;
    Ok((view, fixture))
}
