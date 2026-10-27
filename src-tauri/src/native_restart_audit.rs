//! Fixed read-only R0 observations. No lifecycle writer, grant or callback.
use super::*;
use serde_json::{json, Value};
use std::cell::RefCell;
#[path = "native_restart_r1_audit.rs"]
pub(super) mod r1;
#[path = "native_restart_r2_audit.rs"]
pub(super) mod r2;

// One SELECT supplies a consistent SQLite snapshot, including the ordinary orphan.
// Every selected field is an ID/digest/count/timestamp/closed vocabulary, never a body.
const SNAPSHOT: &str = r#"
SELECT json_object(
 'parentRun',p.run_id,'childRun',c.run_id,'appSession',j.app_session_id,
 'claimedAt',j.claimed_at,'parentStarted',p.started_at,'deadline',r.deadline_at,
 'state',j.state,'ended',j.ended_at,'outcome',c.outcome,'runEnded',c.ended_at,
 'usage',c.usage_state,'nativeClosed',n.closed_at,'closeKind',n.close_kind,
 'revision',n.revision,'occupied',r.occupies_slot,
 'parentOutcome',p.outcome,'parentEnded',p.ended_at,'parentUsage',p.usage_state,
 'parentClose',pn.close_kind,'parentRevision',pn.revision,
 'oldPrecision',ses.close_precision,'oldClosed',ses.clean_closed_at,'oldHeartbeat',ses.last_heartbeat_at,
 'counts',json_array((SELECT count(*) FROM chat_delegation_intents),
  (SELECT count(*) FROM child_job_reservations),(SELECT count(*) FROM child_job_grant_freezes),
  (SELECT count(*) FROM child_job_claims),(SELECT count(*) FROM runs),
  (SELECT count(*) FROM run_configurations),(SELECT count(*) FROM action_native_runs WHERE source_kind='job'),
  (SELECT count(*) FROM action_account_grants),(SELECT count(*) FROM managed_connections),
  (SELECT count(*) FROM managed_connection_attempts),(SELECT count(*) FROM managed_connections WHERE secret_ref IS NOT NULL)),
 'joins',CASE WHEN
  a.parent_run_id=p.run_id AND a.attempt_id=i.attempt_id AND a.authority_id=i.authority_id
  AND pn.source_kind='run' AND pn.child_job_id IS NULL AND pn.parent_run_id IS NULL AND pn.client_id IS NULL
  AND pn.authority_id=i.authority_id AND pn.owner_person=i.owner_person AND pn.vault_id=i.vault_id
  AND pn.store_uuid=i.store_uuid AND pn.cli_session_id=i.parent_cli_session_id AND pn.app_session_id=i.app_session_id
  AND p.mode='attended' AND p.vault_id=i.vault_id AND p.store_uuid=i.store_uuid AND p.cli_session_id=i.parent_cli_session_id
  AND c.parent_run_id=p.run_id AND c.vault_id=i.vault_id AND c.store_uuid=i.store_uuid
  AND c.cli_session_id=r.reserved_cli_session_id AND c.actor='job:'||r.job_id AND c.mode='attended'
  AND c.configuration_capture='required' AND c.configuration_failure_code IS NULL
  AND c.configuration_disposed_at IS NULL AND c.configuration_publication_failure IS NULL
  AND json_extract(c.cause,'$.kind')='handoff' AND json_extract(c.cause,'$.subject')='cerebro-researcher'
  AND c.input_tokens=0 AND c.output_tokens=0 AND c.cache_read=0 AND c.cache_write=0
  AND n.source_kind='job' AND n.child_job_id=r.job_id AND n.parent_run_id=p.run_id AND n.client_id IS NULL
  AND n.cli_session_id=c.cli_session_id AND n.actor_id=c.actor AND n.vault_id=i.vault_id AND n.store_uuid=i.store_uuid
  AND n.owner_person=i.owner_person AND n.app_session_id=i.app_session_id AND n.app_session_id=j.app_session_id
  AND n.canonical_vault_path=pn.canonical_vault_path AND n.authority_id=j.authority_id AND n.authority_id<>pn.authority_id
  AND j.contract_digest=f.contract_digest AND c.started_at=j.claimed_at AND n.admitted_at=j.claimed_at
  AND NOT EXISTS(SELECT 1 FROM run_configurations WHERE run_id=c.run_id)
  THEN 1 ELSE 0 END,
 'immutable',json_array(i.slot_id,i.request_key,i.parent_run_id,i.attempt_id,i.authority_id,i.authority_revision,
  i.owner_person,i.vault_id,i.store_uuid,i.parent_cli_session_id,i.app_session_id,i.actor_id,i.slot_ordinal,
  r.job_id,r.reserved_run_id,r.reserved_cli_session_id,r.request_digest,r.deadline_at,r.elapsed_seconds,r.result_bytes,
  f.contract_digest,f.instruction_source_version,f.policy_digest,j.claim_id,j.run_id,j.authority_id,j.contract_digest,j.app_session_id,j.claimed_at,
  n.run_id,n.authority_id,n.vault_id,n.store_uuid,n.canonical_vault_path,n.owner_person,n.actor_id,n.source_kind,n.app_session_id,n.cli_session_id,n.parent_run_id,n.client_id,n.child_job_id,n.admitted_at,
  pn.run_id,pn.authority_id,pn.vault_id,pn.store_uuid,pn.canonical_vault_path,pn.owner_person,pn.actor_id,pn.source_kind,pn.app_session_id,pn.cli_session_id,pn.parent_run_id,pn.client_id,pn.child_job_id,pn.admitted_at,
  a.parent_run_id,a.attempt_id,a.authority_id))
FROM child_job_claims j
JOIN child_job_reservations r ON r.slot_id=j.slot_id AND r.reserved_run_id=j.run_id
JOIN child_job_grant_freezes f ON f.slot_id=r.slot_id
JOIN chat_delegation_intents i ON i.slot_id=r.slot_id
JOIN chat_parent_attempts a ON a.parent_run_id=i.parent_run_id
JOIN runs p ON p.run_id=i.parent_run_id JOIN action_native_runs pn ON pn.run_id=p.run_id
JOIN runs c ON c.run_id=j.run_id JOIN action_native_runs n ON n.run_id=c.run_id
JOIN app_sessions ses ON ses.session_id=j.app_session_id AND ses.vault_id=i.vault_id AND ses.store_uuid=i.store_uuid
WHERE (SELECT count(*) FROM child_job_claims)=1
"#;
pub(super) fn snapshot(config: &Path) -> Result<Value, &'static str> {
    let read = crate::runtime::ReadOnly::open(config).map_err(|_| "r0-snapshot-open")?;
    let text: String = read
        .query_row(SNAPSHOT, [], |r| r.get(0))
        .map_err(|_| "r0-snapshot-query")?;
    decode_snapshot(&text)
}
fn decode_snapshot(text: &str) -> Result<Value, &'static str> {
    if text.len() > 8192 {
        return Err("r0-snapshot-bound");
    }
    let mut value: Value = serde_json::from_str(text).map_err(|_| "r0-snapshot-json")?;
    let immutable = value
        .as_object_mut()
        .ok_or("r0-snapshot-shape")?
        .remove("immutable")
        .ok_or("r0-snapshot-immutable")?;
    value["immutableDigest"] = json!(crate::ledger::sha256_hex(immutable.to_string().as_bytes()));
    value["consumptions"] = json!(child_backend_consumptions());
    Ok(value)
}
pub(super) fn held(v: &Value) -> bool {
    v["counts"] == json!([1, 1, 1, 1, 2, 1, 1, 0, 0, 0, 0])
        && v["joins"] == 1
        && v["consumptions"] == 0
        && v["state"] == "claimed"
        && v["ended"].is_null()
        && v["outcome"] == "running"
        && v["runEnded"].is_null()
        && v["usage"] == "pending"
        && v["nativeClosed"].is_null()
        && v["closeKind"].is_null()
        && v["revision"] == 1
        && v["occupied"] == 1
        && v["parentOutcome"] == "running"
        && v["parentEnded"].is_null()
        && v["parentClose"].is_null()
        && v["parentRevision"] == 1
        && v["oldPrecision"] == "open"
        && v["oldClosed"].is_null()
}
#[derive(Serialize)]
struct Event {
    stage: &'static str,
    ok: Option<bool>,
    count: Option<usize>,
    snapshot: Option<Value>,
}
struct Trace {
    config: PathBuf,
    events: Vec<Event>,
    r1: bool,
    r2: bool,
}
thread_local! { static TRACE: RefCell<Option<Trace>> = const { RefCell::new(None) }; }
pub(super) fn arm(config: &Path) -> Result<(), &'static str> {
    arm_kind(config, false, false)
}
pub(super) fn arm_r1(config: &Path) -> Result<(), &'static str> {
    arm_kind(config, true, false)
}
pub(super) fn arm_r2(config: &Path) -> Result<(), &'static str> {
    arm_kind(config, false, true)
}
fn arm_kind(config: &Path, r1: bool, r2: bool) -> Result<(), &'static str> {
    TRACE.with(|cell| {
        let mut trace = cell.borrow_mut();
        if trace.is_some() {
            return Err("r0-trace-already-armed");
        }
        *trace = Some(Trace {
            config: config.to_owned(),
            events: Vec::with_capacity(5),
            r1,
            r2,
        });
        Ok(())
    })
}
// Only the current fixed verify worker arms this. Other profiles/production do no IO.
// Storage and SQLite writer guards have dropped; OPEN_LOCK still spans the call.
// ReadOnly has a five-second SQLite busy timeout. No gate, callback or file write.
pub(crate) fn note(stage: &'static str, ok: Option<bool>, count: Option<usize>) {
    TRACE.with(|cell| {
        let mut cell = cell.borrow_mut();
        let Some(trace) = cell.as_mut() else {
            return;
        };
        if trace.events.len() >= 5 {
            return;
        }
        let observed = if stage == "child" {
            (if trace.r2 {
                r2::snapshot(&trace.config)
            } else if trace.r1 {
                r1::snapshot(&trace.config)
            } else {
                snapshot(&trace.config)
            })
            .ok()
        } else {
            None
        };
        trace.events.push(Event {
            stage,
            ok,
            count,
            snapshot: observed,
        });
    });
}
pub(super) fn take(config: &Path) -> Result<Value, &'static str> {
    let trace = TRACE
        .with(|cell| cell.borrow_mut().take())
        .ok_or("r0-trace-missing")?;
    let observed = if trace.r2 {
        r2::snapshot(config)
    } else if trace.r1 {
        r1::snapshot(config)
    } else {
        snapshot(config)
    };
    Ok(json!({"events":trace.events,"snapshotAvailable":observed.is_ok(),"snapshot":observed.ok()}))
}

// track() returns unit; this reports its actual published row/window, not an
// invented Result. Every read happens only for the fixed armed R0 worker.
pub(crate) fn session_observed(config: &Path, scope: &crate::runtime::VaultScope) {
    let armed = TRACE.with(|cell| cell.borrow().is_some());
    if !armed {
        return;
    }
    let r2 = TRACE.with(|cell| cell.borrow().as_ref().is_some_and(|t| t.r2));
    let observed = (|| -> Result<bool, &'static str> {
        let read = crate::runtime::ReadOnly::open(config).map_err(|_| "r0-session-read")?;
        let count:i64=read.query_row("SELECT count(*) FROM app_sessions WHERE session_id=?1 AND vault_id=?2 AND store_uuid=?3 AND close_precision='open' AND clean_closed_at IS NULL",rusqlite::params![crate::runtime::sessions::session_id(),scope.vault_id,scope.store_uuid],|r|r.get(0)).map_err(|_|"r0-session-query")?;
        Ok(count == 1
            && crate::runtime::sessions::window_for(&scope.vault_id).is_some_and(|w| {
                w.precision
                    == (if r2 {
                        "clean_exact"
                    } else {
                        "heartbeat_lower_bound"
                    })
                    && w.cause == "app"
            }))
    })();
    note("session", observed.ok(), None);
}
