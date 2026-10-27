//! Metadata-only child lifecycle checking and terminal writes. No authority mint.
//! All writers require the retained owner's existing IMMEDIATE transaction.
use super::native_runs::{NativeRun, RUN_SQL};
use rusqlite::{params, Connection};

fn unavailable<T>(_: T) -> String {
    "child claim history unavailable".into()
}
fn require(ok: bool) -> Result<(), String> {
    if ok {
        Ok(())
    } else {
        Err(unavailable(()))
    }
}
fn hex(s: &str, n: usize) -> bool {
    s.len() == n
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn instant(s: &str) -> Result<chrono::DateTime<chrono::FixedOffset>, String> {
    require(s.ends_with('Z'))?;
    chrono::DateTime::parse_from_rfc3339(s).map_err(unavailable)
}

// Descriptive metadata, deliberately no owner/subject/grant constructor.
pub(crate) struct History {
    pub slot: String,
    pub claim: String,
    pub run: String,
    pub authority: String,
    pub contract: String,
    pub state: String,
    pub claimed_at: String,
    #[cfg(feature = "native-read-smoke")]
    pub deadline: u64,
    #[cfg(feature = "native-read-smoke")]
    pub child: NativeRun,
    #[cfg(feature = "native-read-smoke")]
    pub parent: NativeRun,
}

pub(crate) fn load(conn: &Connection, slot: &str) -> Result<History, String> {
    use crate::connections::metadata::bounded_text as text;
    require(!conn.is_autocommit() && hex(slot, 32))?;
    let (claim, run, authority, contract, session, claimed_at, state, ended): (
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        Option<String>,
    ) = conn
        .query_row(
            "SELECT * FROM child_job_claims WHERE slot_id=?1",
            [slot],
            |r| {
                Ok((
                    text(r, "claim_id", 32)?,
                    text(r, "run_id", 32)?,
                    text(r, "authority_id", 32)?,
                    text(r, "contract_digest", 64)?,
                    text(r, "app_session_id", 1024)?,
                    text(r, "claimed_at", 64)?,
                    text(r, "state", 32)?,
                    crate::connections::metadata::bounded_optional_text(r, "ended_at", 64)?,
                ))
            },
        )
        .map_err(unavailable)?;
    require(hex(&claim, 32) && hex(&run, 32) && hex(&authority, 32) && hex(&contract, 64))?;
    let child = conn
        .query_row(RUN_SQL, [&run], NativeRun::read)
        .map_err(unavailable)?;
    let parent_id = child
        .parent_run_id
        .as_deref()
        .ok_or_else(|| unavailable(()))?;
    let parent = conn
        .query_row(RUN_SQL, [parent_id], NativeRun::read)
        .map_err(unavailable)?;
    require(
        parent.source_kind == "run"
            && parent.parent_run_id.is_none()
            && parent.child_job_id.is_none()
            && parent.client_id.is_none()
            && parent
                .cli_session_id
                .as_deref()
                .is_some_and(super::cause::is_cli_session_id)
            && parent.owner_person == crate::actions::schema::admission_rules().owner_storage_key
            && hex(&parent.authority_id, 32)
            && parent.authority_id != authority,
    )?;
    for row in [&parent, &child] {
        require(
            row.actual_vault.as_ref() == Some(&row.vault_id)
                && row.actual_store.as_ref() == Some(&row.store_uuid)
                && crate::mcp::normalize_actor(row.actual_actor.as_deref()) == row.actor_id
                && row.actual_cli == row.cli_session_id
                && row.actual_parent == row.parent_run_id
                && row.canonical_vault_path == row.vault_path
                && matches!(
                    row.close_precision.as_str(),
                    "open" | "clean_exact" | "heartbeat_lower_bound"
                )
                && row.close_kind.as_deref().is_none_or(|v| {
                    matches!(v, "completed" | "stopped" | "revoked" | "context_closed")
                }),
        )?;
    }
    require(
        child.source_kind == "job"
            && child.client_id.is_none()
            && child.authority_id == authority
            && child.app_session_id == session
            && child.app_session_id == parent.app_session_id
            && child.owner_person == parent.owner_person
            && child.vault_id == parent.vault_id
            && child.store_uuid == parent.store_uuid
            && child.canonical_vault_path == parent.canonical_vault_path,
    )?;
    let limits = crate::agent::child_jobs::limits::load().map_err(unavailable)?;
    let valid: bool = conn.query_row(
        "SELECT count(*)=1 FROM child_job_claims c
         JOIN child_job_grant_freezes f ON f.slot_id=c.slot_id AND f.contract_digest=c.contract_digest
         JOIN child_job_reservations r ON r.slot_id=c.slot_id AND r.reserved_run_id=c.run_id
         JOIN chat_delegation_intents i ON i.slot_id=r.slot_id
         JOIN chat_parent_attempts a ON a.parent_run_id=i.parent_run_id AND a.attempt_id=i.attempt_id AND a.authority_id=i.authority_id
         JOIN action_native_runs p ON p.run_id=i.parent_run_id AND p.authority_id=i.authority_id
         JOIN action_native_runs n ON n.run_id=c.run_id AND n.authority_id=c.authority_id
         JOIN runs cr ON cr.run_id=c.run_id
         JOIN runs pr ON pr.run_id=p.run_id
         WHERE c.slot_id=?1 AND c.app_session_id=i.app_session_id
          AND n.parent_run_id=i.parent_run_id AND n.child_job_id=r.job_id
          AND n.cli_session_id=r.reserved_cli_session_id AND n.actor_id='job:'||r.job_id
          AND n.owner_person=i.owner_person AND n.vault_id=i.vault_id AND n.store_uuid=i.store_uuid
          AND n.app_session_id=i.app_session_id
          AND p.owner_person=i.owner_person AND p.vault_id=i.vault_id AND p.store_uuid=i.store_uuid
          AND p.app_session_id=i.app_session_id AND p.actor_id=i.actor_id
          AND p.cli_session_id=i.parent_cli_session_id AND p.revision>=i.authority_revision
          AND i.authority_revision>=1 AND i.slot_ordinal>=0 AND i.slot_ordinal<?2
          AND length(i.request_key)=32 AND i.request_key NOT GLOB '*[^0-9a-f]*' AND i.request_key<>i.slot_id
          AND length(i.attempt_id)=32 AND i.attempt_id NOT GLOB '*[^0-9a-f]*'
          AND length(r.job_id)=32 AND r.job_id NOT GLOB '*[^0-9a-f]*'
          AND r.job_id<>r.reserved_run_id AND r.job_id<>p.run_id AND r.reserved_run_id<>p.run_id
          AND r.reserved_cli_session_id<>i.parent_cli_session_id AND length(r.reserved_cli_session_id)=36
          AND length(r.request_digest)=64 AND r.request_digest NOT GLOB '*[^0-9a-f]*'
          AND length(f.instruction_source_version)=64 AND f.instruction_source_version NOT GLOB '*[^0-9a-f]*'
          AND length(f.policy_digest)=64 AND f.policy_digest NOT GLOB '*[^0-9a-f]*'
          AND r.elapsed_seconds BETWEEN 1 AND ?3 AND r.result_bytes BETWEEN 1 AND ?4
          AND r.deadline_at BETWEEN 1 AND 9007199254740991
          AND pr.mode='attended' AND cr.mode='attended' AND cr.configuration_capture='required'
          AND cr.configuration_failure_code IS NULL AND cr.configuration_disposed_at IS NULL
          AND cr.configuration_publication_failure IS NULL
          AND json_extract(cr.cause,'$.kind')='handoff'
          AND json_extract(cr.cause,'$.subject')='cerebro-researcher'
          AND cr.input_tokens=0 AND cr.output_tokens=0 AND cr.cache_read=0 AND cr.cache_write=0
          AND NOT EXISTS(SELECT 1 FROM run_configurations WHERE run_id=c.run_id)
          AND NOT EXISTS(SELECT 1 FROM action_account_grants WHERE run_id=c.run_id)",
        params![slot, limits.max_admissions, i64::try_from(limits.max_elapsed_seconds).map_err(unavailable)?, i64::try_from(limits.max_result_bytes).map_err(unavailable)?],
        |r| r.get(0),
    ).map_err(unavailable)?;
    require(valid)?;
    let (job, child_session, deadline, occupied): (String,String,u64,i64) = conn.query_row(
        "SELECT job_id,reserved_cli_session_id,deadline_at,occupies_slot FROM child_job_reservations WHERE slot_id=?1",
        [slot], |r| Ok((r.get(0)?,r.get(1)?,super::native_runs::counter(r, "deadline_at", 1)?,r.get(3)?)),
    ).map_err(unavailable)?;
    require(super::cause::is_cli_session_id(&child_session))?;
    exact_execution(conn, &job, &run, &child_session, 1)?;
    let (started, usage, native_started, native_ended): (String,String,String,Option<String>) = conn.query_row(
        "SELECT r.started_at,r.usage_state,n.admitted_at,n.closed_at FROM runs r JOIN action_native_runs n ON n.run_id=r.run_id WHERE r.run_id=?1",
        [&run], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)),
    ).map_err(unavailable)?;
    require(started == claimed_at && native_started == claimed_at)?;
    let began = instant(&claimed_at)?;
    require(began.timestamp() >= 0 && (began.timestamp() as u64) < deadline)?;
    let (parent_started, parent_closed): (String,Option<String>) = conn.query_row(
        "SELECT r.started_at,n.closed_at FROM runs r JOIN action_native_runs n ON n.run_id=r.run_id WHERE r.run_id=?1",
        [&parent.run_id], |r| Ok((r.get(0)?,r.get(1)?)),
    ).map_err(unavailable)?;
    let parent_began = instant(&parent_started)?;
    require(parent_began <= began && parent.close_kind.is_some() == parent_closed.is_some())?;
    if let Some(closed) = parent_closed.as_deref() {
        require(instant(closed)? >= began)?;
    }
    if parent.outcome == "running" {
        require(parent.ended_at.is_none())?;
    } else {
        require(matches!(
            parent.outcome.as_str(),
            "succeeded"
                | "failed"
                | "quota_failed"
                | "elapsed_aborted"
                | "cancelled"
                | "abandoned_usage_unknown"
        ))?;
        require(instant(parent.ended_at.as_deref().ok_or_else(|| unavailable(()))?)? >= began)?;
    }
    if state == "claimed" {
        require(
            ended.is_none()
                && occupied == 1
                && child.outcome == "running"
                && child.ended_at.is_none()
                && usage == "pending"
                && child.close_kind.is_none()
                && native_ended.is_none()
                && child.revision == 1,
        )?;
    } else {
        let (outcome, close) = disposition(&state)?;
        let ended = ended.as_deref().ok_or_else(|| unavailable(()))?;
        require(
            instant(ended)? >= began
                && occupied == 0
                && child.outcome == outcome
                && child.ended_at.as_deref() == Some(ended)
                && usage == "unknown"
                && native_ended.as_deref() == Some(ended)
                && child.close_kind.as_deref() == Some(close)
                && child.revision == 2,
        )?;
    }
    Ok(History {
        slot: slot.into(),
        claim,
        run,
        authority,
        contract,
        state,
        claimed_at,
        #[cfg(feature = "native-read-smoke")]
        deadline,
        #[cfg(feature = "native-read-smoke")]
        child,
        #[cfg(feature = "native-read-smoke")]
        parent,
    })
}

fn exact_execution(
    conn: &Connection,
    job: &str,
    run: &str,
    session: &str,
    expected: i64,
) -> Result<(), String> {
    let (runs,native):(i64,i64)=conn.query_row(
        "SELECT (SELECT count(*) FROM runs WHERE run_id IN (?1,?2) OR parent_run_id IN (?1,?2) OR cli_session_id=?3),
        (SELECT count(*) FROM action_native_runs WHERE run_id IN (?1,?2) OR parent_run_id IN (?1,?2) OR child_job_id IN (?1,?2) OR cli_session_id=?3)",
        params![job,run,session],|r|Ok((r.get(0)?,r.get(1)?)),
    ).map_err(unavailable)?;
    require(runs == expected && native == expected)
}

// Return true only for a completely validated actual lifecycle. Released rows
// are equally checked; no claim ID or occupancy shortcut bypasses corruption.
#[cfg(any(test, feature = "native-read-smoke"))]
pub(crate) fn actual_or_inert(
    conn: &Connection,
    slot: &str,
    job: &str,
    run: &str,
    session: &str,
) -> Result<bool, String> {
    let claims: i64 = conn
        .query_row(
            "SELECT count(*) FROM child_job_claims WHERE slot_id=?1 OR run_id IN (?2,?3)",
            params![slot, job, run],
            |r| r.get(0),
        )
        .map_err(unavailable)?;
    match claims {
        0 => {
            exact_execution(conn, job, run, session, 0)?;
            Ok(false)
        }
        1 => {
            let row = load(conn, slot)?;
            require(row.run == run)?;
            Ok(true)
        }
        _ => Err(unavailable(())),
    }
}
fn disposition(state: &str) -> Result<(&'static str, &'static str), String> {
    match state {
        "backend_unavailable" => Ok(("failed", "completed")),
        "cancelled" => Ok(("cancelled", "stopped")),
        "expired" => Ok(("elapsed_aborted", "context_closed")),
        "interrupted" => Ok(("abandoned_usage_unknown", "context_closed")),
        _ => Err(unavailable(())),
    }
}
// The retained owner's caller selects a terminal disposition; this row kernel
// cannot open storage, repair absent rows, expose authority or repeat a backend.
pub(crate) fn settle(
    conn: &Connection,
    history: &History,
    state: &str,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<(), String> {
    let checked = load(conn, &history.slot)?;
    require(
        checked.claim == history.claim
            && checked.run == history.run
            && checked.authority == history.authority
            && checked.contract == history.contract
            && checked.state == "claimed",
    )?;
    let (outcome, close) = disposition(state)?;
    let ended = now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    require(instant(&ended)? >= instant(&history.claimed_at)?)?;
    for changed in [
        conn.execute("UPDATE child_job_claims SET state=?2,ended_at=?3 WHERE slot_id=?1 AND state='claimed'",params![history.slot,state,ended]).map_err(unavailable)?,
        conn.execute("UPDATE runs SET outcome=?2,ended_at=?3,usage_state='unknown' WHERE run_id=?1 AND outcome='running' AND ended_at IS NULL",params![history.run,outcome,ended]).map_err(unavailable)?,
        conn.execute("UPDATE action_native_runs SET closed_at=?2,close_kind=?3,revision=revision+1 WHERE run_id=?1 AND closed_at IS NULL AND revision=1",params![history.run,ended,close]).map_err(unavailable)?,
        conn.execute("UPDATE child_job_reservations SET occupies_slot=0 WHERE slot_id=?1 AND occupies_slot=1",[&history.slot]).map_err(unavailable)?,
    ] { require(changed==1)?; }
    require(load(conn, &history.slot)?.state == state)
}

pub(crate) fn recover(
    conn: &Connection,
    cutoff: chrono::DateTime<chrono::Utc>,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<usize, String> {
    require(!conn.is_autocommit())?;
    // Detect unexplained protected rows first. No partial repair on bad history.
    let unexplained:bool=conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM action_native_runs n WHERE (n.source_kind='job' OR n.child_job_id IS NOT NULL)
            AND NOT EXISTS(SELECT 1 FROM child_job_claims c WHERE c.run_id=n.run_id))
        OR EXISTS(SELECT 1 FROM runs r JOIN child_job_reservations s ON s.reserved_run_id=r.run_id
            WHERE NOT EXISTS(SELECT 1 FROM child_job_claims c WHERE c.run_id=r.run_id AND c.slot_id=s.slot_id))",
        [],|r|r.get(0),
    ).map_err(unavailable)?;
    require(!unexplained)?;
    let mut statement = conn
        .prepare("SELECT slot_id FROM child_job_claims ORDER BY slot_id")
        .map_err(unavailable)?;
    let slots = statement
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(unavailable)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(unavailable)?;
    let mut pending = Vec::new();
    for slot in slots {
        let row = load(conn, &slot)?;
        if row.state == "claimed" && instant(&row.claimed_at)? < cutoff {
            pending.push(row);
        }
    }
    for row in &pending {
        settle(conn, row, "interrupted", now)?;
    }
    Ok(pending.len())
}
