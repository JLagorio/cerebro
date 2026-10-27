//! M95 inert-reservation retirement through actual publication/retained owner.
//! No installed native-window origin, child executor or backend-isolation proof.
use super::*;
use crate::actions::native_owner::tests::{
    chat_delegation::{Allocation, Intent, ParentProbe, Refusal},
    PublicationSqlOwner,
};
use crate::runtime::child_jobs::FreezeDigests;
use std::collections::BTreeMap;

fn counts(conn: &rusqlite::Connection) -> (i64, i64) {
    conn.query_row(
        "SELECT count(*),coalesce(sum(occupies_slot),0) FROM child_job_reservations",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .expect("reservation accounting must be readable before behavior is asserted")
}

fn reservation_rows(conn: &rusqlite::Connection) -> Vec<String> {
    conn.prepare("SELECT json_array(slot_id,job_id,reserved_run_id,reserved_cli_session_id,request_digest,deadline_at,elapsed_seconds,result_bytes,occupies_slot) FROM child_job_reservations ORDER BY slot_id")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

fn immutable_rows(conn: &rusqlite::Connection) -> BTreeMap<String, String> {
    conn.prepare("SELECT slot_id,json_array(slot_id,job_id,reserved_run_id,reserved_cli_session_id,request_digest,deadline_at,elapsed_seconds,result_bytes) FROM child_job_reservations ORDER BY slot_id")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

fn freeze_rows(conn: &rusqlite::Connection) -> Vec<String> {
    conn.prepare("SELECT json_array(slot_id,contract_digest,instruction_source_version,policy_digest) FROM child_job_grant_freezes ORDER BY slot_id")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

fn assert_inert(conn: &rusqlite::Connection) {
    let facts: (i64, i64, i64) = conn.query_row(
        "SELECT (SELECT count(*) FROM runs WHERE run_id IN (SELECT reserved_run_id FROM child_job_reservations) OR run_id IN (SELECT job_id FROM child_job_reservations)),(SELECT count(*) FROM action_native_runs WHERE source_kind='job' OR child_job_id IS NOT NULL),(SELECT count(*) FROM action_account_grants)",
        [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
    ).unwrap();
    assert_eq!(
        facts,
        (0, 0, 0),
        "reservation cleanup created execution authority"
    );
}

fn reserve_pair(
    owner: &mut PublicationSqlOwner,
    parent: &ParentProbe<'_>,
    spec: &child_jobs::types::ChildJobSpec,
) -> [(Intent, Allocation); 2] {
    [0, 1].map(|ordinal| {
        let intent = owner.m95_prepare_intent(parent, ordinal).unwrap();
        let allocation = owner.m95_reserve(parent, &intent, spec, 1000).unwrap();
        (intent, allocation)
    })
}

fn stop_and_reap_leader(parent: &ParentProbe<'_>) {
    let (run, handle) = {
        let slots = lock(&parent.agents.slots);
        assert_eq!(
            slots.len(),
            1,
            "the fixture owns exactly one actual publication"
        );
        let (run, slot) = slots.iter().next().unwrap();
        (*run, slot.handle.clone())
    };
    assert!(parent.agents.stop(run).unwrap());
    handle.terminate(Duration::ZERO);
    // TERM/KILL delivery is not exit observation. Poll the existing try_wait
    // owner until it has reaped the leader, with a bounded fixture-only wait.
    let deadline = Instant::now() + Duration::from_secs(5);
    while handle.alive() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(
        !handle.alive(),
        "fixture leader exit observation timed out after five seconds; terminal books were not written"
    );
    // Handle::alive uses try_wait and reaps/caches the actual leader status.
    // The outer existing fixture still owns stdout/stderr/config/book cleanup.
}

fn finish_cancelled(fixture: &Fixture, parent: &ParentProbe<'_>, conn: &rusqlite::Connection) {
    stop_and_reap_leader(parent);
    meter::finish(
        &fixture.meter,
        &meter::Tally::default(),
        false,
        true,
        chrono::Utc::now(),
    );
    let terminal: (String, bool, String) = conn
        .query_row(
            "SELECT outcome,ended_at IS NOT NULL,usage_state FROM runs WHERE run_id=?1",
            [&fixture.meter.run_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(terminal, ("cancelled".into(), true, "unknown".into()));
}

// Break caught: a metered terminal parent's inert reservations permanently
// consume concurrency, or releasing them rewrites identity/history/freeze rows.
#[test]
fn m95_lifetime_settled_parent_retires_only_occupancy_under_next_original_parent() {
    m95_with_delegation_parent(
        "m95-life-settled",
        None,
        |first, scope, owner, conn, parent| {
            let spec = m95_delegation_spec(&parent);
            let original = reserve_pair(owner, &parent, &spec);
            let contract = "b".repeat(64);
            let policy = "c".repeat(64);
            let digests = FreezeDigests {
                contract: &contract,
                instruction_source: &spec.instruction_source_version,
                policy: &policy,
            };
            assert_eq!(
                owner.m95_freeze_metadata(&parent, &original[0].0, &spec, &digests, None, 1000),
                Ok(original[0].1.clone())
            );
            let identities = immutable_rows(conn);
            let frozen = freeze_rows(conn);
            assert_eq!(frozen.len(), 1);
            finish_cancelled(first, &parent, conn);
            assert_eq!(
                counts(conn),
                (2, 2),
                "retirement belongs to the next admission transaction"
            );
            assert_eq!(
                owner.m95_reserve(&parent, &original[0].0, &spec, 1000),
                Err(Refusal::Unavailable),
                "closed original publication must not replay authority"
            );
            m95_with_delegation_parent(
                "m95-life-next",
                Some((first, scope)),
                |next, _, next_owner, _, next_parent| {
                    assert_eq!(next.session.id(), first.session.id());
                    assert_ne!(next.meter.run_id, first.meter.run_id);
                    let intent = next_owner.m95_prepare_intent(&next_parent, 0).unwrap();
                    let next_spec = m95_delegation_spec(&next_parent);
                    let allocation = next_owner.m95_reserve(&next_parent, &intent, &next_spec, 1000)
                .expect("M95 causal RED: durably settled parent still consumes both concurrency slots");
                    assert_eq!(counts(conn), (3, 1));
                    assert_eq!(
                        next_owner.m95_reserve(&next_parent, &intent, &next_spec, 1000),
                        Ok(allocation)
                    );
                    let after = immutable_rows(conn);
                    for (slot, row) in &identities {
                        assert_eq!(after.get(slot), Some(row));
                    }
                    assert_eq!(freeze_rows(conn), frozen);
                    assert_inert(conn);
                },
            );
        },
    );
}

// Break caught: cancellation/request or dead in-memory slot is mistaken for
// recorded terminal settlement, before the meter has durably closed the parent.
#[test]
fn m95_lifetime_stop_request_without_terminal_books_keeps_occupancy() {
    m95_with_delegation_parent(
        "m95-life-stop-only",
        None,
        |first, scope, owner, conn, parent| {
            let spec = m95_delegation_spec(&parent);
            let original = reserve_pair(owner, &parent, &spec);
            let run = *lock(&parent.agents.slots).keys().next().unwrap();
            assert!(parent.agents.stop(run).unwrap());
            let before = reservation_rows(conn);
            m95_with_delegation_parent(
                "m95-life-before-books",
                Some((first, scope)),
                |_, _, next_owner, _, next_parent| {
                    let intent = next_owner.m95_prepare_intent(&next_parent, 0).unwrap();
                    assert_eq!(
                        next_owner.m95_reserve(
                            &next_parent,
                            &intent,
                            &m95_delegation_spec(&next_parent),
                            1000
                        ),
                        Err(Refusal::Concurrency)
                    );
                    assert_eq!(reservation_rows(conn), before);
                    let row: (String, Option<String>) = conn
                        .query_row(
                            "SELECT outcome,ended_at FROM runs WHERE run_id=?1",
                            [&first.meter.run_id],
                            |row| Ok((row.get(0)?, row.get(1)?)),
                        )
                        .unwrap();
                    assert_eq!(row, ("running".into(), None));
                },
            );
            assert_eq!(
                owner.m95_reserve(&parent, &original[0].0, &spec, 1000),
                Err(Refusal::Unavailable)
            );
            assert_eq!(counts(conn), (2, 2));
        },
    );
}

// Break caught: actual orphan-recovery facts are ignored, or recovery itself
// starts/retries children or erases the original lifetime charge.
#[test]
fn m95_lifetime_recorded_orphan_recovery_retires_at_next_original_reservation() {
    m95_with_delegation_parent(
        "m95-life-orphan",
        None,
        |first, scope, owner, conn, parent| {
            let spec = m95_delegation_spec(&parent);
            let original = reserve_pair(owner, &parent, &spec);
            let identities = immutable_rows(conn);
            stop_and_reap_leader(&parent);
            meter::recover_orphaned(
                &first.meter.data_dir,
                first.meter.started_at + chrono::Duration::seconds(1),
            );
            let terminal: (String, bool, String) = conn
                .query_row(
                    "SELECT outcome,ended_at IS NOT NULL,usage_state FROM runs WHERE run_id=?1",
                    [&first.meter.run_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .unwrap();
            assert_eq!(
                terminal,
                ("abandoned_usage_unknown".into(), true, "unknown".into())
            );
            assert_eq!(counts(conn), (2, 2));
            m95_with_delegation_parent(
                "m95-life-after-recovery",
                Some((first, scope)),
                |_, _, next_owner, _, next_parent| {
                    let intent = next_owner.m95_prepare_intent(&next_parent, 0).unwrap();
                    next_owner
                        .m95_reserve(
                            &next_parent,
                            &intent,
                            &m95_delegation_spec(&next_parent),
                            1000,
                        )
                        .expect(
                            "M95 causal RED: recorded orphan parent still consumes concurrency",
                        );
                    assert_eq!(counts(conn), (3, 1));
                    let after = immutable_rows(conn);
                    for (slot, row) in &identities {
                        assert_eq!(after.get(slot), Some(row));
                    }
                    assert_inert(conn);
                },
            );
            assert_eq!(
                owner.m95_reserve(&parent, &original[0].0, &spec, 1000),
                Err(Refusal::Unavailable)
            );
        },
    );
}

// Break caught: expiry is exclusive, renews the old deadline/identity, or a
// released reservation's metadata replay reoccupies its prior slot.
#[test]
fn m95_lifetime_expiry_is_inclusive_and_metadata_replay_cannot_reoccupy() {
    m95_with_delegation_parent("m95-life-expiry", None, |_, _, owner, conn, parent| {
        let spec = m95_delegation_spec(&parent);
        let original = reserve_pair(owner, &parent, &spec);
        let identities = immutable_rows(conn);
        let fresh = owner.m95_prepare_intent(&parent, 2).unwrap();
        let mut next_spec = spec.clone();
        next_spec.deadline_at = 2200;
        owner.m95_reserve(&parent, &fresh, &next_spec, 1600)
            .expect("M95 causal RED: expired inert reservations still consume concurrency at their deadline");
        assert_eq!(counts(conn), (3, 1));
        assert_eq!(
            owner.m95_reserve(&parent, &original[0].0, &spec, 1600),
            Ok(original[0].1.clone())
        );
        assert_eq!(counts(conn), (3, 1));
        let after = immutable_rows(conn);
        for (slot, row) in &identities {
            assert_eq!(after.get(slot), Some(row));
        }
        assert_inert(conn);
    });
}

// Break caught: expiry/reopen refunds lifetime admission or counts a duplicate
// replay as new; the expected ninth refusal is independent of concurrent slots.
#[test]
fn m95_lifetime_retirement_preserves_eight_across_owner_reopen_and_next_parent() {
    m95_with_delegation_parent(
        "m95-life-eight",
        None,
        |first, scope, owner, conn, parent| {
            let mut oldest = None;
            for ordinal in 0..8 {
                *owner = PublicationSqlOwner::open(&first.meter.data_dir);
                let now = 1000 + u64::from(ordinal) * 600;
                let mut spec = m95_delegation_spec(&parent);
                spec.deadline_at = now + 600;
                let intent = owner.m95_prepare_intent(&parent, ordinal).unwrap();
                let allocation = owner.m95_reserve(&parent, &intent, &spec, now)
                .expect("M95 causal RED: expired reservation prevents lifetime accounting from reaching eight");
                assert_eq!(counts(conn), (i64::from(ordinal) + 1, 1));
                if ordinal == 0 {
                    oldest = Some((intent, spec, allocation));
                }
            }
            let before = reservation_rows(conn);
            m95_with_delegation_parent(
                "m95-life-ninth",
                Some((first, scope)),
                |_, _, next_owner, _, next_parent| {
                    let intent = next_owner.m95_prepare_intent(&next_parent, 0).unwrap();
                    let mut spec = m95_delegation_spec(&next_parent);
                    spec.deadline_at = 6400;
                    assert_eq!(
                        next_owner.m95_reserve(&next_parent, &intent, &spec, 5800),
                        Err(Refusal::SessionAdmissions)
                    );
                },
            );
            assert_eq!(
                reservation_rows(conn),
                before,
                "failed ninth admission must roll back retirement too"
            );
            let (intent, spec, allocation) = oldest.unwrap();
            assert_eq!(
                owner.m95_reserve(&parent, &intent, &spec, 5800),
                Ok(allocation)
            );
            assert_eq!(counts(conn), (8, 1));
            assert_inert(conn);
        },
    );
}

// Break caught: scanning/retiring before validating request identity, intrinsic
// shape, existing digest/replay, or fresh deadline mutates a refused request.
#[test]
fn m95_lifetime_validation_conflict_and_replay_precede_retirement() {
    m95_with_delegation_parent("m95-life-order", None, |_, _, owner, conn, parent| {
        let spec = m95_delegation_spec(&parent);
        let original = reserve_pair(owner, &parent, &spec);
        let fresh = owner.m95_prepare_intent(&parent, 2).unwrap();
        let before = reservation_rows(conn);
        assert_eq!(
            owner.m95_reserve(&parent, &original[0].0, &spec, 1600),
            Ok(original[0].1.clone())
        );
        let mut changed = spec.clone();
        changed.objective.push_str(" changed");
        assert_eq!(
            owner.m95_reserve(&parent, &original[0].0, &changed, 1600),
            Err(Refusal::RequestKeyConflict)
        );
        let mut invalid = spec.clone();
        invalid.objective.clear();
        assert_eq!(
            owner.m95_reserve(&parent, &fresh, &invalid, 1600),
            Err(Refusal::InvalidSpec)
        );
        assert_eq!(
            owner.m95_reserve(&parent, &fresh, &spec, 1600),
            Err(Refusal::Deadline)
        );
        let mut wrong_parent = spec.clone();
        wrong_parent.parent_run_id = "other-parent".into();
        assert_eq!(
            owner.m95_reserve(&parent, &fresh, &wrong_parent, 1600),
            Err(Refusal::Unavailable)
        );
        assert_eq!(reservation_rows(conn), before);
        assert_eq!(counts(conn), (2, 2));
    });
}

// Break caught: expired rows authorize maintenance after the current actual
// listener/publication was replaced; no row selector may substitute for it.
#[test]
fn m95_lifetime_replaced_current_publication_cannot_retire_expired_rows() {
    m95_with_delegation_parent("m95-life-source", None, |_, _, owner, conn, parent| {
        let spec = m95_delegation_spec(&parent);
        reserve_pair(owner, &parent, &spec);
        let fresh = owner.m95_prepare_intent(&parent, 2).unwrap();
        let before = reservation_rows(conn);
        crate::mcp::native_publication_test_support::replace_listener_preserving_entries(
            parent.mcp,
        );
        let mut next = spec;
        next.deadline_at = 2200;
        assert_eq!(
            owner.m95_reserve(&parent, &fresh, &next, 1600),
            Err(Refusal::Unavailable)
        );
        assert_eq!(reservation_rows(conn), before);
    });
}

// Break caught: prior corrupt joins are treated as expired/absent and repaired
// by freeing capacity. The active successor's own provenance remains valid.
#[test]
fn m95_lifetime_corrupt_prior_parent_provenance_refuses_without_retirement() {
    for mutation in ["session", "actor", "terminal-time"] {
        m95_with_delegation_parent(
            "m95-life-corrupt",
            None,
            |first, scope, owner, conn, parent| {
                reserve_pair(owner, &parent, &m95_delegation_spec(&parent));
                finish_cancelled(first, &parent, conn);
                let sql = match mutation {
                    "session" => "UPDATE runs SET cli_session_id=NULL WHERE run_id=?1",
                    "actor" => "UPDATE runs SET actor='process:foreign' WHERE run_id=?1",
                    _ => "UPDATE runs SET ended_at=NULL WHERE run_id=?1",
                };
                assert_eq!(conn.execute(sql, [&first.meter.run_id]).unwrap(), 1);
                let before = reservation_rows(conn);
                m95_with_delegation_parent(
                    "m95-life-corrupt-next",
                    Some((first, scope)),
                    |_, _, next_owner, _, next_parent| {
                        let intent = next_owner.m95_prepare_intent(&next_parent, 0).unwrap();
                        let mut spec = m95_delegation_spec(&next_parent);
                        spec.deadline_at = 2200;
                        assert_eq!(
                            next_owner.m95_reserve(&next_parent, &intent, &spec, 1600),
                            Err(Refusal::Unavailable),
                            "corrupt prior {mutation} must not become permission to retire"
                        );
                        assert_eq!(reservation_rows(conn), before);
                    },
                );
            },
        );
    }
}

// Break caught: a reservation whose reserved execution identity already has a
// run row is retired as inert. The row is adversarial setup, never child proof.
#[test]
fn m95_lifetime_expiry_refuses_an_occupied_reserved_execution_identity() {
    m95_with_delegation_parent(
        "m95-life-not-inert",
        None,
        |fixture, scope, owner, conn, parent| {
            let spec = m95_delegation_spec(&parent);
            let original = reserve_pair(owner, &parent, &spec);
            crate::runtime::dispatch::begin_attended(
                conn,
                &original[0].1.run_id,
                Some(&scope.vault_id),
                scope.store_uuid.as_deref(),
                Some(crate::mcp::DEFAULT_ACTOR),
                Some(&fixture.meter.run_id),
                None,
                chrono::Utc::now(),
            )
            .unwrap();
            let before = reservation_rows(conn);
            let fresh = owner.m95_prepare_intent(&parent, 2).unwrap();
            let mut next = spec;
            next.deadline_at = 2200;
            assert_eq!(
                owner.m95_reserve(&parent, &fresh, &next, 1600),
                Err(Refusal::Unavailable)
            );
            assert_eq!(reservation_rows(conn), before);
        },
    );
}

// Break caught: cleanup commits ahead of allocation, or a definite insert
// rollback incorrectly retires the original RuntimeOwner.
#[test]
fn m95_lifetime_insert_failure_rolls_back_retirement_with_new_allocation() {
    m95_with_delegation_parent("m95-life-rollback", None, |_, _, owner, conn, parent| {
        let spec = m95_delegation_spec(&parent);
        reserve_pair(owner, &parent, &spec);
        let fresh = owner.m95_prepare_intent(&parent, 2).unwrap();
        let before = reservation_rows(conn);
        conn.execute_batch("CREATE TRIGGER m95_lifetime_abort BEFORE INSERT ON child_job_reservations BEGIN SELECT RAISE(ABORT,'lifetime allocation fault'); END;").unwrap();
        let mut next = spec;
        next.deadline_at = 2200;
        assert_eq!(
            owner.m95_reserve(&parent, &fresh, &next, 1600),
            Err(Refusal::Unavailable)
        );
        assert_eq!(reservation_rows(conn), before);
        assert!(!owner.m95_owner_is_retired());
        conn.execute_batch("DROP TRIGGER m95_lifetime_abort")
            .unwrap();
        owner.m95_reserve(&parent, &fresh, &next, 1600)
            .expect("M95 causal RED: definite rollback must leave the same owner able to retry inert metadata admission");
        assert_eq!(counts(conn), (3, 1));
    });
}

// Break caught: committed retirement loses the new reservation's lifetime
// charge on lost acknowledgment, or uncertainty returns/recreates a capability.
#[test]
fn m95_lifetime_lost_ack_keeps_one_commit_and_retires_original_owner() {
    m95_with_delegation_parent("m95-life-ack", None, |_, _, owner, conn, parent| {
        let spec = m95_delegation_spec(&parent);
        reserve_pair(owner, &parent, &spec);
        let identities = immutable_rows(conn);
        let fresh = owner.m95_prepare_intent(&parent, 2).unwrap();
        let mut next = spec;
        next.deadline_at = 2200;
        assert_eq!(
            owner.m95_reserve_losing_ack(&parent, &fresh, &next, 1600),
            Err(Refusal::Unavailable)
        );
        assert!(owner.m95_owner_is_retired());
        assert_eq!(
            counts(conn),
            (3, 1),
            "lost acknowledgment must follow the combined actual commit"
        );
        let committed = reservation_rows(conn);
        assert_eq!(
            owner.m95_reserve(&parent, &fresh, &next, 1600),
            Err(Refusal::Unavailable)
        );
        assert_eq!(reservation_rows(conn), committed);
        let after = immutable_rows(conn);
        for (slot, row) in &identities {
            assert_eq!(after.get(slot), Some(row));
        }
        assert_inert(conn);
    });
}

// Break caught: the sweep uses vault or owner alone and frees reservations
// from a different actual parent CLI session in the same runtime database.
#[test]
fn m95_lifetime_another_actual_cli_session_does_not_retire_foreign_slots() {
    m95_with_delegation_parent(
        "m95-life-session-scope",
        None,
        |first, scope, owner, conn, parent| {
            reserve_pair(owner, &parent, &m95_delegation_spec(&parent));
            let original = reservation_rows(conn);
            let mut other_session = Fixture::new(&first.vault, None, false);
            other_session.meter.data_dir = first.meter.data_dir.clone();
            assert_ne!(other_session.session.id(), first.session.id());
            m95_with_delegation_parent(
                "m95-life-other-session",
                Some((&other_session, scope)),
                |actual, _, next_owner, _, next_parent| {
                    assert_eq!(actual.session.id(), other_session.session.id());
                    assert_eq!(
                        next_parent.receipt.cli_session_id(),
                        Some(actual.session.id())
                    );
                    let intent = next_owner.m95_prepare_intent(&next_parent, 0).unwrap();
                    let mut spec = m95_delegation_spec(&next_parent);
                    spec.deadline_at = 2200;
                    next_owner
                        .m95_reserve(&next_parent, &intent, &spec, 1600)
                        .unwrap();
                    assert_eq!(counts(conn), (3, 3));
                    let after = reservation_rows(conn);
                    for row in &original {
                        assert!(after.contains(row));
                    }
                    assert_inert(conn);
                },
            );
        },
    );
}

// Break caught: matching CLI session alone crosses the caller's native vault/
// store scope. Both roots are actually published against their registered stores.
#[test]
fn m95_lifetime_another_vault_store_does_not_retire_same_cli_session_slots() {
    m95_with_delegation_parent(
        "m95-life-vault-scope",
        None,
        |first, _, owner, conn, parent| {
            reserve_pair(owner, &parent, &m95_delegation_spec(&parent));
            let original = reservation_rows(conn);
            // The outer fixture owns this nested test root's cleanup even on RED.
            let other_root = first.vault.join("separate-vault");
            std::fs::create_dir(&other_root).unwrap();
            let other_store =
                crate::ledger::store::load_or_mint(&crate::ledger::ledger_dir(&other_root))
                    .unwrap();
            let other_vault = crate::runtime::scope::register(conn, &other_root).unwrap();
            crate::runtime::catchup::open_session(
                conn,
                crate::runtime::sessions::session_id(),
                &other_vault,
                &other_store.store_id,
                chrono::Utc::now(),
            )
            .unwrap();
            let other_scope = crate::runtime::VaultScope {
                vault_id: other_vault,
                store_uuid: Some(other_store.store_id),
            };
            assert_ne!(other_scope.vault_id, parent.scope.vault_id);
            assert_ne!(other_scope.store_uuid, parent.scope.store_uuid);
            let mut other = Fixture::new(&other_root, None, false);
            other.meter.data_dir = first.meter.data_dir.clone();
            other.session = first.session.clone();
            m95_with_delegation_parent(
                "m95-life-other-vault",
                Some((&other, &other_scope)),
                |actual, _, next_owner, _, next_parent| {
                    assert_eq!(actual.session.id(), first.session.id());
                    assert_eq!(next_parent.root, other_root.as_path());
                    let intent = next_owner.m95_prepare_intent(&next_parent, 0).unwrap();
                    let mut spec = m95_delegation_spec(&next_parent);
                    spec.deadline_at = 2200;
                    next_owner
                        .m95_reserve(&next_parent, &intent, &spec, 1600)
                        .unwrap();
                    assert_eq!(counts(conn), (3, 3));
                    let after = reservation_rows(conn);
                    for row in &original {
                        assert!(after.contains(row));
                    }
                    assert_inert(conn);
                },
            );
        },
    );
}
