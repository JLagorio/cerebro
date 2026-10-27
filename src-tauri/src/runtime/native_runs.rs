//! Joined native-run row reader; no authority or connection constructor.
use rusqlite::{Result, Row};

pub(super) fn counter(row: &Row<'_>, name: &str, minimum: u64) -> Result<u64> {
    let index = row.as_ref().column_index(name)?;
    let raw: i64 = row.get(index)?;
    u64::try_from(raw)
        .ok()
        .filter(|value| *value >= minimum && *value <= 9_007_199_254_740_991)
        .ok_or_else(|| {
            rusqlite::Error::FromSqlConversionFailure(
                index,
                rusqlite::types::Type::Integer,
                Box::new(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "Action authority counter is outside its exact range.",
                )),
            )
        })
}

pub(crate) const RUN_SQL: &str = "SELECT n.*,r.vault_id AS actual_vault,r.store_uuid AS actual_store,r.actor AS actual_actor,r.cli_session_id AS actual_cli,r.parent_run_id AS actual_parent,r.outcome,r.ended_at,v.vault_path,s.close_precision,t.vault_id AS token_vault,t.slug AS token_slug FROM action_native_runs n JOIN runs r ON r.run_id=n.run_id JOIN vault_registry v ON v.vault_id=n.vault_id JOIN app_sessions s ON s.session_id=n.app_session_id AND s.vault_id=n.vault_id AND s.store_uuid=n.store_uuid LEFT JOIN client_tokens t ON t.token_id=n.client_id WHERE n.run_id=?1";
#[derive(Debug, Clone)]
pub(crate) struct NativeRun {
    pub run_id: String,
    pub authority_id: String,
    pub revision: u64,
    pub vault_id: String,
    pub store_uuid: String,
    pub canonical_vault_path: String,
    pub owner_person: String,
    pub actor_id: String,
    pub source_kind: String,
    pub app_session_id: String,
    pub cli_session_id: Option<String>,
    pub parent_run_id: Option<String>,
    pub client_id: Option<String>,
    pub child_job_id: Option<String>,
    pub close_kind: Option<String>,
    pub actual_vault: Option<String>,
    pub actual_store: Option<String>,
    pub actual_actor: Option<String>,
    pub actual_cli: Option<String>,
    pub actual_parent: Option<String>,
    pub outcome: String,
    pub ended_at: Option<String>,
    pub vault_path: String,
    pub close_precision: String,
    pub token_vault: Option<String>,
    pub token_slug: Option<String>,
}
impl NativeRun {
    pub(crate) fn read(r: &Row<'_>) -> Result<Self> {
        use crate::connections::metadata::{bounded_optional_text, bounded_text};
        let l = &crate::actions::schema::admission_rules().limits;
        Ok(Self {
            run_id: bounded_text(r, "run_id", l.identity_bytes)?,
            authority_id: bounded_text(r, "authority_id", l.identity_bytes)?,
            revision: counter(r, "revision", 1)?,
            vault_id: bounded_text(r, "vault_id", l.identity_bytes)?,
            store_uuid: bounded_text(r, "store_uuid", l.identity_bytes)?,
            canonical_vault_path: bounded_text(r, "canonical_vault_path", l.canonical_path_bytes)?,
            owner_person: bounded_text(r, "owner_person", l.identity_bytes)?,
            actor_id: bounded_text(r, "actor_id", l.identity_bytes)?,
            source_kind: bounded_text(r, "source_kind", l.identity_bytes)?,
            app_session_id: bounded_text(r, "app_session_id", l.process_session_bytes)?,
            cli_session_id: bounded_optional_text(r, "cli_session_id", l.process_session_bytes)?,
            parent_run_id: bounded_optional_text(r, "parent_run_id", l.identity_bytes)?,
            client_id: bounded_optional_text(r, "client_id", l.identity_bytes)?,
            child_job_id: bounded_optional_text(r, "child_job_id", l.identity_bytes)?,
            close_kind: bounded_optional_text(r, "close_kind", l.identity_bytes)?,
            actual_vault: bounded_optional_text(r, "actual_vault", l.identity_bytes)?,
            actual_store: bounded_optional_text(r, "actual_store", l.identity_bytes)?,
            actual_actor: bounded_optional_text(r, "actual_actor", l.identity_bytes)?,
            actual_cli: bounded_optional_text(r, "actual_cli", l.process_session_bytes)?,
            actual_parent: bounded_optional_text(r, "actual_parent", l.identity_bytes)?,
            outcome: bounded_text(r, "outcome", l.identity_bytes)?,
            ended_at: bounded_optional_text(r, "ended_at", l.process_session_bytes)?,
            vault_path: bounded_text(r, "vault_path", l.canonical_path_bytes)?,
            close_precision: bounded_text(r, "close_precision", l.identity_bytes)?,
            token_vault: bounded_optional_text(r, "token_vault", l.identity_bytes)?,
            token_slug: bounded_optional_text(r, "token_slug", l.identity_bytes)?,
        })
    }
}

// Historical disclosure is separate from RUN_SQL's live execution validator.
pub(crate) const HISTORY_RUN_SQL:&str = "SELECT n.*,r.vault_id AS actual_vault,r.store_uuid AS actual_store,r.actor AS actual_actor,r.cli_session_id AS actual_cli,r.parent_run_id AS actual_parent,r.outcome,r.ended_at,r.mode AS history_mode,r.started_at AS history_started_at,v.vault_path,s.close_precision,s.opened_at AS session_opened_at,s.last_heartbeat_at,s.clean_closed_at,p.attempt_id,p.authority_id AS attempt_authority,NULL AS token_vault,NULL AS token_slug FROM action_native_runs n JOIN runs r ON r.run_id=n.run_id JOIN vault_registry v ON v.vault_id=n.vault_id JOIN app_sessions s ON s.session_id=n.app_session_id AND s.vault_id=n.vault_id AND s.store_uuid=n.store_uuid JOIN chat_parent_attempts p ON p.parent_run_id=n.run_id AND p.authority_id=n.authority_id WHERE n.run_id=?1";
pub(crate) struct HistoryNativeRun {
    pub native: NativeRun,
    pub mode: String,
    pub started_at: String,
    pub admitted_at: String,
    pub closed_at: Option<String>,
    pub opened_at: String,
    pub heartbeat_at: String,
    pub clean_closed_at: Option<String>,
    pub attempt_id: String,
    pub attempt_authority: String,
}
impl HistoryNativeRun {
    pub(crate) fn read(row: &Row<'_>) -> Result<Self> {
        use crate::connections::metadata::{bounded_optional_text, bounded_text};
        let l = crate::actions::schema::history_limits();
        // Preflight inherited optional columns before NativeRun allocates them.
        for name in ["ended_at", "app_session_id", "cli_session_id", "actual_cli"] {
            match row.get_ref(name)? {
                rusqlite::types::ValueRef::Null if name != "app_session_id" => {}
                rusqlite::types::ValueRef::Text(bytes) if bytes.len() <= l.max_timestamp_bytes => {}
                _ => return Err(rusqlite::Error::InvalidQuery),
            }
        }
        Ok(Self {
            native: NativeRun::read(row)?,
            mode: bounded_text(row, "history_mode", l.max_id_bytes)?,
            started_at: bounded_text(row, "history_started_at", l.max_timestamp_bytes)?,
            admitted_at: bounded_text(row, "admitted_at", l.max_timestamp_bytes)?,
            closed_at: bounded_optional_text(row, "closed_at", l.max_timestamp_bytes)?,
            opened_at: bounded_text(row, "session_opened_at", l.max_timestamp_bytes)?,
            heartbeat_at: bounded_text(row, "last_heartbeat_at", l.max_timestamp_bytes)?,
            clean_closed_at: bounded_optional_text(row, "clean_closed_at", l.max_timestamp_bytes)?,
            attempt_id: bounded_text(row, "attempt_id", l.max_id_bytes)?,
            attempt_authority: bounded_text(row, "attempt_authority", l.max_id_bytes)?,
        })
    }
}
