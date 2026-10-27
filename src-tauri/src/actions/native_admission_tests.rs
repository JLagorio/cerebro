//! SQL/authority causal probes only. FixtureDoor does not prove native auth.
use super::{
    admission::{
        self,
        fixture::{Door, Facts},
    },
    catalog::ActionCatalog,
    native_authority::NativeAuthoritySource,
    schema::{digest, POLICY},
    service::{AuthorityDb, AuthoritySource},
    types::*,
};
use crate::{
    connections::{
        secrets::SecretRef, AccountBinding, ConnectionHealth, ConnectionStatus, RemoteRevocation,
    },
    runtime,
};
use rusqlite::{params, Connection};
use std::{path::PathBuf, sync::Arc};
const NOW: &str = "2026-10-23T12:00:00.000Z";
const SESSION: &str = "native-process-fixture";
const RUN: &str = "native-run";
const GRANT: &str = "11111111111111111111111111111111";
const PARENT_GRANT: &str = "22222222222222222222222222222222";
struct Harness {
    dir: PathBuf,
    root: PathBuf,
    vault: String,
    conn: Connection,
    door: Door,
    catalog: Arc<ActionCatalog>,
    definition: ActionDefinition,
}
impl Harness {
    fn new(label: &str) -> Self {
        let dir = crate::vault::testutil::temp_vault(&format!("m96-native-{label}"));
        let root = dir.join("vault");
        std::fs::create_dir(&root).unwrap();
        let conn = runtime::open(&dir).unwrap();
        // Test-only reviewed-schema scaffold. The separate migration probe
        // deliberately uses the actual chain with no fixture installation.
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='action_native_runs')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        if !exists {
            conn.execute_batch(runtime::action_authority::FIXTURE_SCHEMA_V35)
                .unwrap();
        }
        let vault = runtime::scope::register(&conn, &root).unwrap();
        conn.execute("INSERT INTO app_sessions(session_id,vault_id,store_uuid,opened_at,last_heartbeat_at,close_precision) VALUES(?1,?2,'fixture-store',?3,?3,'open')",params![SESSION,vault,NOW]).unwrap();
        runtime::dispatch::begin_attended(
            &conn,
            RUN,
            Some(&vault),
            Some("fixture-store"),
            Some("claude-code"),
            None,
            None,
            chrono::DateTime::parse_from_rfc3339(NOW)
                .unwrap()
                .with_timezone(&chrono::Utc),
        )
        .unwrap();
        conn.execute(
            "UPDATE runs SET cli_session_id='native-session' WHERE run_id=?1",
            [RUN],
        )
        .unwrap();
        Self::native_row(
            &conn,
            RUN,
            &vault,
            "claude-code",
            "native-session",
            None,
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        );
        let status = ConnectionStatus {
            connection_id: ConnectionId("connection".into()),
            revision: 1,
            login: "fixture".into(),
            health: ConnectionHealth::Ready,
            account: Some(AccountBinding {
                account_id: AccountId("account".into()),
                subject: "42".into(),
                issuer: "https://fixture.invalid".into(),
                account_revision: 1,
                scope_digest: "scopes-1".into(),
            }),
            secret_revision: 1,
            revocation_generation: 0,
            observed_at: NOW.into(),
            cleanup_pending: false,
            remote_revocation: RemoteRevocation::NotAttempted,
        };
        let reference = SecretRef {
            id: "ffffffffffffffffffffffffffffffff".into(),
            account_id: AccountId("account".into()),
            issuer: "https://fixture.invalid".into(),
            subject: "42".into(),
            secret_revision: 1,
        };
        conn.execute("INSERT INTO managed_connections(connection_id,person,status,secret_ref) VALUES('connection','human:me',?1,?2)",params![serde_json::to_string(&status).unwrap(),serde_json::to_string(&reference).unwrap()]).unwrap();
        let mut catalog = ActionCatalog::default();
        let definition=catalog.insert(DefinitionMaterial{action_id:ActionId("fixture:read".into()),input_schema:r#"{"type":"object","properties":{"title":{"type":"string"}},"required":["title"],"additionalProperties":false}"#.into(),output_schema:r#"{"type":"null"}"#.into(),adapter_revision:"native-fixture-1".into(),effect_class:EffectClass::Read,required_capabilities:vec!["fixture:read".into()],retry:RetryContract::Never,cancel:false,reconcile:false,secret_input_fields:vec![]},"{}").unwrap();
        let identity = digest(
            serde_json::to_string(&("https://fixture.invalid", "42"))
                .unwrap()
                .as_bytes(),
        );
        conn.execute("INSERT INTO action_account_grants(grant_id,run_id,connection_id,account_id,account_identity_digest,account_revision,revocation_generation,action_id,definition_digest,input_scope,capabilities_json,revision,granted_by,granted_at) VALUES(?1,?2,'connection','account',?3,1,0,?4,?5,'all_valid_inputs','[\"fixture:read\"]',1,'human:me',?6)",params![GRANT,RUN,identity,definition.action_id.0,definition.definition_digest.0,NOW]).unwrap();
        let door = Self::door(
            &dir,
            &root,
            &vault,
            None,
            None,
            "claude-code",
            Some("native-session"),
        );
        Self {
            dir,
            root,
            vault,
            conn,
            door,
            catalog: Arc::new(catalog),
            definition,
        }
    }
    fn native_row(
        conn: &Connection,
        run: &str,
        vault: &str,
        actor: &str,
        session: &str,
        parent: Option<&str>,
        authority: &str,
    ) {
        let path = runtime::scope::path_of(conn, vault).unwrap().unwrap();
        conn.execute("INSERT INTO action_native_runs(run_id,authority_id,revision,vault_id,store_uuid,canonical_vault_path,owner_person,actor_id,source_kind,app_session_id,cli_session_id,parent_run_id,admitted_at) VALUES(?1,?2,1,?3,'fixture-store',?4,'human:me',?5,'run',?6,?7,?8,?9)",params![run,authority,vault,path,actor,SESSION,session,parent,NOW]).unwrap();
    }
    fn door(
        dir: &std::path::Path,
        root: &std::path::Path,
        vault: &str,
        parent: Option<&str>,
        client: Option<&str>,
        actor: &str,
        cli: Option<&str>,
    ) -> Door {
        Door::new(Facts {
            data_dir: dir.into(),
            canonical_vault: root.canonicalize().unwrap(),
            vault_id: vault.into(),
            store_uuid: "fixture-store".into(),
            app_session_id: SESSION.into(),
            run_id: RUN.into(),
            actor_id: actor.into(),
            cli_session_id: cli.map(Into::into),
            parent_run_id: parent.map(Into::into),
            client_id: client.map(Into::into),
        })
    }
    fn source(&self) -> NativeAuthoritySource {
        NativeAuthoritySource::from_proof(self.door.proof(), self.catalog.clone())
    }
    fn scope(&self) -> ActionSubjectView {
        ActionSubjectView {
            vault_id: self.vault.clone(),
            run_id: RUN.into(),
            actor_id: "claude-code".into(),
            child_job_id: None,
            client_id: None,
        }
    }
    fn request(&self, title: &str, snapshot: &str) -> PrepareAction {
        PrepareAction {
            action_id: self.definition.action_id.clone(),
            definition_digest: self.definition.definition_digest.clone(),
            connection_id: ConnectionId("connection".into()),
            account_id: AccountId("account".into()),
            snapshot_digest: SnapshotDigest(snapshot.into()),
            input: serde_json::json!({"title":title}).to_string(),
            request_key: "request".into(),
        }
    }
    fn snapshot(&self) -> String {
        self.source()
            .catalog(AuthorityDb::Writer(&self.conn), None)
            .unwrap()
            .snapshot_digest
            .0
    }
    fn rows(&self) -> Vec<String> {
        let mut rows = Vec::new();
        for sql in ["SELECT json_array(run_id,revision,owner_person,actor_id,source_kind,parent_run_id,client_id,child_job_id,closed_at,close_kind) FROM action_native_runs ORDER BY run_id","SELECT json_array(grant_id,run_id,revision,parent_grant_id,revoked_at,input_scope,input_digest,capabilities_json) FROM action_account_grants ORDER BY grant_id"] {
            let mut s=self.conn.prepare(sql).unwrap();rows.extend(s.query_map([],|r|r.get::<_,String>(0)).unwrap().collect::<Result<Vec<_>,_>>().unwrap());
        }
        rows
    }
    fn with_parent(mut self, outcome: &str) -> Self {
        runtime::dispatch::begin_attended(
            &self.conn,
            "parent",
            Some(&self.vault),
            Some("fixture-store"),
            Some("parent-actor"),
            None,
            None,
            chrono::DateTime::parse_from_rfc3339(NOW)
                .unwrap()
                .with_timezone(&chrono::Utc),
        )
        .unwrap();
        self.conn.execute("UPDATE runs SET cli_session_id='parent-session',outcome=?1,ended_at=CASE WHEN ?1='running' THEN NULL ELSE ?2 END WHERE run_id='parent'",params![outcome,NOW]).unwrap();
        Self::native_row(
            &self.conn,
            "parent",
            &self.vault,
            "parent-actor",
            "parent-session",
            None,
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        );
        if outcome != "running" {
            self.conn.execute("UPDATE action_native_runs SET closed_at=?1,close_kind='completed' WHERE run_id='parent'",[NOW]).unwrap();
        }
        self.conn
            .execute(
                "UPDATE runs SET parent_run_id='parent' WHERE run_id=?1",
                [RUN],
            )
            .unwrap();
        self.conn
            .execute(
                "UPDATE action_native_runs SET parent_run_id='parent' WHERE run_id=?1",
                [RUN],
            )
            .unwrap();
        self.conn.execute("INSERT INTO action_account_grants SELECT ?1,'parent',connection_id,account_id,account_identity_digest,account_revision,revocation_generation,action_id,definition_digest,input_scope,input_digest,capabilities_json,NULL,revision,granted_by,granted_at,revoked_at FROM action_account_grants WHERE grant_id=?2",params![PARENT_GRANT,GRANT]).unwrap();
        self.conn
            .execute(
                "UPDATE action_account_grants SET parent_grant_id=?1 WHERE grant_id=?2",
                params![PARENT_GRANT, GRANT],
            )
            .unwrap();
        self.door = Self::door(
            &self.dir,
            &self.root,
            &self.vault,
            Some("parent"),
            None,
            "claude-code",
            Some("native-session"),
        );
        self
    }
}
#[test]
fn native_admission_missing_proof_denies_without_mutation() {
    let h = Harness::new("missing-proof");
    let before = h.rows();
    assert_eq!(
        admission::resolve(AuthorityDb::Writer(&h.conn), None)
            .err()
            .unwrap()
            .code,
        ActionErrorCode::Denied
    );
    assert_eq!(
        admission::record_authenticated(AuthorityDb::Writer(&h.conn), None)
            .err()
            .unwrap()
            .code,
        ActionErrorCode::Denied
    );
    assert_eq!(h.rows(), before);
}
#[test]
fn native_admission_exact_join_returns_its_own_subject() {
    let h = Harness::new("exact-join");
    let before = h.rows();
    let admitted = admission::resolve(AuthorityDb::Writer(&h.conn), Some(&h.door.proof())).unwrap();
    assert_eq!(admitted.scope(), &h.scope());
    assert_eq!(admitted.owner_person(), "human:me");
    assert!(admitted.can_call());
    assert_eq!(h.rows(), before);
}
#[test]
fn native_admission_forged_relationships_never_authorize() {
    let cases: serde_json::Value = serde_json::from_str(include_str!(
        "../../../shared/actions/admission-cases.v1.json"
    ))
    .unwrap();
    for field in cases["forgedFields"].as_array().unwrap() {
        let field = field.as_str().unwrap();
        let h = Harness::new(field);
        let proof = h.door.forged(field);
        let before = h.rows();
        assert_eq!(
            admission::resolve(AuthorityDb::Writer(&h.conn), Some(&proof))
                .err()
                .unwrap()
                .code,
            ActionErrorCode::Denied,
            "{field}"
        );
        assert_eq!(h.rows(), before);
    }
}
#[test]
fn native_admission_closed_native_owner_caller_and_generation_deny() {
    for event in ["owner", "caller", "generation"] {
        let h = Harness::new(event);
        match event {
            "owner" => h.door.close_owner(),
            "caller" => h.door.close_caller(),
            _ => h.door.change_generation(),
        };
        assert_eq!(
            admission::resolve(AuthorityDb::Writer(&h.conn), Some(&h.door.proof()))
                .err()
                .unwrap()
                .code,
            ActionErrorCode::Denied,
            "{event}"
        );
    }
}
#[test]
fn native_admission_parent_natural_outcomes_keep_only_explicit_child_authority() {
    for outcome in ["succeeded", "failed"] {
        let h = Harness::new(outcome).with_parent(outcome);
        let subject =
            admission::resolve(AuthorityDb::Writer(&h.conn), Some(&h.door.proof())).unwrap();
        assert!(subject.can_call());
        assert!(
            subject.scope().child_job_id.is_none(),
            "ordinary handoff is not an M95 job"
        );
        let snapshot = h.snapshot();
        h.source()
            .check(
                AuthorityDb::Writer(&h.conn),
                subject.scope(),
                &h.request("first", &snapshot),
                &h.definition,
            )
            .unwrap();
        h.conn
            .execute(
                "UPDATE action_account_grants SET revoked_at=?1 WHERE grant_id=?2",
                params![NOW, GRANT],
            )
            .unwrap();
        assert_eq!(
            h.source()
                .check(
                    AuthorityDb::Writer(&h.conn),
                    subject.scope(),
                    &h.request("first", &snapshot),
                    &h.definition
                )
                .unwrap_err()
                .code,
            ActionErrorCode::Denied
        );
    }
}
#[test]
fn native_admission_parent_cancelled_outcome_denies_even_if_close_kind_says_completed() {
    let h = Harness::new("parent-cancelled").with_parent("cancelled");
    let before = h.rows();
    assert_eq!(
        admission::resolve(AuthorityDb::Writer(&h.conn), Some(&h.door.proof()))
            .err()
            .unwrap()
            .code,
        ActionErrorCode::Denied
    );
    assert_eq!(h.rows(), before);
}
#[test]
fn native_admission_explicit_parent_stop_denies_despite_successful_outcome() {
    let h = Harness::new("parent-stop").with_parent("succeeded");
    h.conn
        .execute(
            "UPDATE action_native_runs SET close_kind='stopped' WHERE run_id='parent'",
            [],
        )
        .unwrap();
    assert_eq!(
        admission::resolve(AuthorityDb::Writer(&h.conn), Some(&h.door.proof()))
            .err()
            .unwrap()
            .code,
        ActionErrorCode::Denied
    );
}
#[test]
fn native_admission_explicit_grant_binds_current_account_and_edited_input() {
    let h = Harness::new("exact-input");
    let input = digest(b"{\"title\":\"first\"}");
    h.conn.execute("UPDATE action_account_grants SET input_scope='exact_canonical_input',input_digest=?1 WHERE grant_id=?2",params![input,GRANT]).unwrap();
    let snapshot = h.snapshot();
    let source = h.source();
    source
        .check(
            AuthorityDb::Writer(&h.conn),
            &h.scope(),
            &h.request("first", &snapshot),
            &h.definition,
        )
        .unwrap();
    assert_eq!(
        source
            .check(
                AuthorityDb::Writer(&h.conn),
                &h.scope(),
                &h.request("edited", &snapshot),
                &h.definition
            )
            .unwrap_err()
            .code,
        ActionErrorCode::Denied
    );
    let mut other = h.request("first", &snapshot);
    other.account_id = AccountId("other-account".into());
    assert_eq!(
        source
            .check(
                AuthorityDb::Writer(&h.conn),
                &h.scope(),
                &other,
                &h.definition
            )
            .unwrap_err()
            .code,
        ActionErrorCode::Denied
    );
    h.conn
        .execute(
            "UPDATE managed_connections SET person='human:other' WHERE connection_id='connection'",
            [],
        )
        .unwrap();
    assert_eq!(
        source
            .check(
                AuthorityDb::Writer(&h.conn),
                &h.scope(),
                &h.request("first", &snapshot),
                &h.definition
            )
            .unwrap_err()
            .code,
        ActionErrorCode::Denied
    );
}
#[test]
fn native_admission_connection_ownership_is_not_an_action_grant() {
    let h = Harness::new("owner-not-grant");
    h.conn
        .execute("DELETE FROM action_account_grants", [])
        .unwrap();
    let page = h
        .source()
        .catalog(AuthorityDb::Writer(&h.conn), None)
        .unwrap();
    assert!(page.descriptors.is_empty());
    assert_eq!(
        h.source()
            .check(
                AuthorityDb::Writer(&h.conn),
                &h.scope(),
                &h.request("first", &page.snapshot_digest.0),
                &h.definition
            )
            .unwrap_err()
            .code,
        ActionErrorCode::Denied
    );
}
#[test]
fn native_admission_scoped_catalog_and_definition_never_return_other_actions() {
    let h = Harness::new("scoped-catalog");
    let source = h.source();
    let page = source.catalog(AuthorityDb::Writer(&h.conn), None).unwrap();
    assert_eq!(page.descriptors.len(), 1);
    assert_eq!(page.descriptors[0].action_id, h.definition.action_id);
    assert_eq!(
        source
            .definition(
                AuthorityDb::Writer(&h.conn),
                h.definition.action_id.clone(),
                h.definition.definition_digest.clone()
            )
            .unwrap(),
        h.definition
    );
    assert_eq!(
        source
            .definition(
                AuthorityDb::Writer(&h.conn),
                ActionId("other:read".into()),
                h.definition.definition_digest.clone()
            )
            .unwrap_err()
            .code,
        ActionReadErrorCode::NotFound
    );
    h.conn
        .execute("UPDATE action_account_grants SET revoked_at=?1", [NOW])
        .unwrap();
    assert!(source
        .catalog(AuthorityDb::Writer(&h.conn), None)
        .unwrap()
        .descriptors
        .is_empty());
}
#[test]
fn native_admission_same_account_secret_refresh_preserves_binding_but_revocation_does_not() {
    let h = Harness::new("secret-refresh");
    let source = h.source();
    let snapshot = h.snapshot();
    let request = h.request("first", &snapshot);
    let before = source
        .check(
            AuthorityDb::Writer(&h.conn),
            &h.scope(),
            &request,
            &h.definition,
        )
        .unwrap();
    h.conn.execute("UPDATE managed_connections SET status=json_set(status,'$.secretRevision',2),secret_ref=json_set(secret_ref,'$.secretRevision',2)",[]).unwrap();
    assert_eq!(
        source
            .check(
                AuthorityDb::Writer(&h.conn),
                &h.scope(),
                &request,
                &h.definition
            )
            .unwrap(),
        before
    );
    h.conn.execute("UPDATE managed_connections SET status=json_set(status,'$.revocationGeneration',1,'$.health','disabled')",[]).unwrap();
    assert_eq!(
        source
            .check(
                AuthorityDb::Writer(&h.conn),
                &h.scope(),
                &request,
                &h.definition
            )
            .unwrap_err()
            .code,
        ActionErrorCode::Denied
    );
}
#[test]
fn native_admission_policy_is_shared_default_deny_with_explicit_parent_rules() {
    let p: serde_json::Value = serde_json::from_str(POLICY).unwrap();
    assert_eq!(p["admission"]["defaultGrant"], "deny");
    assert_eq!(p["admission"]["ordinaryHandoffChildJobId"], "absent");
    assert_eq!(
        p["admission"]["parentStopOrRevocation"],
        "deny_future_descendant_claims"
    );
}

#[test]
fn native_admission_authority_uses_the_callers_uncommitted_transaction() {
    let mut h = Harness::new("same-transaction");
    let source = h.source();
    let scope = h.scope();
    let snapshot = h.snapshot();
    let request = h.request("first", &snapshot);
    let definition = h.definition.clone();
    let tx = h
        .conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .unwrap();
    tx.execute(
        "UPDATE action_account_grants SET revoked_at=?1 WHERE grant_id=?2",
        params![NOW, GRANT],
    )
    .unwrap();
    let result = source.check(AuthorityDb::Writer(&tx), &scope, &request, &definition);
    tx.rollback().unwrap();
    assert_eq!(
        result.unwrap_err().code,
        ActionErrorCode::Denied,
        "another connection would still see an unrevoked grant"
    );
    source
        .check(AuthorityDb::Writer(&h.conn), &scope, &request, &definition)
        .unwrap();
}
#[test]
fn native_admission_new_authenticated_record_is_idempotent_but_confers_no_grant() {
    let h = Harness::new("record-authenticated");
    h.conn
        .execute("DELETE FROM action_account_grants", [])
        .unwrap();
    h.conn
        .execute("DELETE FROM action_native_runs", [])
        .unwrap();
    let proof = h.door.proof();
    let admitted =
        admission::record_authenticated(AuthorityDb::Writer(&h.conn), Some(&proof)).unwrap();
    assert_eq!(admitted.scope(), &h.scope());
    let before = h.rows();
    admission::record_authenticated(AuthorityDb::Writer(&h.conn), Some(&proof)).unwrap();
    assert_eq!(h.rows(), before);
    assert!(h
        .source()
        .catalog(AuthorityDb::Writer(&h.conn), None)
        .unwrap()
        .descriptors
        .is_empty());
}
#[test]
fn native_admission_actual_no_store_scope_is_unavailable_not_invented() {
    let h = Harness::new("no-store");
    h.conn
        .execute(
            "UPDATE runs SET vault_id=NULL,store_uuid=NULL WHERE run_id=?1",
            [RUN],
        )
        .unwrap();
    let before = h.rows();
    assert_eq!(
        admission::resolve(AuthorityDb::Writer(&h.conn), Some(&h.door.proof()))
            .err()
            .unwrap()
            .code,
        ActionErrorCode::Unavailable
    );
    assert_eq!(h.rows(), before);
}
#[test]
fn native_admission_client_identity_is_exact_and_revocation_retains_history() {
    let mut h = Harness::new("client-revoke");
    let token = runtime::client_tokens::create(
        &h.conn,
        &h.vault,
        &runtime::client_tokens::ClientTokenRequest {
            name: "Native fixture client".into(),
            toolsets: vec!["read".into()],
            write_scope: vec![],
            read_scope: None,
        },
        NOW,
    )
    .unwrap();
    let actor = format!("client:{}", token.token.slug);
    h.conn
        .execute(
            "UPDATE runs SET actor=?1,cli_session_id=NULL WHERE run_id=?2",
            params![actor, RUN],
        )
        .unwrap();
    h.conn.execute("UPDATE action_native_runs SET actor_id=?1,cli_session_id=NULL,source_kind='client',client_id=?2 WHERE run_id=?3",params![actor,token.token.token_id,RUN]).unwrap();
    h.door = Harness::door(
        &h.dir,
        &h.root,
        &h.vault,
        None,
        Some(&token.token.token_id),
        &actor,
        None,
    );
    let proof = h.door.proof();
    let admitted = admission::resolve(AuthorityDb::Writer(&h.conn), Some(&proof)).unwrap();
    assert_eq!(
        admitted.scope().client_id.as_deref(),
        Some(token.token.token_id.as_str())
    );
    let before = h.rows();
    runtime::client_tokens::revoke(&h.conn, &token.token.token_id).unwrap();
    assert_eq!(
        admission::resolve(AuthorityDb::Writer(&h.conn), Some(&proof))
            .err()
            .unwrap()
            .code,
        ActionErrorCode::Denied
    );
    assert_eq!(
        h.rows(),
        before,
        "deleting a token must not cascade native/effect provenance"
    );
}

#[test]
fn native_admission_shared_cases_pin_policy_scope_bytes_and_sql() {
    let cases: serde_json::Value = serde_json::from_str(include_str!(
        "../../../shared/actions/admission-cases.v1.json"
    ))
    .unwrap();
    let policy: serde_json::Value = serde_json::from_str(POLICY).unwrap();
    assert_eq!(cases["admission"], policy["admission"]);
    assert_eq!(
        cases["schemaSqlSha256"],
        digest(crate::runtime::schema::SCHEMA_V35.as_bytes())
    );
    let scope: ActionSubjectView =
        serde_json::from_value(cases["scopeEncoding"]["scope"].clone()).unwrap();
    let canonical = serde_json::to_string(&(
        "cerebro:native-action-catalog-scope",
        1,
        &scope.vault_id,
        &scope.run_id,
        &scope.actor_id,
        &scope.client_id,
        &scope.child_job_id,
    ))
    .unwrap();
    assert_eq!(canonical, cases["scopeEncoding"]["canonical"]);
    assert_eq!(
        super::native_authority::scope_digest(&scope),
        cases["scopeEncoding"]["sha256"]
    );
}

#[test]
fn native_admission_readonly_catalog_preserves_all_rows() {
    let h = Harness::new("readonly-catalog");
    let before = h.rows();
    let reader = runtime::ReadOnly::open(&h.dir).unwrap();
    let page = h
        .source()
        .catalog(AuthorityDb::Reader(&reader), None)
        .unwrap();
    assert_eq!(page.descriptors.len(), 1);
    let source = h.source();
    source
        .check(
            AuthorityDb::Reader(&reader),
            &h.scope(),
            &h.request("first", &page.snapshot_digest.0),
            &h.definition,
        )
        .unwrap();
    assert_eq!(h.rows(), before);
}

#[test]
fn native_admission_shared_parent_cases_use_actual_persisted_outcomes() {
    let cases: serde_json::Value = serde_json::from_str(include_str!(
        "../../../shared/actions/admission-cases.v1.json"
    ))
    .unwrap();
    for row in cases["parentOutcomes"].as_array().unwrap() {
        let outcome = row["outcome"].as_str().unwrap();
        let h = Harness::new(&format!("shared-{outcome}")).with_parent(outcome);
        assert_eq!(
            admission::resolve(AuthorityDb::Writer(&h.conn), Some(&h.door.proof())).is_ok(),
            row["canCall"].as_bool().unwrap(),
            "{outcome}"
        );
    }
}

// The persisted native actor uses the same default normalization as its run.
// These regression cases run no provider, CLI or account operation.
#[test]
fn native_admission_attended_actor_uses_existing_native_normalization() {
    for actor in [None, Some(""), Some("   ")] {
        let h = Harness::new("normalized-attended-actor");
        h.conn
            .execute(
                "UPDATE runs SET actor=?1 WHERE run_id=?2",
                params![actor, RUN],
            )
            .unwrap();
        assert_eq!(crate::mcp::normalize_actor(actor), "claude-code");
        let admitted = admission::resolve(AuthorityDb::Writer(&h.conn), Some(&h.door.proof()))
            .expect("a verified default actor must match its normalized stored actor");
        assert_eq!(admitted.scope(), &h.scope());
    }
}

#[test]
fn native_admission_parent_default_actor_uses_the_same_normalization() {
    let h = Harness::new("normalized-parent-actor").with_parent("succeeded");
    h.conn
        .execute("UPDATE runs SET actor=NULL WHERE run_id='parent'", [])
        .unwrap();
    h.conn
        .execute(
            "UPDATE action_native_runs SET actor_id='claude-code' WHERE run_id='parent'",
            [],
        )
        .unwrap();
    assert!(admission::resolve(AuthorityDb::Writer(&h.conn), Some(&h.door.proof()),).is_ok());
}

#[test]
fn native_admission_nonblank_actor_mismatch_still_denies_self_and_parent() {
    for run in [RUN, "parent"] {
        let h = Harness::new("nonblank-actor-mismatch").with_parent("succeeded");
        let before = h.rows();
        h.conn
            .execute(
                "UPDATE runs SET actor='another-actor' WHERE run_id=?1",
                [run],
            )
            .unwrap();
        assert_eq!(
            admission::resolve(AuthorityDb::Writer(&h.conn), Some(&h.door.proof()))
                .err()
                .unwrap()
                .code,
            ActionErrorCode::Denied,
            "{run}"
        );
        assert_eq!(h.rows(), before);
    }
}

// SQL-kernel negative only: no native owner/window authentication is proved.
// Keep the invalid UTF-8 Path in memory. macOS filesystems may reject creating
// such a name before the insert guard can run; the actual SQL kernel must still
// refuse to replace its identity with U+FFFD inside a real transaction.
#[test]
#[cfg(unix)]
fn native_admission_insert_keeps_strict_canonical_path_utf8_refusal() {
    use super::native_lineage::{self, LineageError, NativeBinding};
    use std::{ffi::OsString, os::unix::ffi::OsStringExt};
    let dir = crate::vault::testutil::temp_vault("m96-native-invalid-path-utf8");
    let root = dir.join("vault");
    std::fs::create_dir(&root).unwrap();
    let invalid = dir.join(OsString::from_vec(b"vault-\xff".to_vec()));
    assert!(invalid.to_str().is_none());
    let conn = runtime::open(&dir).unwrap();
    let vault = runtime::scope::register(&conn, &root).unwrap();
    runtime::catchup::open_session(&conn, SESSION, &vault, "fixture-store", chrono::Utc::now())
        .unwrap();
    runtime::dispatch::begin_attended(
        &conn,
        RUN,
        Some(&vault),
        Some("fixture-store"),
        Some("claude-code"),
        None,
        None,
        chrono::Utc::now(),
    )
    .unwrap();
    runtime::dispatch::record_cli_session(&conn, RUN, "native-session").unwrap();
    let binding = NativeBinding {
        run_id: RUN,
        vault_id: &vault,
        store_uuid: "fixture-store",
        canonical_vault: &invalid,
        owner_person: "human:me",
        actor_id: "claude-code",
        source_kind: "run",
        app_session_id: SESSION,
        cli_session_id: Some("native-session"),
        parent_run_id: None,
        client_id: None,
        child_job_id: None,
    };
    let tx = rusqlite::Transaction::new_unchecked(&conn, rusqlite::TransactionBehavior::Immediate)
        .unwrap();
    let result =
        native_lineage::insert_if_absent(&tx, &binding, "33333333333333333333333333333333", NOW);
    let native_rows: i64 = tx
        .query_row("SELECT count(*) FROM action_native_runs", [], |row| {
            row.get(0)
        })
        .unwrap();
    let grants: i64 = tx
        .query_row("SELECT count(*) FROM action_account_grants", [], |row| {
            row.get(0)
        })
        .unwrap();
    tx.rollback().unwrap();
    let session: String = conn
        .query_row(
            "SELECT cli_session_id FROM runs WHERE run_id=?1",
            [RUN],
            |row| row.get(0),
        )
        .unwrap();
    drop(conn);
    std::fs::remove_dir_all(dir).unwrap();
    assert_eq!(result, Err(LineageError::Unavailable));
    assert_eq!(native_rows, 0, "refused insert changed SQL before rollback");
    assert_eq!(grants, 0);
    assert_eq!(session, "native-session");
}

#[test]
fn native_catalog_native_run_reader_bounds_actual_joined_utf8_text() {
    let h = Harness::new("catalog-native-bounds");
    let read = || {
        h.conn.query_row(
            runtime::native_runs::RUN_SQL,
            [RUN],
            runtime::native_runs::NativeRun::read,
        )
    };
    assert!(read().is_ok());
    // SQLite length() counts characters; the existing table accepts this path
    // while the shared byte ceiling must refuse before String allocation.
    let cap = super::schema::admission_rules().limits.canonical_path_bytes;
    let oversized = "é".repeat(cap / 2 + 1);
    h.conn
        .execute(
            "UPDATE action_native_runs SET canonical_vault_path=?1 WHERE run_id=?2",
            params![oversized, RUN],
        )
        .unwrap();
    assert!(read().is_err());
}

#[test]
fn native_catalog_compiled_definitions_keep_separate_grants_and_execution_unavailable() {
    let h = Harness::new("compiled-catalog-projection");
    let db = AuthorityDb::Writer(&h.conn);
    let proof = h.door.proof();
    let admitted = admission::resolve(db, Some(&proof)).unwrap();
    let catalog = super::compiled_catalog::compiled_catalog().unwrap();
    let material: serde_json::Value = serde_json::from_str(include_str!(
        "../../../shared/actions/github-issues.v1.json"
    ))
    .unwrap();
    let mut authored = ActionCatalog::default();
    let read = authored
        .insert(
            serde_json::from_value(material["definitions"][0].clone()).unwrap(),
            "{}",
        )
        .unwrap();
    let create = authored
        .insert(
            serde_json::from_value(material["definitions"][1].clone()).unwrap(),
            "{}",
        )
        .unwrap();
    let project = || super::native_authority::ScopedCatalog {
        catalog,
        scope: admitted.scope(),
        owner: admitted.owner_person(),
        execution: super::native_authority::CatalogExecution::NoExecutor,
    };
    h.conn.execute("UPDATE action_account_grants SET action_id=?1,definition_digest=?2,capabilities_json='[\"github.issue.read\"]' WHERE grant_id=?3", params![read.action_id.0,read.definition_digest.0,GRANT]).unwrap();
    let page = project().catalog(db, None).unwrap();
    assert_eq!(page.descriptors.len(), 1);
    assert_eq!(page.descriptors[0].action_id, read.action_id);
    assert_eq!(
        page.descriptors[0].status,
        CatalogStatus::Unavailable {
            reason: "Managed execution is not enabled.".into()
        }
    );
    assert_eq!(
        project()
            .definition(db, read.action_id.clone(), read.definition_digest.clone())
            .unwrap(),
        read
    );
    assert_eq!(
        project()
            .definition(
                db,
                create.action_id.clone(),
                create.definition_digest.clone()
            )
            .unwrap_err()
            .code,
        ActionReadErrorCode::NotFound
    );
    h.conn
        .execute(
            "UPDATE action_account_grants SET action_id=?1,definition_digest=?2 WHERE grant_id=?3",
            params![create.action_id.0, create.definition_digest.0, GRANT],
        )
        .unwrap();
    assert!(
        project().catalog(db, None).unwrap().descriptors.is_empty(),
        "read capability is not create capability"
    );
    h.conn.execute("UPDATE action_account_grants SET capabilities_json='[\"github.issue.create\"]' WHERE grant_id=?1", [GRANT]).unwrap();
    let create_page = project().catalog(db, None).unwrap();
    assert_eq!(create_page.descriptors.len(), 1);
    assert_eq!(create_page.descriptors[0].action_id, create.action_id);
    assert!(matches!(
        create_page.descriptors[0].status,
        CatalogStatus::Unavailable { .. }
    ));
    h.conn.execute("UPDATE managed_connections SET person='human:someone-else' WHERE connection_id='connection'", []).unwrap();
    assert!(project().catalog(db, None).unwrap().descriptors.is_empty());
}
