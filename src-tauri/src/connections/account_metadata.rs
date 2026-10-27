//! Shared transaction-local account metadata transitions. No authority constructor.
//! Callers own the existing transaction and its owner identity. This module never
//! opens/commits storage, resolves a secret, starts a process or calls a provider.
#[cfg(any(test, feature = "native-credential-smoke", target_os = "macos"))]
use super::gh_credentials::ValidatedCredential;
#[cfg(any(test, feature = "native-credential-smoke", target_os = "macos"))]
use super::metadata::AccountBinding;
use super::metadata::{MetadataRecord as Record, SecretRef, STATUS_SQL};
use super::opaque_id;
use super::{
    stamp, AcquisitionState, ConnectionError, ConnectionHealth, ConnectionStatus,
    CredentialAcquisition, GhSelection, RemoteRevocation,
};
#[cfg(any(test, feature = "native-credential-smoke", target_os = "macos"))]
use crate::actions::ids::AccountId;
use crate::actions::ids::{AttemptId, ConnectionId};
use rusqlite::{params, Connection, OptionalExtension};

#[cfg(test)]
pub(crate) enum MetadataOperation<'a> {
    Connect {
        selection: &'a GhSelection,
    },
    BeginImport {
        selection: &'a GhSelection,
        expected: u64,
    },
    CancelImport {
        attempt: &'a AttemptId,
    },
    Reconnect {
        connection: &'a ConnectionId,
        expected: u64,
    },
    Disable {
        connection: &'a ConnectionId,
        expected: u64,
    },
}
#[cfg(test)]
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum MetadataOutcome {
    Status(ConnectionStatus),
    Acquisition(CredentialAcquisition),
}
#[cfg(test)]
pub(crate) fn apply(
    tx: &Connection,
    owner_key: &str,
    operation: MetadataOperation<'_>,
) -> Result<MetadataOutcome, ConnectionError> {
    match operation {
        MetadataOperation::Connect { selection } => {
            connect(tx, owner_key, selection).map(MetadataOutcome::Status)
        }
        MetadataOperation::BeginImport {
            selection,
            expected,
        } => begin_import(tx, owner_key, selection, expected).map(MetadataOutcome::Acquisition),
        MetadataOperation::CancelImport { attempt } => {
            cancel_import(tx, owner_key, attempt).map(MetadataOutcome::Acquisition)
        }
        MetadataOperation::Reconnect {
            connection,
            expected,
        } => {
            reconnect(tx, owner_key, connection, expected)?;
            Ok(MetadataOutcome::Status(
                load(tx, owner_key, connection)?.status,
            ))
        }
        MetadataOperation::Disable {
            connection,
            expected,
        } => {
            disable(tx, owner_key, connection, expected)?;
            // Reflect queued cleanup in the descriptive status without OS work
            // while the caller's retained transaction is held.
            Ok(MetadataOutcome::Status(
                load(tx, owner_key, connection)?.status,
            ))
        }
    }
}

pub(super) fn db<T>(result: rusqlite::Result<T>) -> Result<T, ConnectionError> {
    result.map_err(|_| ConnectionError::Unavailable)
}
pub(super) fn json<T: serde::Serialize>(value: &T) -> Result<String, ConnectionError> {
    serde_json::to_string(value).map_err(|_| ConnectionError::Unavailable)
}
pub(super) fn decode<T: serde::de::DeserializeOwned>(value: &str) -> Result<T, ConnectionError> {
    serde_json::from_str(value).map_err(|_| ConnectionError::Unavailable)
}
pub(super) fn next(value: u64) -> Result<u64, ConnectionError> {
    value
        .checked_add(1)
        .filter(|v| *v <= 9_007_199_254_740_991)
        .ok_or(ConnectionError::Unavailable)
}
pub(crate) fn validate_account_login(host: &str, login: &str) -> Result<(), ConnectionError> {
    if host != "github.com" {
        return Err(ConnectionError::Unsupported);
    }
    if login.is_empty()
        || login.len() > 39
        || !login
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        || login.starts_with('-')
        || login.ends_with('-')
    {
        return Err(ConnectionError::InvalidSelection);
    }
    Ok(())
}
pub(super) fn validate_selection(selection: &GhSelection) -> Result<(), ConnectionError> {
    validate_account_login(&selection.host, &selection.login)?;
    if selection.connection_id.0.is_empty() || selection.connection_id.0.len() > 128 {
        return Err(ConnectionError::InvalidSelection);
    }
    Ok(())
}
pub(crate) fn load(
    conn: &Connection,
    owner_key: &str,
    id: &ConnectionId,
) -> Result<Record, ConnectionError> {
    let record = db(conn
        .query_row(STATUS_SQL, params![id.0, owner_key], Record::read)
        .optional())?;
    record.ok_or(ConnectionError::NotFound)
}
pub(super) fn save(
    conn: &Connection,
    owner_key: &str,
    record: &Record,
    expected: u64,
) -> Result<(), ConnectionError> {
    let expected = i64::try_from(expected).map_err(|_| ConnectionError::StaleRevision)?;
    let observation = record
        .observation_revision
        .checked_add(1)
        .filter(|value| *value <= 9_007_199_254_740_991)
        .ok_or(ConnectionError::Unavailable)?;
    // Every status writer claims the observation it read. Two verifies of the
    // same account revision cannot overwrite one another's completed answer.
    let changed = db(conn.execute("UPDATE managed_connections SET status=?1,active_attempt=?2,secret_ref=?3,observation_revision=?8 WHERE connection_id=?4 AND person=?5 AND json_extract(status,'$.revision')=?6 AND observation_revision=?7", params![json(&record.status)?, record.active, record.reference.as_ref().map(json).transpose()?, record.status.connection_id.0, owner_key, expected, record.observation_revision, observation]))?;
    if changed != 1 {
        return Err(ConnectionError::StaleRevision);
    }
    Ok(())
}
// One bounded physical-row decoder serves the transaction kernels and the
// retained owner's SELECT-only poll. No connection or writer is exposed.
pub(crate) const ACQUISITION_SQL: &str = "SELECT connection_id,payload FROM managed_connection_attempts WHERE attempt_id=?1 AND person=?2";

pub(crate) struct AcquisitionRecord {
    connection_id: String,
    payload: String,
}
impl AcquisitionRecord {
    pub(crate) fn read(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        let limits = &crate::actions::schema::admission_rules().limits;
        Ok(Self {
            connection_id: super::metadata::bounded_text(
                row,
                "connection_id",
                limits.identity_bytes,
            )?,
            payload: super::metadata::bounded_text(row, "payload", limits.grant_bytes)?,
        })
    }

    pub(crate) fn decode(
        self,
        owner_key: &str,
        id: &AttemptId,
    ) -> Result<CredentialAcquisition, ConnectionError> {
        let attempt: CredentialAcquisition = decode(&self.payload)?;
        // SQL chooses the physical original row/owner. A corrupt payload cannot
        // redirect a later save_attempt to another acquisition or connection.
        if attempt.attempt_id.0 != id.0
            || attempt.person != owner_key
            || attempt.connection_id.0 != self.connection_id
        {
            return Err(ConnectionError::Unavailable);
        }
        Ok(attempt)
    }
}

pub(super) fn read_attempt(
    conn: &Connection,
    owner_key: &str,
    id: &AttemptId,
) -> Result<CredentialAcquisition, ConnectionError> {
    let record = db(conn
        .query_row(
            ACQUISITION_SQL,
            params![id.0, owner_key],
            AcquisitionRecord::read,
        )
        .optional())?;
    record
        .ok_or(ConnectionError::NotFound)?
        .decode(owner_key, id)
}
pub(super) fn save_attempt(
    conn: &Connection,
    attempt: &CredentialAcquisition,
) -> Result<(), ConnectionError> {
    db(conn.execute(
        "UPDATE managed_connection_attempts SET payload=?1 WHERE attempt_id=?2 AND person=?3",
        params![json(attempt)?, attempt.attempt_id.0, attempt.person],
    ))?;
    Ok(())
}
pub(super) fn cancel_active(
    conn: &Connection,
    owner_key: &str,
    record: &mut Record,
) -> Result<(), ConnectionError> {
    if let Some(id) = record.active.take() {
        let mut attempt = read_attempt(conn, owner_key, &AttemptId(id))?;
        // An active selector may be corrupt even when its ticket is otherwise
        // valid for this person. Never cancel another connection's attempt.
        if attempt.connection_id != record.status.connection_id {
            return Err(ConnectionError::Unavailable);
        }
        if attempt.state == AcquisitionState::Pending {
            attempt.state = AcquisitionState::Cancelled;
            attempt.error = Some(ConnectionError::Cancelled);
            attempt.observed_at = stamp();
            save_attempt(conn, &attempt)?;
        }
    }
    Ok(())
}
pub(super) fn queue_cleanup(
    conn: &Connection,
    id: &ConnectionId,
    reference: &SecretRef,
) -> Result<(), ConnectionError> {
    db(conn.execute("INSERT OR IGNORE INTO managed_secret_cleanup(secret_id,connection_id,reference,disposition) VALUES(?1,?2,?3,'delete')", params![reference.id, id.0, json(reference)?]))?;
    Ok(())
}
pub(crate) fn connect(
    tx: &Connection,
    owner_key: &str,
    selection: &GhSelection,
) -> Result<ConnectionStatus, ConnectionError> {
    validate_selection(selection)?;
    let status = ConnectionStatus {
        connection_id: selection.connection_id.clone(),
        revision: 1,
        login: selection.login.clone(),
        health: ConnectionHealth::SignInRequired,
        account: None,
        secret_revision: 0,
        revocation_generation: 0,
        observed_at: stamp(),
        cleanup_pending: false,
        remote_revocation: RemoteRevocation::NotAttempted,
    };
    db(tx.execute(
        "INSERT INTO managed_connections(connection_id,person,status) VALUES(?1,?2,?3)",
        params![selection.connection_id.0, owner_key, json(&status)?],
    ))?;
    Ok(status)
}

pub(crate) fn begin_import(
    tx: &Connection,
    owner_key: &str,
    selection: &GhSelection,
    expected: u64,
) -> Result<CredentialAcquisition, ConnectionError> {
    validate_selection(selection)?;
    let mut record = load(tx, owner_key, &selection.connection_id)?;
    if record.status.revision != expected {
        return Err(ConnectionError::StaleRevision);
    }
    if record.status.login != selection.login {
        return Err(ConnectionError::InvalidSelection);
    }
    cancel_active(tx, owner_key, &mut record)?;
    record.status.revision = next(expected)?;
    record.status.observed_at = stamp();
    record.status.health = ConnectionHealth::SignInRequired;
    let attempt = CredentialAcquisition {
        attempt_id: AttemptId(opaque_id()),
        connection_id: selection.connection_id.clone(),
        person: owner_key.to_owned(),
        host: selection.host.clone(),
        login: selection.login.clone(),
        expected_revision: record.status.revision,
        revocation_generation: record.status.revocation_generation,
        state: AcquisitionState::Pending,
        error: None,
        observed_at: stamp(),
    };
    record.active = Some(attempt.attempt_id.0.clone());
    db(tx.execute("INSERT INTO managed_connection_attempts(attempt_id,connection_id,person,payload) VALUES(?1,?2,?3,?4)", params![attempt.attempt_id.0, selection.connection_id.0, owner_key, json(&attempt)?]))?;
    save(tx, owner_key, &record, expected)?;
    Ok(attempt)
}

pub(crate) fn cancel_import(
    tx: &Connection,
    owner_key: &str,
    id: &AttemptId,
) -> Result<CredentialAcquisition, ConnectionError> {
    let mut attempt = read_attempt(tx, owner_key, id)?;
    if attempt.state == AcquisitionState::Pending {
        attempt.state = AcquisitionState::Cancelled;
        attempt.error = Some(ConnectionError::Cancelled);
        attempt.observed_at = stamp();
        save_attempt(tx, &attempt)?;
        let mut record = load(tx, owner_key, &attempt.connection_id)?;
        if record.active.as_deref() == Some(&id.0) {
            let expected = record.status.revision;
            record.active = None;
            record.status.revision = next(expected)?;
            record.status.observed_at = stamp();
            save(tx, owner_key, &record, expected)?;
        }
    }
    Ok(attempt)
}

pub(crate) fn disable(
    tx: &Connection,
    owner_key: &str,
    id: &ConnectionId,
    expected: u64,
) -> Result<(), ConnectionError> {
    let mut record = load(tx, owner_key, id)?;
    if record.status.revision != expected {
        return Err(ConnectionError::StaleRevision);
    }
    cancel_active(tx, owner_key, &mut record)?;
    record.status.revision = next(expected)?;
    record.status.revocation_generation = next(record.status.revocation_generation)?;
    record.status.health = ConnectionHealth::Disabled;
    record.status.observed_at = stamp();
    if let Some(reference) = record.reference.take() {
        queue_cleanup(tx, id, &reference)?;
    }
    save(tx, owner_key, &record, expected)?;
    Ok(())
}

#[cfg(test)]
pub(super) fn reconnect(
    tx: &Connection,
    owner_key: &str,
    id: &ConnectionId,
    expected: u64,
) -> Result<(), ConnectionError> {
    let mut record = load(tx, owner_key, id)?;
    if record.status.revision != expected {
        return Err(ConnectionError::StaleRevision);
    }
    cancel_active(tx, owner_key, &mut record)?;
    record.status.revision = next(expected)?;
    record.status.health = ConnectionHealth::SignInRequired;
    record.status.observed_at = stamp();
    save(tx, owner_key, &record, expected)?;
    Ok(())
}

/// A transaction owner supplies this only at its actual commit boundary.
/// A generic ConnectionError never proves a credential was not installed.
pub(crate) enum ImportCommitOutcome<T> {
    Committed(T),
    NotCommitted(ConnectionError),
    CommitUncertain,
}
impl<T> ImportCommitOutcome<T> {
    pub(crate) fn into_result(self) -> Result<T, ConnectionError> {
        match self {
            Self::Committed(value) => Ok(value),
            Self::NotCommitted(error) => Err(error),
            Self::CommitUncertain => Err(ConnectionError::Unavailable),
        }
    }
}

/// Owned descriptive reservation minted only by the shared validated reserve.
/// No secret bytes, serializer, public fields or native authority constructor.
#[cfg(any(test, feature = "native-credential-smoke", target_os = "macos"))]
pub(crate) struct ImportReservation {
    owner_key: String,
    ticket: CredentialAcquisition,
    account: AccountBinding,
    reference: SecretRef,
    previous_secret_revision: u64,
}
#[cfg(any(test, feature = "native-credential-smoke", target_os = "macos"))]
impl ImportReservation {
    pub(crate) fn reference(&self) -> &SecretRef {
        &self.reference
    }
}

fn check_ticket(
    conn: &Connection,
    owner_key: &str,
    ticket: &CredentialAcquisition,
) -> Result<Record, ConnectionError> {
    let current = read_attempt(conn, owner_key, &ticket.attempt_id)?;
    if current.state != AcquisitionState::Pending {
        return Err(ConnectionError::Cancelled);
    }
    if &current != ticket {
        return Err(ConnectionError::StaleRevision);
    }
    let record = load(conn, owner_key, &ticket.connection_id)?;
    if record.status.revision != ticket.expected_revision
        || record.status.revocation_generation != ticket.revocation_generation
        || record.active.as_deref() != Some(&ticket.attempt_id.0)
        || record.status.health == ConnectionHealth::Disabled
    {
        return Err(ConnectionError::StaleRevision);
    }
    Ok(record)
}

#[cfg(any(test, feature = "native-credential-smoke", target_os = "macos"))]
pub(crate) fn import_selection(
    conn: &Connection,
    owner_key: &str,
    ticket: &CredentialAcquisition,
) -> Result<GhSelection, ConnectionError> {
    check_ticket(conn, owner_key, ticket)?;
    let selection = GhSelection {
        connection_id: ticket.connection_id.clone(),
        host: ticket.host.clone(),
        login: ticket.login.clone(),
    };
    validate_selection(&selection)?;
    Ok(selection)
}

#[cfg(any(test, feature = "native-credential-smoke", target_os = "macos"))]
pub(crate) fn validate_credential(
    ticket: &CredentialAcquisition,
    credential: &ValidatedCredential,
) -> Result<(), ConnectionError> {
    if credential.login != ticket.login
        || credential.issuer != "https://github.com"
        || credential.subject.is_empty()
        || credential.subject.len() > 128
        || !credential.subject.bytes().all(|b| b.is_ascii_digit())
        || credential.scope_digest.len() != 64
        || !credential
            .scope_digest
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err(ConnectionError::IdentityMismatch);
    }
    Ok(())
}

#[cfg(any(test, feature = "native-credential-smoke", target_os = "macos"))]
pub(crate) fn reserve_import(
    conn: &Connection,
    owner_key: &str,
    ticket: &CredentialAcquisition,
    credential: &ValidatedCredential,
) -> Result<ImportReservation, ConnectionError> {
    validate_credential(ticket, credential)?;
    let record = check_ticket(conn, owner_key, ticket)?;
    let same_identity = record.status.account.as_ref().is_some_and(|account| {
        account.issuer == credential.issuer && account.subject == credential.subject
    });
    let same_binding = same_identity
        && record
            .status
            .account
            .as_ref()
            .is_some_and(|account| account.scope_digest == credential.scope_digest);
    let account = AccountBinding {
        account_id: if same_identity {
            record.status.account.as_ref().unwrap().account_id.clone()
        } else {
            AccountId(opaque_id())
        },
        issuer: credential.issuer.clone(),
        subject: credential.subject.clone(),
        scope_digest: credential.scope_digest.clone(),
        account_revision: if same_binding {
            record.status.account.as_ref().unwrap().account_revision
        } else {
            next(
                record
                    .status
                    .account
                    .as_ref()
                    .map_or(0, |account| account.account_revision),
            )?
        },
    };
    let reference = SecretRef {
        id: opaque_id(),
        account_id: account.account_id.clone(),
        issuer: account.issuer.clone(),
        subject: account.subject.clone(),
        secret_revision: next(record.status.secret_revision)?,
    };
    // The caller commits this exact reservation before any OS-store write.
    queue_cleanup(conn, &ticket.connection_id, &reference)?;
    let changed = db(conn.execute(
        "UPDATE managed_secret_cleanup SET disposition='reserved' WHERE secret_id=?1 AND connection_id=?2 AND reference=?3",
        params![reference.id, ticket.connection_id.0, json(&reference)?],
    ))?;
    if changed != 1 {
        return Err(ConnectionError::Unavailable);
    }
    Ok(ImportReservation {
        owner_key: owner_key.to_owned(),
        ticket: ticket.clone(),
        account,
        reference,
        previous_secret_revision: record.status.secret_revision,
    })
}

/// Prepare the exact installation in the caller's transaction. Returning Ok
/// means prepared, NOT committed: only the caller's actual commit can say that.
/// The one returned old reference is cleanup work only after a known commit.
#[cfg(any(test, feature = "native-credential-smoke", target_os = "macos"))]
pub(crate) fn complete_import(
    conn: &Connection,
    owner_key: &str,
    ticket: &CredentialAcquisition,
    reservation: &ImportReservation,
) -> Result<Option<SecretRef>, ConnectionError> {
    if owner_key != reservation.owner_key || ticket != &reservation.ticket {
        return Err(ConnectionError::StaleRevision);
    }
    let mut record = check_ticket(conn, owner_key, ticket)?;
    if record.status.secret_revision != reservation.previous_secret_revision {
        return Err(ConnectionError::StaleRevision);
    }
    let reserved: bool = db(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM managed_secret_cleanup WHERE secret_id=?1 AND connection_id=?2 AND reference=?3 AND disposition='reserved')",
        params![reservation.reference.id, ticket.connection_id.0, json(&reservation.reference)?],
        |row| row.get(0),
    ))?;
    if !reserved {
        return Err(ConnectionError::Unavailable);
    }
    // Use the current observation epoch. A Verify completed during OS work
    // cannot be overwritten with the older observation read at reservation.
    let old = record.reference.take();
    if let Some(reference) = &old {
        queue_cleanup(conn, &ticket.connection_id, reference)?;
    }
    record.status.revision = next(ticket.expected_revision)?;
    record.status.account = Some(reservation.account.clone());
    record.status.secret_revision = reservation.reference.secret_revision;
    record.status.health = ConnectionHealth::Ready;
    record.status.observed_at = stamp();
    record.reference = Some(reservation.reference.clone());
    record.active = None;
    save(conn, owner_key, &record, ticket.expected_revision)?;
    let mut installed = ticket.clone();
    installed.state = AcquisitionState::Installed;
    installed.observed_at = stamp();
    save_attempt(conn, &installed)?;
    let changed = db(conn.execute(
        "DELETE FROM managed_secret_cleanup WHERE secret_id=?1 AND connection_id=?2 AND reference=?3 AND disposition='reserved'",
        params![reservation.reference.id, ticket.connection_id.0, json(&reservation.reference)?],
    ))?;
    if changed != 1 {
        return Err(ConnectionError::Unavailable);
    }
    Ok(old)
}

/// Called only for a known uncommitted installation. This exact-reference
/// update cannot turn the current installed reference into pending deletion.
#[cfg(any(test, feature = "native-credential-smoke", target_os = "macos"))]
pub(crate) fn mark_import_unused(
    conn: &Connection,
    owner_key: &str,
    reservation: &ImportReservation,
) -> Result<(), ConnectionError> {
    if owner_key != reservation.owner_key {
        return Err(ConnectionError::StaleRevision);
    }
    let changed = db(conn.execute(
        "UPDATE managed_secret_cleanup SET disposition='delete' WHERE secret_id=?1 AND connection_id=?2 AND reference=?3 AND disposition IN ('reserved','delete') AND EXISTS(SELECT 1 FROM managed_connections c WHERE c.connection_id=?2 AND c.person=?4 AND (c.secret_ref IS NULL OR json_extract(c.secret_ref,'$.id')<>?1))",
        params![reservation.reference.id, reservation.ticket.connection_id.0, json(&reservation.reference)?, owner_key],
    ))?;
    if changed != 1 {
        return Err(ConnectionError::Unavailable);
    }
    Ok(())
}

/// Acknowledge deletion of one exact app-owned reference after OS work. No
/// cleanup-list traversal or current credential can be selected by this door.
#[cfg(any(test, feature = "native-credential-smoke", target_os = "macos"))]
pub(crate) fn retire_import_cleanup(
    conn: &Connection,
    owner_key: &str,
    id: &ConnectionId,
    reference: &SecretRef,
) -> Result<(), ConnectionError> {
    db(conn.execute(
        "DELETE FROM managed_secret_cleanup WHERE secret_id=?1 AND connection_id=?2 AND reference=?3 AND disposition='delete' AND EXISTS(SELECT 1 FROM managed_connections c WHERE c.connection_id=?2 AND c.person=?4 AND (c.secret_ref IS NULL OR json_extract(c.secret_ref,'$.id')<>?1))",
        params![reference.id, id.0, json(reference)?, owner_key],
    ))?;
    Ok(())
}

pub(super) fn health_for_error(error: ConnectionError) -> ConnectionHealth {
    match error {
        ConnectionError::Unsupported => ConnectionHealth::Unsupported,
        ConnectionError::SignInRequired
        | ConnectionError::NotFound
        | ConnectionError::IdentityMismatch => ConnectionHealth::SignInRequired,
        _ => ConnectionHealth::Unavailable,
    }
}

pub(crate) fn fail_import(
    conn: &Connection,
    owner_key: &str,
    ticket: &CredentialAcquisition,
    error: ConnectionError,
) -> Result<(), ConnectionError> {
    if let Ok(mut record) = check_ticket(conn, owner_key, ticket) {
        record.status.health = health_for_error(error);
        record.status.revision = next(ticket.expected_revision)?;
        record.active = None;
        record.status.observed_at = stamp();
        save(conn, owner_key, &record, ticket.expected_revision)?;
        let mut attempt = ticket.clone();
        attempt.state = AcquisitionState::Failed;
        attempt.error = Some(error);
        attempt.observed_at = stamp();
        save_attempt(conn, &attempt)?;
    }
    Ok(())
}

#[cfg(any(test, feature = "native-credential-smoke", target_os = "macos"))]
pub(crate) fn import_status(
    conn: &Connection,
    owner_key: &str,
    id: &ConnectionId,
) -> Result<ConnectionStatus, ConnectionError> {
    Ok(load(conn, owner_key, id)?.status)
}
