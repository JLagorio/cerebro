//! Single joined native-run lineage validator and insert kernel. No caller proof factory.
use super::{native_db::AuthorityDb, native_rules::admission_rules};
use crate::runtime::native_runs::{NativeRun, RUN_SQL};
use rusqlite::{Connection, OptionalExtension};
use std::{collections::BTreeSet, path::Path};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum LineageError {
    Denied,
    Unavailable,
}
fn denied() -> LineageError {
    LineageError::Denied
}
fn unavailable() -> LineageError {
    LineageError::Unavailable
}

// Comparison data only. This cannot authenticate a caller or construct an
// ActionSubject. The production caller must already own a sealed native receipt
// and retained owner transaction; the legacy fixture adapter stays cfg(test).
pub(super) struct NativeBinding<'a> {
    pub run_id: &'a str,
    pub vault_id: &'a str,
    pub store_uuid: &'a str,
    pub canonical_vault: &'a Path,
    pub owner_person: &'a str,
    pub actor_id: &'a str,
    pub source_kind: &'a str,
    pub app_session_id: &'a str,
    pub cli_session_id: Option<&'a str>,
    pub parent_run_id: Option<&'a str>,
    pub client_id: Option<&'a str>,
    pub child_job_id: Option<&'a str>,
}
pub(super) struct ResolvedNative {
    pub row: NativeRun,
    pub can_call: bool,
}
pub(super) fn load_run(db: AuthorityDb<'_>, id: &str) -> Result<NativeRun, LineageError> {
    db.query(RUN_SQL, &[id], NativeRun::read)
        .optional()
        .map_err(|_| unavailable())?
        .ok_or_else(denied)
}
fn validate_row(r: &NativeRun, history: bool) -> Result<bool, LineageError> {
    if r.actual_vault.is_none() || r.actual_store.is_none() {
        return Err(unavailable());
    }
    if r.actual_vault.as_ref() != Some(&r.vault_id)
        || r.actual_store.as_ref() != Some(&r.store_uuid)
        || crate::mcp::normalize_actor(r.actual_actor.as_deref()) != r.actor_id
        || r.actual_cli != r.cli_session_id
        || r.actual_parent != r.parent_run_id
        || r.canonical_vault_path != r.vault_path
        || r.owner_person != admission_rules().owner_storage_key
        || r.revision == 0
        || r.revision > 9_007_199_254_740_991
        || r.authority_id.len() != 32
        || r.child_job_id.is_some()
        || r.source_kind == "job"
        || !admission_rules().source_kinds.contains(&r.source_kind)
        || (r.source_kind == "client") != r.client_id.is_some()
        || (r.source_kind == "run") != r.cli_session_id.is_some()
        || r.close_precision != "open"
    {
        return Err(denied());
    }
    if r.source_kind == "client"
        && (r.token_vault.as_ref() != Some(&r.vault_id)
            || r.token_slug.as_ref().map(|slug| format!("client:{slug}"))
                != Some(r.actor_id.clone()))
    {
        return Err(denied());
    }
    let running = r.outcome == "running" && r.ended_at.is_none() && r.close_kind.is_none();
    let naturally_ended = matches!(r.outcome.as_str(), "succeeded" | "failed")
        && r.ended_at.is_some()
        && r.close_kind.as_deref().is_none_or(|v| v == "completed");
    if !(running || history && naturally_ended) {
        return Err(denied());
    }
    Ok(running)
}
pub(super) fn resolve_lineage(
    db: AuthorityDb<'_>,
    p: &NativeBinding<'_>,
    history: bool,
) -> Result<ResolvedNative, LineageError> {
    let r = load_run(db, p.run_id)?;
    let can_call = validate_row(&r, history)?;
    if r.vault_id != p.vault_id
        || r.store_uuid != p.store_uuid
        || r.canonical_vault_path != p.canonical_vault.to_string_lossy()
        || r.owner_person != p.owner_person
        || r.actor_id != p.actor_id
        || r.source_kind != p.source_kind
        || r.app_session_id != p.app_session_id
        || r.cli_session_id.as_deref() != p.cli_session_id
        || r.parent_run_id.as_deref() != p.parent_run_id
        || r.client_id.as_deref() != p.client_id
        || r.child_job_id.as_deref() != p.child_job_id
    {
        return Err(denied());
    }
    let mut seen = BTreeSet::from([r.run_id.clone()]);
    let mut parent = r.parent_run_id.clone();
    while let Some(id) = parent {
        if seen.len() >= admission_rules().limits.ancestry_depth || !seen.insert(id.clone()) {
            return Err(denied());
        }
        let ancestor = load_run(db, &id)?;
        validate_row(&ancestor, true)?;
        if ancestor.owner_person != r.owner_person
            || ancestor.vault_id != r.vault_id
            || ancestor.store_uuid != r.store_uuid
            || ancestor.canonical_vault_path != r.canonical_vault_path
            || ancestor.app_session_id != r.app_session_id
        {
            return Err(denied());
        }
        parent = ancestor.parent_run_id;
    }
    Ok(ResolvedNative { row: r, can_call })
}
// Low-level row writer, not authentication. Accept only the caller-owned
// existing transaction; never start/commit it or open another database here.
pub(super) fn insert_if_absent(
    conn: &Connection,
    p: &NativeBinding<'_>,
    authority_id: &str,
    admitted_at: &str,
) -> Result<(), LineageError> {
    if conn.is_autocommit() {
        return Err(unavailable());
    }
    let exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM action_native_runs WHERE run_id=?1)",
            [p.run_id],
            |r| r.get(0),
        )
        .map_err(|_| unavailable())?;
    if !exists {
        // The caller authenticates provenance before this low-level writer; it
        // must resolve the joined lineage in this same transaction before commit.
        conn.execute("INSERT INTO action_native_runs(run_id,authority_id,revision,vault_id,store_uuid,canonical_vault_path,owner_person,actor_id,source_kind,app_session_id,cli_session_id,parent_run_id,client_id,child_job_id,admitted_at) VALUES(?1,?2,1,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",rusqlite::params![p.run_id,authority_id,p.vault_id,p.store_uuid,p.canonical_vault.to_str().ok_or_else(unavailable)?,p.owner_person,p.actor_id,p.source_kind,p.app_session_id,p.cli_session_id,p.parent_run_id,p.client_id,p.child_job_id,admitted_at]).map_err(|_|denied())?;
    }
    Ok(())
}
