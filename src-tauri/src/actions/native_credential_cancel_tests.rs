use super::*;
use crate::connections::AcquisitionState;
fn ticket(attempt: &str, connection: &str) -> CredentialAcquisition {
    CredentialAcquisition {
        attempt_id: AttemptId(attempt.into()),
        connection_id: ConnectionId(connection.into()),
        person: "human:fixture".into(),
        host: "github.com".into(),
        login: "alice".into(),
        expected_revision: 2,
        revocation_generation: 0,
        state: AcquisitionState::Pending,
        error: None,
        observed_at: "fixture".into(),
    }
}
#[test]
fn exact_attempt_cancel_does_not_cancel_another_connection() {
    let book = Arc::new(CancellationBook::default());
    let a = book.register(&ticket("a", "one")).unwrap();
    let b = book.register(&ticket("b", "two")).unwrap();
    book.cancel_attempt(&AttemptId("a".into()));
    assert!(a.flag.stopped());
    assert!(!b.flag.stopped());
}
#[test]
fn supersede_or_disable_cancels_every_live_attempt_of_only_that_connection() {
    let book = Arc::new(CancellationBook::default());
    let a = book.register(&ticket("a", "one")).unwrap();
    let b = book.register(&ticket("b", "one")).unwrap();
    let other = book.register(&ticket("other", "two")).unwrap();
    book.cancel_connection(&ConnectionId("one".into()));
    assert!(a.flag.stopped() && b.flag.stopped());
    assert!(!other.flag.stopped());
}
#[test]
fn ambiguous_owner_outcome_cancels_all_without_severing_worker_flags() {
    let book = Arc::new(CancellationBook::default());
    let registration = book.register(&ticket("a", "one")).unwrap();
    let live_worker = registration.flag.clone();
    book.cancel_all();
    assert!(live_worker.stopped());
    drop(registration);
    assert!(book.entries.lock().unwrap().is_empty());
    assert!(live_worker.stopped());
}
#[test]
fn terminal_worker_drop_prunes_entry_and_duplicate_registration_is_refused() {
    let book = Arc::new(CancellationBook::default());
    let first = book.register(&ticket("a", "one")).unwrap();
    assert_eq!(
        book.register(&ticket("a", "one")).err(),
        Some(ConnectionError::Unavailable)
    );
    let adapter_flag = first.flag.clone();
    drop(first);
    assert!(
        adapter_flag.stopped(),
        "pruning cannot sever cancellation of surviving adapter clones"
    );
    assert!(book.entries.lock().unwrap().is_empty());
    drop(book.register(&ticket("a", "one")).unwrap());
}
