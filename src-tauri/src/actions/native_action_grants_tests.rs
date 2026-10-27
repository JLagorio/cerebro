//! Real RuntimeOwner/lineage/account rows, not a native gesture/origin fixture.
//! Direct private row admission values are test metadata only; production read/
//! set constructors must use actual injected-window + original publication.
use super::*;
use crate::actions::{catalog::ActionCatalog, service::test_support::Harness};
use crate::connections::metadata::{
    AccountBinding, ConnectionHealth, ConnectionStatus, RemoteRevocation, SecretRef,
};
use rusqlite::params;
const NOW: &str = "2026-10-26T00:00:00.000Z";
struct Fixture {
    h: Harness,
    owner: RuntimeOwner,
    scope: ActionSubjectView,
    definition: ActionDefinition,
}
impl Fixture {
    fn new(label: &str) -> Self {
        let h = Harness::new(label);
        let root = h.dir().join("native-grant-vault");
        std::fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let store = crate::ledger::store::load_or_mint(&crate::ledger::ledger_dir(&root)).unwrap();
        let mut owner = RuntimeOwner::open_existing(&h.dir().canonicalize().unwrap()).unwrap();
        let status = ConnectionStatus {
            connection_id: ConnectionId("connection".into()),
            revision: 1,
            login: "fixture-person".into(),
            health: ConnectionHealth::Ready,
            account: Some(AccountBinding {
                account_id: AccountId("account".into()),
                subject: "42".into(),
                issuer: crate::actions::github_issues::account_issuer().into(),
                account_revision: 1,
                scope_digest: "scopes-one".into(),
            }),
            secret_revision: 1,
            revocation_generation: 0,
            observed_at: NOW.into(),
            cleanup_pending: false,
            remote_revocation: RemoteRevocation::NotAttempted,
        };
        let reference = SecretRef {
            id: "f".repeat(32),
            account_id: AccountId("account".into()),
            issuer: crate::actions::github_issues::account_issuer().into(),
            subject: "42".into(),
            secret_revision: 1,
        };
        let scope=super::super::super::action_transaction(&mut owner,|conn|{
   let vault=crate::runtime::scope::register(conn,&root).unwrap();crate::runtime::catchup::open_session(conn,"grant-session",&vault,&store.store_id,NOW.parse().unwrap()).unwrap();
   crate::runtime::dispatch::begin_attended(conn,"grant-run",Some(&vault),Some(&store.store_id),Some("claude-code"),None,None,NOW.parse().unwrap()).unwrap();
   conn.execute("UPDATE runs SET cli_session_id='grant-cli-session' WHERE run_id='grant-run'",[]).unwrap();
   native_lineage::insert_if_absent(conn,&native_lineage::NativeBinding{run_id:"grant-run",vault_id:&vault,store_uuid:&store.store_id,canonical_vault:&root,owner_person:"human:me",actor_id:"claude-code",source_kind:"run",app_session_id:"grant-session",cli_session_id:Some("grant-cli-session"),parent_run_id:None,client_id:None,child_job_id:None},&"b".repeat(32),NOW).unwrap();
   conn.execute("INSERT INTO managed_connections(connection_id,person,status,secret_ref) VALUES('connection','human:me',?1,?2)",params![serde_json::to_string(&status).unwrap(),serde_json::to_string(&reference).unwrap()]).unwrap();
   Ok(ActionSubjectView{vault_id:vault,run_id:"grant-run".into(),actor_id:"claude-code".into(),client_id:None,child_job_id:None})
  }).unwrap();
        let compiled: serde_json::Value = serde_json::from_str(include_str!(
            "../../../shared/actions/github-issues.v1.json"
        ))
        .unwrap();
        let material: crate::actions::read_types::DefinitionMaterial =
            serde_json::from_value(compiled["definitions"][0].clone()).unwrap();
        let definition = ActionCatalog::default().insert(material, "{}").unwrap();
        assert_eq!(
            crate::actions::compiled_catalog::compiled_catalog()
                .unwrap()
                .resolve(&definition.action_id, &definition.definition_digest)
                .unwrap(),
            definition
        );
        Self {
            h,
            owner,
            scope,
            definition,
        }
    }
    fn tx<T>(
        &mut self,
        f: impl FnOnce(&Connection, &GrantAdmission<'_>) -> Result<T, ActionError>,
    ) -> Result<T, ActionError> {
        let scope = self.scope.clone();
        super::super::super::action_transaction(&mut self.owner, |conn| {
            let native = native_lineage::load_run(AuthorityDb::Writer(conn), &scope.run_id)
                .map_err(|_| kernel::unavailable())?;
            f(
                conn,
                &GrantAdmission {
                    conn,
                    scope: &scope,
                    native: &native,
                },
            )
        })
    }
    fn view(&mut self) -> RunActionAccessView {
        self.tx(read_rows).unwrap()
    }
    fn selection(&self, scope: GrantInputSelection) -> RunActionGrantSelection {
        RunActionGrantSelection::New {
            selection: RunActionSelection {
                connection_id: ConnectionId("connection".into()),
                account_id: AccountId("account".into()),
                account_revision: SafeCounter::new(1).unwrap(),
                revocation_generation: SafeCounter::new(0).unwrap(),
                action_id: self.definition.action_id.clone(),
                definition_digest: self.definition.definition_digest.clone(),
                input_scope: scope,
            },
        }
    }
    fn set(
        &mut self,
        revision: String,
        selections: Vec<RunActionGrantSelection>,
    ) -> Result<RunActionAccessView, ActionError> {
        self.tx(|conn, admission| {
            replace_rows(
                conn,
                admission,
                &SetRunActionAccess {
                    expected_access_revision: revision,
                    selections,
                    complete_request_id: None,
                },
            )
        })
    }
    fn rows(&self) -> Vec<String> {
        let mut statement=self.owner.conn.prepare("SELECT json_array(grant_id,run_id,connection_id,account_id,account_identity_digest,account_revision,revocation_generation,action_id,definition_digest,input_scope,input_digest,capabilities_json,parent_grant_id,revision,granted_by,granted_at,revoked_at) FROM action_account_grants ORDER BY grant_id").unwrap();
        let rows = statement
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        rows
    }
}
#[test]
fn native_grant_rows_refuse_autocommit_without_creating_authority() {
    let f = Fixture::new("grants-no-tx");
    let native =
        native_lineage::load_run(AuthorityDb::Writer(&f.owner.conn), &f.scope.run_id).unwrap();
    let admission = GrantAdmission {
        conn: &f.owner.conn,
        scope: &f.scope,
        native: &native,
    };
    assert_eq!(
        read_rows(&f.owner.conn, &admission).unwrap_err().code,
        ActionErrorCode::Unavailable
    );
    assert!(f.rows().is_empty());
}
#[test]
fn native_grant_read_lists_choices_but_import_alone_creates_no_grant() {
    let mut f = Fixture::new("grants-default-deny");
    let view = f.view();
    assert_eq!(view.run_id, "grant-run");
    assert_eq!(view.accounts.len(), 1);
    assert_eq!(view.definitions.len(), 2);
    assert!(view.grants.is_empty());
    assert!(f.rows().is_empty());
}
#[test]
fn native_grant_new_choice_writes_only_original_run_and_native_derived_identity_capabilities() {
    let mut f = Fixture::new("grants-explicit");
    let view = f.view();
    let selection = f.selection(GrantInputSelection::AllValidInputs);
    let changed = f.set(view.access_revision, vec![selection]).unwrap();
    assert_eq!(changed.grants.len(), 1);
    let (run, owner, caps, parent): (String, String, String, Option<String>) = f
        .owner
        .conn
        .query_row(
            "SELECT run_id,granted_by,capabilities_json,parent_grant_id FROM action_account_grants",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap();
    assert_eq!(run, "grant-run");
    assert_eq!(owner, "human:me");
    assert_eq!(caps, r#"["github.issue.read"]"#);
    assert!(parent.is_none());
    assert!(changed.access_revision.len() == 64);
}
#[test]
fn native_grant_stale_revision_rolls_back_every_choice() {
    let mut f = Fixture::new("grants-stale");
    let view = f.view();
    let selection = f.selection(GrantInputSelection::AllValidInputs);
    f.set(view.access_revision.clone(), vec![selection])
        .unwrap();
    let before = f.rows();
    let error = f.set(view.access_revision, vec![]).unwrap_err();
    assert_eq!(error.code, ActionErrorCode::RevisionConflict);
    assert_eq!(f.rows(), before);
}
#[test]
fn native_grant_preserve_exact_input_keeps_original_bytes_without_hidden_input_roundtrip() {
    let mut f = Fixture::new("grants-preserve-exact");
    let view = f.view();
    let selection = f.selection(GrantInputSelection::ExactCanonicalInput {
        input: r#"{"number":1,"repository":"fixture/repo"}"#.into(),
    });
    let exact = f.set(view.access_revision, vec![selection]).unwrap();
    let original = f.rows();
    let grant = &exact.grants[0];
    let preserve = RunActionGrantSelection::Preserve {
        grant_id: grant.grant_id.clone(),
        expected_revision: grant.revision,
    };
    let current = f.set(exact.access_revision, vec![preserve]).unwrap();
    assert_eq!(f.rows(), original);
    assert_eq!(current.grants[0].grant_id, exact.grants[0].grant_id);
    assert!(matches!(
        &current.grants[0].input_scope,
        GrantInputView::ExactCanonicalInput { .. }
    ));
}
#[test]
fn native_grant_remove_revokes_original_instead_of_deleting_or_reactivating_it() {
    let mut f = Fixture::new("grants-revoke");
    let view = f.view();
    let selection = f.selection(GrantInputSelection::AllValidInputs);
    let granted = f.set(view.access_revision, vec![selection]).unwrap();
    let old = granted.grants[0].grant_id.clone();
    let old_revision = granted.grants[0].revision;
    let empty = f.set(granted.access_revision, vec![]).unwrap();
    assert!(empty.grants.is_empty());
    let (revoked, revision): (bool, i64) = f
        .owner
        .conn
        .query_row(
            "SELECT revoked_at IS NOT NULL,revision FROM action_account_grants WHERE grant_id=?1",
            [&old],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert!(revoked);
    assert_eq!(revision, 2);
    let before = f.rows();
    let error = f
        .set(
            empty.access_revision,
            vec![RunActionGrantSelection::Preserve {
                grant_id: old,
                expected_revision: old_revision,
            }],
        )
        .unwrap_err();
    assert!(matches!(
        error.code,
        ActionErrorCode::Denied | ActionErrorCode::RevisionConflict
    ));
    assert_eq!(f.rows(), before);
}
#[test]
fn native_grant_outer_rollback_preserves_all_original_rows() {
    let mut f = Fixture::new("grants-rollback");
    let view = f.view();
    let selection = f.selection(GrantInputSelection::AllValidInputs);
    let before = f.rows();
    let scope = f.scope.clone();
    let tx = rusqlite::Transaction::new_unchecked(
        &f.owner.conn,
        rusqlite::TransactionBehavior::Immediate,
    )
    .unwrap();
    let native = native_lineage::load_run(AuthorityDb::Writer(&tx), &scope.run_id).unwrap();
    let admission = GrantAdmission {
        conn: &tx,
        scope: &scope,
        native: &native,
    };
    replace_rows(
        &tx,
        &admission,
        &SetRunActionAccess {
            expected_access_revision: view.access_revision,
            selections: vec![selection],
            complete_request_id: None,
        },
    )
    .unwrap();
    assert_eq!(
        tx.query_row("SELECT count(*) FROM action_account_grants", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    tx.rollback().unwrap();
    assert_eq!(f.rows(), before);
}
#[test]
fn native_grant_changed_account_does_not_promote_old_selection_to_new_identity() {
    let mut f = Fixture::new("grants-account-drift");
    let view = f.view();
    let selection = f.selection(GrantInputSelection::AllValidInputs);
    f.owner.conn.execute("UPDATE managed_connections SET status=json_set(status,'$.account.accountRevision',2,'$.account.subject','new-subject')",[]).unwrap();
    let before = f.rows();
    let error = f.set(view.access_revision, vec![selection]).unwrap_err();
    assert!(matches!(
        error.code,
        ActionErrorCode::RevisionConflict | ActionErrorCode::Denied
    ));
    assert_eq!(f.rows(), before);
}
fn check_owned(lost: bool) {
    let mut f = Fixture::new(if lost {
        "grants-ack-unknown"
    } else {
        "grants-owned-commit"
    });
    let scope = f.scope.clone();
    let definition = f.definition.clone();
    let result = crate::actions::native_owner::tests::with_transaction_ack_probe(|| {
        if lost {
            crate::actions::native_owner::tests::lose_next_transaction_ack();
        }
        change_owned(&mut f.owner, |conn| {
            let native = native_lineage::load_run(AuthorityDb::Writer(conn), &scope.run_id)
                .map_err(|_| kernel::unavailable())?;
            let admission = GrantAdmission {
                conn,
                scope: &scope,
                native: &native,
            };
            let view = read_rows(conn, &admission)?;
            replace_rows(
                conn,
                &admission,
                &SetRunActionAccess {
                    expected_access_revision: view.access_revision,
                    selections: vec![RunActionGrantSelection::New {
                        selection: RunActionSelection {
                            connection_id: ConnectionId("connection".into()),
                            account_id: AccountId("account".into()),
                            account_revision: SafeCounter::new(1).unwrap(),
                            revocation_generation: SafeCounter::new(0).unwrap(),
                            action_id: definition.action_id,
                            definition_digest: definition.definition_digest,
                            input_scope: GrantInputSelection::AllValidInputs,
                        },
                    }],
                    complete_request_id: None,
                },
            )
        })
    });
    if lost {
        assert!(matches!(result, GrantWriteOutcome::CommitUnknown));
        assert!(f.owner.retired);
    } else {
        let GrantWriteOutcome::Committed(view) = result else {
            panic!("known commit")
        };
        assert_eq!(view.grants.len(), 1);
    }
    let conn = crate::runtime::open_existing(f.h.dir()).unwrap();
    assert_eq!(
        conn.query_row("SELECT count(*) FROM action_account_grants", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
}
#[test]
fn native_grant_owned_known_commit_returns_real_original_rows() {
    check_owned(false);
}
#[test]
fn native_grant_owned_lost_commit_ack_returns_unknown_without_changed_authority() {
    check_owned(true);
}

#[test]
fn native_catalog_bindings_preserve_differing_per_action_accounts_without_cross_products() {
    let mut f = Fixture::new("grants-model-bindings");
    f.owner.conn.execute("INSERT INTO managed_connections(connection_id,person,status,secret_ref) SELECT 'connection-two',person,json_set(status,'$.connectionId','connection-two','$.login','second-person','$.account.accountId','account-two','$.account.subject','84'),json_set(secret_ref,'$.id',?1,'$.accountId','account-two','$.subject','84') FROM managed_connections WHERE connection_id='connection'",["e".repeat(32)]).unwrap();
    let view = f.view();
    let first = f.definition.clone();
    let second = view
        .definitions
        .iter()
        .find(|definition| definition.action_id != first.action_id)
        .unwrap()
        .clone();
    let first_selection = f.selection(GrantInputSelection::AllValidInputs);
    let second_selection = RunActionGrantSelection::New {
        selection: RunActionSelection {
            connection_id: ConnectionId("connection-two".into()),
            account_id: AccountId("account-two".into()),
            account_revision: SafeCounter::new(1).unwrap(),
            revocation_generation: SafeCounter::new(0).unwrap(),
            action_id: second.action_id.clone(),
            definition_digest: second.definition_digest.clone(),
            input_scope: GrantInputSelection::AllValidInputs,
        },
    };
    f.set(
        view.access_revision,
        vec![first_selection, second_selection],
    )
    .unwrap();
    let bindings = f
        .tx(|conn, admission| catalog_bindings_rows(conn, admission.scope, admission.native))
        .unwrap();
    assert_eq!(bindings.len(), 2);
    assert!(bindings
        .iter()
        .any(|binding| binding.action_id == first.action_id
            && binding.definition_digest == first.definition_digest
            && binding.connection_id.0 == "connection"
            && binding.account_id.0 == "account"
            && binding.label == "fixture-person"));
    assert!(bindings
        .iter()
        .any(|binding| binding.action_id == second.action_id
            && binding.definition_digest == second.definition_digest
            && binding.connection_id.0 == "connection-two"
            && binding.account_id.0 == "account-two"
            && binding.label == "second-person"));
    assert!(!bindings
        .iter()
        .any(|binding| binding.action_id == first.action_id
            && binding.connection_id.0 == "connection-two"
            || binding.action_id == second.action_id && binding.connection_id.0 == "connection"));
}
#[test]
fn native_catalog_bindings_never_disclose_an_imported_but_ungranted_account() {
    let mut f = Fixture::new("grants-model-ungranted");
    let bindings = f
        .tx(|conn, admission| catalog_bindings_rows(conn, admission.scope, admission.native))
        .unwrap();
    assert!(bindings.is_empty());
}
