//! Actual retained metadata coordinator, fake credential seams, control-only
//! registrations. These tests do not manufacture native/provider authority.
use super::*;
use crate::actions::effect_types::InvocationId;

fn worker(f: &Fixture, id: char, connection: &ConnectionId) -> super::super::native_actions::cancellation::Registration {
    f.owner.action_cancellations.register_fixture(
        "original-run", connection, &InvocationId(id.to_string().repeat(32)),
    ).unwrap()
}

#[test]
fn native_action_account_begin_known_commit_cancels_only_its_connection() {
    let f = Fixture::new("m96-action-hook-begin");
    let first = bridge_connect(&f);
    let original = worker(&f, 'a', &selection().connection_id);
    let other = worker(&f, 'b', &ConnectionId("other-connection".into()));
    let ticket = f.owner.begin_account_acquisition(&selection(), first.revision).unwrap();
    assert_eq!(f.attempt(&ticket.attempt_id), ticket);
    assert!(original.stopped());
    assert!(!other.stopped());
    f.assert_unlocked();
}

#[test]
fn native_action_account_disable_known_commit_cancels_only_its_connection() {
    let f = Fixture::new("m96-action-hook-disable");
    let first = bridge_connect(&f);
    let original = worker(&f, 'a', &selection().connection_id);
    let other = worker(&f, 'b', &ConnectionId("other-connection".into()));
    let status = f.owner.disable_account(&selection().connection_id, first.revision).unwrap();
    assert_eq!(status.health, ConnectionHealth::Disabled);
    assert_eq!(status, f.status());
    assert!(original.stopped());
    assert!(!other.stopped());
    f.assert_unlocked();
}

#[test]
fn native_action_account_stale_begin_and_disable_leave_original_worker_running() {
    let f = Fixture::new("m96-action-hook-stale");
    let first = bridge_connect(&f);
    let original = worker(&f, 'a', &selection().connection_id);
    assert_eq!(f.owner.begin_account_acquisition(&selection(), first.revision + 1), Err(ConnectionError::StaleRevision));
    assert_eq!(f.owner.disable_account(&selection().connection_id, first.revision + 1), Err(ConnectionError::StaleRevision));
    assert_eq!(f.status(), first);
    assert!(!original.stopped());
    f.assert_unlocked();
}

#[test]
fn native_action_account_completion_cancels_after_known_install_commit() {
    let f = Fixture::new("m96-action-hook-install");
    let ticket = f.ticket();
    let original = worker(&f, 'a', &selection().connection_id);
    let other = worker(&f, 'b', &ConnectionId("other-connection".into()));
    let store = FakeStore::default();
    let put = BeforePut {
        inner: &store,
        before: RefCell::new(Some(Box::new(|| {
            f.assert_unlocked();
            assert!(!original.stopped(), "reservation and OS put cannot stand in for installation");
            assert!(!other.stopped());
        }))),
    };
    let installed = f.owner.import_account(&ticket, &gh(), &identity(), &put).unwrap();
    assert_eq!(installed.health, ConnectionHealth::Ready);
    assert_eq!(installed, f.status());
    assert!(original.stopped());
    assert!(!other.stopped());
    f.assert_unlocked();
}

#[test]
fn native_action_account_rolled_back_install_does_not_cancel_original_worker() {
    let f = Fixture::new("m96-action-hook-install-rollback");
    let ticket = f.ticket();
    let original = worker(&f, 'a', &selection().connection_id);
    let store = FakeStore::default();
    f.ordinary.execute_batch("CREATE TRIGGER refuse_fixture_install BEFORE UPDATE ON managed_connections WHEN json_extract(NEW.status,'$.health')='ready' BEGIN SELECT RAISE(ABORT,'fixture installation rollback'); END;").unwrap();
    assert_eq!(f.owner.import_account(&ticket, &gh(), &identity(), &store), Err(ConnectionError::Unavailable));
    assert_eq!(f.status().health, ConnectionHealth::SignInRequired);
    assert!(!original.stopped(), "a known rollback must not publish the install cancellation");
    assert!(store.items.borrow().is_empty());
    f.assert_unlocked();
}
