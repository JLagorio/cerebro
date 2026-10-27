//! Original retained-owner acquisition metadata. No credential/provider adapter.
use super::{NativeOwnerError, NativeOwnerState};
use crate::connections::{account_metadata, ConnectionError, CredentialAcquisition};
use rusqlite::OptionalExtension;
use std::sync::{atomic::Ordering, Arc};

// The authenticated command retains its actual proof.owner Arc once.
// These metadata transitions start no credential or provider adapter.
impl NativeOwnerState {
    pub(super) fn credential_cancellation(
        self: &Arc<Self>, ticket: &CredentialAcquisition,
    ) -> Result<super::credential_cancel::CancellationRegistration, ConnectionError> {
        let registration = self.credential_cancellations.register(ticket)?;
        // Registration precedes the exact retained read, closing cancellation
        // between Pending commit and worker registration without any re-open.
        let current = self.account_acquisition(&ticket.attempt_id)?;
        if &current != ticket || current.state != crate::connections::AcquisitionState::Pending
            || registration.flag.stopped() || !self.registration.live.load(Ordering::SeqCst)
        { return Err(ConnectionError::Cancelled); }
        Ok(registration)
    }
    pub(super) fn acquisition_failed(
        &self,
        ticket: &CredentialAcquisition,
        error: ConnectionError,
    ) -> Result<(), ConnectionError> {
        self.account_transaction(|tx, owner_key| {
            account_metadata::fail_import(tx, owner_key, ticket, error)
        })
        .into_result()
    }

    pub(super) fn begin_account_acquisition(
        self: &Arc<Self>,
        selection: &crate::connections::GhSelection,
        expected_revision: u64,
    ) -> Result<CredentialAcquisition, ConnectionError> {
        // The shared kernel validates selection before its first write. Only
        // an acknowledged commit returns a ticket eligible for worker handoff.
        self.account_transaction_after(|tx, owner_key| {
            account_metadata::begin_import(tx, owner_key, selection, expected_revision)
        }, |_| {
            self.action_cancellations.cancel_connection(&selection.connection_id);
            self.credential_cancellations.cancel_connection(&selection.connection_id);
        })
        .into_result()
    }

    pub(super) fn account_acquisition(
        &self,
        attempt: &crate::actions::ids::AttemptId,
    ) -> Result<CredentialAcquisition, ConnectionError> {
        validate_acquisition_selector(attempt)?;
        if !self.registration.live.load(Ordering::SeqCst) {
            return Err(ConnectionError::Unavailable);
        }
        let rules = super::super::native_rules::admission_rules();
        let record = {
            let mut storage = self
                .storage
                .lock()
                .map_err(|_| ConnectionError::Unavailable)?;
            if storage.failed || !self.registration.live.load(Ordering::SeqCst) {
                return Err(ConnectionError::Unavailable);
            }
            let owner = storage.owner.as_mut().ok_or(ConnectionError::Unavailable)?;
            let result = owner.read_snapshot(|read| {
                let record = read
                    .query(
                        account_metadata::ACQUISITION_SQL,
                        &[&attempt.0, &rules.owner_storage_key],
                        account_metadata::AcquisitionRecord::read,
                    )
                    .optional()
                    .map_err(|_| NativeOwnerError::Unavailable)?;
                if !self.registration.live.load(Ordering::SeqCst) {
                    return Err(NativeOwnerError::Unavailable);
                }
                Ok(record)
            });
            if owner.retired {
                storage.failed = true;
                self.action_cancellations.cancel_all(); self.credential_cancellations.cancel_all();
            }
            result.map_err(|_| ConnectionError::Unavailable)?
        };
        // Bounded bytes were captured within the original read-only snapshot.
        // Decode once through the same physical-row checks as every writer.
        record
            .ok_or(ConnectionError::NotFound)?
            .decode(&rules.owner_storage_key, attempt)
    }

    pub(super) fn cancel_account_acquisition(
        &self,
        attempt: &crate::actions::ids::AttemptId,
    ) -> Result<CredentialAcquisition, ConnectionError> {
        validate_acquisition_selector(attempt)?;
        self.account_transaction_after(|tx, owner_key| {
            account_metadata::cancel_import(tx, owner_key, attempt)
        }, |_| self.credential_cancellations.cancel_attempt(attempt))
        .into_result()
    }
}

fn validate_acquisition_selector(
    attempt: &crate::actions::ids::AttemptId,
) -> Result<(), ConnectionError> {
    if attempt.0.is_empty()
        || attempt.0.len()
            > super::super::native_rules::admission_rules()
                .limits
                .identity_bytes
    {
        return Err(ConnectionError::InvalidSelection);
    }
    Ok(())
}
