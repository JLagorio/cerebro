//! Fixed-purpose Settings metadata on the authenticated original retained owner.
//! No credential adapter, acquisition door or native authority factory is exposed.
use super::{authenticate, NativeOwnerError, NativeOwnerState, RuntimeTransactionOutcome};
use crate::{
    actions::ids::ConnectionId,
    connections::{
        account_metadata::{self, ImportCommitOutcome as Outcome},
        metadata::{ManagedConnectionPage, MetadataRecord},
        ConnectionError, ConnectionStatus, GhSelection,
    },
};
use rusqlite::Connection;
use std::sync::{atomic::Ordering, Arc};
use tauri::{AppHandle, WebviewWindow};

pub(crate) fn managed_list(
    app: &AppHandle,
    window: &WebviewWindow,
    cursor: Option<ConnectionId>,
) -> Result<ManagedConnectionPage, ConnectionError> {
    let proof = authenticate(app, window).map_err(|_| ConnectionError::Unavailable)?;
    proof.owner.list_accounts(cursor)
}
pub(crate) fn managed_add(
    app: &AppHandle,
    window: &WebviewWindow,
    host: String,
    login: String,
) -> Result<ConnectionStatus, ConnectionError> {
    let proof = authenticate(app, window).map_err(|_| ConnectionError::Unavailable)?;
    proof.owner.add_account_selection(&host, &login)
}
pub(crate) fn managed_disable(
    app: &AppHandle,
    window: &WebviewWindow,
    id: ConnectionId,
    expected_revision: u64,
) -> Result<ConnectionStatus, ConnectionError> {
    let proof = authenticate(app, window).map_err(|_| ConnectionError::Unavailable)?;
    proof.owner.disable_account(&id, expected_revision)
}

// Every returned row, including the lookahead, uses the same bounded decoder
// as point status and writes. SQLite selects only the fixed native owner.
const LIST_SQL: &str = "SELECT c.connection_id,status,active_attempt,secret_ref,observation_revision,EXISTS(SELECT 1 FROM managed_secret_cleanup q WHERE q.connection_id=c.connection_id) AS cleanup_pending FROM managed_connections c WHERE person=?1 AND c.connection_id COLLATE BINARY > ?2 ORDER BY c.connection_id COLLATE BINARY LIMIT ?3";

impl NativeOwnerState {
    /// The existing real RuntimeOwner transaction is the sole commit owner.
    /// Native and SQL guards are dropped before returning any outcome to work.
    pub(super) fn account_transaction<T>(
        &self,
        operation: impl FnOnce(&Connection, &str) -> Result<T, ConnectionError>,
    ) -> Outcome<T> {
        self.account_transaction_after(operation, |_| {})
    }
    /// Notification is atomic metadata only, under the same retained storage
    /// guard after known commit, before another command can commit a successor.
    pub(super) fn account_transaction_after<T>(
        &self,
        operation: impl FnOnce(&Connection, &str) -> Result<T, ConnectionError>,
        committed: impl FnOnce(&T),
    ) -> Outcome<T> {
        if !self.registration.live.load(Ordering::SeqCst) {
            self.action_cancellations.cancel_all(); self.credential_cancellations.cancel_all();
            return Outcome::NotCommitted(ConnectionError::Unavailable);
        }
        let mut storage = match self.storage.lock() {
            Ok(storage) => storage,
            Err(_) => { self.action_cancellations.cancel_all(); self.credential_cancellations.cancel_all(); return Outcome::NotCommitted(ConnectionError::Unavailable); },
        };
        if storage.failed || !self.registration.live.load(Ordering::SeqCst) {
            self.action_cancellations.cancel_all(); self.credential_cancellations.cancel_all();
            return Outcome::NotCommitted(ConnectionError::Unavailable);
        }
        let Some(owner) = storage.owner.as_mut() else {
            self.action_cancellations.cancel_all(); self.credential_cancellations.cancel_all();
            return Outcome::NotCommitted(ConnectionError::Unavailable);
        };
        owner.credential_cancellations = Arc::downgrade(&self.credential_cancellations);
        owner.action_cancellations = Arc::downgrade(&self.action_cancellations);
        let owner_key = super::super::native_rules::admission_rules()
            .owner_storage_key
            .clone();
        let mut domain_error = None;
        let result = owner.classified_transaction(|tx| {
            if !self.registration.live.load(Ordering::SeqCst) {
                return Err(NativeOwnerError::Unavailable);
            }
            let value = operation(tx, &owner_key).map_err(|error| {
                domain_error = Some(error);
                NativeOwnerError::Unavailable
            });
            if !self.registration.live.load(Ordering::SeqCst) {
                return Err(NativeOwnerError::Unavailable);
            }
            value
        });
        let retired = owner.retired;
        if retired {
            storage.failed = true;
            self.action_cancellations.cancel_all(); self.credential_cancellations.cancel_all();
        }
        match result {
            RuntimeTransactionOutcome::Committed(value) => { committed(&value); Outcome::Committed(value) },
            RuntimeTransactionOutcome::CommitUncertain => { self.action_cancellations.cancel_all(); self.credential_cancellations.cancel_all(); Outcome::CommitUncertain },
            RuntimeTransactionOutcome::NotCommitted(_) => Outcome::NotCommitted(
                if retired || !self.registration.live.load(Ordering::SeqCst) {
                    ConnectionError::Unavailable
                } else {
                    domain_error.unwrap_or(ConnectionError::Unavailable)
                },
            ),
        }
    }

    pub(super) fn list_accounts(
        &self,
        cursor: Option<ConnectionId>,
    ) -> Result<ManagedConnectionPage, ConnectionError> {
        let rules = super::super::native_rules::admission_rules();
        if cursor
            .as_ref()
            .is_some_and(|id| id.0.is_empty() || id.0.len() > rules.limits.identity_bytes)
        {
            return Err(ConnectionError::InvalidSelection);
        }
        if !self.registration.live.load(Ordering::SeqCst) {
            return Err(ConnectionError::Unavailable);
        }
        let cap = crate::actions::schema::admission_rules()
            .limits
            .catalog_page_size;
        let limit = cap
            .checked_add(1)
            .and_then(|value| i64::try_from(value).ok())
            .ok_or(ConnectionError::Unavailable)?
            .to_string();
        let mut storage = self
            .storage
            .lock()
            .map_err(|_| ConnectionError::Unavailable)?;
        if storage.failed || !self.registration.live.load(Ordering::SeqCst) {
            return Err(ConnectionError::Unavailable);
        }
        let owner = storage.owner.as_mut().ok_or(ConnectionError::Unavailable)?;
        let result = owner.read_snapshot(|read| {
            let rows = read
                .query_all(
                    LIST_SQL,
                    &[
                        &rules.owner_storage_key,
                        cursor.as_ref().map_or("", |id| id.0.as_str()),
                        &limit,
                    ],
                    |row| MetadataRecord::read(row).map(|record| record.status),
                )
                .map_err(|_| NativeOwnerError::Unavailable)?;
            if !self.registration.live.load(Ordering::SeqCst) {
                return Err(NativeOwnerError::Unavailable);
            }
            Ok(rows)
        });
        if owner.retired {
            storage.failed = true;
            self.action_cancellations.cancel_all(); self.credential_cancellations.cancel_all();
        }
        let mut items = result.map_err(|_| ConnectionError::Unavailable)?;
        let next_cursor = if items.len() > cap {
            items.truncate(cap);
            items.last().map(|status| status.connection_id.clone())
        } else {
            None
        };
        Ok(ManagedConnectionPage { items, next_cursor })
    }
    pub(super) fn add_account_selection(
        &self,
        host: &str,
        login: &str,
    ) -> Result<ConnectionStatus, ConnectionError> {
        // Random identity is created natively; wire selection supplies no owner
        // or connection authority. The kernel validates before its first write.
        account_metadata::validate_account_login(host, login)?;
        let selection = GhSelection {
            connection_id: ConnectionId(crate::connections::opaque_id()),
            host: host.to_owned(),
            login: login.to_owned(),
        };
        self.account_transaction(|tx, owner_key| {
            account_metadata::connect(tx, owner_key, &selection)
        })
        .into_result()
    }
    pub(super) fn disable_account(
        &self,
        id: &ConnectionId,
        expected_revision: u64,
    ) -> Result<ConnectionStatus, ConnectionError> {
        if id.0.is_empty()
            || id.0.len()
                > super::super::native_rules::admission_rules()
                    .limits
                    .identity_bytes
        {
            return Err(ConnectionError::InvalidSelection);
        }
        self.account_transaction_after(|tx, owner_key| {
            account_metadata::disable(tx, owner_key, id, expected_revision)?;
            // The shared decoder overlays the real pending cleanup queue. No
            // OS cleanup, provider call or implicit retry follows this commit.
            Ok(account_metadata::load(tx, owner_key, id)?.status)
        }, |_| {
            self.action_cancellations.cancel_connection(id);
            self.credential_cancellations.cancel_connection(id);
        })
        .into_result()
    }
}
