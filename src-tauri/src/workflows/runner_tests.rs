use super::*;
use crate::{
    actions::{schema, workflow_requests},
    mcp::{RunGrant, WriteAsks},
    runtime::workflow_action_inputs,
    vault::corpus::CorpusCache,
};
use rusqlite::{Transaction, TransactionBehavior};
use serde_json::{json, Value};
const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const KEY: &str = "11111111111111111111111111111111";
fn scope() -> rows::Scope<'static> {
    rows::Scope {
        owner: "human:me",
        vault: "cccccccccccccccccccccccccccccccc",
        store: "store",
        actor: "workflow:owner",
    }
}
struct TestDb {
    conn: Option<Connection>,
    dir: std::path::PathBuf,
}
impl std::ops::Deref for TestDb {
    type Target = Connection;
    fn deref(&self) -> &Self::Target {
        self.conn.as_ref().unwrap()
    }
}
impl Drop for TestDb {
    fn drop(&mut self) {
        drop(self.conn.take());
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}
fn db() -> TestDb {
    let dir = crate::vault::testutil::temp_vault("workflow-runner-runtime");
    let mut db = TestDb { conn: None, dir };
    db.conn = Some(crate::runtime::open(&db.dir).unwrap());
    db.execute("INSERT INTO vault_registry(vault_id,vault_path,first_seen_at) VALUES(?1,?2,'2026-10-26T00:00:00.000Z')",rusqlite::params![scope().vault,db.dir.join("fixture-vault").to_string_lossy()]).unwrap();
    db
}
fn tx<T>(conn: &Connection, f: impl FnOnce(&Connection) -> Result<T, Error>) -> Result<T, Error> {
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate).unwrap();
    let result = f(&tx)?;
    tx.commit().unwrap();
    Ok(result)
}
fn def(input: Value, steps: Vec<Value>) -> ValidatedDefinition {
    let schema = input.to_string();
    let digest = schema::workflow_schema_digest(&schema).unwrap();
    super::super::definition::validate(&json!({"formatVersion":1,"workflowId":"runner","entryStepId":steps[0]["stepId"],"inputSchema":input,"inputSchemaDigest":digest,"steps":steps,"trigger":{"kind":"manual"},"declaredActionDigests":steps.iter().filter_map(|s|s["operation"]["definitionDigest"].as_str()).collect::<Vec<_>>(),"authoredBy":"human:me"}).to_string()).unwrap()
}
fn step(id: &str, operation: Value) -> Value {
    json!({"stepId":id,"label":id,"operation":operation})
}
fn literal(value: Value) -> Value {
    json!({"kind":"literal","value":value})
}
fn input(path: &[&str]) -> Value {
    json!({"kind":"input","path":path})
}
fn output(id: &str) -> Value {
    json!({"kind":"output","stepId":id,"path":[]})
}
fn result(id: &str, mapping: Value) -> Value {
    step(id, json!({"kind":"result","output":mapping}))
}
fn transform(id: &str, mapping: Value, schema: Value, next: &str) -> Value {
    step(
        id,
        json!({"kind":"transform","mapping":mapping,"outputSchema":schema,"nextStepId":next}),
    )
}
fn read(next: &str, schema: Value) -> Value {
    step(
        "read",
        json!({"kind":"read","query":literal(json!({"limit":10})),"outputSchema":schema,"nextStepId":next}),
    )
}
fn start(conn: &Connection, definition: &ValidatedDefinition, input: &str) -> rows::Run {
    let rows::Started::New(run) = tx(conn, |c| {
        start_rows(
            c,
            scope(),
            Start {
                key: KEY,
                definition,
                input,
                configuration: HASH,
                grants: HASH,
                act_scope: Some(HASH),
                act_run: Some("original-act-run"),
                now: 100,
            },
        )
    })
    .unwrap() else {
        panic!("new run")
    };
    run
}
fn plan(conn: &Connection, definition: &ValidatedDefinition, run: &str) -> Snapshot {
    let Plan::Pending(plan) = tx(conn, |c| plan_rows(c, scope(), run, definition)).unwrap() else {
        panic!("pending cursor")
    };
    plan
}
fn apply(conn: &Connection, definition: &ValidatedDefinition, run: &str) -> Applied {
    let snapshot = plan(conn, definition, run);
    let prepared = prepare(&snapshot).unwrap();
    tx(conn, |c| {
        apply_rows(c, scope(), prepared, None, "process", 101)
    })
    .unwrap()
}
fn count(conn: &Connection, table: &str) -> i64 {
    conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}
fn recorded(conn: &Connection, run: &str, step: &str) -> String {
    conn.query_row("SELECT canonical_json FROM workflow_values WHERE run_id=?1 AND step_id=?2 AND role='step_output'",[run,step],|r|r.get(0)).unwrap()
}
struct QueryVault(std::path::PathBuf);
impl Drop for QueryVault {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn query_grant() -> (QueryVault, RunGrant) {
    let dir = crate::vault::testutil::temp_vault("workflow-real-query");
    std::fs::create_dir_all(dir.join("visible")).unwrap();
    std::fs::create_dir_all(dir.join("hidden")).unwrap();
    std::fs::write(dir.join("visible/a.md"), "# Visible runner record\n").unwrap();
    std::fs::write(dir.join("hidden/secret.md"), "# SECRET-RUNNER-RECORD\n").unwrap();
    let grant = RunGrant {
        actor: "workflow:owner".into(),
        run_id: "dddddddddddddddddddddddddddddddd".into(),
        scope: Some(vec![]),
        read_scope: Some(vec!["visible".into()]),
        tools: Some(vec!["query_records".into()]),
        chain: vec!["workflow:owner".into()],
        vault: Some(dir.clone()),
        asks: WriteAsks::UNASKED,
    };
    (QueryVault(dir), grant)
}
fn query(query: &str) -> String {
    let (_dir, grant) = query_grant();
    super::super::read::execute(
        &CorpusCache::new(16),
        &grant,
        query,
        chrono_tz::UTC,
        chrono::NaiveDate::from_ymd_opt(2026, 10, 26).unwrap(),
    )
    .unwrap()
}
#[test]
fn runner_real_scoped_query_door_preserves_scope_before_schema() {
    let text = query(r#"{"limit":10}"#);
    let decoded: String = serde_json::from_str(&text).unwrap();
    assert!(decoded.contains("visible/a.md"));
    assert!(!decoded.contains("SECRET-RUNNER-RECORD"));
    assert!(!decoded.contains("hidden/secret.md"));
}
#[test]
fn runner_read_transform_condition_result_uses_recorded_outputs() {
    let conn = db();
    let definition = def(
        json!({"type":"object"}),
        vec![
            read("copy", json!({"type":"string"})),
            transform("copy", output("read"), json!({"type":"string"}), "choose"),
            step(
                "choose",
                json!({"kind":"condition","predicate":{"kind":"exists","value":output("copy")},"ifTrue":"yes","ifFalse":"no"}),
            ),
            result("yes", output("copy")),
            result("no", literal(json!(false))),
        ],
    );
    let run = start(&conn, &definition, "{}");
    let Applied::Read(work) = apply(&conn, &definition, &run.id) else {
        panic!("read")
    };
    let answer = query(&work.query);
    tx(&conn, |c| {
        settle_read_rows(c, scope(), &work, &definition, Ok(&answer), 102)
    })
    .unwrap();
    assert_eq!(recorded(&conn, &run.id, "read"), answer);
    assert!(matches!(
        apply(&conn, &definition, &run.id),
        Applied::Advanced(_)
    ));
    assert_eq!(recorded(&conn, &run.id, "copy"), answer);
    assert!(matches!(
        apply(&conn, &definition, &run.id),
        Applied::Advanced(_)
    ));
    let skipped: String = conn
        .query_row(
            "SELECT state FROM workflow_steps WHERE run_id=?1 AND step_id='no'",
            [&run.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(skipped, "skipped");
    let Applied::Advanced(done) = apply(&conn, &definition, &run.id) else {
        panic!("result")
    };
    assert_eq!(done.state, "succeeded");
    assert_eq!(count(&conn, "workflow_values"), 0);
}
#[test]
fn runner_running_and_completed_inspection_never_reissues_read() {
    let conn = db();
    let definition = def(
        json!({"type":"object"}),
        vec![
            read("done", json!({"type":"string"})),
            result("done", output("read")),
        ],
    );
    let run = start(&conn, &definition, "{}");
    let Applied::Read(work) = apply(&conn, &definition, &run.id) else {
        panic!("read")
    };
    assert!(matches!(
        tx(&conn, |c| plan_rows(c, scope(), &run.id, &definition)).unwrap(),
        Plan::Observed(_)
    ));
    assert_eq!(count(&conn, "workflow_attempts"), 1);
    let answer = query(&work.query);
    tx(&conn, |c| {
        settle_read_rows(c, scope(), &work, &definition, Ok(&answer), 102)
    })
    .unwrap();
    apply(&conn, &definition, &run.id);
    assert!(matches!(
        tx(&conn, |c| plan_rows(c, scope(), &run.id, &definition)).unwrap(),
        Plan::Observed(_)
    ));
    assert_eq!(count(&conn, "workflow_attempts"), 2);
}
#[test]
fn runner_duplicate_plan_cas_creates_only_one_claim() {
    let conn = db();
    let definition = def(
        json!({"type":"object"}),
        vec![
            read("done", json!({"type":"string"})),
            result("done", output("read")),
        ],
    );
    let run = start(&conn, &definition, "{}");
    let snapshot = plan(&conn, &definition, &run.id);
    let first = prepare(&snapshot).unwrap();
    let second = prepare(&snapshot).unwrap();
    tx(&conn, |c| apply_rows(c, scope(), first, None, "one", 101)).unwrap();
    assert!(tx(&conn, |c| apply_rows(c, scope(), second, None, "two", 101)).is_err());
    assert_eq!(count(&conn, "workflow_attempts"), 1);
}
#[test]
fn runner_pinned_definition_mismatch_does_not_claim() {
    let conn = db();
    let original = def(
        json!({"type":"object"}),
        vec![result("done", literal(json!(1)))],
    );
    let changed = def(
        json!({"type":"object"}),
        vec![result("done", literal(json!(2)))],
    );
    let run = start(&conn, &original, "{}");
    assert!(matches!(
        tx(&conn, |c| plan_rows(c, scope(), &run.id, &changed)),
        Err(Error::InvalidDefinition)
    ));
    assert_eq!(count(&conn, "workflow_attempts"), 0);
}
#[test]
fn runner_start_validates_actual_input_schema_before_rows() {
    let conn = db();
    let definition = def(json!({"type":"string"}), vec![result("done", input(&[]))]);
    assert!(matches!(
        tx(&conn, |c| start_rows(
            c,
            scope(),
            Start {
                key: KEY,
                definition: &definition,
                input: "{}",
                configuration: HASH,
                grants: HASH,
                act_scope: None,
                act_run: None,
                now: 100
            }
        )),
        Err(Error::InvalidInput)
    ));
    assert_eq!(count(&conn, "workflow_runs"), 0);
}
#[test]
fn runner_missing_required_mapping_fails_without_fabricated_attempt_input() {
    let conn = db();
    let definition = def(
        json!({"type":"object"}),
        vec![
            transform(
                "copy",
                input(&["missing"]),
                json!({"type":"string"}),
                "done",
            ),
            result("done", output("copy")),
        ],
    );
    let run = start(&conn, &definition, "{}");
    let snapshot = plan(&conn, &definition, &run.id);
    assert!(matches!(prepare(&snapshot), Err(Error::MissingStepOutput)));
    let failed = tx(&conn, |c| {
        reject_rows(c, scope(), &snapshot, Error::MissingStepOutput, 102)
    })
    .unwrap();
    assert_eq!(failed.reason.as_deref(), Some("missing_step_output"));
    assert_eq!(count(&conn, "workflow_attempts"), 0);
}
#[test]
fn runner_optional_object_mapping_omits_missing_under_actual_schema() {
    let conn = db();
    let definition = def(
        json!({"type":"object"}),
        vec![
            transform(
                "copy",
                json!({"kind":"object","fields":{"optional":input(&["missing"])}}),
                json!({"type":"object","properties":{"optional":{"type":"string"}},"additionalProperties":false}),
                "done",
            ),
            result("done", output("copy")),
        ],
    );
    let run = start(&conn, &definition, "{}");
    apply(&conn, &definition, &run.id);
    assert_eq!(recorded(&conn, &run.id, "copy"), "{}");
}
#[test]
fn runner_mapping_output_limit_is_durable_failure_before_claim() {
    let conn = db();
    let definition = def(
        json!({"type":"string"}),
        vec![
            transform(
                "copy",
                json!({"kind":"array","items":vec![input(&[]);40]}),
                json!({"type":"array","items":{"type":"string"}}),
                "done",
            ),
            result("done", output("copy")),
        ],
    );
    let input = serde_json::to_string(&"x".repeat(8_000)).unwrap();
    let run = start(&conn, &definition, &input);
    let snapshot = plan(&conn, &definition, &run.id);
    assert!(matches!(prepare(&snapshot), Err(Error::OutputLimit)));
    let failed = tx(&conn, |c| {
        reject_rows(c, scope(), &snapshot, Error::OutputLimit, 102)
    })
    .unwrap();
    assert_eq!(failed.reason.as_deref(), Some("output_limit"));
    assert_eq!(count(&conn, "workflow_attempts"), 0);
}
#[test]
fn runner_read_output_schema_failure_never_advances() {
    let conn = db();
    let definition = def(
        json!({"type":"object"}),
        vec![
            read("done", json!({"type":"object"})),
            result("done", output("read")),
        ],
    );
    let run = start(&conn, &definition, "{}");
    let Applied::Read(work) = apply(&conn, &definition, &run.id) else {
        panic!("read")
    };
    let answer = query(&work.query);
    let failed = tx(&conn, |c| {
        settle_read_rows(c, scope(), &work, &definition, Ok(&answer), 102)
    })
    .unwrap();
    assert_eq!(failed.state, "failed");
    assert_eq!(failed.reason.as_deref(), Some("invalid_output"));
}
#[test]
fn runner_cancelled_read_settlement_cannot_advance() {
    let conn = db();
    let definition = def(
        json!({"type":"object"}),
        vec![
            read("done", json!({"type":"string"})),
            result("done", output("read")),
        ],
    );
    let run = start(&conn, &definition, "{}");
    let Applied::Read(work) = apply(&conn, &definition, &run.id) else {
        panic!("read")
    };
    let answer = query(&work.query);
    tx(&conn, |c| {
        rows::cancel_rows(c, scope(), &run.id, work.claim.run_revision, 102).map_err(Error::from)
    })
    .unwrap();
    assert!(tx(&conn, |c| settle_read_rows(
        c,
        scope(),
        &work,
        &definition,
        Ok(&answer),
        103
    ))
    .is_err());
    assert_eq!(count(&conn, "workflow_values"), 0);
}
#[test]
fn runner_timer_uses_pinned_definition_and_installs_one_wait() {
    let conn = db();
    let definition = def(
        json!({"type":"object"}),
        vec![
            step(
                "wait",
                json!({"kind":"wait","until":{"kind":"timer","at":"2030-01-01T00:00:00Z"},"nextStepId":"done"}),
            ),
            result("done", literal(json!(true))),
        ],
    );
    let run = start(&conn, &definition, "{}");
    assert!(matches!(
        apply(&conn, &definition, &run.id),
        Applied::Waiting(_)
    ));
    assert!(matches!(
        tx(&conn, |c| plan_rows(c, scope(), &run.id, &definition)).unwrap(),
        Plan::Observed(_)
    ));
    assert_eq!(count(&conn, "workflow_waits"), 1);
}
fn action_definition() -> (ValidatedDefinition, workflow_requests::Selectors) {
    let selectors = workflow_requests::fixture_selectors();
    let definition = def(
        json!({"type":"object"}),
        vec![
            step(
                "action",
                json!({"kind":"action","actionId":selectors.action_id,"definitionDigest":selectors.definition_digest,"connectionId":selectors.connection_id,"accountId":selectors.account_id,"input":input(&[]),"nextStepId":"done"}),
            ),
            result("done", output("action")),
        ],
    );
    (definition, selectors)
}
#[test]
fn runner_action_freezes_exact_original_selectors_and_recovers_original_request() {
    let conn = db();
    let (definition, selectors) = action_definition();
    let run = start(
        &conn,
        &definition,
        r#"{"repository":"owner/repo","title":"first","body":"body"}"#,
    );
    let snapshot = plan(&conn, &definition, &run.id);
    let prepared = prepare(&snapshot).unwrap();
    let Applied::Action(work) = tx(&conn, |c| {
        apply_rows(
            c,
            scope(),
            prepared,
            Some(ActionSnapshot {
                snapshot_digest: &selectors.snapshot_digest,
                configuration_digest: HASH,
            }),
            "one",
            101,
        )
    })
    .unwrap() else {
        panic!("action")
    };
    assert_eq!(work.request.selectors, selectors);
    let recovered = tx(&conn, |c| {
        workflow_action_inputs::recover_rows(c, scope(), &run.id, "action").map_err(Error::from)
    })
    .unwrap();
    assert_eq!(recovered, work.request);
    assert_eq!(recovered.request_key, work.claim.request_key);
    assert_eq!(count(&conn, "workflow_action_inputs"), 1);
    assert_eq!(
        count(&conn, "workflow_values"),
        2,
        "selectors do not duplicate the input body"
    );
}
#[test]
fn runner_changed_action_configuration_refuses_before_claim() {
    let conn = db();
    let (definition, selectors) = action_definition();
    let run = start(
        &conn,
        &definition,
        r#"{"repository":"owner/repo","title":"first","body":"body"}"#,
    );
    let snapshot = plan(&conn, &definition, &run.id);
    let prepared = prepare(&snapshot).unwrap();
    assert!(tx(&conn, |c| apply_rows(
        c,
        scope(),
        prepared,
        Some(ActionSnapshot {
            snapshot_digest: &selectors.snapshot_digest,
            configuration_digest: &"b".repeat(64)
        }),
        "one",
        101
    ))
    .is_err());
    assert_eq!(count(&conn, "workflow_attempts"), 0);
    assert_eq!(count(&conn, "workflow_action_inputs"), 0);
}
#[test]
fn runner_missing_required_action_input_never_prepares_request() {
    let conn = db();
    let (definition, _) = action_definition();
    let run = start(&conn, &definition, "{}");
    let snapshot = plan(&conn, &definition, &run.id);
    assert!(prepare(&snapshot).is_err());
    assert_eq!(count(&conn, "workflow_action_inputs"), 0);
    assert_eq!(count(&conn, "workflow_attempts"), 0);
}

#[test]
fn runner_requires_transaction_before_start() {
    let conn = db();
    let definition = def(
        json!({"type":"object"}),
        vec![result("done", literal(json!(1)))],
    );
    assert!(matches!(
        start_rows(
            &conn,
            scope(),
            Start {
                key: KEY,
                definition: &definition,
                input: "{}",
                configuration: HASH,
                grants: HASH,
                act_scope: None,
                act_run: None,
                now: 100
            }
        ),
        Err(Error::Unavailable) | Err(Error::Runtime(rows::Error::Unavailable))
    ));
    assert_eq!(count(&conn, "workflow_runs"), 0);
}
fn claimed_action(conn: &Connection) -> (rows::Run, ActionWork) {
    let (definition, selectors) = action_definition();
    let run = start(
        conn,
        &definition,
        r#"{"repository":"owner/repo","title":"first","body":"body"}"#,
    );
    let snapshot = plan(conn, &definition, &run.id);
    let prepared = prepare(&snapshot).unwrap();
    let Applied::Action(work) = tx(conn, |c| {
        apply_rows(
            c,
            scope(),
            prepared,
            Some(ActionSnapshot {
                snapshot_digest: &selectors.snapshot_digest,
                configuration_digest: HASH,
            }),
            "one",
            101,
        )
    })
    .unwrap() else {
        panic!("action")
    };
    (run, work)
}
#[test]
fn runner_frozen_request_cannot_be_replaced_by_current_snapshot() {
    let conn = db();
    let (run, work) = claimed_action(&conn);
    let mut changed = work.request.selectors.clone();
    changed.snapshot_digest = "d".repeat(64);
    let changed =
        workflow_requests::freeze(changed, &work.request.input, &work.request.request_key).unwrap();
    assert!(tx(&conn, |c| workflow_action_inputs::freeze_rows(
        c,
        scope(),
        &work.claim,
        &changed,
        HASH
    )
    .map_err(Error::from))
    .is_err());
    let recovered = tx(&conn, |c| {
        workflow_action_inputs::recover_rows(c, scope(), &run.id, "action").map_err(Error::from)
    })
    .unwrap();
    assert_eq!(recovered, work.request);
}
#[test]
fn runner_cancelled_claim_protects_original_request_until_act_settlement() {
    let conn = db();
    let (run, work) = claimed_action(&conn);
    let cancelled = tx(&conn, |c| {
        rows::cancel_rows(c, scope(), &run.id, work.claim.run_revision, 102).map_err(Error::from)
    })
    .unwrap();
    assert_eq!(cancelled.state, "blocked");
    assert!(cancelled.cancel_requested);
    assert!(count(&conn, "workflow_values") > 0);
    assert_eq!(count(&conn, "workflow_action_inputs"), 1);
    let original = tx(&conn, |c| {
        workflow_action_inputs::recover_rows(c, scope(), &run.id, "action").map_err(Error::from)
    })
    .unwrap();
    assert_eq!(original, work.request);
}
#[test]
fn runner_frozen_request_is_bound_to_original_actor() {
    let conn = db();
    let (run, _) = claimed_action(&conn);
    assert!(tx(&conn, |c| workflow_action_inputs::recover_rows(
        c,
        rows::Scope {
            actor: "another",
            ..scope()
        },
        &run.id,
        "action"
    )
    .map_err(Error::from))
    .is_err());
}
#[test]
fn runner_action_claim_and_selector_freeze_roll_back_together() {
    let conn = db();
    let (definition, selectors) = action_definition();
    let run = start(
        &conn,
        &definition,
        r#"{"repository":"owner/repo","title":"first","body":"body"}"#,
    );
    let snapshot = plan(&conn, &definition, &run.id);
    let prepared = prepare(&snapshot).unwrap();
    let transaction = Transaction::new_unchecked(&conn, TransactionBehavior::Immediate).unwrap();
    assert!(matches!(
        apply_rows(
            &transaction,
            scope(),
            prepared,
            Some(ActionSnapshot {
                snapshot_digest: &selectors.snapshot_digest,
                configuration_digest: HASH
            }),
            "one",
            101
        )
        .unwrap(),
        Applied::Action(_)
    ));
    transaction.rollback().unwrap();
    assert_eq!(count(&conn, "workflow_attempts"), 0);
    assert_eq!(count(&conn, "workflow_action_inputs"), 0);
    let current = tx(&conn, |c| {
        rows::inspect_rows(c, scope(), &run.id).map_err(Error::from)
    })
    .unwrap();
    assert_eq!(current.state, "queued");
}

#[test]
fn runner_read_without_query_tool_is_denied_before_read() {
    let (_dir, mut grant) = query_grant();
    grant.tools = Some(vec!["get_note".into()]);
    assert_eq!(
        super::super::read::execute(
            &CorpusCache::new(16),
            &grant,
            "{}",
            chrono_tz::UTC,
            chrono::NaiveDate::from_ymd_opt(2026, 10, 26).unwrap()
        ),
        Err(super::super::read::Error::Denied)
    );
}
#[test]
fn runner_read_without_bound_vault_is_denied() {
    let (_dir, mut grant) = query_grant();
    grant.vault = None;
    assert_eq!(
        super::super::read::execute(
            &CorpusCache::new(16),
            &grant,
            "{}",
            chrono_tz::UTC,
            chrono::NaiveDate::from_ymd_opt(2026, 10, 26).unwrap()
        ),
        Err(super::super::read::Error::Denied)
    );
}

#[test]
fn runner_exists_on_skipped_branch_stays_missing_not_null() {
    let conn = db();
    let definition = def(
        json!({"type":"object"}),
        vec![
            step(
                "choose",
                json!({"kind":"condition","predicate":{"kind":"equals","left":literal(json!(true)),"right":literal(json!(true))},"ifTrue":"left","ifFalse":"right"}),
            ),
            transform(
                "left",
                literal(json!(1)),
                json!({"type":"integer"}),
                "exists",
            ),
            transform(
                "right",
                literal(json!(2)),
                json!({"type":"integer"}),
                "exists",
            ),
            step(
                "exists",
                json!({"kind":"condition","predicate":{"kind":"exists","value":output("right")},"ifTrue":"yes","ifFalse":"no"}),
            ),
            result("yes", literal(json!(true))),
            result("no", literal(json!(false))),
        ],
    );
    let run = start(&conn, &definition, "{}");
    apply(&conn, &definition, &run.id);
    apply(&conn, &definition, &run.id);
    apply(&conn, &definition, &run.id);
    assert_eq!(recorded(&conn, &run.id, "exists"), "false");
    let right_outputs:i64=conn.query_row("SELECT count(*) FROM workflow_values WHERE run_id=?1 AND step_id='right' AND role='step_output'",[&run.id],|r|r.get(0)).unwrap();
    assert_eq!(right_outputs, 0);
}
#[test]
fn runner_lost_start_ack_reuses_exact_version_and_input() {
    let conn = db();
    let definition = def(json!({"type":"object"}), vec![result("done", input(&[]))]);
    let first = start(&conn, &definition, "{}");
    let replay = tx(&conn, |c| {
        start_rows(
            c,
            scope(),
            Start {
                key: KEY,
                definition: &definition,
                input: "{}",
                configuration: HASH,
                grants: HASH,
                act_scope: Some(HASH),
                act_run: Some("original-act-run"),
                now: 101,
            },
        )
    })
    .unwrap();
    assert_eq!(replay, rows::Started::Observed(first));
    assert!(tx(&conn, |c| start_rows(
        c,
        scope(),
        Start {
            key: KEY,
            definition: &definition,
            input: r#"{"changed":true}"#,
            configuration: HASH,
            grants: HASH,
            act_scope: Some(HASH),
            act_run: Some("original-act-run"),
            now: 102
        }
    ))
    .is_err());
    assert_eq!(count(&conn, "workflow_runs"), 1);
}
#[test]
fn runner_v45_installs_after_actual_v44_migration() {
    let dir = QueryVault(crate::vault::testutil::temp_vault("workflow-v45-migration"));
    let conn = crate::runtime::open(&dir.0).unwrap();
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert!(version >= 45);
    let tables:i64=conn.query_row("SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('action_output_handoffs','workflow_action_inputs')",[],|r|r.get(0)).unwrap();
    assert_eq!(tables, 2);
    drop(conn);
}

// M98 recovery identity review: a frozen copy cannot replace the current attempt.
fn recovery_rejects_changed_attempt(column: &str, changed: &str) {
    let conn = db();
    let (run, _) = claimed_action(&conn);
    let sql = match column {
        "input_ref" => "UPDATE workflow_attempts SET input_ref=?2 WHERE run_id=?1 AND step_id='action' AND ordinal=1",
        "input_digest" => "UPDATE workflow_attempts SET input_digest=?2 WHERE run_id=?1 AND step_id='action' AND ordinal=1",
        "request_key" => "UPDATE workflow_attempts SET request_key=?2 WHERE run_id=?1 AND step_id='action' AND ordinal=1",
        _ => panic!("fixed test selector"),
    };
    assert_eq!(
        conn.execute(sql, rusqlite::params![run.id, changed])
            .unwrap(),
        1
    );
    assert!(
        tx(&conn, |c| workflow_action_inputs::recover_rows(
            c,
            scope(),
            &run.id,
            "action"
        )
        .map_err(Error::from))
        .is_err(),
        "frozen request must match the actual current attempt's {column}"
    );
    assert_eq!(
        count(&conn, "workflow_action_inputs"),
        1,
        "refusal preserves recovery evidence"
    );
}
#[test]
fn runner_recovery_rejects_changed_attempt_input_ref() {
    recovery_rejects_changed_attempt("input_ref", &"f".repeat(32));
}
#[test]
fn runner_recovery_rejects_changed_attempt_input_digest() {
    recovery_rejects_changed_attempt("input_digest", &"f".repeat(64));
}
#[test]
fn runner_recovery_rejects_changed_attempt_request_key() {
    recovery_rejects_changed_attempt("request_key", &"f".repeat(64));
}
#[test]
fn runner_recovery_rejects_changed_current_step_input_identity() {
    for column in ["input_ref", "input_digest"] {
        let conn = db();
        let (run, _) = claimed_action(&conn);
        let (sql, changed) = if column == "input_ref" {
            (
                "UPDATE workflow_steps SET input_ref=?2 WHERE run_id=?1 AND step_id='action'",
                "f".repeat(32),
            )
        } else {
            (
                "UPDATE workflow_steps SET input_digest=?2 WHERE run_id=?1 AND step_id='action'",
                "f".repeat(64),
            )
        };
        assert_eq!(
            conn.execute(sql, rusqlite::params![run.id, changed])
                .unwrap(),
            1
        );
        assert!(
            tx(&conn, |c| workflow_action_inputs::recover_rows(
                c,
                scope(),
                &run.id,
                "action"
            )
            .map_err(Error::from))
            .is_err(),
            "current step's {column} differs from its frozen attempt"
        );
    }
}
#[test]
fn runner_recovery_rejects_inactive_current_step_with_live_run() {
    for state in ["pending", "succeeded", "failed", "skipped", "cancelled"] {
        let conn = db();
        let (run, _) = claimed_action(&conn);
        assert_eq!(
            conn.execute(
                "UPDATE workflow_steps SET state=?2 WHERE run_id=?1 AND step_id='action'",
                rusqlite::params![run.id, state]
            )
            .unwrap(),
            1
        );
        assert!(
            tx(&conn, |c| workflow_action_inputs::recover_rows(
                c,
                scope(),
                &run.id,
                "action"
            )
            .map_err(Error::from))
            .is_err(),
            "{state} step is not recoverable action work"
        );
    }
}
