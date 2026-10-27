//! Native account lifecycle. No secret-bearing value is an IPC type.
#[cfg(test)]
pub(crate) mod accounts;
#[cfg(any(test, feature = "native-credential-smoke", target_os = "macos"))]
pub(crate) mod gh_credentials;
#[cfg(target_os = "macos")]
mod keychain;
#[cfg(feature = "native-keychain-smoke")]
pub(crate) mod keychain_acceptance;
#[cfg(test)]
pub(crate) mod migration;
#[cfg(any(
    test,
    feature = "native-keychain-smoke",
    feature = "native-credential-smoke",
    target_os = "macos"
))]
pub(crate) mod secrets;
#[cfg(test)]
mod tests;

pub(crate) mod metadata;
#[cfg(test)]
pub(crate) use metadata::AccountBinding;
pub(crate) use metadata::{ConnectionError, ConnectionStatus};
pub(crate) use metadata::{ConnectionHealth, RemoteRevocation};

#[cfg(test)]
use crate::actions::ids::AccountId;
use crate::actions::ids::{AttemptId, ConnectionId};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub(crate) enum AcquisitionState {
    Pending,
    Installed,
    Cancelled,
    Failed,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CredentialAcquisition {
    pub attempt_id: AttemptId,
    pub connection_id: ConnectionId,
    pub person: String,
    pub host: String,
    pub login: String,
    pub expected_revision: u64,
    pub revocation_generation: u64,
    pub state: AcquisitionState,
    pub error: Option<ConnectionError>,
    pub observed_at: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GhSelection {
    pub connection_id: ConnectionId,
    pub host: String,
    pub login: String,
}

/// Construct only at the attended native command door, never from an MCP run.
/// This is caller admission metadata, not an authorization inferred from a wire field.
#[cfg(test)]
pub(crate) struct AttendedPerson(String);
#[cfg(test)]
impl AttendedPerson {
    pub(crate) fn at_native_door(person: &str) -> Result<Self, ConnectionError> {
        if person.starts_with("human:") && person.len() > 6 && person.len() <= 128 {
            Ok(Self(person.to_owned()))
        } else {
            Err(ConnectionError::InvalidSelection)
        }
    }
}
pub(super) fn stamp() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
pub(crate) fn opaque_id() -> String {
    use rand::Rng;
    format!("{:032x}", rand::thread_rng().gen::<u128>())
}
#[cfg(any(test, feature = "native-keychain-smoke", target_os = "macos"))]
pub(super) fn digest(value: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(value))
}

pub(crate) mod account_metadata;

#[cfg(test)]
pub(crate) mod test_support;

// Fixed native process adapter, reachable only from the admitted owned worker.
#[cfg(target_os = "macos")]
pub(crate) mod gh_native;

#[cfg(any(test, target_os = "macos"))]
pub(crate) mod github_identity;
