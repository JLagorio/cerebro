//! Real transaction state tests; no CLI, provider, process or account access.
use super::*;
use rusqlite::{params, Transaction, TransactionBehavior};
const KEY: &str = "11111111111111111111111111111111";
const DIGEST: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SESSION: &str = "12345678-1234-1234-1234-123456789abc";
const ANSWER: &str = "22222222222222222222222222222222";
fn scope() -> Scope<'static> {
    Scope {
        owner: "human:me",
        vault: "cccccccccccccccccccccccccccccccc",
        store: "store",
        actor: "claude-code",
        process: "process-one",
    }
}
fn db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "foreign_keys", true).unwrap();
    conn.execute_batch("CREATE TABLE vault_registry(vault_id TEXT PRIMARY KEY); INSERT INTO vault_registry VALUES('cccccccccccccccccccccccccccccccc');").unwrap();
    conn.execute_batch(crate::runtime::schema::SCHEMA_V42)
        .unwrap();
    conn.execute_batch(crate::runtime::schema::SCHEMA_V49)
        .unwrap();
    conn
}
fn tx<T>(conn: &Connection, f: impl FnOnce(&Connection) -> Result<T, Error>) -> Result<T, Error> {
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate).unwrap();
    let result = f(&tx)?;
    tx.commit().unwrap();
    Ok(result)
}
fn first(conn: &Connection) -> Receipt {
    match tx(conn, |tx| begin_rows(tx, scope(), KEY, DIGEST)).unwrap() {
        Admission::New(r) => r,
        other => panic!("first admission must own exactly one start: {other:?}"),
    }
}
fn read(conn: &Connection) -> Receipt {
    match tx(conn, |tx| begin_rows(tx, scope(), KEY, DIGEST)).unwrap() {
        Admission::Observed(r) => r,
        other => panic!("redelivery must never reacquire dispatch: {other:?}"),
    }
}
fn running(conn: &Connection) -> Receipt {
    let r = first(conn);
    tx(conn, |tx| {
        bind_session_rows(tx, scope(), &r.current_run_id, SESSION)
    })
    .unwrap();
    r
}
#[test]
fn generation_lost_ack_observes_original_ids_without_reacquiring_dispatch() {
    let conn = db();
    let r = first(&conn);
    let seen = read(&conn);
    assert_eq!(seen, r);
    assert_eq!(
        conn.query_row("SELECT count(*) FROM chat_generation_runs", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_ne!(r.generation_id, r.first_run_id);
}
#[test]
fn generation_same_key_changed_payload_conflicts_before_any_second_member() {
    let conn = db();
    first(&conn);
    assert_eq!(
        tx(&conn, |tx| begin_rows(tx, scope(), KEY, &"b".repeat(64))),
        Err(Error::Conflict)
    );
    assert_eq!(
        conn.query_row("SELECT count(*) FROM chat_generation_runs", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
}
#[test]
fn generation_same_key_changed_actor_cannot_hide_a_changed_request() {
    let conn = db();
    first(&conn);
    assert_eq!(
        tx(&conn, |tx| begin_rows(
            tx,
            Scope {
                actor: "process:other",
                ..scope()
            },
            KEY,
            DIGEST
        )),
        Err(Error::Conflict)
    );
}
#[test]
fn generation_admission_requires_an_enclosing_transaction() {
    let conn = db();
    assert_eq!(
        begin_rows(&conn, scope(), KEY, DIGEST),
        Err(Error::Unavailable)
    );
    assert_eq!(
        conn.query_row("SELECT count(*) FROM chat_generations", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
}
#[test]
fn generation_failed_initial_spawn_replays_failure_without_a_new_member() {
    let conn = db();
    let r = first(&conn);
    tx(&conn, |tx| {
        fail_unstarted_rows(tx, scope(), &r.current_run_id)
    })
    .unwrap();
    let seen = read(&conn);
    assert_eq!(seen.state, "failed");
    assert_eq!(seen.first_run_id, r.first_run_id);
}
#[test]
fn generation_resume_requires_exact_source_scope_and_session() {
    let conn = db();
    let r = running(&conn);
    for (sc, session) in [
        (
            Scope {
                store: "wrong",
                ..scope()
            },
            SESSION,
        ),
        (scope(), "12345678-1234-1234-1234-123456789abd"),
    ] {
        assert_eq!(
            tx(&conn, |tx| resume_rows(
                tx,
                sc,
                &r.current_run_id,
                session,
                ANSWER
            )),
            Err(Error::Denied)
        );
    }
    assert_eq!(
        tx(&conn, |tx| resume_rows(
            tx,
            scope(),
            "legacy-unlinked",
            SESSION,
            ANSWER
        )),
        Ok(None)
    );
    assert_eq!(
        conn.query_row("SELECT count(*) FROM chat_generation_runs", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
}
#[test]
fn generation_fast_held_answer_keeps_identity_and_late_original_exit_cannot_settle_it() {
    let conn = db();
    let r = running(&conn);
    let resumed = tx(&conn, |tx| {
        resume_rows(tx, scope(), &r.current_run_id, SESSION, ANSWER)
    })
    .unwrap();
    let Some(Admission::New(next)) = resumed else {
        panic!("trusted answer must append a member")
    };
    assert_eq!(next.generation_id, r.generation_id);
    assert_ne!(next.current_run_id, r.current_run_id);
    tx(&conn, |tx| {
        finish_rows(tx, scope(), &r.current_run_id, End::Deferred)
    })
    .unwrap();
    assert_eq!(read(&conn).current_run_id, next.current_run_id);
    assert_eq!(read(&conn).state, "admitted");
    assert_eq!(
        tx(&conn, |tx| resume_rows(
            tx,
            scope(),
            &r.current_run_id,
            SESSION,
            ANSWER
        )),
        Ok(Some(Admission::Observed(next.clone())))
    );
    tx(&conn, |tx| {
        bind_session_rows(tx, scope(), &next.current_run_id, SESSION)
    })
    .unwrap();
    tx(&conn, |tx| {
        finish_rows(tx, scope(), &next.current_run_id, End::Completed)
    })
    .unwrap();
    assert_eq!(read(&conn).state, "completed");
}
#[test]
fn generation_unstarted_resume_restores_waiting_predecessor_but_retains_failed_member() {
    let conn = db();
    let r = running(&conn);
    tx(&conn, |tx| {
        finish_rows(tx, scope(), &r.current_run_id, End::Deferred)
    })
    .unwrap();
    let Some(Admission::New(next)) = tx(&conn, |tx| {
        resume_rows(tx, scope(), &r.current_run_id, SESSION, ANSWER)
    })
    .unwrap() else {
        panic!("new member")
    };
    tx(&conn, |tx| {
        fail_unstarted_rows(tx, scope(), &next.current_run_id)
    })
    .unwrap();
    assert_eq!(read(&conn).current_run_id, r.current_run_id);
    assert_eq!(read(&conn).state, "deferred");
    let failed: String = conn
        .query_row(
            "SELECT state FROM chat_generation_runs WHERE run_id=?1",
            [&next.current_run_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(failed, "failed");
    let answer2 = "33333333333333333333333333333333";
    assert!(matches!(
        tx(&conn, |tx| resume_rows(
            tx,
            scope(),
            &r.current_run_id,
            SESSION,
            answer2
        )),
        Ok(Some(Admission::New(_)))
    ));
}
#[test]
fn generation_restart_interrupts_old_active_members_without_resend_or_repair() {
    let conn = db();
    let r = running(&conn);
    let fresh = Scope {
        process: "process-two",
        ..scope()
    };
    tx(&conn, |tx| recover_rows(tx, fresh)).unwrap();
    let seen = tx(&conn, |tx| begin_rows(tx, fresh, KEY, DIGEST)).unwrap();
    let Admission::Observed(seen) = seen else {
        panic!("restart cannot launch")
    };
    assert_eq!(seen.state, "interrupted");
    assert_eq!(seen.current_run_id, r.current_run_id);
    assert_eq!(
        tx(&conn, |tx| resume_rows(
            tx,
            fresh,
            &r.current_run_id,
            SESSION,
            ANSWER
        )),
        Err(Error::Denied)
    );
}
#[test]
fn generation_terminal_states_are_immutable_and_never_imply_effect_cancellation() {
    let conn = db();
    let r = running(&conn);
    tx(&conn, |tx| {
        finish_rows(tx, scope(), &r.current_run_id, End::Cancelled)
    })
    .unwrap();
    tx(&conn, |tx| {
        finish_rows(tx, scope(), &r.current_run_id, End::Completed)
    })
    .unwrap();
    assert_eq!(read(&conn).state, "cancelled");
    assert_eq!(
        tx(&conn, |tx| resume_rows(
            tx,
            scope(),
            &r.current_run_id,
            SESSION,
            ANSWER
        )),
        Err(Error::Denied)
    );
}
#[test]
fn generation_rollback_leaves_no_dispatch_or_partial_membership() {
    let conn = db();
    {
        let tx = Transaction::new_unchecked(&conn, TransactionBehavior::Immediate).unwrap();
        assert!(matches!(
            begin_rows(&tx, scope(), KEY, DIGEST),
            Ok(Admission::New(_))
        ));
    }
    assert_eq!(
        conn.query_row("SELECT count(*) FROM chat_generations", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    first(&conn);
}
#[test]
fn generation_foreign_process_cannot_settle_a_current_member() {
    let conn = db();
    let r = running(&conn);
    assert_eq!(
        tx(&conn, |tx| finish_rows(
            tx,
            Scope {
                process: "other",
                ..scope()
            },
            &r.current_run_id,
            End::Failed
        )),
        Err(Error::Denied)
    );
    assert_eq!(read(&conn).state, "running");
    let columns: Vec<String> = conn
        .prepare("SELECT name FROM pragma_table_info('chat_generations')")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert!(!columns
        .iter()
        .any(|name| name.contains("prompt") || name.contains("body") || name.contains("message")));
    let _: i64 = conn
        .query_row(
            "SELECT count(*) FROM chat_generation_runs WHERE generation_id=?1",
            params![r.generation_id],
            |r| r.get(0),
        )
        .unwrap();
}

#[test]
fn generation_cancelling_a_deferred_card_after_process_exit_settles_generation() {
    let conn = db();
    let r = running(&conn);
    tx(&conn, |tx| {
        finish_rows(tx, scope(), &r.current_run_id, End::Deferred)
    })
    .unwrap();
    tx(&conn, |tx| cancel_wait_rows(tx, scope(), &r.current_run_id)).unwrap();
    assert_eq!(read(&conn).state, "cancelled");
    assert_eq!(
        tx(&conn, |tx| resume_rows(
            tx,
            scope(),
            &r.current_run_id,
            SESSION,
            ANSWER
        )),
        Err(Error::Denied)
    );
}
#[test]
fn generation_failed_resumed_process_restores_the_unconsumed_wait() {
    let conn = db();
    let r = running(&conn);
    tx(&conn, |tx| {
        finish_rows(tx, scope(), &r.current_run_id, End::Deferred)
    })
    .unwrap();
    let Some(Admission::New(next)) = tx(&conn, |tx| {
        resume_rows(tx, scope(), &r.current_run_id, SESSION, ANSWER)
    })
    .unwrap() else {
        panic!("resume")
    };
    tx(&conn, |tx| {
        bind_session_rows(tx, scope(), &next.current_run_id, SESSION)
    })
    .unwrap();
    tx(&conn, |tx| {
        restore_waiting_rows(tx, scope(), &next.current_run_id)
    })
    .unwrap();
    assert_eq!(read(&conn).state, "deferred");
    assert_eq!(read(&conn).current_run_id, r.current_run_id);
    let failed: String = conn
        .query_row(
            "SELECT state FROM chat_generation_runs WHERE run_id=?1",
            [&next.current_run_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(failed, "failed");
    assert!(matches!(
        tx(&conn, |tx| resume_rows(
            tx,
            scope(),
            &r.current_run_id,
            SESSION,
            "33333333333333333333333333333333"
        )),
        Ok(Some(Admission::New(_)))
    ));
}
#[test]
fn generation_cancel_before_deferred_settlement_is_remembered_without_overwriting_success() {
    let conn = db();
    let r = running(&conn);
    tx(&conn, |tx| cancel_wait_rows(tx, scope(), &r.current_run_id)).unwrap();
    assert_eq!(
        read(&conn).state,
        "running",
        "a cancelled wait does not prove process exit"
    );
    tx(&conn, |tx| {
        finish_rows(tx, scope(), &r.current_run_id, End::Deferred)
    })
    .unwrap();
    assert_eq!(read(&conn).state, "cancelled");
    let conn = db();
    let r = running(&conn);
    tx(&conn, |tx| cancel_wait_rows(tx, scope(), &r.current_run_id)).unwrap();
    tx(&conn, |tx| {
        finish_rows(tx, scope(), &r.current_run_id, End::Completed)
    })
    .unwrap();
    assert_eq!(
        read(&conn).state,
        "completed",
        "a completed run is preserved even if Stop raced it"
    );
}
