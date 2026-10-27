//! Historical SQL fixtures exercise no authority constructor or native caller.
//! Actual owner/sequential assertions live in native_child_claim_smoke.rs.
use super::*;
use crate::runtime::child_claim_history as claims;
const SLOT: &str = "dddddddddddddddddddddddddddddddd";
const CHILD: &str = "22222222222222222222222222222222";
const JOB: &str = "11111111111111111111111111111111";
const CHILD_SESSION: &str = "00000000-0000-4000-8000-000000000033";
fn at(seconds: i64) -> chrono::DateTime<chrono::Utc> {
    chrono::DateTime::parse_from_rfc3339(NOW)
        .unwrap()
        .with_timezone(&chrono::Utc)
        + chrono::Duration::seconds(seconds)
}
fn ready() -> Fixture {
    let f = Fixture::through_38();
    f.step_39();
    f.seed_intent("claude-code");
    let limits = crate::agent::child_jobs::limits::load().unwrap();
    let elapsed = i64::try_from(limits.max_elapsed_seconds).unwrap();
    let result_bytes = i64::try_from(limits.max_result_bytes).unwrap();
    let deadline = at(0).timestamp().checked_add(elapsed).unwrap();
    f.conn.execute("INSERT INTO child_job_reservations(slot_id,job_id,reserved_run_id,reserved_cli_session_id,request_digest,deadline_at,elapsed_seconds,result_bytes,occupies_slot) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,1)",
        params![SLOT,JOB,CHILD,CHILD_SESSION,"a".repeat(64),deadline,elapsed,result_bytes]).unwrap();
    for migration in MIGRATIONS.iter().filter(|m| m.to == 40 || m.to == 41) {
        step(&f.conn, migration).unwrap();
    }
    // Today's run writers and recovery skip runs a workflow originated, a
    // table a later schema adds. This store predates workflows, so it holds
    // none: an empty stand-in with the two columns those readers consult.
    f.conn
        .execute_batch(
            "CREATE TABLE workflow_run_origins(workflow_run_id TEXT PRIMARY KEY NOT NULL, native_run_id TEXT NOT NULL UNIQUE)",
        )
        .unwrap();
    f.conn
        .execute(
            "UPDATE runs SET started_at=?1 WHERE run_id='historic-parent'",
            [NOW],
        )
        .unwrap();
    f.conn
        .execute(
            "INSERT INTO child_job_grant_freezes VALUES(?1,?2,?3,?4)",
            params![SLOT, "b".repeat(64), "c".repeat(64), "d".repeat(64)],
        )
        .unwrap();
    f
}
fn seed_claim(f: &Fixture) {
    let parent = f
        .conn
        .query_row(
            crate::runtime::native_runs::RUN_SQL,
            ["historic-parent"],
            crate::runtime::native_runs::NativeRun::read,
        )
        .unwrap();
    let cause = crate::runtime::cause::RunCause::new(
        crate::runtime::cause::CauseKind::Handoff,
        Some("cerebro-researcher"),
        Some(JOB),
        None,
    );
    dispatch::begin_attended(
        &f.conn,
        CHILD,
        Some(&parent.vault_id),
        Some(&parent.store_uuid),
        Some(&format!("job:{JOB}")),
        Some(&parent.run_id),
        Some(&cause),
        at(1),
    )
    .unwrap();
    dispatch::record_cli_session(&f.conn, CHILD, CHILD_SESSION).unwrap();
    let stamp = at(1).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    f.conn.execute("INSERT INTO action_native_runs(run_id,authority_id,revision,vault_id,store_uuid,canonical_vault_path,owner_person,actor_id,source_kind,app_session_id,cli_session_id,parent_run_id,child_job_id,admitted_at) VALUES(?1,?2,1,?3,?4,?5,?6,?7,'job',?8,?9,?10,?11,?12)",
        params![CHILD,"f".repeat(32),parent.vault_id,parent.store_uuid,parent.canonical_vault_path,parent.owner_person,format!("job:{JOB}"),parent.app_session_id,CHILD_SESSION,parent.run_id,JOB,stamp]).unwrap();
    f.conn
        .execute(
            "INSERT INTO child_job_claims VALUES(?1,?2,?3,?4,?5,?6,?7,'claimed',NULL)",
            params![
                SLOT,
                "9".repeat(32),
                CHILD,
                "f".repeat(32),
                "b".repeat(64),
                parent.app_session_id,
                stamp
            ],
        )
        .unwrap();
}
fn snapshot(f: &Fixture) -> String {
    f.conn.query_row("SELECT json_array(c.state,c.ended_at,r.outcome,r.ended_at,r.usage_state,n.close_kind,n.closed_at,n.revision,s.occupies_slot) FROM child_job_claims c JOIN runs r ON r.run_id=c.run_id JOIN action_native_runs n ON n.run_id=r.run_id JOIN child_job_reservations s ON s.slot_id=c.slot_id",[],|r|r.get(0)).unwrap()
}
fn transaction<T>(
    f: &Fixture,
    operation: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    f.conn.execute_batch("BEGIN IMMEDIATE").unwrap();
    let result = operation(&f.conn);
    f.conn
        .execute_batch(if result.is_ok() { "COMMIT" } else { "ROLLBACK" })
        .unwrap();
    result
}
fn ordinary(f: &Fixture) {
    dispatch::begin_attended(
        &f.conn,
        "ordinary-orphan",
        None,
        None,
        None,
        None,
        None,
        at(0),
    )
    .unwrap();
}
fn close_parent(f: &Fixture, kind: &str) {
    f.conn.execute("UPDATE action_native_runs SET revision=revision+1,close_kind=?1,closed_at=?2 WHERE run_id='historic-parent'",
        params![kind,at(2).to_rfc3339_opts(chrono::SecondsFormat::Millis,true)]).unwrap();
    f.conn.execute("UPDATE runs SET outcome='cancelled',ended_at=?1,usage_state='unknown' WHERE run_id='historic-parent'",
        [at(2).to_rfc3339_opts(chrono::SecondsFormat::Millis,true)]).unwrap();
    let vault: String = f
        .conn
        .query_row(
            "SELECT vault_id FROM runs WHERE run_id='historic-parent'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    catchup::close_session(
        &f.conn,
        "historical-app-session",
        &vault,
        "store-one",
        at(2),
    )
    .unwrap();
}
#[test]
fn m95_claim_v41_preserves_history_and_has_no_backfill() {
    let f = ready();
    validate_v41(&f.conn).unwrap();
    assert_eq!(user_version(&f.conn).unwrap(), 41);
    assert_eq!(
        f.conn
            .query_row("SELECT count(*) FROM child_job_claims", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(history(&f.conn).len(), 1);
    f.finish();
}
#[test]
fn m95_claim_identity_terminal_disposition_and_body_shape_are_immutable() {
    let f = ready();
    seed_claim(&f);
    for sql in [
        "DELETE FROM child_job_claims",
        "UPDATE child_job_claims SET claim_id=claim_id",
        "INSERT OR REPLACE INTO child_job_claims SELECT * FROM child_job_claims",
    ] {
        assert!(f.conn.execute(sql, []).is_err(), "{sql}");
    }
    transaction(&f, |tx| {
        let h = claims::load(tx, SLOT)?;
        claims::settle(tx, &h, "backend_unavailable", at(3))
    })
    .unwrap();
    let before = snapshot(&f);
    assert!(transaction(&f, |tx| {
        let h = claims::load(tx, SLOT)?;
        claims::settle(tx, &h, "interrupted", at(4))
    })
    .is_err());
    assert_eq!(snapshot(&f), before);
    f.conn
        .execute_batch("ALTER TABLE child_job_claims ADD COLUMN body TEXT")
        .unwrap();
    assert!(validate_v41(&f.conn).is_err());
    f.finish();
}
#[test]
fn m95_claim_historical_stop_and_vault_close_need_no_live_parent_or_capsule() {
    for (close, state) in [("stopped", "cancelled"), ("context_closed", "interrupted")] {
        let f = ready();
        seed_claim(&f);
        close_parent(&f, close);
        transaction(&f, |tx| {
            let h = claims::load(tx, SLOT)?;
            claims::settle(tx, &h, state, at(3))
        })
        .unwrap();
        let state_read = transaction(&f, |tx| Ok(claims::load(tx, SLOT)?.state)).unwrap();
        assert_eq!(state_read, state);
        assert_eq!(
            f.conn
                .query_row(
                    "SELECT sum(occupies_slot) FROM child_job_reservations",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        f.finish();
    }
}
#[test]
fn m95_claim_restart_after_closed_old_session_settles_all_four_rows_once() {
    let f = ready();
    seed_claim(&f);
    close_parent(&f, "context_closed");
    ordinary(&f);
    assert_eq!(
        transaction(&f, |tx| claims::recover(tx, at(4), at(5))).unwrap(),
        1
    );
    assert_eq!(
        transaction(&f, |tx| claims::recover(tx, at(4), at(5))).unwrap(),
        0
    );
    let child = snapshot(&f);
    assert!(
        child.contains("interrupted")
            && child.contains("abandoned_usage_unknown")
            && child.contains("unknown")
    );
    assert_eq!(
        dispatch::recover_orphaned_attended(&f.conn, at(4), at(5)).unwrap(),
        1
    );
    assert_eq!(snapshot(&f), child);
    f.finish();
}
#[test]
fn m95_claim_failed_recovery_cannot_escape_to_generic_sweep() {
    let f = ready();
    seed_claim(&f);
    close_parent(&f, "stopped");
    ordinary(&f);
    // An otherwise valid claim with a changed child actor is corrupt, not inert.
    f.conn
        .execute(
            "UPDATE runs SET actor='process:forged' WHERE run_id=?1",
            [CHILD],
        )
        .unwrap();
    let before = snapshot(&f);
    assert!(transaction(&f, |tx| claims::recover(tx, at(4), at(5))).is_err());
    assert_eq!(snapshot(&f), before);
    assert_eq!(
        dispatch::recover_orphaned_attended(&f.conn, at(4), at(5)).unwrap(),
        1
    );
    assert_eq!(snapshot(&f), before);
    assert_eq!(
        f.conn
            .query_row(
                "SELECT outcome FROM runs WHERE run_id='ordinary-orphan'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "abandoned_usage_unknown"
    );
    f.finish();
}
#[test]
fn m95_claim_missing_join_protection_is_independent_of_valid_claim_or_native_row() {
    for removed in ["claim", "native", "both"] {
        let f = ready();
        seed_claim(&f);
        close_parent(&f, "stopped");
        ordinary(&f);
        f.conn.pragma_update(None, "foreign_keys", false).unwrap();
        f.conn
            .execute_batch("DROP TRIGGER child_job_claims_retained")
            .unwrap();
        if removed != "native" {
            f.conn.execute("DELETE FROM child_job_claims", []).unwrap();
        }
        if removed != "claim" {
            f.conn
                .execute("DELETE FROM action_native_runs WHERE run_id=?1", [CHILD])
                .unwrap();
        }
        assert!(transaction(&f, |tx| claims::recover(tx, at(4), at(5))).is_err());
        assert_eq!(
            dispatch::recover_orphaned_attended(&f.conn, at(4), at(5)).unwrap(),
            1
        );
        assert_eq!(
            f.conn
                .query_row("SELECT outcome FROM runs WHERE run_id=?1", [CHILD], |r| {
                    r.get::<_, String>(0)
                })
                .unwrap(),
            "running"
        );
        f.finish();
    }
}
#[test]
fn m95_claim_generic_finalizer_rechecks_protection_and_schema_failure_is_closed() {
    let f = ready();
    seed_claim(&f);
    ordinary(&f);
    let before = snapshot(&f);
    assert!(dispatch::finalize(
        &f.conn,
        CHILD,
        dispatch::RunOutcome::AbandonedUsageUnknown,
        None,
        None,
        dispatch::ItemOutcome::Requeue,
        at(5)
    )
    .is_err());
    assert_eq!(snapshot(&f), before);
    f.conn
        .execute_batch("ALTER TABLE child_job_claims RENAME TO missing_claims")
        .unwrap();
    assert!(dispatch::recover_orphaned_attended(&f.conn, at(4), at(5)).is_err());
    assert_eq!(
        f.conn
            .query_row(
                "SELECT outcome FROM runs WHERE run_id='ordinary-orphan'",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "running"
    );
    f.finish();
}
#[test]
fn m95_claim_mixed_classifier_validates_claimed_and_released_terminal_rows() {
    let f = ready();
    assert!(!transaction(&f, |tx| claims::actual_or_inert(
        tx,
        SLOT,
        JOB,
        CHILD,
        CHILD_SESSION
    ))
    .unwrap());
    seed_claim(&f);
    assert!(transaction(&f, |tx| claims::actual_or_inert(
        tx,
        SLOT,
        JOB,
        CHILD,
        CHILD_SESSION
    ))
    .unwrap());
    transaction(&f, |tx| {
        let h = claims::load(tx, SLOT)?;
        claims::settle(tx, &h, "backend_unavailable", at(3))
    })
    .unwrap();
    assert!(transaction(&f, |tx| claims::actual_or_inert(
        tx,
        SLOT,
        JOB,
        CHILD,
        CHILD_SESSION
    ))
    .unwrap());
    f.conn
        .execute(
            "UPDATE runs SET actor='process:wrong' WHERE run_id=?1",
            [CHILD],
        )
        .unwrap();
    assert!(transaction(&f, |tx| claims::actual_or_inert(
        tx,
        SLOT,
        JOB,
        CHILD,
        CHILD_SESSION
    ))
    .is_err());
    f.finish();
}
#[test]
fn m95_claim_corruption_matrix_refuses_without_partial_settlement() {
    for sql in [
        "UPDATE child_job_reservations SET occupies_slot=0",
        "UPDATE runs SET actor='process:wrong' WHERE run_id='22222222222222222222222222222222'",
        "UPDATE runs SET parent_run_id=NULL WHERE run_id='22222222222222222222222222222222'",
        "UPDATE runs SET store_uuid='wrong' WHERE run_id='22222222222222222222222222222222'",
        "UPDATE runs SET cli_session_id='other-session' WHERE run_id='22222222222222222222222222222222'",
        "UPDATE runs SET usage_state='unknown' WHERE run_id='22222222222222222222222222222222'",
        "UPDATE action_native_runs SET revision=2 WHERE run_id='22222222222222222222222222222222'",
        "UPDATE action_native_runs SET parent_run_id=NULL WHERE run_id='22222222222222222222222222222222'",
        "UPDATE action_native_runs SET actor_id='process:wrong' WHERE run_id='22222222222222222222222222222222'",
        "UPDATE action_native_runs SET app_session_id='missing-session' WHERE run_id='22222222222222222222222222222222'",
        "DROP TRIGGER child_job_grant_freezes_retained; DELETE FROM child_job_grant_freezes",
        "DROP TRIGGER child_job_claims_immutable; UPDATE child_job_claims SET contract_digest=printf('%064d',0)",
        "DROP TRIGGER child_job_claims_immutable; UPDATE child_job_claims SET run_id='missing-run'",
    ] {
        let f=ready();seed_claim(&f);
        f.conn.pragma_update(None,"foreign_keys",false).unwrap();
        f.conn.execute_batch(sql).unwrap();
        let before:String=f.conn.query_row("SELECT json_array(state,ended_at) FROM child_job_claims",[],|r|r.get(0)).unwrap();
        assert!(transaction(&f,|tx|claims::recover(tx,at(4),at(5))).is_err(),"{sql}");
        assert!(transaction(&f,|tx|claims::actual_or_inert(tx,SLOT,JOB,CHILD,CHILD_SESSION)).is_err(),"{sql}");
        assert_eq!(f.conn.query_row("SELECT json_array(state,ended_at) FROM child_job_claims",[],|r|r.get::<_,String>(0)).unwrap(),before);
        f.finish();
    }
}
#[test]
fn m95_claim_additional_execution_collision_refuses_even_after_terminal_release() {
    let f = ready();
    seed_claim(&f);
    transaction(&f, |tx| {
        let h = claims::load(tx, SLOT)?;
        claims::settle(tx, &h, "backend_unavailable", at(3))
    })
    .unwrap();
    dispatch::begin_attended(
        &f.conn,
        "colliding-descendant",
        None,
        None,
        None,
        Some(CHILD),
        None,
        at(4),
    )
    .unwrap();
    assert!(transaction(&f, |tx| claims::actual_or_inert(
        tx,
        SLOT,
        JOB,
        CHILD,
        CHILD_SESSION
    ))
    .is_err());
    f.finish();
}
#[test]
fn m95_claim_startup_registration_precedes_generic_recovery_and_opening_bind() {
    let source = include_str!("../lib.rs");
    let start = source
        .find("native_storage_ready = actions::native_owner::prepare_storage")
        .unwrap();
    let opening = &source[start..];
    let child = opening
        .find("actions::native_owner::recover_unstarted_children(&app, process_started())")
        .unwrap();
    let generic = opening
        .find("agent::meter::recover_orphaned(&dir, process_started())")
        .unwrap();
    let session = opening.find("runtime::sessions::track(&scope)").unwrap();
    let bind = opening.find("actions::native_owner::bind_opening").unwrap();
    assert!(child < generic && generic < session && session < bind);
}

#[test]
fn m95_claim_corrupt_released_history_rolls_back_prospective_inert_cleanup_and_admission() {
    use crate::agent::child_jobs::types::{ChildJobSpec, JobBudget, RequestedReadGrant};
    use crate::runtime::child_jobs as reservations;
    let f = ready();
    seed_claim(&f);
    transaction(&f, |tx| {
        let h = claims::load(tx, SLOT)?;
        claims::settle(tx, &h, "backend_unavailable", at(3))
    })
    .unwrap();
    let parent = f
        .conn
        .query_row(
            crate::runtime::native_runs::RUN_SQL,
            ["historic-parent"],
            crate::runtime::native_runs::NativeRun::read,
        )
        .unwrap();
    let limits = crate::agent::child_jobs::limits::load().unwrap();
    let now = at(4).timestamp() as u64;
    let spec = ChildJobSpec {
        parent_run_id: parent.run_id.clone(),
        parent_attempt_id: ATTEMPT.into(),
        objective: "historical accounting fixture".into(),
        instruction_source_version: "c".repeat(64),
        input_evidence_refs: vec![],
        result_schema_id: "read_evidence_summary.v1".into(),
        requested_grant: RequestedReadGrant {
            read_scope: vec!["projects".into()],
        },
        budget: JobBudget {
            elapsed_seconds: limits.max_elapsed_seconds as u32,
            result_bytes: limits.max_result_bytes as u32,
        },
        deadline_at: now + limits.max_elapsed_seconds,
    };
    let inert = transaction(&f, |tx| {
        let intent = reservations::prepare_intent_rows(tx, &parent, ATTEMPT, 1)
            .map_err(|e| format!("{e:?}"))?;
        reservations::reserve_rows(tx, &parent, ATTEMPT, &intent, &spec, now)
            .map_err(|e| format!("{e:?}"))?;
        Ok(intent)
    })
    .unwrap();
    let next = transaction(&f, |tx| {
        reservations::prepare_intent_rows(tx, &parent, ATTEMPT, 2).map_err(|e| format!("{e:?}"))
    })
    .unwrap();
    f.conn
        .execute(
            "UPDATE runs SET actor='process:corrupt' WHERE run_id=?1",
            [CHILD],
        )
        .unwrap();
    let later = spec.deadline_at;
    let next_spec = ChildJobSpec {
        deadline_at: later + limits.max_elapsed_seconds,
        ..spec
    };
    f.conn.execute_batch("BEGIN IMMEDIATE").unwrap();
    assert_eq!(
        reservations::reserve_rows(&f.conn, &parent, ATTEMPT, &next, &next_spec, later).err(),
        Some(reservations::Refusal::Unavailable)
    );
    f.conn.execute_batch("ROLLBACK").unwrap();
    assert_eq!(
        f.conn
            .query_row(
                "SELECT occupies_slot FROM child_job_reservations WHERE slot_id=?1",
                [&inert.slot_id],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    assert_eq!(
        f.conn
            .query_row("SELECT count(*) FROM child_job_reservations", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        2
    );
    f.finish();
}
#[test]
fn m95_claim_terminal_with_occupancy_and_partial_settlement_refuse() {
    for mutation in [
        "DROP TRIGGER child_job_reservations_immutable; UPDATE child_job_reservations SET occupies_slot=1",
        "UPDATE runs SET usage_state='pending' WHERE run_id='22222222222222222222222222222222'",
        "UPDATE action_native_runs SET close_kind='stopped' WHERE run_id='22222222222222222222222222222222'",
    ] {
        let f=ready();seed_claim(&f);
        transaction(&f,|tx|{let h=claims::load(tx,SLOT)?;claims::settle(tx,&h,"backend_unavailable",at(3))}).unwrap();
        f.conn.execute_batch(mutation).unwrap();
        assert!(transaction(&f,|tx|claims::actual_or_inert(tx,SLOT,JOB,CHILD,CHILD_SESSION)).is_err(),"{mutation}");
        f.finish();
    }
}

#[test]
fn m95_claim_signed_deadline_boundaries_refuse_without_partial_settlement() {
    for raw in [
        "-9223372036854775808",
        "-1",
        "0",
        "9007199254740992",
        "9223372036854775807",
        "18446744073709551615",
        "2000000000.5",
    ] {
        let f = ready();
        seed_claim(&f);
        // Model corrupted durable metadata, not an alternate authority path.
        f.conn.execute_batch(
            "PRAGMA ignore_check_constraints=ON; DROP TRIGGER child_job_reservations_immutable;",
        ).unwrap();
        f.conn
            .execute_batch(&format!(
                "UPDATE child_job_reservations SET deadline_at={raw}",
            ))
            .unwrap();
        let before = snapshot(&f);
        assert!(
            transaction(&f, |tx| claims::load(tx, SLOT)).is_err(),
            "{raw}"
        );
        assert!(
            transaction(&f, |tx| claims::recover(tx, at(4), at(5))).is_err(),
            "{raw}"
        );
        assert_eq!(snapshot(&f), before, "{raw}");
        f.finish();
    }
    // The existing exact counter ceiling is inclusive; do not narrow policy.
    let f = ready();
    seed_claim(&f);
    f.conn.execute_batch(
        "DROP TRIGGER child_job_reservations_immutable; UPDATE child_job_reservations SET deadline_at=9007199254740991;",
    ).unwrap();
    transaction(&f, |tx| {
        let history = claims::load(tx, SLOT)?;
        claims::settle(tx, &history, "interrupted", at(5))
    })
    .unwrap();
    assert_eq!(
        transaction(&f, |tx| Ok(claims::load(tx, SLOT)?.state)).unwrap(),
        "interrupted"
    );
    f.finish();
}
