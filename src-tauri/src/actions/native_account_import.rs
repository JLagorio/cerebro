//! Private original-owner account coordinator, used by tests and a fixed native fixture.
//! The opt-in worker retains its actual authenticated original owner Arc.
//! No production credential/provider adapter or public import command is enabled.
use super::NativeOwnerState;
use crate::actions::ids::ConnectionId;
use crate::connections::{
    account_metadata::{self, ImportCommitOutcome as Outcome, ImportReservation},
    gh_credentials::{self, GhProcess, IdentityReader},
    secrets::{SecretRef, SecretStore},
    ConnectionError, ConnectionStatus, CredentialAcquisition,
};
use std::sync::Arc;

impl NativeOwnerState {
    /// Only the explicit NotCommitted installation branch may call this.
    /// Reservation/cleanup bookkeeping uncertainty does not install a secret.
    /// The exact private reference remains known unused by this operation.
    fn discard_uncommitted_import(
        &self,
        ticket: &CredentialAcquisition,
        reservation: &ImportReservation,
        store: &dyn SecretStore,
        put_error: Option<ConnectionError>,
    ) -> Result<(), ConnectionError> {
        let marked = self
            .account_transaction(|tx, owner_key| {
                account_metadata::mark_import_unused(tx, owner_key, reservation)?;
                if let Some(error) = put_error {
                    account_metadata::fail_import(tx, owner_key, ticket, error)?;
                }
                Ok(())
            })
            .into_result();
        // If the original runtime retired before completion, deleting this
        // unused private reference needs no replacement runtime or new owner.
        // Its original durable reservation remains for explicit recovery.
        let deleted = store.delete(reservation.reference()).is_ok();
        if deleted && marked.is_ok() {
            self.account_transaction(|tx, owner_key| {
                account_metadata::retire_import_cleanup(
                    tx,
                    owner_key,
                    &ticket.connection_id,
                    reservation.reference(),
                )
            })
            .into_result()?;
        }
        marked
    }

    fn cleanup_committed_reference(
        &self,
        id: &ConnectionId,
        reference: &SecretRef,
        store: &dyn SecretStore,
    ) -> Result<(), ConnectionError> {
        // This reference came only from the exact successful completion. No
        // arbitrary/global cleanup list or current credential is selected here.
        if store.delete(reference).is_ok() {
            self.account_transaction(|tx, owner_key| {
                account_metadata::retire_import_cleanup(tx, owner_key, id, reference)
            })
            .into_result()?;
        }
        Ok(())
    }

    pub(super) fn import_account(
        self: &Arc<Self>,
        ticket: &CredentialAcquisition,
        process: &dyn GhProcess,
        identity: &dyn IdentityReader,
        store: &dyn SecretStore,
    ) -> Result<ConnectionStatus, ConnectionError> {
        // Retain this exact owner throughout. No authenticate/ensure_runtime,
        // path reopen, current-vault lookup or replacement owner occurs here.
        let selection = self
            .account_transaction(|tx, owner_key| {
                account_metadata::import_selection(tx, owner_key, ticket)
            })
            .into_result()?;
        let credential = match gh_credentials::acquire(&selection, process, identity) {
            Ok(credential) => credential,
            Err(error) => {
                self.acquisition_failed(ticket, error)?;
                return Err(error);
            }
        };
        if let Err(error) = account_metadata::validate_credential(ticket, &credential) {
            self.acquisition_failed(ticket, error)?;
            return Err(error);
        }
        let reservation = self
            .account_transaction(|tx, owner_key| {
                account_metadata::reserve_import(tx, owner_key, ticket, &credential)
            })
            .into_result()?;
        // Reservation is durable, but authority may have changed before OS
        // dispatch. A refused check has not put a secret; only this exact new
        // unused reservation is eligible for cleanup.
        if let Err(error) = self.account_transaction(|tx, owner_key| {
            account_metadata::import_selection(tx, owner_key, ticket).map(|_| ())
        }).into_result() {
            self.discard_uncommitted_import(ticket, &reservation, store, Some(error))?;
            return Err(error);
        }
        if let Err(error) = store.put(reservation.reference(), &credential.secret) {
            // Installation has not been dispatched. Only the owned new secret
            // can be discarded; its metadata never becomes Ready.
            self.discard_uncommitted_import(ticket, &reservation, store, Some(error))?;
            return Err(error);
        }
        match self.account_transaction_after(|tx, owner_key| {
            account_metadata::complete_import(tx, owner_key, ticket, &reservation)
        }, |_| self.action_cancellations.cancel_connection(&ticket.connection_id)) {
            Outcome::Committed(old_reference) => {
                if let Some(reference) = old_reference {
                    self.cleanup_committed_reference(&ticket.connection_id, &reference, store)?;
                }
                self.account_transaction(|tx, owner_key| {
                    account_metadata::import_status(tx, owner_key, &ticket.connection_id)
                })
                .into_result()
            }
            Outcome::NotCommitted(error) => {
                self.discard_uncommitted_import(ticket, &reservation, store, None)?;
                Err(error)
            }
            // Commit may have installed this reference. Do not mark it unused,
            // call delete, reacquire an owner, or repeat acquisition on retry.
            Outcome::CommitUncertain => Err(ConnectionError::Unavailable),
        }
    }
}
