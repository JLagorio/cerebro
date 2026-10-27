//! Authenticated original-root history; no live publication or executor proof.
use super::*;
use crate::actions::{
    effect_reads,
    effect_record::{hex_id, timestamp},
    read_types::*,
    recovery_read_types::*,
};
use crate::runtime::native_runs::{HistoryNativeRun, HISTORY_RUN_SQL};
use crate::workspace_service::authority::AuthorityContext;

pub(crate) fn inspect(
    app: &AppHandle,
    window: &WebviewWindow,
    run_id: &str,
) -> Result<ChatRecoveryInspection, ActionReadError> {
    // AppKit/window authentication is complete before any authority lock.
    let proof = authenticate(app, window).map_err(|_| read_unavailable())?;
    let context = crate::workspace_service::authority::context().map_err(|_| read_unavailable())?;
    inspect_authenticated(proof, &context, run_id)
}
struct AdmittedHistoryRead<'a> {
    read: &'a RetainedRead<'a>,
    origin: HistoryOrigin,
    owner: &'a str,
}
impl AdmittedHistoryRead<'_> {
    fn inspect(self) -> Result<ChatRecoveryInspection, ActionReadError> {
        effect_reads::inspect(self.read, self.origin, self.owner)
    }
}
fn inspect_authenticated(
    proof: AttendedWindowProof,
    context: &AuthorityContext,
    run_id: &str,
) -> Result<ChatRecoveryInspection, ActionReadError> {
    if run_id.is_empty() || run_id.len() > crate::actions::schema::history_limits().max_id_bytes {
        return Err(read_unavailable());
    }
    let (root, ticket) = context
        .capture_current_legacy_opening()
        .map_err(|_| read_unavailable())?;
    #[cfg(all(test, target_os = "macos"))]
    tests::checkpoint("after_capture");
    let store = read_native_store(&root).map_err(|_| read_unavailable())?;
    let result = context
        .with_legacy_opening(&ticket, || {
            if !proof.owner.registration.live.load(Ordering::SeqCst) {
                return Err(NativeOwnerError::Unavailable);
            }
            let mut storage = proof.owner.storage.lock().map_err(unavailable)?;
            if storage.failed {
                return Err(NativeOwnerError::Unavailable);
            }
            let owner = storage
                .owner
                .as_mut()
                .ok_or(NativeOwnerError::Unavailable)?;
            owner.read_snapshot(|read| {
                store.recheck()?;
                let result = (|| {
                    let found = read
                        .query(HISTORY_RUN_SQL, &[run_id], HistoryNativeRun::read)
                        .optional()
                        .map_err(|_| read_unavailable())?;
                    let historical = found.ok_or_else(|| ActionReadError {
                        code: ActionReadErrorCode::Denied,
                        retry_disposition: RetryDisposition::Never,
                        message: "Historical root is unavailable in this opening.".into(),
                    })?;
                    let origin = history_origin(historical, &root, &store.info.store_id)?;
                    AdmittedHistoryRead {
                        read,
                        origin,
                        owner: &crate::actions::schema::admission_rules().owner_storage_key,
                    }
                    .inspect()
                })();
                #[cfg(all(test, target_os = "macos"))]
                tests::checkpoint("before_return");
                store.recheck()?;
                if !proof.owner.registration.live.load(Ordering::SeqCst) {
                    return Err(NativeOwnerError::Unavailable);
                }
                Ok(result)
            })
        })
        .map_err(|_| read_unavailable())?
        .map_err(|_| read_unavailable())?;
    // A new opening between guards cannot revive the first ticket (including A-B-A).
    context
        .with_legacy_opening(&ticket, || {
            store.recheck()?;
            if !proof.owner.registration.live.load(Ordering::SeqCst) {
                return Err(NativeOwnerError::Unavailable);
            }
            let mut storage = proof.owner.storage.lock().map_err(unavailable)?;
            if storage.failed {
                return Err(NativeOwnerError::Unavailable);
            }
            storage
                .owner
                .as_mut()
                .ok_or(NativeOwnerError::Unavailable)?
                .validate()
        })
        .map_err(|_| read_unavailable())?
        .map_err(|_| read_unavailable())?;
    result
}
fn history_origin(
    h: HistoryNativeRun,
    root: &Path,
    store: &str,
) -> Result<HistoryOrigin, ActionReadError> {
    let r = &h.native;
    let rules = crate::actions::schema::admission_rules();
    let id_cap = crate::actions::schema::history_limits().max_id_bytes;
    if h.mode != "attended"
        || r.source_kind != "run"
        || r.parent_run_id.is_some()
        || r.actual_parent.is_some()
        || r.client_id.is_some()
        || r.child_job_id.is_some()
        || r.owner_person != rules.owner_storage_key
        || r.actual_vault.as_deref() != Some(&r.vault_id)
        || r.actual_store.as_deref() != Some(&r.store_uuid)
        || crate::mcp::normalize_actor(r.actual_actor.as_deref()) != r.actor_id
        || r.actual_cli != r.cli_session_id
        || r.cli_session_id
            .as_ref()
            .is_none_or(|v| v.is_empty() || v.len() > id_cap)
        || r.app_session_id.is_empty()
        || r.app_session_id.len() > id_cap
        || r.vault_id != crate::runtime::scope::derive_vault_id(root)
        || r.store_uuid != store
        || r.canonical_vault_path != root.to_string_lossy()
        || r.vault_path != r.canonical_vault_path
        || !hex_id(&r.authority_id, 32)
        || !hex_id(&h.attempt_id, 32)
        || h.attempt_authority != r.authority_id
        || r.revision == 0
        || r.revision > 9_007_199_254_740_991
    {
        return Err(read_unavailable());
    }
    let parse = |s: &str| timestamp(s).map_err(|_| read_unavailable());
    parse(&h.admitted_at)?;
    let started = parse(&h.started_at)?;
    let opened = parse(&h.opened_at)?;
    let heartbeat = parse(&h.heartbeat_at)?;
    let ended = r.ended_at.as_deref().map(parse).transpose()?;
    let closed = h.closed_at.as_deref().map(parse).transpose()?;
    let clean = h.clean_closed_at.as_deref().map(parse).transpose()?;
    if heartbeat < opened
        || ended.is_some_and(|v| v < started)
        || closed.is_some_and(|v| v < started)
        || clean.is_some_and(|v| v < opened)
        || h.closed_at.is_some() != r.close_kind.is_some()
    {
        return Err(read_unavailable());
    }
    let current = r.app_session_id == crate::runtime::sessions::session_id();
    match r.close_precision.as_str() {
        "open" if clean.is_none() && current => {}
        "clean_exact" if clean == Some(heartbeat) => {}
        "heartbeat_lower_bound" if clean.is_none() => {}
        _ => return Err(read_unavailable()),
    }
    if r.close_kind
        .as_deref()
        .is_some_and(|v| !matches!(v, "completed" | "stopped" | "revoked" | "context_closed"))
    {
        return Err(read_unavailable());
    }
    match r.outcome.as_str() {
        "running" if ended.is_none() => match r.close_kind.as_deref() {
            Some("stopped" | "revoked" | "context_closed") => {}
            None if r.close_precision == "open" && current => {}
            None if r.close_precision != "open" && !current => {}
            _ => return Err(read_unavailable()),
        },
        "succeeded"
        | "failed"
        | "quota_failed"
        | "elapsed_aborted"
        | "cancelled"
        | "abandoned_usage_unknown"
            if ended.is_some() => {}
        _ => return Err(read_unavailable()),
    }
    Ok(HistoryOrigin {
        root_attempt_id: h.attempt_id,
        run_id: r.run_id.clone(),
        vault_id: r.vault_id.clone(),
        store_id: r.store_uuid.clone(),
        actor_id: r.actor_id.clone(),
        cli_session_id: r.cli_session_id.clone().ok_or_else(read_unavailable)?,
        historical_app_session_id: r.app_session_id.clone(),
        outcome: r.outcome.clone(),
        started_at: h.started_at,
        ended_at: r.ended_at.clone(),
        native_closed_at: h.closed_at,
        native_close_kind: r.close_kind.clone(),
        app_close_precision: r.close_precision.clone(),
    })
}
#[cfg(all(test, target_os = "macos"))]
#[path = "native_chat_recovery_tests.rs"]
mod tests;
#[cfg(all(test, target_os = "macos"))]
pub(in crate::actions) fn inventory_observed() {
    tests::checkpoint("after_inventory");
}

#[cfg(all(test, target_os = "macos"))]
pub(in crate::actions) fn payload_observed() {
    tests::payload_observed();
}
