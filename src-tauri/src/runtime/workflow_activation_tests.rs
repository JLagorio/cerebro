//! Actual migration-backed transaction fixtures; no native authority construction.
use super::*;
use crate::runtime::workflows as flow;
use rusqlite::{params, Transaction, TransactionBehavior};
const VAULT: &str = "cccccccccccccccccccccccccccccccc";
const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const KEY: &str = "11111111111111111111111111111111";
const NEXT: &str = "22222222222222222222222222222222";
const THIRD: &str = "33333333333333333333333333333333";
const PERMISSIONS: &str = r#"{"accounts":[],"queryRecords":false,"readPrefixes":[]}"#;
fn scope() -> Scope<'static> {
    Scope {
        owner: "human:me",
        vault: VAULT,
        store: "store",
        canonical_vault: "/synthetic/workflow-activation",
    }
}
fn selection() -> Selection<'static> {
    Selection {
        workflow: "workflow",
        version: HASH,
        schema: HASH,
        configuration: HASH,
        input: "{}",
        permissions: PERMISSIONS,
        interval_seconds: 60,
        catch_up: CatchUp::SkipMissed,
    }
}
struct Db {
    conn: Option<Connection>,
    dir: std::path::PathBuf,
}
impl std::ops::Deref for Db {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        self.conn.as_ref().unwrap()
    }
}
impl Drop for Db {
    fn drop(&mut self) {
        drop(self.conn.take());
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}
fn db() -> Db {
    let dir = crate::vault::testutil::temp_vault("workflow-activation-rows")
        .canonicalize()
        .unwrap();
    let conn = crate::runtime::open(&dir).unwrap();
    conn.execute("INSERT INTO vault_registry(vault_id,vault_path,first_seen_at) VALUES(?1,?2,'2026-10-26T00:00:00.000Z')",params![VAULT,scope().canonical_vault]).unwrap();
    Db {
        conn: Some(conn),
        dir,
    }
}
fn tx<T>(
    conn: &Connection,
    work: impl FnOnce(&Connection) -> Result<T, Error>,
) -> Result<T, Error> {
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate).unwrap();
    let value = work(&tx)?;
    tx.commit().unwrap();
    Ok(value)
}
fn enable(conn: &Connection) -> Changed {
    tx(conn, |c| {
        enable_rows(c, scope(), KEY, 0, selection(), 60_000)
    })
    .unwrap()
}
fn count(conn: &Connection, table: &str) -> i64 {
    let sql = match table {
        "activations" => "SELECT count(*) FROM workflow_activations",
        "requests" => "SELECT count(*) FROM workflow_activation_requests",
        "runs" => "SELECT count(*) FROM workflow_runs",
        "occurrences" => "SELECT count(*) FROM workflow_occurrences",
        _ => panic!("fixed table"),
    };
    conn.query_row(sql, [], |r| r.get(0)).unwrap()
}
#[test]
fn v48_installs_all_operational_identity_tables() {
    let conn = db();
    let head: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert!(head >= 48);
    let count:i64=conn.query_row("SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('workflow_activations','workflow_activation_requests','workflow_occurrences','workflow_activation_journal','workflow_activation_accounts')",[],|r|r.get(0)).unwrap();
    assert_eq!(count, 5);
}
#[test]
fn activation_mutations_require_actual_transaction() {
    let conn = db();
    assert_eq!(
        enable_rows(&conn, scope(), KEY, 0, selection(), 60_000),
        Err(Error::Unavailable)
    );
    assert_eq!(count(&conn, "activations"), 0);
}
#[test]
fn absent_activation_is_disabled_without_materializing_a_row() {
    let conn = db();
    assert_eq!(
        tx(&conn, |c| inspect_rows(c, scope(), "workflow")).unwrap(),
        None
    );
    assert_eq!((count(&conn, "activations"), count(&conn, "runs")), (0, 0));
}
#[test]
fn explicit_enable_pins_selected_material_without_starting_run() {
    let conn = db();
    let value = enable(&conn);
    assert_eq!(value.current.workflow, "workflow");
    assert_eq!(value.current.version, HASH);
    assert_eq!(value.current.configuration, HASH);
    assert_eq!(value.current.state, "enabled");
    assert_eq!(value.current.revision, 1);
    assert_eq!(value.current.anchor_ms, 60_000);
    assert_eq!(value.current.cursor_ms, 60_000);
    assert_eq!(value.current.epoch.len(), 32);
    assert!(!value.current.held);
    assert!(!value.replayed);
    assert_eq!(value.receipt.state, "enabled");
    assert_eq!(
        (
            count(&conn, "activations"),
            count(&conn, "requests"),
            count(&conn, "runs"),
            count(&conn, "occurrences")
        ),
        (1, 1, 0, 0)
    );
}
#[test]
fn lost_enable_ack_observes_same_epoch_despite_later_clock() {
    let conn = db();
    let first = enable(&conn);
    let again = tx(&conn, |c| {
        enable_rows(c, scope(), KEY, 0, selection(), 120_000)
    })
    .unwrap();
    assert_eq!(again.receipt, first.receipt);
    assert_eq!(again.current, first.current);
    assert!(again.replayed);
    assert_eq!(count(&conn, "requests"), 1);
}
#[test]
fn changed_material_under_enable_key_conflicts() {
    let conn = db();
    enable(&conn);
    let changed = Selection {
        input: "{\"changed\":true}",
        ..selection()
    };
    assert_eq!(
        tx(&conn, |c| enable_rows(c, scope(), KEY, 0, changed, 120_000)),
        Err(Error::Conflict)
    );
    assert_eq!(count(&conn, "requests"), 1);
}
#[test]
fn different_workflow_cannot_adopt_same_scoped_request_key() {
    let conn = db();
    enable(&conn);
    assert_eq!(
        tx(&conn, |c| enable_rows(
            c,
            scope(),
            KEY,
            0,
            Selection {
                workflow: "other",
                ..selection()
            },
            120_000
        )),
        Err(Error::Conflict)
    );
    assert_eq!(count(&conn, "activations"), 1);
}
#[test]
fn stale_enable_cannot_replace_current_selected_version() {
    let conn = db();
    let first = enable(&conn);
    let other = "b".repeat(64);
    assert_eq!(
        tx(&conn, |c| enable_rows(
            c,
            scope(),
            NEXT,
            0,
            Selection {
                version: &other,
                ..selection()
            },
            120_000
        )),
        Err(Error::Stale)
    );
    assert_eq!(
        tx(&conn, |c| inspect_rows(c, scope(), "workflow")).unwrap(),
        Some(first.current)
    );
}
#[test]
fn pause_is_cas_and_preserves_pinned_selection() {
    let conn = db();
    let first = enable(&conn);
    let paused = tx(&conn, |c| {
        pause_rows(c, scope(), NEXT, "workflow", 1, 120_000)
    })
    .unwrap();
    assert_eq!(paused.current.state, "paused");
    assert_eq!(paused.current.revision, 2);
    assert_eq!(paused.current.epoch, first.current.epoch);
    assert_eq!(paused.current.version, first.current.version);
    assert_eq!(paused.current.input_digest, first.current.input_digest);
    assert_eq!(
        tx(&conn, |c| pause_rows(
            c,
            scope(),
            THIRD,
            "workflow",
            1,
            130_000
        )),
        Err(Error::Stale)
    );
}
#[test]
fn old_enable_redelivery_after_pause_cannot_reenable() {
    let conn = db();
    let first = enable(&conn);
    let paused = tx(&conn, |c| {
        pause_rows(c, scope(), NEXT, "workflow", 1, 120_000)
    })
    .unwrap();
    let old = tx(&conn, |c| {
        enable_rows(c, scope(), KEY, 0, selection(), 180_000)
    })
    .unwrap();
    assert_eq!(old.receipt, first.receipt);
    assert_eq!(old.current, paused.current);
    assert!(old.replayed);
    assert_eq!(old.current.state, "paused");
}
#[test]
fn reenable_starts_distinct_epoch_at_explicit_instant() {
    let conn = db();
    let first = enable(&conn);
    tx(&conn, |c| {
        pause_rows(c, scope(), NEXT, "workflow", 1, 120_000)
    })
    .unwrap();
    let next = tx(&conn, |c| {
        enable_rows(c, scope(), THIRD, 2, selection(), 600_000)
    })
    .unwrap();
    assert_ne!(next.current.epoch, first.current.epoch);
    assert_eq!(next.current.revision, 3);
    assert_eq!(
        (next.current.anchor_ms, next.current.cursor_ms),
        (600_000, 600_000)
    );
    assert_eq!(next.current.state, "enabled");
}
#[test]
fn explicit_version_replace_keeps_single_mutable_binding() {
    let conn = db();
    let first = enable(&conn);
    let hash = "b".repeat(64);
    let next = tx(&conn, |c| {
        enable_rows(
            c,
            scope(),
            NEXT,
            1,
            Selection {
                version: &hash,
                ..selection()
            },
            120_000,
        )
    })
    .unwrap();
    assert_eq!(next.current.id, first.current.id);
    assert_ne!(next.current.epoch, first.current.epoch);
    assert_eq!(next.current.version, hash);
    assert_eq!(count(&conn, "activations"), 1);
}
#[test]
fn rollback_leaves_no_activation_or_idempotency_receipt() {
    let conn = db();
    let tx = Transaction::new_unchecked(&conn, TransactionBehavior::Immediate).unwrap();
    enable_rows(&tx, scope(), KEY, 0, selection(), 60_000).unwrap();
    tx.rollback().unwrap();
    assert_eq!(
        (count(&conn, "activations"), count(&conn, "requests")),
        (0, 0)
    );
}
#[test]
fn inspection_is_query_only_and_never_a_grant_or_launch() {
    let conn = db();
    let first = enable(&conn);
    conn.execute_batch("PRAGMA query_only=ON").unwrap();
    let tx = Transaction::new_unchecked(&conn, TransactionBehavior::Deferred).unwrap();
    assert_eq!(
        inspect_rows(&tx, scope(), "workflow").unwrap(),
        Some(first.current)
    );
    assert_eq!((count(&tx, "requests"), count(&tx, "runs")), (1, 0));
    tx.rollback().unwrap();
    conn.execute_batch("PRAGMA query_only=OFF").unwrap();
}
#[test]
fn activation_identity_survives_actual_database_reopen() {
    let mut conn = db();
    let first = enable(&conn);
    drop(conn.conn.take());
    conn.conn = Some(crate::runtime::open_existing(&conn.dir).unwrap());
    assert_eq!(
        tx(&conn, |c| inspect_rows(c, scope(), "workflow")).unwrap(),
        Some(first.current)
    );
}
#[test]
fn same_store_replacement_path_is_not_adopted() {
    let conn = db();
    enable(&conn);
    assert_eq!(
        tx(&conn, |c| inspect_rows(
            c,
            Scope {
                canonical_vault: "/replacement",
                ..scope()
            },
            "workflow"
        )),
        Err(Error::Denied)
    );
    assert_eq!(
        tx(&conn, |c| inspect_rows(
            c,
            Scope {
                store: "other",
                ..scope()
            },
            "workflow"
        ))
        .unwrap(),
        None
    );
}
#[test]
fn pending_pointer_journal_holds_existing_and_refuses_new_enable() {
    let conn = db();
    let first = enable(&conn);
    conn.execute("INSERT INTO workflow_activation_journal(transition_id,owner_person,vault_id,store_uuid,canonical_vault_path,workflow_id,expected_publication_revision,expected_definition_hash,phase,created_at_ms,updated_at_ms) VALUES(?1,'human:me',?2,'store',?3,'workflow',1,?4,'prepared',60000,60000)",params![THIRD,VAULT,scope().canonical_vault,HASH]).unwrap();
    let held = tx(&conn, |c| inspect_rows(c, scope(), "workflow"))
        .unwrap()
        .unwrap();
    assert!(held.held);
    assert_eq!(held.epoch, first.current.epoch);
    assert_eq!(
        tx(&conn, |c| enable_rows(
            c,
            scope(),
            NEXT,
            1,
            selection(),
            120_000
        )),
        Err(Error::Denied)
    );
    assert_eq!(count(&conn, "requests"), 1);
}
#[test]
fn configuration_input_preserves_exact_decimal_canonical_value() {
    let conn = db();
    let exact = "9007199254740993.0000000000000001";
    let canonical = crate::actions::schema::workflow_canonical_json(exact, 262144, 64).unwrap();
    let enabled = tx(&conn, |c| {
        enable_rows(
            c,
            scope(),
            KEY,
            0,
            Selection {
                input: exact,
                ..selection()
            },
            60_000,
        )
    })
    .unwrap();
    let body: String = conn
        .query_row(
            "SELECT input_json FROM workflow_activations WHERE activation_id=?1",
            [&enabled.current.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(body, canonical);
    assert_eq!(
        enabled.current.input_digest,
        crate::ledger::sha256_hex(canonical.as_bytes())
    );
}
#[test]
fn duplicate_json_and_oversized_inputs_refuse_before_configuration_rows() {
    let conn = db();
    assert_eq!(
        tx(&conn, |c| enable_rows(
            c,
            scope(),
            KEY,
            0,
            Selection {
                input: r#"{"a":1,"a":2}"#,
                ..selection()
            },
            60_000
        )),
        Err(Error::Invalid)
    );
    let huge = format!("\"{}\"", "x".repeat(262144));
    assert_eq!(
        tx(&conn, |c| enable_rows(
            c,
            scope(),
            KEY,
            0,
            Selection {
                input: &huge,
                ..selection()
            },
            60_000
        )),
        Err(Error::Capacity)
    );
    assert_eq!(count(&conn, "activations"), 0);
}
#[test]
fn activation_budget_counts_other_stores_of_same_vault() {
    let conn = db();
    flow::with_active_vault_limit(15, || {
        tx(&conn, |c| {
            enable_rows(
                c,
                scope(),
                KEY,
                0,
                Selection {
                    input: r#""123456""#,
                    ..selection()
                },
                60_000,
            )
        })
        .unwrap();
        assert_eq!(
            tx(&conn, |c| enable_rows(
                c,
                Scope {
                    store: "replacement",
                    ..scope()
                },
                NEXT,
                0,
                Selection {
                    input: r#""123456""#,
                    ..selection()
                },
                60_000
            )),
            Err(Error::Capacity)
        );
    });
    assert_eq!(count(&conn, "activations"), 1);
}
#[test]
fn paused_configuration_keeps_counted_input_until_explicit_remove() {
    let conn = db();
    flow::with_active_vault_limit(9, || {
        tx(&conn, |c| {
            enable_rows(
                c,
                scope(),
                KEY,
                0,
                Selection {
                    input: r#""123456""#,
                    ..selection()
                },
                60_000,
            )
        })
        .unwrap();
        tx(&conn, |c| {
            pause_rows(c, scope(), NEXT, "workflow", 1, 120_000)
        })
        .unwrap();
        assert_eq!(
            tx(&conn, |c| enable_rows(
                c,
                scope(),
                THIRD,
                0,
                Selection {
                    workflow: "other",
                    ..selection()
                },
                180_000
            )),
            Err(Error::Capacity)
        );
        tx(&conn, |c| {
            remove_rows(c, scope(), THIRD, "workflow", 2, 180_000)
        })
        .unwrap();
        let fourth = "4".repeat(32);
        tx(&conn, |c| {
            enable_rows(
                c,
                scope(),
                &fourth,
                0,
                Selection {
                    workflow: "other",
                    ..selection()
                },
                180_000,
            )
        })
        .unwrap();
    });
    let body: Option<String> = conn
        .query_row(
            "SELECT input_json FROM workflow_activations WHERE workflow_id='workflow'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(body.is_none());
    assert_eq!(count(&conn, "requests"), 4);
}
#[test]
fn replacing_current_input_uses_checked_delta_without_double_charge() {
    let conn = db();
    flow::with_active_vault_limit(8, || {
        tx(&conn, |c| {
            enable_rows(
                c,
                scope(),
                KEY,
                0,
                Selection {
                    input: r#""123456""#,
                    ..selection()
                },
                60_000,
            )
        })
        .unwrap();
        let next = tx(&conn, |c| {
            enable_rows(
                c,
                scope(),
                NEXT,
                1,
                Selection {
                    input: r#""654321""#,
                    ..selection()
                },
                120_000,
            )
        })
        .unwrap();
        assert_eq!(next.current.revision, 2);
    });
}
#[test]
fn actual_run_budget_cannot_ignore_standing_activation_input() {
    let conn = db();
    flow::with_active_vault_limit(9, || {
        tx(&conn, |c| {
            enable_rows(
                c,
                scope(),
                KEY,
                0,
                Selection {
                    input: r#""123456""#,
                    ..selection()
                },
                60_000,
            )
        })
        .unwrap();
        let steps = [flow::Step {
            id: "done",
            kind: flow::Kind::Result,
            next: None,
            otherwise: None,
        }];
        let actual = tx(&conn, |c| {
            flow::start_rows(
                c,
                flow::Scope {
                    owner: "human:me",
                    vault: VAULT,
                    store: "replacement",
                    actor: "fixture",
                },
                flow::Start {
                    key: NEXT,
                    workflow: "run",
                    version: HASH,
                    schema_digest: HASH,
                    input: "{}",
                    configuration: HASH,
                    grants: HASH,
                    act_scope: None,
                    act_run: None,
                    entry: "done",
                    steps: &steps,
                    now: 60_000,
                },
            )
        });
        assert_eq!(actual, Err(Error::Capacity));
    });
    assert_eq!(count(&conn, "runs"), 0);
}

#[test]
fn pausing_future_admission_preserves_actual_existing_wait_and_value_rows() {
    let conn = db();
    let flow_scope = flow::Scope {
        owner: "human:me",
        vault: VAULT,
        store: "store",
        actor: "fixture",
    };
    let steps = [
        flow::Step {
            id: "timer",
            kind: flow::Kind::Timer,
            next: Some("done"),
            otherwise: None,
        },
        flow::Step {
            id: "done",
            kind: flow::Kind::Result,
            next: None,
            otherwise: None,
        },
    ];
    let (run, wait) = tx(&conn, |c| {
        let started = flow::start_rows(
            c,
            flow_scope,
            flow::Start {
                key: NEXT,
                workflow: "workflow",
                version: HASH,
                schema_digest: HASH,
                input: "{}",
                configuration: HASH,
                grants: HASH,
                act_scope: None,
                act_run: None,
                entry: "timer",
                steps: &steps,
                now: 60_000,
            },
        )?;
        let flow::Started::New(run) = started else {
            panic!("new")
        };
        let claim = flow::claim_rows(
            c,
            flow_scope,
            &run.id,
            run.revision,
            "{}",
            "process",
            60_000,
        )?;
        let wait = flow::park_rows(
            c,
            flow_scope,
            &claim,
            flow::WaitFor::Timer { due: 600_000 },
            60_000,
        )?;
        Ok((flow::inspect_rows(c, flow_scope, &run.id)?, wait))
    })
    .unwrap();
    let values: i64 = conn
        .query_row(
            "SELECT count(*) FROM workflow_values WHERE run_id=?1",
            [&run.id],
            |r| r.get(0),
        )
        .unwrap();
    enable(&conn);
    tx(&conn, |c| {
        pause_rows(c, scope(), THIRD, "workflow", 1, 120_000)
    })
    .unwrap();
    assert_eq!(
        tx(&conn, |c| flow::inspect_rows(c, flow_scope, &run.id)).unwrap(),
        run
    );
    let pending: String = conn
        .query_row(
            "SELECT state FROM workflow_waits WHERE continuation_id=?1",
            [&wait.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(pending, "pending");
    assert_eq!(
        conn.query_row(
            "SELECT count(*) FROM workflow_values WHERE run_id=?1",
            [&run.id],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        values
    );
}

// SQL metadata pin fixture only. This is not a native grant/Enable authority.
fn pin_account(conn: &Connection, activation: &Activation) {
    conn.execute("INSERT INTO workflow_activation_accounts(activation_id,epoch,connection_id,account_id,account_identity_digest,account_revision,revocation_generation) VALUES(?1,?2,'connection','account',?3,1,0)",params![activation.id,activation.epoch,HASH]).unwrap();
}
#[test]
fn pause_keeps_current_account_pins_but_replace_requires_new_explicit_epoch_pins() {
    let conn = db();
    let first = enable(&conn);
    pin_account(&conn, &first.current);
    tx(&conn, |c| {
        pause_rows(c, scope(), NEXT, "workflow", 1, 120_000)
    })
    .unwrap();
    let kept: i64 = conn
        .query_row(
            "SELECT count(*) FROM workflow_activation_accounts",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(kept, 1);
    let replaced = tx(&conn, |c| {
        enable_rows(c, scope(), THIRD, 2, selection(), 180_000)
    })
    .unwrap();
    assert_ne!(replaced.current.epoch, first.current.epoch);
    let old: i64 = conn
        .query_row(
            "SELECT count(*) FROM workflow_activation_accounts",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(old,0,"new native Enable must explicitly repin actual current account material in its same transaction");
}
#[test]
fn remove_releases_current_account_configuration_pins() {
    let conn = db();
    let first = enable(&conn);
    pin_account(&conn, &first.current);
    let removed = tx(&conn, |c| {
        remove_rows(c, scope(), NEXT, "workflow", 1, 120_000)
    })
    .unwrap();
    assert_eq!(removed.current.state, "removed");
    let left: i64 = conn
        .query_row(
            "SELECT count(*) FROM workflow_activation_accounts",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(left, 0);
}

#[test]
fn schedule_material_and_page_require_existing_transaction() {
    let conn = db();
    assert_eq!(
        material_rows(&conn, scope(), "workflow"),
        Err(Error::Unavailable)
    );
    assert_eq!(
        sweep_page_rows(&conn, scope(), None),
        Err(Error::Unavailable)
    );
}
#[test]
fn schedule_material_is_query_only_exact_and_never_books_or_grants() {
    let conn = db();
    let selected = Selection {
        input: r#"{"amount":9007199254740993.0000000000000001}"#,
        ..selection()
    };
    let first = tx(&conn, |c| enable_rows(c, scope(), KEY, 0, selected, 60_000)).unwrap();
    conn.execute_batch("PRAGMA query_only=ON").unwrap();
    let tx = Transaction::new_unchecked(&conn, TransactionBehavior::Deferred).unwrap();
    let material = material_rows(&tx, scope(), "workflow").unwrap().unwrap();
    assert_eq!(material.current, first.current);
    assert_eq!(
        material.input.as_deref(),
        Some(r#"{"amount":90071992547409930000000000000001e-16}"#)
    );
    assert_eq!(material.permissions.as_deref(), Some(PERMISSIONS));
    assert_eq!((material.skipped, material.coalesced), (0, 0));
    assert!(!material.coverage_known);
    assert_eq!(material.observed_at_ms, None);
    assert_eq!(
        (
            count(&tx, "requests"),
            count(&tx, "runs"),
            count(&tx, "occurrences")
        ),
        (1, 0, 0)
    );
    tx.rollback().unwrap();
}
#[test]
fn schedule_material_absence_removed_and_unavailable_are_distinct() {
    let conn = db();
    assert_eq!(
        tx(&conn, |c| material_rows(c, scope(), "workflow")).unwrap(),
        None
    );
    let enabled = enable(&conn);
    let removed = tx(&conn, |c| {
        remove_rows(c, scope(), NEXT, "workflow", 1, 120_000)
    })
    .unwrap();
    let material = tx(&conn, |c| material_rows(c, scope(), "workflow"))
        .unwrap()
        .unwrap();
    assert_eq!(material.current, removed.current);
    assert_eq!(material.current.input_digest, enabled.current.input_digest);
    assert!(material.input.is_none() && material.permissions.is_none());
    assert_eq!((count(&conn, "runs"), count(&conn, "occurrences")), (0, 0));
}
#[test]
fn sweep_pages_are_bounded_stable_and_do_not_erase_later_enabled_selections() {
    let conn = db();
    let limit = flow::execution_policy().reconciliation_batch;
    let mut expected = Vec::new();
    for index in 0..limit + 3 {
        let workflow = format!("flow-{index}");
        let key = format!("{index:032x}");
        let selected = Selection {
            workflow: &workflow,
            ..selection()
        };
        expected.push(
            tx(&conn, |c| {
                enable_rows(c, scope(), &key, 0, selected, 60_000)
            })
            .unwrap()
            .current
            .id,
        );
    }
    for (index, name, remove) in [(limit + 3, "paused", false), (limit + 4, "removed", true)] {
        let key = format!("{index:032x}");
        tx(&conn, |c| {
            enable_rows(
                c,
                scope(),
                &key,
                0,
                Selection {
                    workflow: name,
                    ..selection()
                },
                60_000,
            )
        })
        .unwrap();
        let changed = format!("{:032x}", index + 100);
        if remove {
            tx(&conn, |c| {
                remove_rows(c, scope(), &changed, name, 1, 120_000)
            })
            .unwrap();
        } else {
            tx(&conn, |c| {
                pause_rows(c, scope(), &changed, name, 1, 120_000)
            })
            .unwrap();
        }
    }
    expected.sort();
    conn.execute_batch("PRAGMA query_only=ON").unwrap();
    let tx = Transaction::new_unchecked(&conn, TransactionBehavior::Deferred).unwrap();
    let first = sweep_page_rows(&tx, scope(), None).unwrap();
    assert_eq!(first.items.len(), limit);
    assert_eq!(
        first.next.as_deref(),
        first.items.last().map(|v| v.id.as_str())
    );
    let second = sweep_page_rows(&tx, scope(), first.next.as_deref()).unwrap();
    assert_eq!(second.items.len(), 3);
    assert!(second.next.is_none());
    let actual = first
        .items
        .into_iter()
        .chain(second.items)
        .map(|v| {
            assert_eq!(v.state, "enabled");
            v.id
        })
        .collect::<Vec<_>>();
    assert_eq!(actual, expected);
    assert_eq!(count(&tx, "runs"), 0);
    tx.rollback().unwrap();
}
#[test]
fn sweep_selection_refuses_original_path_substitution_and_does_not_adopt_other_store() {
    let conn = db();
    enable(&conn);
    let wrong = Scope {
        canonical_vault: "/replacement",
        ..scope()
    };
    assert_eq!(
        tx(&conn, |c| material_rows(c, wrong, "workflow")),
        Err(Error::Denied)
    );
    assert_eq!(
        tx(&conn, |c| sweep_page_rows(c, wrong, None)),
        Err(Error::Denied)
    );
    let other = Scope {
        store: "different-store",
        ..scope()
    };
    assert_eq!(
        tx(&conn, |c| material_rows(c, other, "workflow")).unwrap(),
        None
    );
    let page = tx(&conn, |c| sweep_page_rows(c, other, None)).unwrap();
    assert!(page.items.is_empty() && page.next.is_none());
}
#[test]
fn sweep_selection_refuses_bad_cursor_and_corrupted_operational_material() {
    let conn = db();
    enable(&conn);
    assert_eq!(
        tx(&conn, |c| sweep_page_rows(
            c,
            scope(),
            Some("not-an-activation-id")
        )),
        Err(Error::Invalid)
    );
    conn.execute(
        "UPDATE workflow_activations SET input_json=?1,input_bytes=7",
        [r#"{"x":1}"#],
    )
    .unwrap();
    assert_eq!(
        tx(&conn, |c| material_rows(c, scope(), "workflow")),
        Err(Error::Unavailable)
    );
}

// Unpublish uses actual V48 rows and transactions; no file/native proof factory.
const UNPUBLISH: &str = "44444444444444444444444444444444";
fn prepare_unpublish(conn: &Connection) -> Result<PublicationTransition, Error> {
    prepare_unpublish_rows(conn, scope(), UNPUBLISH, "workflow", 1, HASH, 120_000)
}
fn journal_count(conn: &Connection) -> i64 {
    conn.query_row(
        "SELECT count(*) FROM workflow_activation_journal",
        [],
        |r| r.get(0),
    )
    .unwrap()
}

#[test]
fn publication_journal_requires_actual_transaction() {
    let conn = db();
    assert_eq!(prepare_unpublish(&conn), Err(Error::Unavailable));
    assert_eq!(journal_count(&conn), 0);
}

#[test]
fn publication_prepare_atomically_pauses_and_holds_without_repinning_selection() {
    let conn = db();
    let first = enable(&conn);
    let prepared = tx(&conn, prepare_unpublish).unwrap();
    assert_eq!(prepared.phase, "prepared");
    assert_eq!(prepared.expected_revision, 1);
    assert_eq!(prepared.expected_hash, HASH);
    let current = tx(&conn, |c| inspect_rows(c, scope(), "workflow"))
        .unwrap()
        .unwrap();
    assert_eq!(current.state, "paused");
    assert_eq!(current.revision, 2);
    assert!(current.held);
    assert_eq!(current.epoch, first.current.epoch);
    assert_eq!(
        (
            current.version,
            current.input_digest,
            current.permission_digest
        ),
        (
            first.current.version,
            first.current.input_digest,
            first.current.permission_digest
        )
    );
    assert_eq!(
        tx(&conn, |c| enable_rows(
            c,
            scope(),
            NEXT,
            2,
            selection(),
            180_000
        )),
        Err(Error::Denied)
    );
    assert_eq!(
        (
            journal_count(&conn),
            count(&conn, "runs"),
            count(&conn, "requests")
        ),
        (1, 0, 1)
    );
}

#[test]
fn publication_prepare_rollback_leaves_enabled_selection_and_no_hold() {
    let conn = db();
    let first = enable(&conn);
    let result: Result<(), Error> = tx(&conn, |c| {
        prepare_unpublish(c)?;
        Err(Error::Invalid)
    });
    assert_eq!(result, Err(Error::Invalid));
    assert_eq!(journal_count(&conn), 0);
    assert_eq!(
        tx(&conn, |c| inspect_rows(c, scope(), "workflow")).unwrap(),
        Some(first.current)
    );
}

#[test]
fn publication_exact_replay_never_repauses_a_later_explicit_enable() {
    let conn = db();
    enable(&conn);
    let prepared = tx(&conn, prepare_unpublish).unwrap();
    let cleared = tx(&conn, |c| {
        pointer_cleared_rows(c, scope(), &prepared, 2, 120_001)
    })
    .unwrap();
    assert_eq!(cleared.phase, "pointer_cleared");
    let done = tx(&conn, |c| {
        reconcile_unpublish_rows(c, scope(), &cleared, 120_002)
    })
    .unwrap();
    assert_eq!(done.phase, "reconciled");
    let reenabled = tx(&conn, |c| {
        enable_rows(c, scope(), NEXT, 2, selection(), 180_000)
    })
    .unwrap();
    assert_eq!(tx(&conn, prepare_unpublish).unwrap(), done);
    assert_eq!(
        tx(&conn, |c| inspect_rows(c, scope(), "workflow")).unwrap(),
        Some(reenabled.current)
    );
    assert_eq!(journal_count(&conn), 1);
}

#[test]
fn publication_key_and_original_target_conflicts_do_not_change_journal() {
    let conn = db();
    let first = tx(&conn, prepare_unpublish).unwrap();
    for (key, workflow, revision, hash) in [
        (UNPUBLISH, "workflow", 2, HASH),
        (
            UNPUBLISH,
            "workflow",
            1,
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        ),
        (UNPUBLISH, "other", 1, HASH),
        (NEXT, "workflow", 1, HASH),
    ] {
        assert_eq!(
            tx(&conn, |c| prepare_unpublish_rows(
                c,
                scope(),
                key,
                workflow,
                revision,
                hash,
                130_000
            )),
            Err(Error::Conflict)
        );
    }
    assert_eq!(tx(&conn, prepare_unpublish).unwrap(), first);
    assert_eq!(journal_count(&conn), 1);
}

#[test]
fn publication_recovery_rejects_changed_store_path_or_original_hash() {
    let conn = db();
    let prepared = tx(&conn, prepare_unpublish).unwrap();
    for changed in [
        Scope {
            store: "replacement",
            ..scope()
        },
        Scope {
            canonical_vault: "/replacement",
            ..scope()
        },
    ] {
        assert_eq!(
            tx(&conn, |c| pointer_cleared_rows(
                c, changed, &prepared, 2, 130_000
            )),
            Err(Error::Denied)
        );
    }
    let mut foreign = prepared.clone();
    foreign.expected_hash = "b".repeat(64);
    assert_eq!(
        tx(&conn, |c| pointer_cleared_rows(
            c,
            scope(),
            &foreign,
            2,
            130_000
        )),
        Err(Error::Conflict)
    );
    assert_eq!(
        tx(&conn, |c| pointer_cleared_rows(
            c,
            scope(),
            &prepared,
            3,
            130_000
        )),
        Err(Error::Conflict)
    );
    assert_eq!(tx(&conn, prepare_unpublish).unwrap().phase, "prepared");
}

#[test]
fn publication_reconcile_requires_cleared_phase_and_is_idempotent() {
    let conn = db();
    enable(&conn);
    let prepared = tx(&conn, prepare_unpublish).unwrap();
    assert_eq!(
        tx(&conn, |c| reconcile_unpublish_rows(
            c,
            scope(),
            &prepared,
            120_001
        )),
        Err(Error::Denied)
    );
    let cleared = tx(&conn, |c| {
        pointer_cleared_rows(c, scope(), &prepared, 2, 120_002)
    })
    .unwrap();
    let done = tx(&conn, |c| {
        reconcile_unpublish_rows(c, scope(), &cleared, 120_003)
    })
    .unwrap();
    assert_eq!(
        tx(&conn, |c| reconcile_unpublish_rows(
            c,
            scope(),
            &cleared,
            120_004
        ))
        .unwrap(),
        done
    );
    let current = tx(&conn, |c| inspect_rows(c, scope(), "workflow"))
        .unwrap()
        .unwrap();
    assert!(!current.held);
    assert_eq!((current.state.as_str(), current.revision), ("paused", 2));
}

#[test]
fn publication_prepare_does_not_materialize_a_missing_activation() {
    let conn = db();
    tx(&conn, prepare_unpublish).unwrap();
    assert_eq!(count(&conn, "activations"), 0);
    assert_eq!(
        tx(&conn, |c| enable_rows(
            c,
            scope(),
            NEXT,
            0,
            selection(),
            180_000
        )),
        Err(Error::Denied)
    );
    assert_eq!(count(&conn, "activations"), 0);
}

#[test]
fn publication_prepare_preserves_already_paused_or_removed_revision() {
    for remove in [false, true] {
        let conn = db();
        enable(&conn);
        let before = tx(&conn, |c| {
            if remove {
                remove_rows(c, scope(), NEXT, "workflow", 1, 100_000)
            } else {
                pause_rows(c, scope(), NEXT, "workflow", 1, 100_000)
            }
        })
        .unwrap()
        .current;
        tx(&conn, prepare_unpublish).unwrap();
        let mut current = tx(&conn, |c| inspect_rows(c, scope(), "workflow"))
            .unwrap()
            .unwrap();
        assert!(current.held);
        current.held = false;
        assert_eq!(current, before);
    }
}

#[test]
fn publication_pause_counter_exhaustion_rolls_back_prepared_hold() {
    let conn = db();
    enable(&conn);
    conn.execute(
        "UPDATE workflow_activations SET revision=9007199254740991",
        [],
    )
    .unwrap();
    assert_eq!(tx(&conn, prepare_unpublish), Err(Error::Capacity));
    assert_eq!(journal_count(&conn), 0);
    let current = tx(&conn, |c| inspect_rows(c, scope(), "workflow"))
        .unwrap()
        .unwrap();
    assert_eq!(current.state, "enabled");
    assert!(!current.held);
}

#[test]
fn publication_prepare_leaves_actual_pinned_timer_run_and_wait_unchanged() {
    let conn = db();
    enable(&conn);
    let run_scope = flow::Scope {
        owner: scope().owner,
        vault: VAULT,
        store: "store",
        actor: "workflow:original",
    };
    let steps = [
        flow::Step {
            id: "wait",
            kind: flow::Kind::Timer,
            next: Some("done"),
            otherwise: None,
        },
        flow::Step {
            id: "done",
            kind: flow::Kind::Result,
            next: None,
            otherwise: None,
        },
    ];
    let started = tx(&conn, |c| {
        flow::start_rows(
            c,
            run_scope,
            flow::Start {
                key: THIRD,
                workflow: "workflow",
                version: HASH,
                schema_digest: HASH,
                input: "{}",
                configuration: HASH,
                grants: HASH,
                act_scope: None,
                act_run: None,
                entry: "wait",
                steps: &steps,
                now: 60_000,
            },
        )
    })
    .unwrap();
    let flow::Started::New(run) = started else {
        panic!("new run required");
    };
    let claim = tx(&conn, |c| {
        flow::claim_rows(
            c,
            run_scope,
            &run.id,
            run.revision,
            "{}",
            "original-process",
            60_001,
        )
    })
    .unwrap();
    let wait = tx(&conn, |c| {
        flow::park_rows(
            c,
            run_scope,
            &claim,
            flow::WaitFor::Timer { due: 180_000 },
            60_002,
        )
    })
    .unwrap();
    let before = tx(&conn, |c| flow::inspect_rows(c, run_scope, &run.id)).unwrap();
    let wait_before: (String, i64) = conn
        .query_row(
            "SELECT state,revision FROM workflow_waits WHERE continuation_id=?1",
            [&wait.id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    tx(&conn, prepare_unpublish).unwrap();
    assert_eq!(
        tx(&conn, |c| flow::inspect_rows(c, run_scope, &run.id)).unwrap(),
        before
    );
    let wait_after: (String, i64) = conn
        .query_row(
            "SELECT state,revision FROM workflow_waits WHERE continuation_id=?1",
            [&wait.id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(wait_after, wait_before);
    assert_eq!(wait_after.0, "pending");
}

#[test]
fn publication_pending_recovery_is_query_only_bounded_and_continued() {
    let conn = db();
    for ordinal in 1..=33 {
        let key = format!("{ordinal:032x}");
        let workflow = format!("workflow_{ordinal}");
        tx(&conn, |c| {
            prepare_unpublish_rows(c, scope(), &key, &workflow, 1, HASH, 120_000)
        })
        .unwrap();
    }
    conn.execute_batch("PRAGMA query_only=ON").unwrap();
    let read = Transaction::new_unchecked(&conn, TransactionBehavior::Deferred).unwrap();
    let first = pending_publications_rows(&read, scope(), None).unwrap();
    assert_eq!(first.items.len(), 32);
    assert!(first.items.iter().all(|row| row.phase == "prepared"));
    assert_eq!(
        first.next.as_deref(),
        Some("00000000000000000000000000000020")
    );
    let second = pending_publications_rows(&read, scope(), first.next.as_deref()).unwrap();
    assert_eq!(second.items.len(), 1);
    assert_eq!(second.items[0].id, "00000000000000000000000000000021");
    assert_eq!(second.next, None);
    assert_eq!(journal_count(&read), 33);
    read.rollback().unwrap();
    conn.execute_batch("PRAGMA query_only=OFF").unwrap();
}
