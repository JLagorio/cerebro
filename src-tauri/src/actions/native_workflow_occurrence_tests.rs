//! Actual migrations, contained immutable definitions and retained RuntimeOwner.
//! V48 metadata is seeded to isolate this seam from the separate Enable RED.
//! No CurrentWorkflowOrigin, native grant capability or provider is fabricated.
use super::*;
use crate::actions::native_owner::{native_workflows as native, RuntimeOwner};
use crate::workflows::schedule::Observation;
use native::occurrence::{self, Claimed, Expected};
fn at_due() -> chrono::DateTime<chrono::Utc> {
    time() + chrono::Duration::milliseconds(60_500)
}
fn awake() -> Observation {
    Observation::Native {
        previous_ms: time().timestamp_millis() + 59_500,
        same_opening: true,
        resumed: false,
    }
}
fn hash_text(value: &str) -> String {
    crate::ledger::sha256_hex(value.as_bytes())
}
fn seeded(conn: &Db, action: bool) -> (nd::NativeDefinition, Expected) {
    let (p, steps) = if action {
        let (p, s) = selected_account(conn);
        let action = driver_step(
            "action",
            serde_json::json!({"kind":"action","actionId":s.action,"definitionDigest":s.definition,"connectionId":s.connection,"accountId":s.account,"input":{"kind":"input","path":[]},"nextStepId":"done"}),
        );
        (p, vec![action, driver_result()])
    } else {
        (permissions(), vec![driver_result()])
    };
    seed_definition(
        conn,
        &p,
        steps,
        serde_json::json!({"kind":"schedule","intervalSeconds":60,"catchUp":"skip_missed"}),
    )
}
fn seed_definition(
    conn: &Db,
    p: &Permissions,
    steps: Vec<serde_json::Value>,
    trigger: serde_json::Value,
) -> (nd::NativeDefinition, Expected) {
    let schema = serde_json::json!({"type":"object"});
    let schema_digest =
        crate::actions::schema::workflow_schema_digest(&schema.to_string()).unwrap();
    let raw = serde_json::json!({"formatVersion":1,"workflowId":"scheduled","entryStepId":steps[0]["stepId"],"inputSchema":schema,"inputSchemaDigest":schema_digest,"declaredActionDigests":steps.iter().filter_map(|s|s["operation"]["definitionDigest"].as_str()).collect::<Vec<_>>(),"steps":steps,"trigger":trigger,"authoredBy":"human:me"});
    let pinned = nd::publish_fixture(&conn.dir, &raw.to_string(), "{}");
    let configuration = native::workflow_configuration(&pinned).unwrap();
    let permission_bytes = permission_bytes(p).unwrap();
    // Exact protocol fixture, not authority: production hashes this same pinned
    // trigger material including shared schedule policy, separate from V47 config.
    let policy =
        crate::ledger::sha256_hex(include_bytes!("../../../shared/workflows/schedule.v1.json"));
    let trigger_digest = hash_text(
        &serde_json::to_string(&(
            "cerebro.workflow.activation.trigger",
            1,
            pinned.workflow(),
            pinned.version(),
            60,
            "skip_missed",
            policy,
        ))
        .unwrap(),
    );
    let expected = Expected {
        activation: "4".repeat(32),
        workflow: pinned.workflow().into(),
        revision: 1,
        epoch: "5".repeat(32),
        version: pinned.version().into(),
        configuration,
        input_digest: hash_text(pinned.input()),
        permission_digest: hash_text(&permission_bytes),
        trigger_digest,
        cursor_ms: time().timestamp_millis(),
        intended_ms: time().timestamp_millis() + 60_000,
    };
    let transaction = Transaction::new_unchecked(conn, TransactionBehavior::Immediate).unwrap();
    transaction.execute("INSERT INTO workflow_activations(activation_id,owner_person,vault_id,store_uuid,canonical_vault_path,workflow_id,definition_hash,input_schema_digest,configuration_digest,trigger_digest,input_digest,permission_digest,input_json,input_bytes,permissions_json,interval_seconds,catch_up,state,revision,epoch,anchor_ms,cursor_ms,created_at_ms,updated_at_ms) VALUES(?1,'human:me',?2,'store',?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,60,'skip_missed','enabled',1,?14,?15,?15,?15,?15)",params![expected.activation,VAULT,PATH,expected.workflow,expected.version,pinned.schema(),expected.configuration,expected.trigger_digest,expected.input_digest,expected.permission_digest,pinned.input(),i64::try_from(pinned.input().len()).unwrap(),permission_bytes,expected.epoch,expected.cursor_ms]).unwrap();
    for selected in &p.accounts {
        let actual = grant_material(&transaction, facts(), selected).unwrap();
        transaction.execute("INSERT INTO workflow_activation_accounts(activation_id,epoch,connection_id,account_id,account_identity_digest,account_revision,revocation_generation) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![expected.activation,expected.epoch,selected.connection,selected.account,actual.identity,i64::try_from(actual.account_revision).unwrap(),i64::try_from(actual.revocation_generation).unwrap()]).unwrap();
    }
    transaction.commit().unwrap();
    (pinned, expected)
}
fn owned(
    conn: &Db,
    expected: &Expected,
    pinned: &nd::NativeDefinition,
) -> Result<Claimed, flow::Error> {
    let mut owner = RuntimeOwner::open_existing(&conn.dir).unwrap();
    occurrence::claim_owned_rows(
        &mut owner,
        facts(),
        expected,
        pinned,
        awake(),
        at_due(),
        || Ok(()),
    )
}
fn new_origin(claim: Claimed) -> Origin {
    let Started::New(origin) = claim.started else {
        panic!("new native origin")
    };
    origin
}
fn occurrences(conn: &Connection) -> i64 {
    conn.query_row("SELECT count(*) FROM workflow_occurrences", [], |r| {
        r.get(0)
    })
    .unwrap()
}
fn current_cursor(conn: &Connection) -> i64 {
    conn.query_row("SELECT cursor_ms FROM workflow_activations", [], |r| {
        r.get(0)
    })
    .unwrap()
}
#[test]
fn occurrence_requires_existing_transaction() {
    let conn = db();
    let (pinned, expected) = seeded(&conn, false);
    assert_eq!(
        occurrence::claim_rows(&conn, facts(), &expected, &pinned, awake(), at_due()),
        Err(flow::Error::Unavailable)
    );
    assert_eq!(occurrences(&conn), 0);
}
#[test]
fn validated_definition_exposes_only_its_actual_schedule_projection() {
    let conn = db();
    let (pinned, _) = seeded(&conn, false);
    assert_eq!(
        pinned.schedule(),
        Some((60, crate::workflows::schedule::CatchUp::SkipMissed))
    );
}
#[test]
fn original_manual_start_still_records_manual_cause() {
    let conn = db();
    let origin = original(&conn);
    let raw: String = conn
        .query_row(
            "SELECT cause FROM runs WHERE run_id=?1",
            [origin.native_run],
            |r| r.get(0),
        )
        .unwrap();
    let cause: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(cause["kind"], "manual");
}
#[test]
fn occurrence_owned_precheck_refuses_before_any_run() {
    let conn = db();
    let (pinned, expected) = seeded(&conn, false);
    let mut owner = RuntimeOwner::open_existing(&conn.dir).unwrap();
    assert_eq!(
        occurrence::claim_owned_rows(
            &mut owner,
            facts(),
            &expected,
            &pinned,
            awake(),
            at_due(),
            || Err(flow::Error::Denied)
        ),
        Err(flow::Error::Denied)
    );
    assert_eq!((count(&conn, "runs"), occurrences(&conn)), (0, 0));
}
#[test]
fn occurrence_creates_actual_native_flow_and_schedule_cause_atomically() {
    let conn = db();
    let (pinned, expected) = seeded(&conn, false);
    let claim = owned(&conn, &expected, &pinned).unwrap();
    assert_eq!(claim.intended_ms, expected.intended_ms);
    assert_eq!(claim.occurrence.len(), 64);
    let origin = new_origin(claim);
    let (raw, usage, mode, cli): (String, String, String, Option<String>) = conn
        .query_row(
            "SELECT cause,usage_state,mode,cli_session_id FROM runs WHERE run_id=?1",
            [&origin.native_run],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap();
    let cause: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(cause["kind"], "schedule");
    assert_eq!(cause["due_at"], "2026-10-26T00:01:00.000Z");
    assert_eq!(usage, "unknown");
    assert_eq!(mode, "attended");
    assert!(cli.is_none());
    let (run, epoch, version, due): (String, String, String, i64) = conn
        .query_row(
            "SELECT workflow_run_id,epoch,definition_hash,intended_at_ms FROM workflow_occurrences",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap();
    assert_eq!(run, origin.flow_run);
    assert_eq!(epoch, expected.epoch);
    assert_eq!(version, expected.version);
    assert_eq!(due, expected.intended_ms);
    assert_eq!(current_cursor(&conn), expected.intended_ms);
    assert_eq!(
        (
            count(&conn, "runs"),
            count(&conn, "flow"),
            count(&conn, "origins"),
            occurrences(&conn)
        ),
        (1, 1, 1, 1)
    );
    assert_eq!(origin.original, permissions());
}
#[test]
fn two_actual_retained_owners_observe_one_occurrence() {
    let conn = db();
    let (pinned, expected) = seeded(&conn, false);
    let mut first = RuntimeOwner::open_existing(&conn.dir).unwrap();
    let mut second = RuntimeOwner::open_existing(&conn.dir).unwrap();
    let claim = occurrence::claim_owned_rows(
        &mut first,
        facts(),
        &expected,
        &pinned,
        awake(),
        at_due(),
        || Ok(()),
    )
    .unwrap();
    let occurrence = claim.occurrence.clone();
    let origin = new_origin(claim);
    let replay = occurrence::claim_owned_rows(
        &mut second,
        facts(),
        &expected,
        &pinned,
        awake(),
        at_due(),
        || Ok(()),
    )
    .unwrap();
    assert_eq!(replay.started, Started::Observed(origin));
    assert_eq!(replay.occurrence, occurrence);
    assert_eq!((count(&conn, "runs"), occurrences(&conn)), (1, 1));
}
#[test]
fn stale_captured_activation_identity_cannot_be_rebased() {
    let conn = db();
    let (pinned, expected) = seeded(&conn, false);
    let changes: [fn(&mut Expected); 8] = [
        |e| e.revision += 1,
        |e| e.epoch = "f".repeat(32),
        |e| e.version = "f".repeat(64),
        |e| e.cursor_ms += 60_000,
        |e| e.configuration = "f".repeat(64),
        |e| e.input_digest = "f".repeat(64),
        |e| e.permission_digest = "f".repeat(64),
        |e| e.trigger_digest = "f".repeat(64),
    ];
    for change in changes {
        let mut stale = expected.clone();
        change(&mut stale);
        assert_eq!(owned(&conn, &stale, &pinned), Err(flow::Error::Stale));
    }
    assert_eq!((count(&conn, "runs"), occurrences(&conn)), (0, 0));
    assert_eq!(current_cursor(&conn), expected.cursor_ms);
}
#[test]
fn paused_current_activation_never_mints_native_run() {
    let conn = db();
    let (pinned, mut expected) = seeded(&conn, false);
    conn.execute(
        "UPDATE workflow_activations SET state='paused',revision=2",
        [],
    )
    .unwrap();
    expected.revision = 2;
    assert_eq!(owned(&conn, &expected, &pinned), Err(flow::Error::Denied));
    assert_eq!(count(&conn, "runs"), 0);
}
#[test]
fn pending_publication_journal_holds_occurrence() {
    let conn = db();
    let (pinned, expected) = seeded(&conn, false);
    conn.execute("INSERT INTO workflow_activation_journal(transition_id,owner_person,vault_id,store_uuid,canonical_vault_path,workflow_id,expected_publication_revision,expected_definition_hash,phase,created_at_ms,updated_at_ms) VALUES(?1,'human:me',?2,'store',?3,?4,1,?5,'prepared',?6,?6)",params!["6".repeat(32),VAULT,PATH,expected.workflow,expected.version,expected.cursor_ms]).unwrap();
    assert_eq!(owned(&conn, &expected, &pinned), Err(flow::Error::Denied));
    assert_eq!(count(&conn, "runs"), 0);
}
#[test]
fn closed_original_session_cannot_start_schedule() {
    let conn = db();
    let (pinned, expected) = seeded(&conn, false);
    crate::runtime::catchup::close_session(&conn, "session-one", VAULT, "store", at_due()).unwrap();
    assert_eq!(owned(&conn, &expected, &pinned), Err(flow::Error::Denied));
    assert_eq!(count(&conn, "runs"), 0);
}
#[test]
fn schedule_claim_checks_actual_pinned_trigger_not_only_row_selectors() {
    let conn = db();
    let (pinned, expected) = seed_definition(
        &conn,
        &permissions(),
        vec![driver_result()],
        serde_json::json!({"kind":"manual"}),
    );
    assert!(pinned.schedule().is_none());
    assert_eq!(owned(&conn, &expected, &pinned), Err(flow::Error::Denied));
    assert_eq!(count(&conn, "runs"), 0);
}
#[test]
fn early_or_unknown_coverage_claim_does_not_start() {
    let conn = db();
    let (pinned, expected) = seeded(&conn, false);
    let mut owner = RuntimeOwner::open_existing(&conn.dir).unwrap();
    assert_eq!(
        occurrence::claim_owned_rows(
            &mut owner,
            facts(),
            &expected,
            &pinned,
            awake(),
            time() + chrono::Duration::seconds(59),
            || Ok(())
        ),
        Err(flow::Error::NotDue)
    );
    assert_eq!(
        occurrence::claim_owned_rows(
            &mut owner,
            facts(),
            &expected,
            &pinned,
            Observation::Unknown,
            at_due(),
            || Ok(())
        ),
        Err(flow::Error::NotDue)
    );
    assert_eq!((count(&conn, "runs"), occurrences(&conn)), (0, 0));
}
#[test]
fn selected_accounts_are_pinned_before_actual_per_run_grants_and_snapshot() {
    let conn = db();
    let (pinned, expected) = seeded(&conn, true);
    assert_eq!(count(&conn, "grants"), 0);
    let origin = new_origin(owned(&conn, &expected, &pinned).unwrap());
    assert_eq!(count(&conn, "grants"), 1);
    let(identity,revision,generation):(String,i64,i64)=conn.query_row("SELECT g.account_identity_digest,g.account_revision,g.revocation_generation FROM workflow_origin_account_grants w JOIN action_account_grants g ON g.grant_id=w.grant_id WHERE w.workflow_run_id=?1",[&origin.flow_run],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
    let pin:(String,i64,i64)=conn.query_row("SELECT account_identity_digest,account_revision,revocation_generation FROM workflow_activation_accounts",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
    assert_eq!((identity, revision, generation), pin);
    let selected = tx(&conn, |c| {
        selector_rows(c, facts(), &origin.flow_run, "action")
    })
    .unwrap();
    assert_eq!(selected.snapshot.len(), 64);
    let replay = owned(&conn, &expected, &pinned).unwrap();
    assert_eq!(replay.started, Started::Observed(origin));
    assert_eq!(count(&conn, "grants"), 1);
}
#[test]
fn missing_enable_account_pin_cannot_be_recaptured() {
    let conn = db();
    let (pinned, expected) = seeded(&conn, true);
    conn.execute("DELETE FROM workflow_activation_accounts", [])
        .unwrap();
    assert_eq!(owned(&conn, &expected, &pinned), Err(flow::Error::Denied));
    assert_eq!((count(&conn, "grants"), count(&conn, "runs")), (0, 0));
}
#[test]
fn changed_actual_account_identity_cannot_be_recaptured() {
    let conn = db();
    let (pinned, expected) = seeded(&conn, true);
    conn.execute("UPDATE managed_connections SET status=json_set(status,'$.account.subject','replacement'),secret_ref=json_set(secret_ref,'$.subject','replacement')",[]).unwrap();
    assert_eq!(owned(&conn, &expected, &pinned), Err(flow::Error::Denied));
    assert_eq!((count(&conn, "grants"), count(&conn, "runs")), (0, 0));
}
#[test]
fn changed_actual_account_revision_cannot_be_recaptured() {
    let conn = db();
    let (pinned, expected) = seeded(&conn, true);
    conn.execute(
        "UPDATE managed_connections SET status=json_set(status,'$.account.accountRevision',2)",
        [],
    )
    .unwrap();
    assert_eq!(owned(&conn, &expected, &pinned), Err(flow::Error::Denied));
    assert_eq!((count(&conn, "grants"), count(&conn, "runs")), (0, 0));
}
#[test]
fn changed_actual_revocation_generation_cannot_be_recaptured() {
    let conn = db();
    let (pinned, expected) = seeded(&conn, true);
    conn.execute(
        "UPDATE managed_connections SET status=json_set(status,'$.revocationGeneration',1)",
        [],
    )
    .unwrap();
    assert_eq!(owned(&conn, &expected, &pinned), Err(flow::Error::Denied));
    assert_eq!((count(&conn, "grants"), count(&conn, "runs")), (0, 0));
}
#[test]
fn actual_disabled_account_blocks_new_occurrence() {
    let conn = db();
    let (pinned, expected) = seeded(&conn, true);
    let connection = pinned.selectors()[0].connection.clone();
    let change = Transaction::new_unchecked(&conn, TransactionBehavior::Immediate).unwrap();
    crate::connections::account_metadata::disable(
        &change,
        "human:me",
        &crate::actions::ids::ConnectionId(connection),
        1,
    )
    .unwrap();
    change.commit().unwrap();
    assert_eq!(owned(&conn, &expected, &pinned), Err(flow::Error::Denied));
    assert_eq!((count(&conn, "grants"), count(&conn, "runs")), (0, 0));
}
#[test]
fn original_opening_loss_before_commit_rolls_back_occurrence_native_run_and_grants() {
    let conn = db();
    let (pinned, expected) = seeded(&conn, true);
    let mut owner = RuntimeOwner::open_existing(&conn.dir).unwrap();
    let calls = std::cell::Cell::new(0);
    assert_eq!(
        occurrence::claim_owned_rows(
            &mut owner,
            facts(),
            &expected,
            &pinned,
            awake(),
            at_due(),
            || {
                calls.set(calls.get() + 1);
                if calls.get() == 1 {
                    Ok(())
                } else {
                    Err(flow::Error::Denied)
                }
            }
        ),
        Err(flow::Error::Denied)
    );
    assert_eq!(calls.get(), 2);
    assert_eq!(
        (
            count(&conn, "runs"),
            count(&conn, "flow"),
            count(&conn, "origins"),
            count(&conn, "grants"),
            occurrences(&conn)
        ),
        (0, 0, 0, 0, 0)
    );
    assert_eq!(current_cursor(&conn), expected.cursor_ms);
}
#[test]
fn actual_transaction_rollback_never_keeps_occurrence_or_cursor() {
    let conn = db();
    let (pinned, expected) = seeded(&conn, true);
    let transaction = Transaction::new_unchecked(&conn, TransactionBehavior::Immediate).unwrap();
    occurrence::claim_rows(&transaction, facts(), &expected, &pinned, awake(), at_due()).unwrap();
    transaction.rollback().unwrap();
    assert_eq!(
        (
            count(&conn, "runs"),
            count(&conn, "grants"),
            occurrences(&conn)
        ),
        (0, 0, 0)
    );
    assert_eq!(current_cursor(&conn), expected.cursor_ms);
}
#[test]
fn lost_commit_ack_preserves_exact_run_but_returns_no_runnable_owner() {
    let conn = db();
    let (pinned, expected) = seeded(&conn, false);
    let mut owner = RuntimeOwner::open_existing(&conn.dir).unwrap();
    let result = crate::actions::native_owner::tests::with_transaction_ack_probe(|| {
        crate::actions::native_owner::tests::lose_next_transaction_ack();
        occurrence::claim_owned_rows(
            &mut owner,
            facts(),
            &expected,
            &pinned,
            awake(),
            at_due(),
            || Ok(()),
        )
    });
    assert_eq!(result, Err(flow::Error::Unavailable));
    assert!(owner.retired);
    assert_eq!((count(&conn, "runs"), occurrences(&conn)), (1, 1));
    let replay = owned(&conn, &expected, &pinned).unwrap();
    assert!(matches!(replay.started, Started::Observed(_)));
    assert_eq!((count(&conn, "runs"), occurrences(&conn)), (1, 1));
}
#[test]
fn recorded_occurrence_corruption_cannot_adopt_another_run() {
    let conn = db();
    let (pinned, expected) = seeded(&conn, false);
    owned(&conn, &expected, &pinned).unwrap();
    let other = original(&conn);
    conn.execute(
        "UPDATE workflow_occurrences SET workflow_run_id=?1",
        [other.flow_run],
    )
    .unwrap();
    assert_eq!(owned(&conn, &expected, &pinned), Err(flow::Error::Conflict));
    assert_eq!((count(&conn, "runs"), occurrences(&conn)), (2, 1));
}
#[test]
fn duplicate_occurrence_after_pause_is_observational_without_new_grants() {
    let conn = db();
    let (pinned, expected) = seeded(&conn, true);
    let origin = new_origin(owned(&conn, &expected, &pinned).unwrap());
    conn.execute(
        "UPDATE workflow_activations SET state='paused',revision=2",
        [],
    )
    .unwrap();
    let replay = owned(&conn, &expected, &pinned).unwrap();
    assert_eq!(replay.started, Started::Observed(origin));
    assert_eq!(
        (
            count(&conn, "runs"),
            count(&conn, "grants"),
            occurrences(&conn)
        ),
        (1, 1, 1)
    );
}
#[test]
fn replacement_scope_cannot_claim_original_activation() {
    let conn = db();
    let (pinned, expected) = seeded(&conn, false);
    for changed in [
        OpeningFacts {
            store: "replacement",
            ..facts()
        },
        OpeningFacts {
            canonical_vault: "/replacement",
            ..facts()
        },
        OpeningFacts {
            owner: "human:other",
            ..facts()
        },
    ] {
        let mut owner = RuntimeOwner::open_existing(&conn.dir).unwrap();
        assert_eq!(
            occurrence::claim_owned_rows(
                &mut owner,
                changed,
                &expected,
                &pinned,
                awake(),
                at_due(),
                || Ok(())
            ),
            Err(flow::Error::Denied)
        );
    }
    assert_eq!((count(&conn, "runs"), occurrences(&conn)), (0, 0));
}

fn observe(
    conn: &Db,
    expected: &Expected,
    pinned: &nd::NativeDefinition,
    observation: Observation,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<occurrence::Coverage, flow::Error> {
    let mut owner = RuntimeOwner::open_existing(&conn.dir).unwrap();
    occurrence::observe_owned_rows(
        &mut owner,
        facts(),
        expected,
        pinned,
        observation,
        now,
        || Ok(()),
    )
}
#[test]
fn schedule_coverage_requires_actual_owner_transaction() {
    let conn = db();
    let (pinned, expected) = seeded(&conn, false);
    assert_eq!(
        occurrence::observe_rows(
            &conn,
            facts(),
            &expected,
            &pinned,
            Observation::Unknown,
            at_due()
        ),
        Err(flow::Error::Unavailable)
    );
    assert_eq!(current_cursor(&conn), expected.cursor_ms);
}
#[test]
fn unknown_coverage_skips_missed_slot_without_creating_a_run_or_grant() {
    let conn = db();
    let (pinned, expected) = seeded(&conn, false);
    let observed = observe(&conn, &expected, &pinned, Observation::Unknown, at_due()).unwrap();
    assert_eq!(observed.plan.due_ms, None);
    assert_eq!(observed.plan.skipped, 1);
    assert!(!observed.plan.coverage_known);
    assert_eq!(observed.current.cursor_ms, expected.intended_ms);
    assert_eq!(observed.current.revision, 2);
    let (skipped, known): (i64, bool) = conn
        .query_row(
            "SELECT skipped_count,coverage_known FROM workflow_activations",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!((skipped, known), (1, false));
    assert_eq!(
        (
            count(&conn, "runs"),
            count(&conn, "flow"),
            count(&conn, "grants"),
            occurrences(&conn)
        ),
        (0, 0, 0, 0)
    );
}
#[test]
fn known_observation_that_began_after_slot_records_skip_not_catchup_run() {
    let conn = db();
    let (pinned, expected) = seeded(&conn, false);
    let after = Observation::Native {
        previous_ms: expected.intended_ms,
        same_opening: true,
        resumed: false,
    };
    let observed = observe(&conn, &expected, &pinned, after, at_due()).unwrap();
    assert!(observed.plan.coverage_known);
    assert_eq!(observed.plan.due_ms, None);
    assert_eq!(observed.plan.skipped, 1);
    assert_eq!(current_cursor(&conn), expected.intended_ms);
    assert_eq!(count(&conn, "runs"), 0);
}
#[test]
fn runnable_due_observation_leaves_cursor_for_actual_atomic_claim() {
    let conn = db();
    let (pinned, expected) = seeded(&conn, false);
    let observed = observe(&conn, &expected, &pinned, awake(), at_due()).unwrap();
    assert_eq!(observed.plan.due_ms, Some(expected.intended_ms));
    assert_eq!(observed.current.cursor_ms, expected.cursor_ms);
    assert_eq!(observed.current.revision, 1);
    assert_eq!(occurrences(&conn), 0);
    let origin = new_origin(owned(&conn, &expected, &pinned).unwrap());
    assert_eq!(occurrences(&conn), 1);
    assert_eq!(count(&conn, "runs"), 1);
    assert!(!origin.flow_run.is_empty());
}
#[test]
fn stale_coverage_capture_cannot_advance_replaced_configuration() {
    let conn = db();
    let (pinned, mut expected) = seeded(&conn, false);
    let original = expected.cursor_ms;
    expected.revision = 2;
    assert_eq!(
        observe(&conn, &expected, &pinned, Observation::Unknown, at_due()),
        Err(flow::Error::Stale)
    );
    assert_eq!(current_cursor(&conn), original);
    assert_eq!(count(&conn, "runs"), 0);
}
#[test]
fn changed_enable_account_pin_holds_skipped_coverage_without_regrant() {
    let conn = db();
    let (pinned, expected) = seeded(&conn, true);
    conn.execute(
        "UPDATE managed_connections SET status=json_set(status,'$.account.accountRevision',2)",
        [],
    )
    .unwrap();
    assert_eq!(
        observe(&conn, &expected, &pinned, Observation::Unknown, at_due()),
        Err(flow::Error::Denied)
    );
    assert_eq!(current_cursor(&conn), expected.cursor_ms);
    assert_eq!(count(&conn, "grants"), 0);
}
#[test]
fn original_opening_loss_rolls_back_skipped_cursor_and_finite_counts() {
    let conn = db();
    let (pinned, expected) = seeded(&conn, false);
    let mut owner = RuntimeOwner::open_existing(&conn.dir).unwrap();
    let calls = std::cell::Cell::new(0);
    let result = occurrence::observe_owned_rows(
        &mut owner,
        facts(),
        &expected,
        &pinned,
        Observation::Unknown,
        at_due(),
        || {
            calls.set(calls.get() + 1);
            if calls.get() == 1 {
                Ok(())
            } else {
                Err(flow::Error::Denied)
            }
        },
    );
    assert_eq!(result, Err(flow::Error::Denied));
    assert_eq!(calls.get(), 2);
    assert_eq!(current_cursor(&conn), expected.cursor_ms);
    let skipped: i64 = conn
        .query_row(
            "SELECT skipped_count FROM workflow_activations",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(skipped, 0);
}
#[test]
fn lost_coverage_commit_ack_keeps_finite_progress_but_retires_original_owner() {
    let conn = db();
    let (pinned, expected) = seeded(&conn, false);
    let mut owner = RuntimeOwner::open_existing(&conn.dir).unwrap();
    let result = crate::actions::native_owner::tests::with_transaction_ack_probe(|| {
        crate::actions::native_owner::tests::lose_next_transaction_ack();
        occurrence::observe_owned_rows(
            &mut owner,
            facts(),
            &expected,
            &pinned,
            Observation::Unknown,
            at_due(),
            || Ok(()),
        )
    });
    assert_eq!(result, Err(flow::Error::Unavailable));
    assert!(owner.retired);
    assert_eq!(current_cursor(&conn), expected.intended_ms);
    assert_eq!(count(&conn, "runs"), 0);
    assert_eq!(
        observe(&conn, &expected, &pinned, Observation::Unknown, at_due()),
        Err(flow::Error::Stale)
    );
}
#[test]
fn one_day_unknown_coverage_records_all_skips_in_one_finite_decision() {
    let conn = db();
    let (pinned, expected) = seeded(&conn, false);
    let now = time() + chrono::Duration::days(1) + chrono::Duration::milliseconds(500);
    let observed = observe(&conn, &expected, &pinned, Observation::Unknown, now).unwrap();
    assert_eq!(observed.plan.skipped, 1440);
    assert_eq!(observed.plan.due_ms, None);
    assert_eq!(
        observed.current.cursor_ms,
        time().timestamp_millis() + 86_400_000
    );
    let (first, last): (i64, i64) = conn
        .query_row(
            "SELECT first_skipped_ms,last_skipped_ms FROM workflow_activations",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(first, expected.intended_ms);
    assert_eq!(last, time().timestamp_millis() + 86_400_000);
    assert_eq!(count(&conn, "runs"), 0);
}

#[test]
fn schedule_preview_requires_existing_transaction() {
    let conn = db();
    let (pinned, expected) = seeded(&conn, false);
    assert_eq!(
        occurrence::preview_rows(&conn, facts(), &expected, &pinned, awake(), at_due()),
        Err(flow::Error::Unavailable)
    );
}
#[test]
fn schedule_preview_uses_real_pins_query_only_without_consuming_due_slot() {
    let conn = db();
    let (pinned, expected) = seeded(&conn, true);
    conn.execute_batch("PRAGMA query_only=ON").unwrap();
    let tx = Transaction::new_unchecked(&conn, TransactionBehavior::Deferred).unwrap();
    let before = tx.total_changes();
    let observed =
        occurrence::preview_rows(&tx, facts(), &expected, &pinned, awake(), at_due()).unwrap();
    assert_eq!(observed.plan.due_ms, Some(expected.intended_ms));
    assert_eq!(observed.current.cursor_ms, expected.cursor_ms);
    assert!(observed.plan.coverage_known);
    assert_eq!(tx.total_changes(), before);
    assert_eq!(
        (count(&tx, "runs"), count(&tx, "grants"), occurrences(&tx)),
        (0, 0, 0)
    );
    assert_eq!(current_cursor(&tx), expected.cursor_ms);
    tx.rollback().unwrap();
}
#[test]
fn schedule_preview_unknown_coverage_describes_skips_without_advancing_cursor() {
    let conn = db();
    let (pinned, expected) = seeded(&conn, false);
    let observed = tx(&conn, |c| {
        occurrence::preview_rows(
            c,
            facts(),
            &expected,
            &pinned,
            Observation::Unknown,
            at_due(),
        )
    })
    .unwrap();
    assert_eq!(observed.plan.due_ms, None);
    assert_eq!(observed.plan.skipped, 1);
    assert!(!observed.plan.coverage_known);
    assert_eq!(observed.plan.cursor_ms, expected.intended_ms);
    assert_eq!(current_cursor(&conn), expected.cursor_ms);
    assert_eq!(occurrences(&conn), 0);
}
#[test]
fn schedule_preview_does_not_report_ready_after_exact_selection_or_account_changes() {
    let conn = db();
    let (pinned, expected) = seeded(&conn, true);
    let mut stale = expected.clone();
    stale.revision += 1;
    assert_eq!(
        tx(&conn, |c| occurrence::preview_rows(
            c,
            facts(),
            &stale,
            &pinned,
            awake(),
            at_due()
        )),
        Err(flow::Error::Stale)
    );
    let (connection, revision): (String, i64) = conn
        .query_row(
            "SELECT connection_id,account_revision FROM workflow_activation_accounts",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    tx(&conn, |c| {
        crate::connections::account_metadata::disable(
            c,
            "human:me",
            &crate::actions::ids::ConnectionId(connection),
            u64::try_from(revision).unwrap(),
        )
        .unwrap();
        Ok(())
    })
    .unwrap();
    assert_eq!(
        tx(&conn, |c| occurrence::preview_rows(
            c,
            facts(),
            &expected,
            &pinned,
            awake(),
            at_due()
        )),
        Err(flow::Error::Denied)
    );
    assert_eq!(
        (
            count(&conn, "runs"),
            count(&conn, "grants"),
            occurrences(&conn)
        ),
        (0, 0, 0)
    );
    assert_eq!(current_cursor(&conn), expected.cursor_ms);
}
