//! Bounded metadata projection. No secret resolver, provider or grant writer.
use crate::actions::ids::{AccountId, ConnectionId};
use rusqlite::{types::ValueRef, Row};
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub(crate) enum ConnectionHealth {
    SignInRequired,
    Ready,
    Unavailable,
    Unsupported,
    Disabled,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub(crate) enum ConnectionError {
    SignInRequired,
    InvalidSelection,
    StaleRevision,
    NotFound,
    Unavailable,
    Unsupported,
    IdentityMismatch,
    Cancelled,
    SourceChanged,
    UnsafePath,
    InvalidConfig,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[cfg_attr(test, schemars(deny_unknown_fields))]
#[serde(rename_all = "camelCase")]
pub(crate) struct AccountBinding {
    pub account_id: AccountId,
    pub subject: String,
    pub issuer: String,
    #[cfg_attr(test, schemars(schema_with = "schema_counter", range(min = 1)))]
    pub account_revision: u64,
    pub scope_digest: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[cfg_attr(test, schemars(deny_unknown_fields))]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectionStatus {
    pub connection_id: ConnectionId,
    #[cfg_attr(test, schemars(schema_with = "schema_counter", range(min = 1)))]
    pub revision: u64,
    pub login: String,
    pub health: ConnectionHealth,
    #[cfg_attr(
        test,
        schemars(with = "crate::actions::read_types::RequiredNullable<AccountBinding>")
    )]
    pub account: Option<AccountBinding>,
    #[cfg_attr(test, schemars(schema_with = "schema_counter"))]
    pub secret_revision: u64,
    #[cfg_attr(test, schemars(schema_with = "schema_counter"))]
    pub revocation_generation: u64,
    pub observed_at: String,
    pub cleanup_pending: bool,
    pub remote_revocation: RemoteRevocation,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub(crate) enum RemoteRevocation {
    NotAttempted,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SecretRef {
    pub id: String,
    pub account_id: AccountId,
    pub issuer: String,
    pub subject: String,
    pub secret_revision: u64,
}

/// Safe account metadata page. Cursor is a selector, never native authority.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ManagedConnectionPage {
    pub items: Vec<ConnectionStatus>,
    #[serde(deserialize_with = "crate::actions::read_types::required_nullable")]
    #[cfg_attr(
        test,
        schemars(with = "crate::actions::read_types::RequiredNullable<ConnectionId>")
    )]
    pub next_cursor: Option<ConnectionId>,
}

/// Safe lifecycle projection. Internal person/ticket/secret authority is never
/// serialized through this view; no public completion accepts it as proof.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CredentialAcquisitionView {
    pub attempt_id: crate::actions::ids::AttemptId,
    pub connection_id: ConnectionId,
    pub host: String,
    pub login: String,
    #[cfg_attr(test, schemars(schema_with = "schema_counter", range(min = 1)))]
    pub expected_revision: u64,
    #[cfg_attr(test, schemars(schema_with = "schema_counter"))]
    pub revocation_generation: u64,
    pub state: super::AcquisitionState,
    #[serde(deserialize_with = "crate::actions::read_types::required_nullable")]
    #[cfg_attr(
        test,
        schemars(with = "crate::actions::read_types::RequiredNullable<ConnectionError>")
    )]
    pub error: Option<ConnectionError>,
    pub observed_at: String,
}
impl From<&super::CredentialAcquisition> for CredentialAcquisitionView {
    fn from(value: &super::CredentialAcquisition) -> Self {
        Self {
            attempt_id: value.attempt_id.clone(),
            connection_id: value.connection_id.clone(),
            host: value.host.clone(),
            login: value.login.clone(),
            expected_revision: value.expected_revision,
            revocation_generation: value.revocation_generation,
            state: value.state,
            error: value.error,
            observed_at: value.observed_at.clone(),
        }
    }
}

// Export the already-enforced exact-JavaScript counter range without the
// default uint64 format/unsafe maximum that the contract generator refuses.
#[cfg(test)]
fn schema_counter(_: &mut schemars::gen::SchemaGenerator) -> schemars::schema::Schema {
    use schemars::schema::{InstanceType, NumberValidation, Schema, SchemaObject};
    Schema::Object(SchemaObject {
        instance_type: Some(InstanceType::Integer.into()),
        number: Some(Box::new(NumberValidation {
            minimum: Some(0.0),
            maximum: Some(9_007_199_254_740_991.0),
            ..Default::default()
        })),
        ..Default::default()
    })
}

// Existing action admission bounds, applied before allocating SQLite TEXT.
pub(crate) fn bounded_text(row: &Row<'_>, name: &str, max: usize) -> rusqlite::Result<String> {
    let value = row.get_ref(name)?;
    match value {
        ValueRef::Text(bytes) if bytes.len() <= max => std::str::from_utf8(bytes)
            .map(str::to_owned)
            .map_err(|_| rusqlite::Error::InvalidQuery),
        _ => Err(rusqlite::Error::InvalidQuery),
    }
}
pub(crate) fn bounded_optional_text(
    row: &Row<'_>,
    name: &str,
    max: usize,
) -> rusqlite::Result<Option<String>> {
    if row.get_ref(name)? == ValueRef::Null {
        Ok(None)
    } else {
        bounded_text(row, name, max).map(Some)
    }
}
pub(crate) const STATUS_SQL: &str = "SELECT c.connection_id,status,active_attempt,secret_ref,observation_revision,EXISTS(SELECT 1 FROM managed_secret_cleanup q WHERE q.connection_id=c.connection_id) AS cleanup_pending FROM managed_connections c WHERE connection_id=?1 AND person=?2";
pub(crate) struct MetadataRecord {
    pub(crate) observation_revision: i64,
    pub(crate) status: ConnectionStatus,
    pub(crate) active: Option<String>,
    pub(crate) reference: Option<SecretRef>,
}
impl MetadataRecord {
    pub(crate) fn read(row: &Row<'_>) -> rusqlite::Result<Self> {
        let limits = crate::actions::schema::admission_rules();
        let raw = bounded_text(row, "status", limits.limits.grant_bytes)?;
        let reference = bounded_optional_text(row, "secret_ref", limits.limits.grant_bytes)?;
        let status = decode_status(&raw, row.get("cleanup_pending")?)
            .map_err(|_| rusqlite::Error::InvalidQuery)?;
        // The selected physical row owns identity. Corrupt JSON cannot retarget
        // a list result or the following metadata CAS to another connection.
        let id = bounded_text(row, "connection_id", limits.limits.identity_bytes)?;
        if id.is_empty() || status.connection_id.0 != id {
            return Err(rusqlite::Error::InvalidQuery);
        }
        let reference =
            decode_reference(reference.as_deref()).map_err(|_| rusqlite::Error::InvalidQuery)?;
        let observation_revision: i64 = row.get("observation_revision")?;
        if !(0..=9_007_199_254_740_991).contains(&observation_revision) {
            return Err(rusqlite::Error::InvalidQuery);
        }
        let active = bounded_optional_text(row, "active_attempt", limits.limits.identity_bytes)?;
        Ok(Self {
            status,
            observation_revision,
            reference,
            active,
        })
    }
}
fn text(value: &str, required: bool, maximum: usize) -> bool {
    (!required || !value.is_empty()) && value.len() <= maximum
}
fn counter(value: u64) -> bool {
    value <= 9_007_199_254_740_991
}
pub(crate) fn decode_status(
    raw: &str,
    cleanup_pending: bool,
) -> Result<ConnectionStatus, ConnectionError> {
    let l = &crate::actions::schema::admission_rules().limits;
    if raw.len() > l.grant_bytes {
        return Err(ConnectionError::Unavailable);
    }
    let mut status: ConnectionStatus =
        serde_json::from_str(raw).map_err(|_| ConnectionError::Unavailable)?;
    if !text(&status.connection_id.0, true, l.identity_bytes)
        || !text(&status.login, false, l.identity_bytes)
        || !text(&status.observed_at, false, l.process_session_bytes)
        || status.revision == 0
        || !counter(status.revision)
        || !counter(status.secret_revision)
        || !counter(status.revocation_generation)
        || status.account.as_ref().is_some_and(|a| {
            !text(&a.account_id.0, true, l.identity_bytes)
                || !text(&a.subject, true, l.identity_bytes)
                || !text(&a.issuer, true, l.identity_bytes)
                || !text(&a.scope_digest, true, l.identity_bytes)
                || a.account_revision == 0
                || !counter(a.account_revision)
        })
    {
        return Err(ConnectionError::Unavailable);
    }
    status.cleanup_pending = cleanup_pending;
    Ok(status)
}
pub(crate) fn decode_reference(raw: Option<&str>) -> Result<Option<SecretRef>, ConnectionError> {
    let l = &crate::actions::schema::admission_rules().limits;
    let Some(raw) = raw else {
        return Ok(None);
    };
    if raw.len() > l.grant_bytes {
        return Err(ConnectionError::Unavailable);
    }
    let value: SecretRef = serde_json::from_str(raw).map_err(|_| ConnectionError::Unavailable)?;
    if [
        &value.id,
        &value.account_id.0,
        &value.issuer,
        &value.subject,
    ]
    .iter()
    .any(|s| !text(s, true, l.identity_bytes))
        || value.secret_revision == 0
        || !counter(value.secret_revision)
    {
        return Err(ConnectionError::Unavailable);
    }
    Ok(Some(value))
}

#[cfg(test)]
#[path = "metadata_tests.rs"]
mod tests;
