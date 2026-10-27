//! Actual definitions/account metadata and retained owner, no native permit fixture.
use super::*;
use crate::actions::native_owner::{
    native_workflows::{self as native, activation_service as service},
    RuntimeOwner,
};
fn definition(
    conn: &Db,
    action: bool,
    trigger: serde_json::Value,
) -> (nd::NativeDefinition, Permissions) {
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
    let schema = serde_json::json!({"type":"object"});
    let schema_digest =
        crate::actions::schema::workflow_schema_digest(&schema.to_string()).unwrap();
    let raw = serde_json::json!({"formatVersion":1,"workflowId":"configured","entryStepId":steps[0]["stepId"],"inputSchema":schema,"inputSchemaDigest":schema_digest,"declaredActionDigests":steps.iter().filter_map(|s|s["operation"]["definitionDigest"].as_str()).collect::<Vec<_>>(),"steps":steps,"trigger":trigger,"authoredBy":"human:me"});
    (nd::publish_fixture(&conn.dir, &raw.to_string(), "{}"), p)
}
fn scheduled(conn: &Db, action: bool) -> (nd::NativeDefinition, Permissions) {
    definition(
        conn,
        action,
        serde_json::json!({"kind":"schedule","intervalSeconds":60,"catchUp":"skip_missed"}),
    )
}
fn request<'a>(
    definition: &'a nd::NativeDefinition,
    permissions: &'a Permissions,
) -> service::Enable<'a> {
    service::Enable {
        key: KEY,
        expected: 0,
        definition,
        permissions,
        now: time(),
    }
}
fn owned(
    conn: &Db,
    request: service::Enable<'_>,
) -> Result<crate::runtime::workflow_activations::Changed, flow::Error> {
    let mut owner = RuntimeOwner::open_existing(&conn.dir).unwrap();
    service::enable_owned_rows(&mut owner, facts(), request, || Ok(()))
}
fn configurations(conn: &Connection) -> i64 {
    conn.query_row("SELECT count(*) FROM workflow_activations", [], |row| {
        row.get(0)
    })
    .unwrap()
}
#[test]
fn explicit_native_enable_requires_existing_transaction() {
    let conn = db();
    let (d, p) = scheduled(&conn, true);
    assert_eq!(
        service::enable_rows(&conn, facts(), request(&d, &p)),
        Err(flow::Error::Unavailable)
    );
    assert_eq!(configurations(&conn), 0);
}
#[test]
fn explicit_enable_atomically_pins_actual_account_without_minting_run_authority() {
    let conn = db();
    let (d, p) = scheduled(&conn, true);
    let enabled = owned(&conn, request(&d, &p)).unwrap();
    assert_eq!(enabled.current.version, d.version());
    assert_eq!(
        enabled.current.configuration,
        native::workflow_configuration(&d).unwrap()
    );
    assert_eq!(enabled.current.state, "enabled");
    let (body, scope): (String, String) = conn
        .query_row(
            "SELECT input_json,permissions_json FROM workflow_activations",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(body, "{}");
    assert_eq!(serde_json::from_str::<Permissions>(&scope).unwrap(), p);
    let(identity,revision,generation,epoch):(String,i64,i64,String)=conn.query_row("SELECT account_identity_digest,account_revision,revocation_generation,epoch FROM workflow_activation_accounts",[],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))).unwrap();
    assert_eq!(
        identity,
        crate::ledger::sha256_hex(br#"["https://github.com","42"]"#)
    );
    assert_eq!((revision, generation), (1, 0));
    assert_eq!(epoch, enabled.current.epoch);
    assert_eq!(
        (
            count(&conn, "runs"),
            count(&conn, "flow"),
            count(&conn, "grants")
        ),
        (0, 0, 0)
    );
}
#[test]
fn manual_definition_cannot_be_enabled_by_schedule_configuration() {
    let conn = db();
    let (d, p) = definition(&conn, false, serde_json::json!({"kind":"manual"}));
    assert_eq!(owned(&conn, request(&d, &p)), Err(flow::Error::Denied));
    assert_eq!(configurations(&conn), 0);
}
#[test]
fn unrelated_selected_account_cannot_be_pinned_from_definition_declarations() {
    let conn = db();
    let (d, _) = scheduled(&conn, false);
    let (p, _) = selected_account(&conn);
    assert_eq!(owned(&conn, request(&d, &p)), Err(flow::Error::Denied));
    assert_eq!(configurations(&conn), 0);
    assert_eq!(count(&conn, "grants"), 0);
}
#[test]
fn disabled_actual_account_refuses_enable_without_partial_configuration() {
    let conn = db();
    let (d, p) = scheduled(&conn, true);
    let transaction = Transaction::new_unchecked(&conn, TransactionBehavior::Immediate).unwrap();
    crate::connections::account_metadata::disable(
        &transaction,
        "human:me",
        &crate::actions::ids::ConnectionId(p.accounts[0].connection.clone()),
        1,
    )
    .unwrap();
    transaction.commit().unwrap();
    assert_eq!(owned(&conn, request(&d, &p)), Err(flow::Error::Denied));
    assert_eq!(configurations(&conn), 0);
}
#[test]
fn enable_redelivery_observes_original_pins_after_account_is_disabled() {
    let conn = db();
    let (d, p) = scheduled(&conn, true);
    let first = owned(&conn, request(&d, &p)).unwrap();
    let transaction = Transaction::new_unchecked(&conn, TransactionBehavior::Immediate).unwrap();
    crate::connections::account_metadata::disable(
        &transaction,
        "human:me",
        &crate::actions::ids::ConnectionId(p.accounts[0].connection.clone()),
        1,
    )
    .unwrap();
    transaction.commit().unwrap();
    let again = owned(&conn, request(&d, &p)).unwrap();
    assert!(again.replayed);
    assert_eq!(again.receipt, first.receipt);
    assert_eq!(again.current, first.current);
    let generation: i64 = conn
        .query_row(
            "SELECT revocation_generation FROM workflow_activation_accounts",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(generation, 0);
    assert_eq!(count(&conn, "grants"), 0);
}
#[test]
fn failed_explicit_replacement_restores_previous_epoch_and_account_pins() {
    let conn = db();
    let (d, p) = scheduled(&conn, true);
    let first = owned(&conn, request(&d, &p)).unwrap();
    let transaction = Transaction::new_unchecked(&conn, TransactionBehavior::Immediate).unwrap();
    crate::connections::account_metadata::disable(
        &transaction,
        "human:me",
        &crate::actions::ids::ConnectionId(p.accounts[0].connection.clone()),
        1,
    )
    .unwrap();
    transaction.commit().unwrap();
    let next = "2".repeat(32);
    assert_eq!(
        owned(
            &conn,
            service::Enable {
                key: &next,
                expected: 1,
                now: time() + chrono::Duration::seconds(30),
                ..request(&d, &p)
            }
        ),
        Err(flow::Error::Denied)
    );
    let (epoch, revision): (String, i64) = conn
        .query_row(
            "SELECT epoch,revision FROM workflow_activations",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!((epoch, revision), (first.current.epoch.clone(), 1));
    let pin_epoch: String = conn
        .query_row(
            "SELECT epoch FROM workflow_activation_accounts",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(pin_epoch, first.current.epoch);
}
#[test]
fn late_original_opening_loss_rolls_back_configuration_and_account_pins() {
    let conn = db();
    let (d, p) = scheduled(&conn, true);
    let mut owner = RuntimeOwner::open_existing(&conn.dir).unwrap();
    let calls = std::cell::Cell::new(0);
    let result = service::enable_owned_rows(&mut owner, facts(), request(&d, &p), || {
        calls.set(calls.get() + 1);
        if calls.get() == 1 {
            Ok(())
        } else {
            Err(flow::Error::Denied)
        }
    });
    assert_eq!(result, Err(flow::Error::Denied));
    assert_eq!(calls.get(), 2);
    assert_eq!(configurations(&conn), 0);
    let pins: i64 = conn
        .query_row(
            "SELECT count(*) FROM workflow_activation_accounts",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(pins, 0);
}
#[test]
fn lost_enable_commit_ack_preserves_configuration_but_returns_no_native_origin() {
    let conn = db();
    let (d, p) = scheduled(&conn, true);
    let mut owner = RuntimeOwner::open_existing(&conn.dir).unwrap();
    let result = crate::actions::native_owner::tests::with_transaction_ack_probe(|| {
        crate::actions::native_owner::tests::lose_next_transaction_ack();
        service::enable_owned_rows(&mut owner, facts(), request(&d, &p), || Ok(()))
    });
    assert_eq!(result, Err(flow::Error::Unavailable));
    assert!(owner.retired);
    assert_eq!(configurations(&conn), 1);
    let replay = owned(&conn, request(&d, &p)).unwrap();
    assert!(replay.replayed);
    assert_eq!(count(&conn, "runs"), 0);
}
