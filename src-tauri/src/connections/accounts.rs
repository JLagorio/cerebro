//! Durable metadata writes; secrets live only in the native store seam.
pub(super) use super::account_metadata::validate_selection;
use super::account_metadata::{
    cancel_active, db, decode, health_for_error, load, next, read_attempt, save,
};
use super::secrets::{SecretRef, SecretStore};
use super::*;
use rusqlite::Connection;

pub(crate) use super::gh_credentials::ValidatedCredential;
pub(crate) struct ConnectionService<'a> {
    pub conn: &'a mut Connection,
    pub store: &'a dyn SecretStore,
}
// The legacy adapter still owns its original transaction. The state transition
// itself is shared; this function records which real commit boundary was crossed.
fn install_reserved(
    conn: &mut Connection,
    owner_key: &str,
    ticket: &CredentialAcquisition,
    reservation: &account_metadata::ImportReservation,
) -> account_metadata::ImportCommitOutcome<Option<SecretRef>> {
    use account_metadata::ImportCommitOutcome as Outcome;
    let tx = match conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate) {
        Ok(tx) => tx,
        Err(_) => return Outcome::NotCommitted(ConnectionError::Unavailable),
    };
    let old = match account_metadata::complete_import(&tx, owner_key, ticket, reservation) {
        Ok(old) => old,
        Err(error) => return Outcome::NotCommitted(error),
    };
    match tx.commit() {
        Ok(()) => Outcome::Committed(old),
        Err(_) => Outcome::CommitUncertain,
    }
}

impl ConnectionService<'_> {
    /// Call once at process startup before any acquisition worker is admitted.
    /// Never run this against another live process's worker population.
    pub(crate) fn recover_after_restart(
        &mut self,
        person: &AttendedPerson,
    ) -> Result<(), ConnectionError> {
        let tx = db(self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate))?;
        let ids = {
            let mut statement =
                db(tx.prepare("SELECT connection_id FROM managed_connections WHERE person=?1"))?;
            let rows = db(statement.query_map([&person.0], |r| r.get::<_, String>(0)))?;
            db(rows.collect::<rusqlite::Result<Vec<_>>>())?
        };
        for id in &ids {
            let id = ConnectionId(id.clone());
            let mut record = load(&tx, &person.0, &id)?;
            if record.active.is_some() {
                let expected = record.status.revision;
                cancel_active(&tx, &person.0, &mut record)?;
                record.status.revision = next(expected)?;
                record.status.observed_at = stamp();
                save(&tx, &person.0, &record, expected)?;
            }
            db(tx.execute("UPDATE managed_secret_cleanup SET disposition='delete' WHERE connection_id=?1 AND disposition='reserved'", [&id.0]))?;
        }
        db(tx.commit())?;
        for id in ids {
            self.cleanup(person, &ConnectionId(id))?;
        }
        Ok(())
    }
    pub(crate) fn connect(
        &mut self,
        person: &AttendedPerson,
        selection: &GhSelection,
    ) -> Result<ConnectionStatus, ConnectionError> {
        validate_selection(selection)?;
        let tx = db(self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate))?;
        let status = account_metadata::connect(&tx, &person.0, selection)?;
        db(tx.commit())?;
        Ok(status)
    }
    pub(crate) fn status(
        &self,
        person: &AttendedPerson,
        id: &ConnectionId,
    ) -> Result<ConnectionStatus, ConnectionError> {
        Ok(load(self.conn, &person.0, id)?.status)
    }
    pub(crate) fn begin_gh_import(
        &mut self,
        person: &AttendedPerson,
        selection: &GhSelection,
        expected: u64,
    ) -> Result<CredentialAcquisition, ConnectionError> {
        validate_selection(selection)?;
        let tx = db(self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate))?;
        let attempt = account_metadata::begin_import(&tx, &person.0, selection, expected)?;
        db(tx.commit())?;
        Ok(attempt)
    }
    pub(crate) fn credential_acquisition(
        &self,
        person: &AttendedPerson,
        id: &AttemptId,
    ) -> Result<CredentialAcquisition, ConnectionError> {
        read_attempt(self.conn, &person.0, id)
    }
    pub(crate) fn cancel_credential_acquisition(
        &mut self,
        person: &AttendedPerson,
        id: &AttemptId,
    ) -> Result<CredentialAcquisition, ConnectionError> {
        let tx = db(self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate))?;
        let attempt = account_metadata::cancel_import(&tx, &person.0, id)?;
        db(tx.commit())?;
        Ok(attempt)
    }
    pub(crate) fn complete_import(
        &mut self,
        person: &AttendedPerson,
        ticket: &CredentialAcquisition,
        credential: ValidatedCredential,
    ) -> Result<ConnectionStatus, ConnectionError> {
        if let Err(error) = account_metadata::validate_credential(ticket, &credential) {
            self.fail_attempt(person, ticket, error)?;
            return Err(error);
        }
        let tx = db(self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate))?;
        let reservation = account_metadata::reserve_import(&tx, &person.0, ticket, &credential)?;
        db(tx.commit())?;
        if let Err(error) = self.store.put(reservation.reference(), &credential.secret) {
            account_metadata::mark_import_unused(self.conn, &person.0, &reservation)?;
            self.fail_attempt(person, ticket, error)?;
            self.cleanup(person, &ticket.connection_id)?;
            return Err(error);
        }
        match install_reserved(self.conn, &person.0, ticket, &reservation) {
            account_metadata::ImportCommitOutcome::Committed(_) => {
                self.cleanup(person, &ticket.connection_id)?;
                self.status(person, &ticket.connection_id)
            }
            account_metadata::ImportCommitOutcome::NotCommitted(error) => {
                account_metadata::mark_import_unused(self.conn, &person.0, &reservation)?;
                self.cleanup(person, &ticket.connection_id)?;
                Err(error)
            }
            // Preserve the reference after an actual commit attempt fails:
            // it may be installed. Never infer safe deletion from that error.
            account_metadata::ImportCommitOutcome::CommitUncertain => {
                Err(ConnectionError::Unavailable)
            }
        }
    }
    /// Native acquisition workers call this with a finite, non-secret error.
    pub(crate) fn fail_credential_acquisition(
        &mut self,
        person: &AttendedPerson,
        id: &AttemptId,
        error: ConnectionError,
    ) -> Result<CredentialAcquisition, ConnectionError> {
        let attempt = read_attempt(self.conn, &person.0, id)?;
        if attempt.state == AcquisitionState::Pending {
            self.fail_attempt(person, &attempt, error)?;
        }
        self.credential_acquisition(person, id)
    }
    fn fail_attempt(
        &mut self,
        person: &AttendedPerson,
        ticket: &CredentialAcquisition,
        error: ConnectionError,
    ) -> Result<(), ConnectionError> {
        let tx = db(self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate))?;
        account_metadata::fail_import(&tx, &person.0, ticket, error)?;
        db(tx.commit())?;
        Ok(())
    }
    /// Retry app-owned cleanup only. Dispatch stays disabled after a failed delete.
    pub(crate) fn cleanup(
        &mut self,
        person: &AttendedPerson,
        id: &ConnectionId,
    ) -> Result<(), ConnectionError> {
        load(self.conn, &person.0, id)?;
        let references = {
            let mut stmt = db(self
                .conn
                .prepare("SELECT reference FROM managed_secret_cleanup WHERE connection_id=?1 AND disposition='delete'"))?;
            let rows = db(stmt.query_map([&id.0], |row| row.get::<_, String>(0)))?;
            db(rows.collect::<rusqlite::Result<Vec<_>>>())?
        };
        for raw in references {
            let reference: SecretRef = decode(&raw)?;
            if self.store.delete(&reference).is_ok() {
                db(self.conn.execute(
                    "DELETE FROM managed_secret_cleanup WHERE secret_id=?1",
                    [&reference.id],
                ))?;
            }
        }
        Ok(())
    }
    pub(crate) fn revoke(
        &mut self,
        person: &AttendedPerson,
        id: &ConnectionId,
        expected: u64,
    ) -> Result<ConnectionStatus, ConnectionError> {
        let tx = db(self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate))?;
        account_metadata::disable(&tx, &person.0, id, expected)?;
        db(tx.commit())?;
        self.cleanup(person, id)?;
        self.status(person, id)
    }
    pub(crate) fn reconnect(
        &mut self,
        person: &AttendedPerson,
        id: &ConnectionId,
        expected: u64,
    ) -> Result<ConnectionStatus, ConnectionError> {
        let tx = db(self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate))?;
        account_metadata::reconnect(&tx, &person.0, id, expected)?;
        db(tx.commit())?;
        self.status(person, id)
    }
    /// Explicit identity read with the current secret. Never repeats gh import or refresh.
    pub(crate) fn verify(
        &mut self,
        person: &AttendedPerson,
        id: &ConnectionId,
        expected: u64,
        identity: &dyn super::gh_credentials::IdentityReader,
    ) -> Result<ConnectionStatus, ConnectionError> {
        let mut record = load(self.conn, &person.0, id)?;
        if record.status.revision != expected {
            return Err(ConnectionError::StaleRevision);
        }
        if record.status.health == ConnectionHealth::Disabled {
            return Ok(record.status);
        }
        record.status.health = match record.reference.as_ref().map(|r| self.store.resolve(r)) {
            Some(Ok(secret)) => match identity.authenticated_identity(&secret) {
                Ok(remote)
                    if record.status.account.as_ref().is_some_and(|a| {
                        remote.login == record.status.login
                            && remote.subject == a.subject
                            && remote.issuer == a.issuer
                            && remote.scope_digest == a.scope_digest
                    }) =>
                {
                    ConnectionHealth::Ready
                }
                Ok(_) => ConnectionHealth::SignInRequired,
                Err(error) => health_for_error(error),
            },
            Some(Err(ConnectionError::Unsupported)) => ConnectionHealth::Unsupported,
            None | Some(Err(ConnectionError::SignInRequired)) => ConnectionHealth::SignInRequired,
            Some(Err(_)) => ConnectionHealth::Unavailable,
        };
        record.status.observed_at = stamp();
        save(self.conn, &person.0, &record, expected)?;
        self.status(person, id)
    }
}
