//! Actual original publication + retained SQL owner; no native-window proof.
use super::*;
use crate::actions::native_owner::tests::{chat_delegation::Refusal, PublicationSqlOwner};
use crate::runtime::child_jobs::FreezeDigests;
fn count(conn: &rusqlite::Connection) -> i64 {
    conn.query_row("SELECT count(*) FROM child_job_grant_freezes", [], |row| {
        row.get(0)
    })
    .unwrap()
}
#[test]
fn m95_freeze_sql_existing_reservation_binds_once_and_replays_only_retained_tuple() {
    m95_with_delegation_parent("m95-freeze-rows", None, |_, _, owner, conn, parent| {
        let intent = owner.m95_prepare_intent(&parent, 0).unwrap();
        let spec = m95_delegation_spec(&parent);
        let contract = "b".repeat(64);
        let policy = "c".repeat(64);
        let digests = FreezeDigests {
            contract: &contract,
            instruction_source: &spec.instruction_source_version,
            policy: &policy,
        };
        assert_eq!(
            owner.m95_freeze_metadata(&parent, &intent, &spec, &digests, None, 1000),
            Err(Refusal::Unavailable)
        );
        assert_eq!(count(conn), 0);
        let allocation = owner.m95_reserve(&parent, &intent, &spec, 1000).unwrap();
        assert_eq!(
            owner.m95_freeze_metadata(&parent, &intent, &spec, &digests, None, 1000),
            Ok(allocation.clone())
        );
        assert_eq!(
            owner.m95_freeze_metadata(&parent, &intent, &spec, &digests, Some(&allocation), 1001),
            Ok(allocation.clone())
        );
        assert_eq!(
            owner.m95_freeze_metadata(&parent, &intent, &spec, &digests, None, 1001),
            Err(Refusal::Unavailable)
        );
        let changed_contract = "d".repeat(64);
        let changed_digests = FreezeDigests {
            contract: &changed_contract,
            instruction_source: &spec.instruction_source_version,
            policy: &policy,
        };
        assert_eq!(
            owner.m95_freeze_metadata(
                &parent,
                &intent,
                &spec,
                &changed_digests,
                Some(&allocation),
                1001
            ),
            Err(Refusal::Unavailable)
        );
        assert_eq!(
            conn.query_row(
                "SELECT contract_digest FROM child_job_grant_freezes",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
            contract
        );
        assert_eq!(
            owner.m95_freeze_metadata(&parent, &intent, &spec, &digests, Some(&allocation), 1600),
            Err(Refusal::Deadline)
        );
        let mut changed = spec.clone();
        changed.objective.push_str(" changed");
        assert_eq!(
            owner.m95_freeze_metadata(
                &parent,
                &intent,
                &changed,
                &digests,
                Some(&allocation),
                1001
            ),
            Err(Refusal::RequestKeyConflict)
        );
        assert_eq!(count(conn), 1);
        assert_eq!(
            conn.query_row("SELECT count(*) FROM runs", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM action_native_runs WHERE source_kind='job'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        assert_eq!(
            conn.query_row("SELECT count(*) FROM action_account_grants", [], |row| row
                .get::<_, i64>(
                0
            ))
            .unwrap(),
            0
        );
    });
}
#[test]
fn m95_freeze_sql_precommit_failure_has_no_binding_and_does_not_retire_owner() {
    m95_with_delegation_parent("m95-freeze-abort", None, |_, _, owner, conn, parent| {
        let intent = owner.m95_prepare_intent(&parent, 0).unwrap();
        let spec = m95_delegation_spec(&parent);
        let allocation = owner.m95_reserve(&parent, &intent, &spec, 1000).unwrap();
        let contract = "b".repeat(64);
        let policy = "c".repeat(64);
        let digests = FreezeDigests {
            contract: &contract,
            instruction_source: &spec.instruction_source_version,
            policy: &policy,
        };
        conn.execute_batch("CREATE TRIGGER freeze_abort BEFORE INSERT ON child_job_grant_freezes BEGIN SELECT RAISE(ABORT,'injected precommit failure'); END;").unwrap();
        assert_eq!(
            owner.m95_freeze_metadata(&parent, &intent, &spec, &digests, None, 1000),
            Err(Refusal::Unavailable)
        );
        assert_eq!(count(conn), 0);
        assert!(!owner.m95_owner_is_retired());
        conn.execute_batch("DROP TRIGGER freeze_abort").unwrap();
        // This proves row-kernel rollback only; the native caller conservatively
        // closes after unavailable, and this helper cannot issue a capsule.
        assert_eq!(
            owner.m95_freeze_metadata(&parent, &intent, &spec, &digests, None, 1000),
            Ok(allocation)
        );
        assert_eq!(count(conn), 1);
    });
}
#[test]
fn m95_freeze_sql_lost_ack_and_reopened_owner_cannot_reconstruct_capsule() {
    m95_with_delegation_parent(
        "m95-freeze-lost-ack",
        None,
        |fixture, _, owner, conn, parent| {
            let intent = owner.m95_prepare_intent(&parent, 0).unwrap();
            let spec = m95_delegation_spec(&parent);
            let _allocation = owner.m95_reserve(&parent, &intent, &spec, 1000).unwrap();
            let contract = "b".repeat(64);
            let policy = "c".repeat(64);
            let digests = FreezeDigests {
                contract: &contract,
                instruction_source: &spec.instruction_source_version,
                policy: &policy,
            };
            assert_eq!(
                owner.m95_freeze_metadata_losing_ack(&parent, &intent, &spec, &digests, 1000),
                Err(Refusal::Unavailable)
            );
            assert!(owner.m95_owner_is_retired());
            assert_eq!(count(conn), 1);
            assert_eq!(
                owner.m95_freeze_metadata(&parent, &intent, &spec, &digests, None, 1001),
                Err(Refusal::Unavailable)
            );
            let mut reopened = PublicationSqlOwner::open(&fixture.meter.data_dir);
            assert_eq!(
                reopened.m95_freeze_metadata(&parent, &intent, &spec, &digests, None, 1001),
                Err(Refusal::Unavailable)
            );
            assert_eq!(count(conn), 1);
        },
    );
}
#[test]
fn m95_freeze_actual_mint_snapshot_detects_scope_and_tool_drift_with_same_receipt() {
    use crate::mcp::native_publication_test_support as transport;
    for scope in [true, false] {
        m95_with_delegation_parent("m95-freeze-mint-drift", None, |_, _, _, _, parent| {
            let before = parent.mcp.current_native_observation(parent.slot).unwrap();
            assert!(Arc::ptr_eq(before.receipt(), parent.receipt));
            transport::narrow_read_axes_for_freeze_probe(parent.mcp, parent.slot, scope);
            let after = parent.mcp.current_native_observation(parent.slot).unwrap();
            assert!(Arc::ptr_eq(after.receipt(), parent.receipt));
            assert!(!after.same_as(&before));
            transport::replace_listener_preserving_entries(parent.mcp);
            assert!(parent.mcp.current_native_observation(parent.slot).is_none());
        });
    }
}

// Same effective child axes are insufficient: the original observation and its
// actual authority/revision must also alter the immutable binding.
#[test]
fn m95_freeze_digest_binds_actual_parent_even_when_effective_child_axes_are_equal() {
    use crate::agent::child_jobs::freeze::{now, PreparedFreeze};
    use crate::mcp::native_publication_test_support as transport;
    for scope in [true, false] {
        m95_with_delegation_parent(
            "m95-freeze-parent-digest",
            None,
            |_, _, owner, conn, parent| {
                let mut spec = m95_delegation_spec(&parent);
                spec.deadline_at = now().unwrap() + 600;
                spec.instruction_source_version = crate::ledger::sha256_hex(
                    crate::agent::cli_agents::preset_prompt("cerebro-researcher")
                        .unwrap()
                        .as_bytes(),
                );
                spec.input_evidence_refs.clear();
                spec.requested_grant.read_scope = vec!["knowledge".into()];
                let intent = owner.m95_prepare_intent(&parent, 0).unwrap();
                let allocation = owner
                    .m95_reserve(&parent, &intent, &spec, now().unwrap())
                    .unwrap();
                let native = conn
                    .query_row(
                        crate::runtime::native_runs::RUN_SQL,
                        [parent.receipt.run_id()],
                        crate::runtime::native_runs::NativeRun::read,
                    )
                    .unwrap();
                let before = parent.mcp.current_native_observation(parent.slot).unwrap();
                let prepared = PreparedFreeze::prepare(parent.root, before.grant(), &spec).unwrap();
                let binding = before.binding_digest(&native);
                let digest = prepared.digest(&allocation, &before, &native);
                let mut changed = native.clone();
                changed.revision += 1;
                assert_ne!(digest, prepared.digest(&allocation, &before, &changed));
                changed = native.clone();
                changed.authority_id = "f".repeat(32);
                assert_ne!(digest, prepared.digest(&allocation, &before, &changed));
                transport::change_parent_with_same_child_axes_for_freeze_probe(
                    parent.mcp,
                    parent.slot,
                    scope,
                );
                let after = parent.mcp.current_native_observation(parent.slot).unwrap();
                let next = PreparedFreeze::prepare(parent.root, after.grant(), &spec).unwrap();
                assert_eq!(prepared.read_scope, next.read_scope);
                assert_eq!(prepared.tools, next.tools);
                assert!(!after.same_as(&before));
                assert_ne!(binding, after.binding_digest(&native));
                assert_ne!(digest, next.digest(&allocation, &after, &native));
                assert_eq!(count(conn), 0);
            },
        );
    }
}
