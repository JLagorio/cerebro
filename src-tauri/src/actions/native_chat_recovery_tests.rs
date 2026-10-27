//! Fixture observations enter the same private composition as the managed command.
//! This is not OS/AppKit smoke and never constructs a live action subject.
#![cfg(target_os = "macos")]
use super::*;
use crate::actions::{effect_record, effect_types::*};
use serde_json::{json, Value};
use std::fs;
const RUN: &str = "original-root";
const STAMP: &str = "2026-10-25T00:00:00Z";
type CheckpointHook = (&'static str, Box<dyn FnOnce()>);
thread_local! { static HOOK: std::cell::RefCell<Option<CheckpointHook>> = const { std::cell::RefCell::new(None) }; }
pub(super) fn checkpoint(name: &str) {
    let hook = HOOK.with(|slot| {
        let mut slot = slot.borrow_mut();
        if slot.as_ref().is_some_and(|(n, _)| *n == name) {
            slot.take().map(|(_, f)| f)
        } else {
            None
        }
    });
    if let Some(hook) = hook {
        hook();
    }
}
fn hooked<T>(name: &'static str, hook: impl FnOnce() + 'static, work: impl FnOnce() -> T) -> T {
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            HOOK.with(|slot| *slot.borrow_mut() = None);
        }
    }
    HOOK.with(|slot| *slot.borrow_mut() = Some((name, Box::new(hook))));
    let _reset = Reset;
    work()
}
struct Host {
    data: PathBuf,
    root: PathBuf,
    conn: Connection,
    context: crate::workspace_service::authority::AuthorityContext,
    owner: Arc<NativeOwnerState>,
    scope: ActionSubjectView,
}
impl Host {
    fn new() -> Self {
        let data = crate::vault::testutil::temp_vault("m95-history-data")
            .canonicalize()
            .unwrap();
        let root = crate::vault::testutil::temp_vault("m95-history-root")
            .canonicalize()
            .unwrap();
        let store = crate::ledger::store::load_or_mint(&crate::ledger::ledger_dir(&root)).unwrap();
        let conn = crate::runtime::open(&data).unwrap();
        let vault = crate::runtime::scope::register(&conn, &root).unwrap();
        conn.execute("INSERT INTO app_sessions(session_id,vault_id,store_uuid,opened_at,last_heartbeat_at,clean_closed_at,close_precision) VALUES(?1,?2,?3,?4,?4,NULL,'open')",rusqlite::params![crate::runtime::sessions::session_id(),vault,store.store_id,STAMP]).unwrap();
        conn.execute("INSERT INTO runs(run_id,vault_id,store_uuid,mode,lane,started_at,outcome,usage_state,input_tokens,output_tokens,cache_read,cache_write,reserved_total_tokens,reserved_output_tokens,proposals_submitted,applied,rejected,actor,cli_session_id) VALUES(?1,?2,?3,'attended',(SELECT lane FROM lane_registry LIMIT 1),?4,'running','pending',0,0,0,0,0,0,0,0,0,'human:me','12345678-1234-1234-1234-123456789abc')",rusqlite::params![RUN,vault,store.store_id,STAMP]).unwrap();
        conn.execute("INSERT INTO action_native_runs(run_id,authority_id,revision,vault_id,store_uuid,canonical_vault_path,owner_person,actor_id,source_kind,app_session_id,cli_session_id,admitted_at) VALUES(?1,?2,1,?3,?4,?5,'human:me','human:me','run',?6,'12345678-1234-1234-1234-123456789abc',?7)",rusqlite::params![RUN,"1".repeat(32),vault,store.store_id,root.to_str().unwrap(),crate::runtime::sessions::session_id(),STAMP]).unwrap();
        conn.execute("INSERT INTO chat_parent_attempts(parent_run_id,attempt_id,authority_id) VALUES(?1,?2,?3)",rusqlite::params![RUN,"2".repeat(32),"1".repeat(32)]).unwrap();
        let status = json!({"connectionId":"connection","revision":1,"login":"test","health":"sign_in_required","account":{"accountId":"account","subject":"subject","issuer":"issuer","accountRevision":1,"scopeDigest":"d".repeat(64)},"secretRevision":0,"revocationGeneration":0,"observedAt":STAMP,"cleanupPending":false,"remoteRevocation":"not_attempted"});
        conn.execute("INSERT INTO managed_connections(connection_id,person,status) VALUES('connection','human:me',?1)",[status.to_string()]).unwrap();
        let registration = Arc::new(WindowRegistration {
            identity: NativeWindowIdentity {
                window: 100,
                view: 200,
                label: "main".into(),
            },
            origin: data.clone(),
            live: AtomicBool::new(true),
        });
        let owner = Arc::new(NativeOwnerState {
            credential_cancellations: Arc::default(),
            action_cancellations: Arc::default(),
            registration,
            storage: Mutex::new(StorageState {
                owner: Some(RuntimeOwner::open_existing(&data).unwrap()),
                failed: false,
            }),
        });
        let context = crate::workspace_service::authority::AuthorityContext::new(data.clone());
        context
            .publish_open(context.begin_open().unwrap(), &root)
            .unwrap();
        Self {
            data,
            root,
            conn,
            context,
            owner,
            scope: ActionSubjectView {
                vault_id: vault,
                run_id: RUN.into(),
                actor_id: "human:me".into(),
                child_job_id: None,
                client_id: None,
            },
        }
    }
    fn read(&self) -> Result<ChatRecoveryInspection, ActionReadError> {
        self.read_selector(RUN)
    }
    fn read_selector(&self, id: &str) -> Result<ChatRecoveryInspection, ActionReadError> {
        self.read_observation(id, self.owner.registration.identity.clone())
    }
    fn read_observation(
        &self,
        id: &str,
        injected: NativeWindowIdentity,
    ) -> Result<ChatRecoveryInspection, ActionReadError> {
        let observed = WindowObservation {
            registration: self.owner.registration.clone(),
            injected,
            current: self.owner.registration.identity.clone(),
            origin: self.data.clone(),
            entry: Url::parse("tauri://localhost/").unwrap(),
        };
        verify_window(&self.owner.registration, &observed, None).map_err(|_| read_unavailable())?;
        inspect_authenticated(
            AttendedWindowProof {
                owner: self.owner.clone(),
            },
            &self.context,
            id,
        )
    }
    fn insert(&self, n: usize) -> Value {
        let value = effect_record::tests::fixture(&self.scope, n);
        self.insert_value(&value);
        value
    }
    fn insert_value(&self, v: &Value) {
        let version = v["lookup_version"].as_u64().unwrap_or(0);
        let scope = if version == 0 {
            effect_record::legacy_scope_key(&self.scope)
        } else {
            effect_record::scope_key(&self.scope)
        }
        .unwrap();
        self.conn.execute("INSERT INTO action_invocations(invocation_id,subject_scope,request_key,request_digest,revision,state,payload) VALUES(?1,?2,?3,?4,?5,?6,?7)",rusqlite::params![v["details"]["effect"]["invocationId"].as_str().unwrap(),scope,v["request"]["requestKey"].as_str().unwrap(),v["request_digest"].as_str().unwrap(),v["details"]["revision"].as_i64().unwrap(),v["details"]["effect"]["state"].as_str().unwrap(),v.to_string()]).unwrap();
    }
    fn corrupt(&self, sql: &str) {
        self.conn
            .execute_batch("PRAGMA ignore_check_constraints=ON; PRAGMA foreign_keys=OFF;")
            .unwrap();
        self.conn.execute_batch(sql).unwrap();
    }
    fn status(&self, modify: impl FnOnce(&mut Value)) {
        let raw: String = self
            .conn
            .query_row("SELECT status FROM managed_connections", [], |r| r.get(0))
            .unwrap();
        let mut v: Value = serde_json::from_str(&raw).unwrap();
        modify(&mut v);
        self.conn
            .execute_batch("PRAGMA ignore_check_constraints=ON")
            .unwrap();
        self.conn
            .execute("UPDATE managed_connections SET status=?1", [v.to_string()])
            .unwrap();
    }
    fn assert_quiet(&self) {
        assert!(!self.data.join(".action-submission-owners").exists());
        let storage = self.owner.storage.lock().unwrap();
        let owner = storage.owner.as_ref().unwrap();
        assert_eq!(
            owner
                .conn
                .query_row("PRAGMA query_only", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
}
impl Drop for Host {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
        let _ = fs::remove_dir_all(&self.data);
    }
}
#[test]
fn p1a_01_06_actual_composition_returns_scoped_history_with_no_execution() {
    let h = Host::new();
    h.insert(1);
    h.corrupt(
        "UPDATE action_native_runs SET close_kind='stopped',closed_at='2026-10-25T00:00:01Z'",
    );
    for health in ["ready", "sign_in_required"] {
        h.status(|s| s["health"] = json!(health));
        let answer = h.read().unwrap();
        let v = serde_json::to_value(answer).unwrap();
        assert_eq!(v["origin"]["rootAttemptId"], "2".repeat(32));
        assert_eq!(v["origin"]["runId"], RUN);
        assert_eq!(v["origin"]["outcome"], "running");
        assert_eq!(v["effects"][0]["detailsRead"], "available");
        assert_eq!(
            v["effects"][0]["details"]["preview"]["summary"],
            "Safe preview"
        );
        assert_eq!(v["effects"][0]["effect"]["state"], "outcome_unknown");
        assert_eq!(v["effects"][0]["effect"]["canRetry"], false);
        assert_eq!(v["effects"][0]["details"]["effect"]["canReconcile"], false);
        assert_eq!(v["brokerInventory"]["state"], "complete");
        assert_eq!(v["brokerInventory"]["observedCount"], 1);
        assert_eq!(v["generationCoverage"]["state"], "unknown");
        assert_eq!(v["externalEffectsCoverage"]["state"], "unknown");
        h.assert_quiet();
    }
}
#[test]
fn p1a_02_19_foreign_or_malformed_roots_never_leak_or_backfill() {
    for sql in [
        "UPDATE runs SET mode='ambient'",
        "UPDATE runs SET actor='process:other'",
        "UPDATE runs SET cli_session_id='different-session'",
        "UPDATE action_native_runs SET owner_person='human:other'",
        "UPDATE action_native_runs SET parent_run_id='parent'",
        "UPDATE action_native_runs SET store_uuid='foreign'",
        "UPDATE action_native_runs SET source_kind='client',client_id='fake'",
        "UPDATE action_native_runs SET child_job_id='child'",
        "DELETE FROM chat_parent_attempts",
        "UPDATE chat_parent_attempts SET authority_id='bad'",
        "UPDATE chat_parent_attempts SET attempt_id='BAD'",
        "UPDATE action_native_runs SET revision=0",
        "UPDATE action_native_runs SET revision=9007199254740992",
        "UPDATE action_native_runs SET vault_id='foreign'",
    ] {
        let h = Host::new();
        h.insert(1);
        h.corrupt(sql);
        assert!(h.read().is_err(), "{sql}");
        h.assert_quiet();
    }
    let h = Host::new();
    for id in ["", "foreign", &"é".repeat(65)] {
        assert!(h.read_selector(id).is_err());
    }
}
#[test]
fn p1a_03_history_lifecycle_is_distinct_from_live_execution() {
    for close in ["stopped", "revoked", "context_closed"] {
        for precision in ["open", "clean_exact", "heartbeat_lower_bound"] {
            let h = Host::new();
            h.insert(1);
            h.conn
                .execute(
                    "UPDATE action_native_runs SET close_kind=?1,closed_at='2026-10-25T00:00:01Z'",
                    [close],
                )
                .unwrap();
            if precision != "open" {
                h.corrupt("UPDATE app_sessions SET session_id='old-process';UPDATE action_native_runs SET app_session_id='old-process'");
                h.conn.execute("UPDATE app_sessions SET close_precision=?1,clean_closed_at=CASE WHEN ?1='clean_exact' THEN last_heartbeat_at ELSE NULL END",[precision]).unwrap();
            }
            let answer = h.read().unwrap();
            assert_eq!(answer.origin.outcome, "running");
            assert_eq!(
                answer.effects[0].effect.state,
                InvocationState::OutcomeUnknown
            );
        }
    }
    for outcome in [
        "succeeded",
        "failed",
        "quota_failed",
        "elapsed_aborted",
        "cancelled",
        "abandoned_usage_unknown",
    ] {
        let h = Host::new();
        h.insert(1);
        h.conn
            .execute(
                "UPDATE runs SET outcome=?1,ended_at='2026-10-25T00:00:01Z'",
                [outcome],
            )
            .unwrap();
        assert_eq!(
            serde_json::to_value(h.read().unwrap()).unwrap()["origin"]["outcome"],
            outcome
        );
    }
    for precision in ["clean_exact", "heartbeat_lower_bound"] {
        let h = Host::new();
        h.corrupt("UPDATE app_sessions SET session_id='old-process';UPDATE action_native_runs SET app_session_id='old-process'");
        h.conn.execute("UPDATE app_sessions SET close_precision=?1,clean_closed_at=CASE WHEN ?1='clean_exact' THEN last_heartbeat_at ELSE NULL END",[precision]).unwrap();
        assert!(h.read().is_ok());
    }
    let h = Host::new();
    h.corrupt("UPDATE app_sessions SET opened_at='2026-10-25T00:01:00Z',last_heartbeat_at='2026-10-25T00:01:00Z'");
    assert!(h.read().is_ok());
}
#[test]
fn p1a_04_incoherent_history_is_unavailable() {
    for sql in ["UPDATE runs SET ended_at='2026-10-25T00:00:01Z'","UPDATE runs SET outcome='cancelled'","UPDATE action_native_runs SET close_kind='completed',closed_at='2026-10-25T00:00:01Z'","UPDATE action_native_runs SET close_kind='stopped'","UPDATE app_sessions SET session_id='old';UPDATE action_native_runs SET app_session_id='old'","UPDATE app_sessions SET last_heartbeat_at='2026-10-24T00:00:00Z'","UPDATE app_sessions SET clean_closed_at='2026-10-25T00:00:02Z',close_precision='clean_exact'","UPDATE runs SET started_at='not-a-time'","UPDATE action_native_runs SET close_kind='stopped',closed_at='2026-10-24T00:00:00Z'"] {
        let h=Host::new();h.corrupt(sql);assert!(h.read().is_err(),"{sql}");
    }
}
#[test]
fn p1a_05_exact_window_owner_opening_and_physical_runtime_are_rechecked() {
    let h = Host::new();
    let mut wrong = h.owner.registration.identity.clone();
    wrong.view += 1;
    assert!(h.read_observation(RUN, wrong).is_err());
    let owner = h.owner.clone();
    assert!(hooked(
        "before_return",
        move || owner.registration.live.store(false, Ordering::SeqCst),
        || h.read()
    )
    .is_err());
    let h = Host::new();
    let ctx = h.context.clone();
    let root = h.root.clone();
    assert!(hooked(
        "after_capture",
        move || {
            let other = crate::vault::testutil::temp_vault("m95-other");
            ctx.publish_open(ctx.begin_open().unwrap(), &other).unwrap();
            ctx.publish_open(ctx.begin_open().unwrap(), &root).unwrap();
        },
        || h.read()
    )
    .is_err());
    let h = Host::new();
    let db = crate::runtime::runtime_db_path(&h.data);
    let copy = db.with_extension("original");
    fs::rename(&db, copy).unwrap();
    fs::write(&db, b"replacement").unwrap();
    assert!(h.read().is_err());
    let h = Host::new();
    let db = crate::runtime::runtime_db_path(&h.data);
    let moved = db.with_extension("retained");
    assert!(hooked(
        "before_return",
        move || {
            fs::rename(&db, moved).unwrap();
            fs::write(&db, b"mid-read replacement").unwrap();
        },
        || h.read()
    )
    .is_err());
    let h = Host::new();
    let store = crate::ledger::ledger_dir(&h.root).join("store.json");
    assert!(hooked(
        "before_return",
        move || fs::write(store, b"{}").unwrap(),
        || h.read()
    )
    .is_err());
}
#[test]
fn p1a_07_08_account_masking_removes_entire_sensitive_projection() {
    for (field, value, read) in [
        ("/health", json!("disabled"), "denied"),
        ("/account/accountId", json!("swapped"), "denied"),
        ("/account/accountRevision", json!(2), "denied"),
        ("/revocationGeneration", json!(1), "denied"),
        ("/account", Value::Null, "denied"),
        ("/health", json!("unavailable"), "unavailable"),
        ("/health", json!("unsupported"), "unavailable"),
    ] {
        let h = Host::new();
        h.insert(1);
        h.status(|s| *s.pointer_mut(field).unwrap() = value);
        let v = serde_json::to_value(h.read().unwrap()).unwrap();
        assert_eq!(v["effects"][0]["detailsRead"], read);
        assert!(v["effects"][0]["details"].is_null());
        assert!(v["effects"][0]["effect"]["accountLabel"].is_null());
        assert!(v["effects"][0]["effect"]["approvalId"].is_null());
        for secret in [
            "Safe account",
            "Safe target",
            "Safe preview",
            "safe-remote",
            "private-request",
        ] {
            assert!(!v.to_string().contains(secret));
        }
        assert_eq!(v["brokerInventory"]["state"], "complete");
    }
    for sql in [
        "DELETE FROM managed_connections",
        "UPDATE managed_connections SET person='human:other'",
        "UPDATE managed_connections SET status='{}'",
    ] {
        let h = Host::new();
        h.insert(1);
        h.corrupt(sql);
        assert_eq!(
            serde_json::to_value(h.read().unwrap()).unwrap()["effects"][0]["detailsRead"],
            "denied"
        );
    }
}
#[test]
fn p1a_09_10_11_12_13_18_bad_payloads_are_incomplete_not_empty_or_leaky() {
    for raw in [
        "{broken".into(),
        format!("{{\"x\":\"{}\"}}", "é".repeat(524289)),
        "{\"lookup_version\":1,\"lookup_version\":0}".into(),
    ] {
        let h = Host::new();
        h.insert(1);
        h.insert(2);
        h.conn
            .execute_batch("PRAGMA ignore_check_constraints=ON")
            .unwrap();
        h.conn
            .execute(
                "UPDATE action_invocations SET payload=?1 WHERE invocation_id=?2",
                rusqlite::params![raw, format!("{:032x}", 2)],
            )
            .unwrap();
        let v = serde_json::to_value(h.read().unwrap()).unwrap();
        assert_eq!(v["brokerInventory"]["state"], "incomplete");
        assert_eq!(v["effects"].as_array().unwrap().len(), 1);
        assert!(!v.to_string().contains("private-request"));
    }
    for sql in [
        "UPDATE action_invocations SET state='failed'",
        "UPDATE action_invocations SET request_digest=printf('%064d',0)",
        "UPDATE action_invocations SET revision=2",
        "UPDATE action_invocations SET payload=CAST(x'ff' AS TEXT)",
        "UPDATE action_invocations SET payload=x'00'",
    ] {
        let h = Host::new();
        h.insert(1);
        h.corrupt(sql);
        assert_eq!(
            serde_json::to_value(h.read().unwrap()).unwrap()["brokerInventory"]["state"],
            "incomplete"
        );
    }
    let h = Host::new();
    h.corrupt("DROP TABLE action_invocations");
    assert!(h.read().is_err());
}
#[test]
fn p1a_14_15_output_and_inventory_are_bounded() {
    for count in [0, 1, 32, 33, 80] {
        let h = Host::new();
        for n in 1..=count {
            h.insert(n);
        }
        let answer = h.read().unwrap();
        let v = serde_json::to_value(&answer).unwrap();
        assert_eq!(v["effects"].as_array().unwrap().len(), count.min(32));
        assert_eq!(v["brokerInventory"]["overflow"], count > 32);
        assert!(serde_json::to_vec(&answer).unwrap().len() <= 262144);
    }
    let h = Host::new();
    let mut v = effect_record::tests::fixture(&h.scope, 1);
    v["details"]["preview"]["fields"] = json!((0..32)
        .map(|_| json!({"label":"safe","value":"x".repeat(8192)}))
        .collect::<Vec<_>>());
    h.insert_value(&v);
    let got = serde_json::to_value(h.read().unwrap()).unwrap();
    assert_eq!(got["effects"].as_array().unwrap().len(), 1);
    assert_eq!(
        got["effects"][0]["effect"]["invocationId"],
        format!("{:032x}", 1)
    );
    assert_eq!(got["effects"][0]["effect"]["state"], "outcome_unknown");
    assert!(got["effects"][0]["effect"]["accountLabel"].is_null());
    assert!(got["effects"][0]["effect"]["approvalId"].is_null());
    assert_eq!(got["effects"][0]["detailsRead"], "unavailable");
    assert!(got["effects"][0]["details"].is_null());
    assert_eq!(got["effects"][0]["reason"], "output_limit");
}
#[test]
fn p1a_16_each_refresh_is_one_snapshot() {
    let h = Host::new();
    h.insert(1);
    let path = crate::runtime::runtime_db_path(&h.data);
    let first = hooked(
        "after_inventory",
        move || {
            let writer = Connection::open(path).unwrap();
            writer
                .execute("DELETE FROM action_invocations", [])
                .unwrap();
        },
        || h.read(),
    )
    .unwrap();
    assert_eq!(first.effects.len(), 1);
    assert!(h.read().unwrap().effects.is_empty());
}
#[test]
fn p1a_17_empty_broker_never_claims_generation_or_foreign_coverage() {
    let h = Host::new();
    let v = serde_json::to_value(h.read().unwrap()).unwrap();
    assert_eq!(v["brokerInventory"]["observedCount"], 0);
    assert_eq!(v["brokerInventory"]["inspectedRunIds"], json!([RUN]));
    assert_eq!(
        v["generationCoverage"],
        json!({"state":"unknown","reason":"root_only_no_generation_binding"})
    );
    assert_eq!(
        v["externalEffectsCoverage"],
        json!({"state":"unknown","reason":"unbrokered_execution_not_covered"})
    );
    for name in [
        "permit",
        "canAskAgain",
        "canContinue",
        "canonicalPath",
        "person",
    ] {
        assert!(!v.to_string().contains(name));
    }
}
#[test]
fn p1a_19_21_22_reader_changes_no_persistent_bytes_rows_schema_or_query_guard() {
    let h = Host::new();
    h.insert(1);
    h.conn
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
        .unwrap();
    let db = crate::runtime::runtime_db_path(&h.data);
    let before = fs::read(&db).unwrap();
    let wal = PathBuf::from(format!("{}-wal", db.display()));
    let before_wal = fs::read(&wal).ok();
    let version = h
        .conn
        .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
        .unwrap();
    assert!(h.read().is_ok());
    assert!(h.read_selector("missing").is_err());
    assert_eq!(before, fs::read(&db).unwrap());
    assert_eq!(before_wal, fs::read(&wal).ok());
    assert_eq!(
        version,
        h.conn
            .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap()
    );
    assert_eq!(
        h.conn
            .query_row("SELECT count(*) FROM chat_parent_attempts", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    h.assert_quiet();
    let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        hooked("before_return", || panic!("fixture unwind"), || h.read())
    }));
    assert!(panic.is_err());
    // The storage mutex is intentionally poisoned by unwind; the retained guard
    // still restores query_only before that poison escapes.
    let storage = h
        .owner
        .storage
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    assert_eq!(
        storage
            .owner
            .as_ref()
            .unwrap()
            .conn
            .query_row("PRAGMA query_only", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
}

thread_local! { static PAYLOAD_READS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) }; }
pub(super) fn payload_observed() {
    PAYLOAD_READS.with(|n| n.set(n.get() + 1));
}
fn payload_reads() -> usize {
    PAYLOAD_READS.with(|n| n.replace(0))
}

fn padded_record(h: &Host, n: usize, size: usize) -> String {
    let mut v = effect_record::tests::fixture(&h.scope, n);
    v["private-padding"] = json!([
        "x".repeat(262144),
        "x".repeat(262144),
        "x".repeat(262144),
        ""
    ]);
    let remaining = size - v.to_string().len();
    assert!(remaining <= 262144);
    v["private-padding"][3] = json!("x".repeat(remaining));
    let raw = v.to_string();
    assert_eq!(raw.len(), size);
    raw
}
#[test]
fn p1a_09_15_preflight_never_fetches_oversize_aggregate_or_overflow_payloads() {
    let h = Host::new();
    for n in 1..=5 {
        h.insert(n);
        let raw = padded_record(&h, n, 1048576);
        h.conn
            .execute(
                "UPDATE action_invocations SET payload=?1 WHERE invocation_id=?2",
                rusqlite::params![raw, format!("{n:032x}")],
            )
            .unwrap();
    }
    payload_reads();
    let answer = h.read().unwrap();
    assert_eq!(payload_reads(), 4);
    assert_eq!(answer.effects.len(), 4);
    assert!(answer
        .broker_inventory
        .reasons
        .contains(&HistoryReason::AggregateLimit));
    let h = Host::new();
    h.insert(1);
    let raw = padded_record(&h, 1, 1048576) + " ";
    h.conn
        .execute_batch("PRAGMA ignore_check_constraints=ON")
        .unwrap();
    h.conn
        .execute("UPDATE action_invocations SET payload=?1", [raw])
        .unwrap();
    payload_reads();
    assert_eq!(
        h.read().unwrap().broker_inventory.state,
        InventoryState::Incomplete
    );
    assert_eq!(payload_reads(), 0);
    let h = Host::new();
    for n in 1..=33 {
        h.insert(n);
    }
    h.conn
        .execute_batch("PRAGMA ignore_check_constraints=ON")
        .unwrap();
    h.conn.execute("UPDATE action_invocations SET payload='unread overflow sentinel' WHERE invocation_id=?1",[format!("{:032x}",33)]).unwrap();
    payload_reads();
    let answer = h.read().unwrap();
    assert_eq!(payload_reads(), 32);
    assert!(answer.broker_inventory.overflow);
    assert_eq!(answer.effects.len(), 32);
}
#[test]
fn p1a_07_08_cleanup_and_metadata_failure_cannot_expose_previous_details() {
    let h = Host::new();
    h.insert(1);
    assert!(h.read().unwrap().effects[0].details.is_some());
    h.conn.execute("INSERT INTO managed_secret_cleanup(secret_id,connection_id,disposition,reference) VALUES(?1,'connection','delete',?2)",rusqlite::params!["f".repeat(32),json!({"id":"f".repeat(32),"secretRevision":1,"private-sentinel":"cleanup-private"}).to_string()]).unwrap();
    let masked = h.read().unwrap();
    assert_eq!(masked.effects[0].details_read, DetailsRead::Denied);
    assert!(masked.effects[0].details.is_none());
    assert!(!serde_json::to_string(&masked)
        .unwrap()
        .contains("cleanup-private"));
    h.corrupt("DROP TABLE managed_secret_cleanup");
    let unavailable = h.read().unwrap();
    assert_eq!(
        unavailable.effects[0].details_read,
        DetailsRead::Unavailable
    );
    assert!(unavailable.effects[0].details.is_none());
    let h = Host::new();
    h.insert(1);
    h.status(|s| {
        s["health"] = json!("unavailable");
        s["account"] = Value::Null;
    });
    assert_eq!(
        h.read().unwrap().effects[0].details_read,
        DetailsRead::Unavailable
    );
}
#[test]
fn p1a_12_scope_versions_and_conflicting_representations_are_not_merged() {
    for version in [0, 1] {
        let h = Host::new();
        let mut v = effect_record::tests::fixture(&h.scope, 1);
        v["lookup_version"] = json!(version);
        let request: effect_record::PrepareAction =
            serde_json::from_value(v["request"].clone()).unwrap();
        if version == 0 {
            v["request_digest"] = json!(effect_record::legacy_request_digest(&request).unwrap());
        }
        h.insert_value(&v);
        assert_eq!(h.read().unwrap().effects.len(), 1);
    }
    let h = Host::new();
    let v = h.insert(1);
    let mut legacy = v.clone();
    legacy["lookup_version"] = json!(0);
    legacy["details"]["effect"]["invocationId"] = json!(format!("{:032x}", 2));
    let request: effect_record::PrepareAction =
        serde_json::from_value(legacy["request"].clone()).unwrap();
    legacy["request_digest"] = json!(effect_record::legacy_request_digest(&request).unwrap());
    h.insert_value(&legacy);
    let answer = h.read().unwrap();
    assert!(answer.effects.is_empty());
    assert_eq!(answer.broker_inventory.state, InventoryState::Incomplete);
    let h = Host::new();
    let mut v = effect_record::tests::fixture(&h.scope, 1);
    v["scope"]["actorId"] = json!("human:foreign");
    h.insert_value(&v);
    assert!(h.read().unwrap().effects.is_empty());
}
#[test]
fn p1a_13_private_unknown_fields_are_validated_but_never_projected() {
    let h = Host::new();
    let mut v = effect_record::tests::fixture(&h.scope, 1);
    v["raw-provider-output"] = json!({"credentials":"private-provider-sentinel"});
    h.insert_value(&v);
    let answer = h.read().unwrap();
    let encoded = serde_json::to_string(&answer).unwrap();
    assert!(answer.effects[0].details.is_some());
    for private in [
        "private-provider-sentinel",
        "private-request",
        "grant_digest",
        "canonical_input",
    ] {
        assert!(!encoded.contains(private));
    }
}
#[test]
fn p1a_14_total_output_limit_keeps_refs_and_says_incomplete() {
    let h = Host::new();
    for n in 1..=32 {
        let mut v = effect_record::tests::fixture(&h.scope, n);
        v["details"]["preview"]["fields"] =
            json!([{"label":"a","value":"é".repeat(4096)},{"label":"b","value":"x".repeat(8192)}]);
        h.insert_value(&v);
    }
    let answer = h.read().unwrap();
    let encoded = serde_json::to_vec(&answer).unwrap();
    assert!(encoded.len() <= 262144);
    assert_eq!(answer.broker_inventory.state, InventoryState::Incomplete);
    assert!(answer
        .broker_inventory
        .reasons
        .contains(&HistoryReason::OutputLimit));
    assert_eq!(answer.broker_inventory.observed_count.get(), 32);
    // The whole-result cap may omit later entries after retaining a safe prefix.
    assert!(!answer.effects.is_empty());
    assert!(answer.effects.len() < 32);
    for (index, effect) in answer.effects.iter().enumerate() {
        assert_eq!(effect.effect.invocation_id.0, format!("{:032x}", index + 1));
        assert_eq!(effect.effect.state, InvocationState::OutcomeUnknown);
        assert!(!effect.effect.can_retry);
        assert!(!effect.effect.can_reconcile);
        if let Some(details) = &effect.details {
            assert_eq!(effect.details_read, DetailsRead::Available);
            assert!(effect.reason.is_none());
            assert_eq!(details.effect, effect.effect);
        } else {
            assert_eq!(effect.details_read, DetailsRead::Unavailable);
            assert_eq!(effect.reason, Some(HistoryReason::OutputLimit));
            assert!(effect.effect.account_label.is_none());
            assert!(effect.effect.approval_id.is_none());
        }
    }
    let wire = std::str::from_utf8(&encoded).unwrap();
    for private in [
        "private-request",
        "grant_digest",
        "canonical_input",
        "request_digest",
    ] {
        assert!(!wire.contains(private));
    }
    assert!(answer.effects.iter().any(|e| e.details.is_none()));
}
#[test]
fn p1a_18_19_masked_and_malformed_rows_have_distinct_inventory_meanings() {
    let h = Host::new();
    h.insert(1);
    h.insert(2);
    h.status(|s| s["health"] = json!("disabled"));
    let masked = h.read().unwrap();
    assert_eq!(masked.broker_inventory.state, InventoryState::Complete);
    assert_eq!(masked.effects.len(), 2);
    h.corrupt("UPDATE action_invocations SET revision=2 WHERE invocation_id='00000000000000000000000000000002'");
    let malformed = h.read().unwrap();
    assert_eq!(malformed.broker_inventory.state, InventoryState::Incomplete);
    assert_eq!(malformed.effects.len(), 1);
}
#[test]
fn p1a_22_unsupported_retained_schema_never_becomes_empty() {
    let h = Host::new();
    h.conn
        .pragma_update(None, "user_version", crate::runtime::USER_VERSION + 1)
        .unwrap();
    assert!(h.read().is_err());
    h.assert_quiet();
}

#[test]
fn p1a_05_missing_or_selected_current_opening_never_uses_the_requested_runs_path() {
    let h = Host::new();
    h.insert(1);
    h.context.begin_open().unwrap();
    assert!(h.read().is_err());
    let h = Host::new();
    h.insert(1);
    let workspace = "3ee5b6eb-9f80-4bac-9538-f2a0c5938a62";
    let bindings = h.data.join("workspaces");
    fs::create_dir_all(&bindings).unwrap();
    fs::write(
        bindings.join("bindings.v1.json"),
        json!({"version":1,"bindings":[{"workspaceId":workspace,"bodyRoot":h.root}]}).to_string(),
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&bindings, fs::Permissions::from_mode(0o700)).unwrap();
    fs::set_permissions(
        bindings.join("bindings.v1.json"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    fs::write(h.root.join(".cerebro/workspace-format.json"),json!({"format":2,"authority":"sqlite_metadata","state":"activated","workspaceId":workspace}).to_string()).unwrap();
    assert!(h.read().is_err());
    h.assert_quiet();
}
fn approved_record(h: &Host) -> Value {
    let mut v = effect_record::tests::fixture(&h.scope, 1);
    let id = "9".repeat(32);
    let digest = v["details"]["inputDigest"].clone();
    let view = json!({"approvalId":id,"revision":1,"expiresAt":"2026-10-25T00:10:00Z","askedInputDigest":digest,"approvedInputDigest":digest,"approvedPreview":{"summary":"approved-sensitive","fields":[],"redactedFields":[]}});
    v["details"]["effect"]["approvalId"] = json!(id);
    v["details"]["approval"] = view.clone();
    v["approval"] = json!({"decided_by":"human:me","decided_at":STAMP,"decision":"allow","view":view,"approved_input":"\"private-request\"","consumed":true,"retired":false});
    v
}
#[test]
fn p1a_07_nonnull_historical_approval_and_receipts_are_removed_after_revocation() {
    let h = Host::new();
    h.insert_value(&approved_record(&h));
    let allowed = h.read().unwrap();
    assert!(allowed.effects[0].effect.approval_id.is_some());
    assert!(allowed.effects[0]
        .details
        .as_ref()
        .unwrap()
        .approval
        .is_some());
    h.status(|s| s["revocationGeneration"] = json!(1));
    let denied = h.read().unwrap();
    assert!(denied.effects[0].effect.approval_id.is_none());
    assert!(denied.effects[0].details.is_none());
    let wire = serde_json::to_string(&denied).unwrap();
    for sentinel in [
        "approved-sensitive",
        "safe-remote",
        "Safe value",
        "Safe target",
        "private-request",
    ] {
        assert!(!wire.contains(sentinel));
    }
}
#[test]
fn p1a_07_request_binding_and_details_accounts_must_all_agree() {
    for field in ["/binding/account_id", "/details/account/accountId"] {
        let h = Host::new();
        let mut v = effect_record::tests::fixture(&h.scope, 1);
        *v.pointer_mut(field).unwrap() = json!("foreign-account");
        h.insert_value(&v);
        let answer = h.read().unwrap();
        assert_eq!(answer.effects.len(), 1);
        assert_eq!(answer.effects[0].details_read, DetailsRead::Denied);
        assert!(answer.effects[0].details.is_none());
    }
}

// M95 P1a review R1: invalid target identity is malformed inventory, not a ref.
#[test]
fn p1a_10_18_overlong_target_identity_preserves_only_valid_inventory() {
    for paths in [
        vec!["/target/target/kind", "/details/target/kind"],
        vec!["/target/conflict_domain"],
    ] {
        let h = Host::new();
        h.insert(1);
        let mut invalid = effect_record::tests::fixture(&h.scope, 2);
        for path in &paths {
            *invalid.pointer_mut(path).unwrap() = json!("x".repeat(513));
        }
        h.insert_value(&invalid);
        let answer = h.read().unwrap();
        assert_eq!(answer.broker_inventory.state, InventoryState::Incomplete);
        assert_eq!(answer.broker_inventory.observed_count.get(), 1);
        assert_eq!(answer.effects.len(), 1);
        assert_eq!(
            answer.effects[0].effect.invocation_id.0,
            format!("{:032x}", 1)
        );
        assert!(answer
            .broker_inventory
            .reasons
            .contains(&HistoryReason::InvalidRecord));
        h.assert_quiet();
    }
}

// R1 addendum: denied disclosure cannot rescue an invalid stored target.
#[test]
fn p1a_10_18_invalid_target_semantics_never_become_masked_minimal_refs() {
    let mut observations = Vec::new();
    for path in [
        "/target/conflict_domain",
        "/target/target/kind",
        "/target/target/label",
        "/target/target/safeReference",
        "/details/target/kind",
        "/details/target/label",
        "/details/target/safeReference",
    ] {
        let h = Host::new();
        h.insert(1);
        let mut invalid = effect_record::tests::fixture(&h.scope, 2);
        *invalid.pointer_mut(path).unwrap() = json!("safe\u{85}forged");
        h.insert_value(&invalid);
        h.status(|status| status["health"] = json!("disabled"));
        let observation = h.read().map(|answer| {
            let correct = answer.broker_inventory.state == InventoryState::Incomplete
                && answer.broker_inventory.observed_count.get() == 1
                && answer.effects.len() == 1
                && answer.effects[0].effect.invocation_id.0 == format!("{:032x}", 1)
                && answer.effects[0].details_read == DetailsRead::Denied
                && answer.effects[0].details.is_none()
                && answer
                    .broker_inventory
                    .reasons
                    .contains(&HistoryReason::InvalidRecord);
            (correct, serde_json::to_value(&answer).unwrap())
        });
        observations.push((path, observation));
        h.assert_quiet();
    }
    assert!(
        observations
            .iter()
            .all(|(_, observed)| observed.as_ref().is_ok_and(|(correct, _)| *correct)),
        "{observations:?}"
    );
}

#[test]
fn p1a_10_history_preserves_the_approved_8192_byte_target_reference() {
    let h = Host::new();
    let mut value = effect_record::tests::fixture(&h.scope, 1);
    let reference = "é".repeat(4096);
    assert_eq!(reference.len(), 8192);
    value["target"]["target"]["safeReference"] = json!(reference.clone());
    value["details"]["target"]["safeReference"] = json!(reference.clone());
    h.insert_value(&value);
    let answer = h.read().unwrap();
    assert_eq!(answer.broker_inventory.state, InventoryState::Complete);
    assert_eq!(answer.effects[0].details_read, DetailsRead::Available);
    assert_eq!(
        answer.effects[0]
            .details
            .as_ref()
            .unwrap()
            .target
            .as_ref()
            .unwrap()
            .safe_reference,
        reference
    );
    h.assert_quiet();
}
