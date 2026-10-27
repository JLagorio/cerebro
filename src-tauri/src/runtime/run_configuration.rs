//! Immutable bounded configuration facts at actual CLI dispatch.
//! Informational metadata cannot grant authority. No bodies/secrets are stored.
// No instruction, arbitrary
// config Value, endpoint, env/header/credential, argv or message field exists.
use crate::runtime::ReadOnly;
use crate::workspace_service::authority::{AuthorityContext, LegacyOpeningTicket};
use chrono::{DateTime, Utc};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::{io::Write, sync::OnceLock};

#[cfg_attr(test, derive(schemars::JsonSchema))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case", deny_unknown_fields)]
pub enum Known<T> {
    Recorded { value: T },
    Unknown { reason: UnknownReason },
}
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnknownReason {
    NotObservedBeforeDispatch,
    NotReportedByNativeProbe,
    UnrecognizedCliVersion,
    NoNativeIdentityReceipt,
    InheritedUserConfiguration,
    SpecIdentityNotSupplied,
}
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
pub enum ScopeAxis {
    Unrestricted,
    None,
    // Exact ordered selector identities are retained. A displayable prefix is
    // optional, approved metadata; opaque/unrecognized syntax is hash-only.
    Prefixes { selectors: Vec<SelectorIdentity> },
}
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SelectorIdentity {
    pub sha256: String,
    pub metadata_label: Option<String>,
}
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
pub enum ToolAxis {
    Unrestricted,
    None,
    Restricted { selectors: Vec<SelectorIdentity> },
}
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EffectiveGrant {
    pub actor_id: SelectorIdentity,
    pub write_scope: ScopeAxis,
    pub read_scope: ScopeAxis,
    pub tools: ToolAxis,
    pub chain: Vec<SelectorIdentity>,
    pub run_kind: String,
    pub ask_first: bool,
}
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StrictCliVersion {
    #[cfg_attr(test, schemars(schema_with = "schema_u32"))]
    pub major: u32,
    #[cfg_attr(test, schemars(schema_with = "schema_u32"))]
    pub minor: u32,
    #[cfg_attr(test, schemars(schema_with = "schema_u32"))]
    pub patch: u32,
}
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArtifactIdentity {
    pub artifact: String,
    pub sha256: String,
}
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DefinitionIdentity {
    pub id: String,
    pub sha256: String,
}
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConnectorIdentity {
    // Actual loaded CLI identifier from RunConnectors, not a credential-bearing
    // merged config, endpoint, command, argument, header or environment value.
    pub cli_id: SelectorIdentity,
    pub spec_identity: Known<String>,
}
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunConfigurationManifestV1 {
    #[cfg_attr(test, schemars(schema_with = "schema_u32"))]
    pub format: u32,
    pub run_id: String,
    pub vault_id: String,
    pub store_uuid: Option<String>,
    pub dispatched_at: String,
    pub effective_grant: EffectiveGrant,
    pub permission_mode: String,
    pub cli_tools: Vec<SelectorIdentity>,
    pub allowed_tools: Vec<SelectorIdentity>,
    pub denied_tools: Vec<SelectorIdentity>,
    pub asked_tools: Vec<SelectorIdentity>,
    pub requested_model: Option<SelectorIdentity>,
    pub requested_effort: Option<String>,
    pub observed_model_at_dispatch: Known<String>,
    pub observed_cli_version: Known<StrictCliVersion>,
    pub artifacts: Vec<ArtifactIdentity>,
    pub standing_agent: Known<DefinitionIdentity>,
    pub skills: Known<Vec<DefinitionIdentity>>,
    pub defined_subagents: Vec<DefinitionIdentity>,
    pub effective_system_prompt_sha256: Option<String>,
    pub connectors: Vec<ConnectorIdentity>,
    pub inherits_user_mcp: bool,
    pub user_settings: Known<()>,
    pub settings_hardening: bool,
    pub seated: bool,
    pub message_transport: String,
    pub coverage: Vec<String>,
}
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case", deny_unknown_fields)]
#[expect(
    clippy::large_enum_variant,
    reason = "the stable owned reader API carries one capped immutable payload without a second allocation"
)]
pub enum ConfigurationRead {
    Recorded {
        manifest: RunConfigurationManifestV1,
    },
    NotRecorded {
        reason: NotRecordedReason,
    },
}
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NotRecordedReason {
    Legacy,
    Expired,
    Deleted,
    CaptureFailed,
}

#[cfg_attr(test, derive(schemars::JsonSchema))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConfigurationUnavailableCode {
    StorageUnavailable,
    OpeningChanged,
    ScopeUnavailable,
}
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case", deny_unknown_fields)]
pub enum ConfigurationReply {
    Recorded {
        manifest: Box<RunConfigurationManifestV1>,
    },
    NotRecorded {
        reason: NotRecordedReason,
    },
    Unavailable {
        code: ConfigurationUnavailableCode,
    },
}
impl ConfigurationReply {
    pub fn from_read(value: Result<ConfigurationRead, ConfigurationReadError>) -> Self {
        match value {
            Ok(ConfigurationRead::Recorded { manifest }) => Self::Recorded {
                manifest: Box::new(manifest),
            },
            Ok(ConfigurationRead::NotRecorded { reason }) => Self::NotRecorded { reason },
            Err(error) => Self::Unavailable {
                code: match error {
                    ConfigurationReadError::Unavailable => {
                        ConfigurationUnavailableCode::StorageUnavailable
                    }
                    ConfigurationReadError::WrongScope => {
                        ConfigurationUnavailableCode::ScopeUnavailable
                    }
                    ConfigurationReadError::OpeningChanged => {
                        ConfigurationUnavailableCode::OpeningChanged
                    }
                },
            },
        }
    }
}
#[cfg(test)]
fn schema_u32(_: &mut schemars::gen::SchemaGenerator) -> schemars::schema::Schema {
    use schemars::schema::{InstanceType, NumberValidation, Schema, SchemaObject};
    Schema::Object(SchemaObject {
        instance_type: Some(InstanceType::Integer.into()),
        number: Some(Box::new(NumberValidation {
            minimum: Some(0.0),
            maximum: Some(4_294_967_295.0),
            ..Default::default()
        })),
        ..Default::default()
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManifestWriteError {
    Unavailable,
    Conflict,
    InvalidMetadata,
    TooLarge,
    ActiveCapacity,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigurationReadError {
    Unavailable,
    WrongScope,
    OpeningChanged,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Recorded {
    Stored,
    AlreadyStored,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PruneReport {
    pub expired: u64,
    pub evicted: u64,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg(test)]
pub enum DeleteOutcome {
    Deleted,
    AlreadyDeleted,
}

// This owns the actual existing opening ticket, never a copied path/generation.
// Scope resolution and the SELECT remain under with_legacy_opening in GREEN.
pub struct ConfigurationReadTicket {
    context: AuthorityContext,
    opening: LegacyOpeningTicket,
    root: PathBuf,
}
pub fn capture_read_ticket(
    context: &AuthorityContext,
    root: &Path,
) -> Result<ConfigurationReadTicket, ConfigurationReadError> {
    let root = root
        .canonicalize()
        .map_err(|_| ConfigurationReadError::WrongScope)?;
    let opening = context
        .capture_legacy_opening(&root)
        .map_err(|_| ConfigurationReadError::OpeningChanged)?;
    Ok(ConfigurationReadTicket {
        context: context.clone(),
        opening,
        root,
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Limits {
    format: u32,
    pub(crate) encoded_bytes: usize,
    completed_retention_seconds: i64,
    per_vault_payload_bytes: i64,
    active_rows: String,
    capacity: String,
    bodies: String,
    secret_environment_header_values: String,
    run_history_and_effect_receipts: String,
    cleanup_batch_rows: usize,
    cleanup_tick_seconds: u64,
}
pub(crate) fn limits() -> &'static Limits {
    static LIMITS: OnceLock<Limits> = OnceLock::new();
    LIMITS.get_or_init(|| {
        let l: Limits = serde_json::from_str(include_str!(
            "../../../shared/policy/run-configuration.v1.json"
        ))
        .expect("run configuration policy");
        assert_eq!(l.format, 1);
        assert_eq!(l.active_rows, "pinned");
        assert_eq!(
            l.capacity,
            "expire_then_oldest_completed_then_refuse_before_launch"
        );
        assert_eq!(l.bodies, "never_retained");
        assert_eq!(l.secret_environment_header_values, "never_retained");
        assert_eq!(
            l.run_history_and_effect_receipts,
            "never_deleted_by_configuration_lifecycle"
        );
        assert_eq!(l.encoded_bytes, 65_536);
        assert!(l.per_vault_payload_bytes >= l.encoded_bytes as i64);
        assert!(
            l.completed_retention_seconds > 0
                && l.cleanup_batch_rows > 0
                && l.cleanup_tick_seconds > 0
        );
        l
    })
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DisplayVocabulary {
    format: u32,
    authority: String,
    origin: DisplayOrigin,
    tool_labels: Vec<String>,
    permission_modes: Vec<String>,
    effort_levels: Vec<String>,
    subagent_ids: Vec<String>,
    artifact_paths: Vec<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DisplayOrigin {
    name: String,
    tools_sha256: String,
    subagents_sha256: String,
    approval_sha256: String,
    run_options_sha256: String,
}
fn vocabulary() -> &'static DisplayVocabulary {
    static VALUE: OnceLock<DisplayVocabulary> = OnceLock::new();
    VALUE.get_or_init(|| {
        let v: DisplayVocabulary = serde_json::from_str(include_str!(
            "../../../shared/run-configuration/metadata-labels.v1.json"
        ))
        .expect("configuration display vocabulary");
        assert_eq!(v.format, 1);
        assert_eq!(v.authority, "none_display_metadata_only");
        assert!(!v.origin.name.is_empty());
        assert!([
            &v.origin.tools_sha256,
            &v.origin.subagents_sha256,
            &v.origin.approval_sha256,
            &v.origin.run_options_sha256
        ]
        .into_iter()
        .all(|h| hash(h)));
        v
    })
}
fn known_label(value: &str) -> bool {
    vocabulary().tool_labels.iter().any(|v| v == value)
        && (crate::policy::tools::cli_tool(value).is_some()
            || crate::policy::tools::row(value).is_some())
}
pub(crate) fn selector_identity(value: &str, allow_static_tool_label: bool) -> SelectorIdentity {
    SelectorIdentity {
        sha256: crate::ledger::sha256_hex(value.as_bytes()),
        metadata_label: (allow_static_tool_label && known_label(value)).then(|| value.to_owned()),
    }
}
fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
#[derive(Clone, Copy, PartialEq)]
enum Validation {
    Capture,
    Historical,
}
fn valid_identity(value: &SelectorIdentity, phase: Validation) -> bool {
    hash(&value.sha256)
        && value.metadata_label.as_deref().is_none_or(|label| {
            vocabulary().tool_labels.iter().any(|v| v == label)
                && (phase == Validation::Historical || known_label(label))
                && crate::ledger::sha256_hex(label.as_bytes()) == value.sha256
        })
}
fn valid_vector(values: &[SelectorIdentity], phase: Validation) -> bool {
    values.iter().all(|v| valid_identity(v, phase))
}
fn valid_scope(value: &ScopeAxis, phase: Validation) -> bool {
    match value {
        ScopeAxis::Prefixes { selectors } => valid_vector(selectors, phase),
        _ => true,
    }
}
fn valid_tools(value: &ToolAxis, phase: Validation) -> bool {
    match value {
        ToolAxis::Restricted { selectors } => valid_vector(selectors, phase),
        _ => true,
    }
}
fn unknown<T>(value: &Known<T>, reason: UnknownReason) -> bool {
    matches!(value,Known::Unknown {reason:r} if *r==reason)
}
pub(crate) fn artifact_identities() -> Vec<ArtifactIdentity> {
    [
        (
            "shared/policy/tools.v1.json",
            include_bytes!("../../../shared/policy/tools.v1.json").as_slice(),
        ),
        (
            "shared/policy/tool-approval.v1.json",
            include_bytes!("../../../shared/policy/tool-approval.v1.json").as_slice(),
        ),
        (
            "shared/policy/subagents.v1.json",
            include_bytes!("../../../shared/policy/subagents.v1.json").as_slice(),
        ),
        (
            "shared/policy/run-options.v1.json",
            include_bytes!("../../../shared/policy/run-options.v1.json").as_slice(),
        ),
    ]
    .into_iter()
    .map(|(artifact, bytes)| ArtifactIdentity {
        artifact: artifact.into(),
        sha256: crate::ledger::sha256_hex(bytes),
    })
    .collect()
}
fn validate(m: &RunConfigurationManifestV1, phase: Validation) -> Result<(), ManifestWriteError> {
    let known = artifact_identities();
    let modes = &crate::policy::tool_approval::table().permission_modes;
    let metadata = m.format == 1
        && !m.run_id.is_empty()
        && m.run_id.len() <= 128
        && m.vault_id.len() == 32
        && m.vault_id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        && m.store_uuid
            .as_deref()
            .is_some_and(|v| !v.is_empty() && v.len() <= 128)
        && DateTime::parse_from_rfc3339(&m.dispatched_at).is_ok()
        && valid_identity(&m.effective_grant.actor_id, phase)
        && valid_scope(&m.effective_grant.write_scope, phase)
        && valid_scope(&m.effective_grant.read_scope, phase)
        && valid_tools(&m.effective_grant.tools, phase)
        && !m.effective_grant.chain.is_empty()
        && valid_vector(&m.effective_grant.chain, phase)
        && matches!(
            m.effective_grant.run_kind.as_str(),
            "attended" | "unattended" | "internal"
        )
        && vocabulary().permission_modes.contains(&m.permission_mode)
        && (phase == Validation::Historical
            || [&modes.internal, &modes.asks, &modes.otherwise].contains(&&m.permission_mode))
        && [
            &m.cli_tools,
            &m.allowed_tools,
            &m.denied_tools,
            &m.asked_tools,
        ]
        .into_iter()
        .all(|v| valid_vector(v, phase))
        && m.requested_model
            .as_ref()
            .is_none_or(|v| valid_identity(v, phase))
        && m.requested_effort.as_ref().is_none_or(|v| {
            vocabulary().effort_levels.contains(v)
                && (phase == Validation::Historical
                    || crate::agent::run_options::validate_effort(Some(v)).is_ok())
        })
        && unknown(
            &m.observed_model_at_dispatch,
            UnknownReason::NotObservedBeforeDispatch,
        )
        && matches!(
            m.observed_cli_version,
            Known::Recorded { .. }
                | Known::Unknown {
                    reason: UnknownReason::NotReportedByNativeProbe
                        | UnknownReason::UnrecognizedCliVersion
                }
        )
        && m.artifacts.iter().all(|v| {
            vocabulary().artifact_paths.contains(&v.artifact)
                && hash(&v.sha256)
                && (phase == Validation::Historical || known.contains(v))
        })
        && unknown(&m.standing_agent, UnknownReason::NoNativeIdentityReceipt)
        && unknown(&m.skills, UnknownReason::NoNativeIdentityReceipt)
        && m.defined_subagents.iter().all(|v| {
            hash(&v.sha256)
                && vocabulary().subagent_ids.contains(&v.id)
                && (phase == Validation::Historical
                    || crate::policy::subagents::presets()
                        .iter()
                        .any(|p| p.name == v.id))
        })
        && m.effective_system_prompt_sha256.as_deref().is_none_or(hash)
        && m.connectors.iter().all(|v| {
            valid_identity(&v.cli_id, phase)
                && unknown(&v.spec_identity, UnknownReason::SpecIdentityNotSupplied)
        })
        && unknown(&m.user_settings, UnknownReason::InheritedUserConfiguration)
        && matches!(m.message_transport.as_str(), "argv" | "stdin")
        && m.coverage.iter().all(|v| {
            [
                "hash_only_instructions",
                "model_not_observed_before_dispatch",
                "standing_agent_identity_not_recorded",
                "skill_identity_not_recorded",
                "connector_spec_identity_not_recorded",
                "inherited_user_configuration_not_observed",
                "subagent_brief_identity_not_recorded",
            ]
            .contains(&v.as_str())
        });
    if metadata {
        Ok(())
    } else {
        Err(ManifestWriteError::InvalidMetadata)
    }
}
struct Capped {
    bytes: Vec<u8>,
    overflow: bool,
}
impl Write for Capped {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.bytes.len().saturating_add(bytes.len()) > limits().encoded_bytes {
            self.overflow = true;
            return Err(std::io::Error::other("configuration size limit"));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn encode(m: &RunConfigurationManifestV1) -> Result<String, ManifestWriteError> {
    let mut output = Capped {
        bytes: Vec::new(),
        overflow: false,
    };
    let encoded = serde_json::to_writer(&mut output, m);
    if output.overflow {
        return Err(ManifestWriteError::TooLarge);
    }
    encoded.map_err(|_| ManifestWriteError::InvalidMetadata)?;
    validate(m, Validation::Capture)?;
    String::from_utf8(output.bytes).map_err(|_| ManifestWriteError::InvalidMetadata)
}
fn unavailable<T>(value: rusqlite::Result<T>) -> Result<T, ManifestWriteError> {
    value.map_err(|_| ManifestWriteError::Unavailable)
}
fn transaction(conn: &Connection) -> Result<Transaction<'_>, ManifestWriteError> {
    unavailable(Transaction::new_unchecked(
        conn,
        TransactionBehavior::Immediate,
    ))
}
fn stamp(now: DateTime<Utc>) -> String {
    now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn text(row: &rusqlite::Row<'_>, index: usize, max: usize) -> rusqlite::Result<String> {
    match row.get_ref(index)? {
        rusqlite::types::ValueRef::Text(raw) if raw.len() <= max => std::str::from_utf8(raw)
            .map(str::to_owned)
            .map_err(|_| rusqlite::Error::InvalidQuery),
        _ => Err(rusqlite::Error::InvalidQuery),
    }
}
fn optional_text(
    row: &rusqlite::Row<'_>,
    index: usize,
    max: usize,
) -> rusqlite::Result<Option<String>> {
    if matches!(row.get_ref(index)?, rusqlite::types::ValueRef::Null) {
        Ok(None)
    } else {
        text(row, index, max).map(Some)
    }
}

fn dispose(
    conn: &Connection,
    id: &str,
    reason: &str,
    now: DateTime<Utc>,
) -> Result<(), ManifestWriteError> {
    unavailable(conn.execute("DELETE FROM run_configurations WHERE run_id=?1", [id]))?;
    let n=unavailable(conn.execute("UPDATE runs SET configuration_capture=?2,configuration_disposed_at=?3 WHERE run_id=?1 AND configuration_capture='recorded'",rusqlite::params![id,reason,stamp(now)]))?;
    if n != 1 {
        return Err(ManifestWriteError::Unavailable);
    }
    Ok(())
}
fn expire(
    conn: &Connection,
    vault: Option<&str>,
    now: DateTime<Utc>,
) -> Result<u64, ManifestWriteError> {
    let rows = {
        let mut q=unavailable(conn.prepare("SELECT c.run_id,r.ended_at FROM run_configurations c JOIN runs r ON r.run_id=c.run_id WHERE (?1 IS NULL OR c.vault_id=?1) AND r.outcome!='running' AND r.ended_at IS NOT NULL ORDER BY r.ended_at,r.run_id LIMIT ?2"))?;
        let rows = unavailable(q.query_map(
            rusqlite::params![vault, limits().cleanup_batch_rows as i64],
            |r| Ok((text(r, 0, 128)?, text(r, 1, 64)?)),
        ))?;
        unavailable(rows.collect::<rusqlite::Result<Vec<_>>>())?
    };
    let mut count = 0;
    for (id, ended) in rows {
        let ended = DateTime::parse_from_rfc3339(&ended)
            .map_err(|_| ManifestWriteError::Unavailable)?
            .with_timezone(&Utc);
        if now.signed_duration_since(ended).num_seconds() >= limits().completed_retention_seconds {
            dispose(conn, &id, "expired", now)?;
            count += 1;
        }
    }
    Ok(count)
}
pub fn record_configuration(
    writer: &Connection,
    manifest: &RunConfigurationManifestV1,
    now: DateTime<Utc>,
) -> Result<Recorded, ManifestWriteError> {
    let payload = encode(manifest)?;
    let tx = transaction(writer)?;
    let row=unavailable(tx.query_row("SELECT vault_id,store_uuid,actor,outcome,configuration_capture FROM runs WHERE run_id=?1",[&manifest.run_id],|r|Ok((text(r,0,128)?,optional_text(r,1,128)?,optional_text(r,2,128)?,text(r,3,32)?,text(r,4,32)?))).optional())?.ok_or(ManifestWriteError::Unavailable)?;
    if row.0 != manifest.vault_id
        || row.1 != manifest.store_uuid
        || selector_identity(crate::mcp::normalize_actor(row.2.as_deref()), false).sha256
            != manifest.effective_grant.actor_id.sha256
    {
        return Err(ManifestWriteError::Conflict);
    }
    if row.4 == "recorded" {
        let original = unavailable(
            tx.query_row(
                "SELECT manifest_json FROM run_configurations WHERE run_id=?1",
                [&manifest.run_id],
                |r| text(r, 0, limits().encoded_bytes),
            )
            .optional(),
        )?
        .ok_or(ManifestWriteError::Unavailable)?;
        return if original == payload {
            Ok(Recorded::AlreadyStored)
        } else {
            Err(ManifestWriteError::Conflict)
        };
    }
    if row.4 != "required" || row.3 != "running" {
        return Err(ManifestWriteError::Conflict);
    }
    expire(&tx, Some(&manifest.vault_id), now)?;
    let mut total: i64 = unavailable(tx.query_row(
        "SELECT coalesce(sum(payload_bytes),0) FROM run_configurations WHERE vault_id=?1",
        [&manifest.vault_id],
        |r| r.get(0),
    ))?;
    let size = i64::try_from(payload.len()).map_err(|_| ManifestWriteError::TooLarge)?;
    while total
        .checked_add(size)
        .ok_or(ManifestWriteError::Unavailable)?
        > limits().per_vault_payload_bytes
    {
        let old=unavailable(tx.query_row("SELECT c.run_id,c.payload_bytes FROM run_configurations c JOIN runs r ON r.run_id=c.run_id WHERE c.vault_id=?1 AND r.outcome!='running' AND r.ended_at IS NOT NULL ORDER BY r.ended_at,r.run_id LIMIT 1",[&manifest.vault_id],|r|Ok((text(r,0,128)?,r.get::<_,i64>(1)?))).optional())?;
        let Some((id, bytes)) = old else {
            unavailable(tx.execute("UPDATE runs SET configuration_capture='capture_failed',configuration_failure_code='active_capacity' WHERE run_id=?1 AND configuration_capture='required'",[&manifest.run_id]))?;
            unavailable(tx.commit())?;
            return Err(ManifestWriteError::ActiveCapacity);
        };
        if bytes <= 0 || bytes > limits().encoded_bytes as i64 {
            return Err(ManifestWriteError::Unavailable);
        }
        dispose(&tx, &id, "expired", now)?;
        total = total
            .checked_sub(bytes)
            .ok_or(ManifestWriteError::Unavailable)?;
    }
    unavailable(tx.execute("INSERT INTO run_configurations(run_id,vault_id,store_uuid,format,captured_at,manifest_json,payload_bytes) VALUES(?1,?2,?3,1,?4,?5,?6)",rusqlite::params![manifest.run_id,manifest.vault_id,manifest.store_uuid,stamp(now),payload,size]))?;
    let n=unavailable(tx.execute("UPDATE runs SET configuration_capture='recorded',configuration_failure_code=NULL WHERE run_id=?1 AND configuration_capture='required' AND outcome='running'",[&manifest.run_id]))?;
    if n != 1 {
        return Err(ManifestWriteError::Unavailable);
    }
    unavailable(tx.commit())?;
    Ok(Recorded::Stored)
}
fn current_scope(
    ro: &ReadOnly,
    ticket: &ConfigurationReadTicket,
) -> Result<crate::runtime::VaultScope, ConfigurationReadError> {
    let root = ticket
        .root
        .to_str()
        .ok_or(ConfigurationReadError::Unavailable)?;
    let id = crate::runtime::scope::derive_vault_id(&ticket.root);
    // Missing registration is an unknown scope. A registered scope whose
    // current process/store cannot be resolved remains unavailable below.
    let registered: bool = ro
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM vault_registry WHERE vault_id=?1 AND vault_path=?2)",
            rusqlite::params![id, root],
            |row| row.get(0),
        )
        .map_err(|_| ConfigurationReadError::Unavailable)?;
    if !registered {
        return Err(ConfigurationReadError::WrongScope);
    }
    let mut query=ro.prepare("SELECT s.store_uuid FROM app_sessions s JOIN vault_registry v ON v.vault_id=s.vault_id WHERE v.vault_id=?1 AND v.vault_path=?2 AND s.session_id=?3 AND s.close_precision='open' ORDER BY s.store_uuid LIMIT 2").map_err(|_|ConfigurationReadError::Unavailable)?;
    let rows = query
        .query_map(
            rusqlite::params![id, root, crate::runtime::sessions::session_id()],
            |r| text(r, 0, 128),
        )
        .map_err(|_| ConfigurationReadError::Unavailable)?;
    let stores = rows
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| ConfigurationReadError::Unavailable)?;
    if stores.len() != 1 || stores[0].is_empty() {
        return Err(ConfigurationReadError::Unavailable);
    }
    Ok(crate::runtime::VaultScope {
        vault_id: id,
        store_uuid: Some(stores[0].clone()),
    })
}
pub fn read_configuration(
    ro: &ReadOnly,
    ticket: &ConfigurationReadTicket,
    run_id: &str,
) -> Result<ConfigurationRead, ConfigurationReadError> {
    ticket.context.with_legacy_opening(&ticket.opening,||{
        if run_id.is_empty() || run_id.len()>128 {return Err(ConfigurationReadError::WrongScope);}
        let scope=current_scope(ro,ticket)?;
        let row=ro.query_row("SELECT r.configuration_capture,r.outcome,r.ended_at,c.manifest_json,c.payload_bytes,c.vault_id,c.store_uuid,c.format FROM runs r LEFT JOIN run_configurations c ON c.run_id=r.run_id WHERE r.run_id=?1 AND r.vault_id=?2 AND r.store_uuid IS ?3",rusqlite::params![run_id,scope.vault_id,scope.store_uuid],|r|{
            Ok((text(r,0,32)?,text(r,1,32)?,optional_text(r,2,64)?,optional_text(r,3,limits().encoded_bytes)?,r.get::<_,Option<i64>>(4)?,optional_text(r,5,128)?,optional_text(r,6,128)?,r.get::<_,Option<i64>>(7)?))
        }).optional().map_err(|_|ConfigurationReadError::Unavailable)?.ok_or(ConfigurationReadError::WrongScope)?;
        let reason=match row.0.as_str(){
            "legacy"=>Some(NotRecordedReason::Legacy),"expired"=>Some(NotRecordedReason::Expired),
            "deleted"=>Some(NotRecordedReason::Deleted),"capture_failed"=>Some(NotRecordedReason::CaptureFailed),
            "required" if row.1!="running"=>Some(NotRecordedReason::CaptureFailed),
            "required"=>return Err(ConfigurationReadError::Unavailable),
            "recorded"=>None,_=>return Err(ConfigurationReadError::Unavailable),
        };
        if let Some(reason)=reason {
            if row.3.is_some(){return Err(ConfigurationReadError::Unavailable);}
            return Ok(ConfigurationRead::NotRecorded {reason});
        }
        let payload=row.3.ok_or(ConfigurationReadError::Unavailable)?;
        if row.7!=Some(1) || row.4!=Some(payload.len() as i64) || row.5.as_deref()!=Some(scope.vault_id.as_str()) || row.6!=scope.store_uuid {
            return Err(ConfigurationReadError::Unavailable);
        }
        let manifest:RunConfigurationManifestV1=serde_json::from_str(&payload).map_err(|_|ConfigurationReadError::Unavailable)?;
        validate(&manifest,Validation::Historical).map_err(|_|ConfigurationReadError::Unavailable)?;
        if manifest.run_id!=run_id || manifest.vault_id!=scope.vault_id || manifest.store_uuid!=scope.store_uuid {return Err(ConfigurationReadError::Unavailable);}
        if row.1!="running" {
            // Terminal rows without a completion time have no knowable age.
            // Preserve their bytes but never turn that absence into forever.
            let ended=row.2.ok_or(ConfigurationReadError::Unavailable)?;
            let ended=DateTime::parse_from_rfc3339(&ended).map_err(|_|ConfigurationReadError::Unavailable)?.with_timezone(&Utc);
            if Utc::now().signed_duration_since(ended).num_seconds()>=limits().completed_retention_seconds {
                return Ok(ConfigurationRead::NotRecorded {reason:NotRecordedReason::Expired});
            }
        }
        Ok(ConfigurationRead::Recorded {manifest})
    }).map_err(|_|ConfigurationReadError::OpeningChanged)?
}
#[cfg(test)]
pub fn prune_configuration(
    writer: &Connection,
    vault_id: &str,
    now: DateTime<Utc>,
) -> Result<PruneReport, ManifestWriteError> {
    let tx = transaction(writer)?;
    let expired = expire(&tx, Some(vault_id), now)?;
    unavailable(tx.commit())?;
    Ok(PruneReport {
        expired,
        evicted: 0,
    })
}
pub fn maintenance_tick(
    data_dir: &Path,
    now: DateTime<Utc>,
) -> Result<PruneReport, ManifestWriteError> {
    let conn =
        crate::runtime::open_existing(data_dir).map_err(|_| ManifestWriteError::Unavailable)?;
    let tx = transaction(&conn)?;
    let expired = expire(&tx, None, now)?;
    unavailable(tx.commit())?;
    Ok(PruneReport {
        expired,
        evicted: 0,
    })
}
// One setup owner, no read-side or webview-owned cleanup worker. A stopped
// process has no daemon; logical expiry remains enforced by the SELECT reader.
pub(crate) fn start_cleanup(data_dir: PathBuf) {
    std::thread::spawn(move || loop {
        if maintenance_tick(&data_dir, Utc::now()).is_err() {
            log::warn!("run_configuration_cleanup_unavailable");
        }
        std::thread::sleep(std::time::Duration::from_secs(
            limits().cleanup_tick_seconds,
        ));
    });
}
#[cfg(test)]
pub fn delete_configuration(
    writer: &Connection,
    scope: &crate::runtime::VaultScope,
    run_id: &str,
    now: DateTime<Utc>,
) -> Result<DeleteOutcome, ManifestWriteError> {
    let tx = transaction(writer)?;
    let row=unavailable(tx.query_row("SELECT outcome,configuration_capture FROM runs WHERE run_id=?1 AND vault_id=?2 AND store_uuid IS ?3",rusqlite::params![run_id,scope.vault_id,scope.store_uuid],|r|Ok((text(r,0,32)?,text(r,1,32)?))).optional())?.ok_or(ManifestWriteError::Conflict)?;
    if row.0 == "running" {
        return Err(ManifestWriteError::Conflict);
    }
    if row.1 == "deleted" {
        return Ok(DeleteOutcome::AlreadyDeleted);
    }
    if row.1 != "recorded" {
        return Err(ManifestWriteError::Conflict);
    }
    dispose(&tx, run_id, "deleted", now)?;
    unavailable(tx.commit())?;
    Ok(DeleteOutcome::Deleted)
}
#[derive(Clone, Copy)]
pub(crate) enum PublicationFailureStage {
    BeforeStart,
    AfterStart,
}
impl PublicationFailureStage {
    fn code(self) -> &'static str {
        match self {
            Self::BeforeStart => "failed_before_start",
            Self::AfterStart => "failed_publication",
        }
    }
}
pub(crate) fn require_claim_capture(
    writer: &Connection,
    meter: &crate::agent::meter::Meter,
) -> Result<(), ManifestWriteError> {
    let tx = transaction(writer)?;
    let actor=unavailable(tx.query_row("SELECT actor FROM runs WHERE run_id=?1 AND vault_id IS ?2 AND store_uuid IS ?3 AND mode='ambient' AND outcome='running' AND configuration_capture='legacy'",rusqlite::params![meter.run_id,meter.vault_id,meter.store_uuid],|r|optional_text(r,0,128)).optional())?.ok_or(ManifestWriteError::Unavailable)?;
    if crate::mcp::normalize_actor(actor.as_deref())
        != crate::mcp::normalize_actor(meter.actor.as_deref())
    {
        return Err(ManifestWriteError::Unavailable);
    }
    let changed=unavailable(tx.execute("UPDATE runs SET configuration_capture='required' WHERE run_id=?1 AND outcome='running' AND configuration_capture='legacy'",[&meter.run_id]))?;
    if changed != 1 {
        return Err(ManifestWriteError::Unavailable);
    }
    unavailable(tx.commit())?;
    Ok(())
}
pub(crate) fn publication_failed(
    writer: &Connection,
    meter: &crate::agent::meter::Meter,
    stage: PublicationFailureStage,
    capture: Option<ManifestWriteError>,
    now: DateTime<Utc>,
) -> Result<(), ManifestWriteError> {
    let tx = transaction(writer)?;
    let run_id = &meter.run_id;
    let attended = meter.mode == crate::agent::meter::Mode::Attended;
    let row=unavailable(tx.query_row("SELECT configuration_capture,actor FROM runs WHERE run_id=?1 AND vault_id IS ?2 AND store_uuid IS ?3",rusqlite::params![run_id,meter.vault_id,meter.store_uuid],|r|Ok((text(r,0,32)?,optional_text(r,1,128)?))).optional())?;
    if row.as_ref().is_some_and(|(_, actor)| {
        crate::mcp::normalize_actor(actor.as_deref())
            != crate::mcp::normalize_actor(meter.actor.as_deref())
    }) {
        return Err(ManifestWriteError::Unavailable);
    }
    let state = row.map(|(state, _)| state);
    if state.as_deref() == Some("legacy") {
        if attended {
            crate::runtime::dispatch::discard_unstarted_attended(&tx, run_id)
                .map_err(|_| ManifestWriteError::Unavailable)?;
        }
    } else if state.is_some() {
        let code = match capture {
            Some(ManifestWriteError::TooLarge) => "too_large",
            Some(ManifestWriteError::ActiveCapacity) => "active_capacity",
            Some(ManifestWriteError::InvalidMetadata) => "invalid_metadata",
            Some(_) => "write_failed",
            None => "interrupted",
        };
        unavailable(tx.execute("UPDATE runs SET configuration_publication_failure=?2,configuration_capture=CASE WHEN configuration_capture='required' THEN 'capture_failed' ELSE configuration_capture END,configuration_failure_code=CASE WHEN configuration_capture='required' THEN ?3 ELSE configuration_failure_code END,ended_at=CASE WHEN ?4 THEN ?5 ELSE ended_at END,outcome=CASE WHEN ?4 THEN 'failed' ELSE outcome END,usage_state=CASE WHEN ?4 THEN 'unknown' ELSE usage_state END WHERE run_id=?1 AND outcome='running'",rusqlite::params![run_id,stage.code(),code,attended,stamp(now)]))?;
    }
    unavailable(tx.commit())?;
    Ok(())
}

#[cfg(test)]
#[path = "run_configuration_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "run_configuration_contract_tests.rs"]
mod contract_tests;
