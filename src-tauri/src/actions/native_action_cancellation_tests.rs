//! Metadata-only cancellation registrations; no window/run/provider authority.
use super::*;
fn connection(value: &str) -> ConnectionId {
    ConnectionId(value.into())
}
fn invocation(value: char) -> InvocationId {
    InvocationId(value.to_string().repeat(32))
}
#[test]
fn action_worker_cancel_connection_is_scoped_to_original_workers() {
    let book = Arc::new(CancellationBook::default());
    let first = book
        .register_fixture("run", &connection("one"), &invocation('a'))
        .expect("first worker");
    let other = book
        .register("run", &connection("two"), &invocation('b'))
        .unwrap();
    assert!(!first.stopped());
    book.cancel_connection(&connection("one"));
    assert!(first.stopped());
    assert!(!other.stopped());
}
#[test]
fn action_worker_stop_run_and_cancel_invocation_reach_only_original_workers() {
    let book = Arc::new(CancellationBook::default());
    let first = book
        .register("run-one", &connection("one"), &invocation('a'))
        .unwrap();
    let other = book
        .register("run-two", &connection("one"), &invocation('b'))
        .unwrap();
    book.cancel_run("run-one");
    assert!(first.stopped());
    assert!(!other.stopped());
    book.cancel_invocation(&invocation('b'));
    assert!(other.stopped());
}
#[test]
fn action_worker_owner_retirement_cancels_all_registered_workers() {
    let book = Arc::new(CancellationBook::default());
    let first = book
        .register("run-one", &connection("one"), &invocation('a'))
        .unwrap();
    let other = book
        .register("run-two", &connection("two"), &invocation('b'))
        .unwrap();
    book.cancel_all();
    assert!(first.stopped());
    assert!(other.stopped());
}
#[test]
fn action_worker_registration_drop_stops_old_flag_and_cannot_leave_or_remove_a_new_owner() {
    let book = Arc::new(CancellationBook::default());
    let first = book
        .register("run", &connection("one"), &invocation('a'))
        .unwrap();
    let flag = first.flag.clone();
    assert!(book
        .register("other-run", &connection("two"), &invocation('a'))
        .is_err());
    drop(first);
    assert!(flag.load(Ordering::SeqCst));
    let next = book
        .register("run", &connection("one"), &invocation('a'))
        .unwrap();
    assert!(!next.stopped());
    book.cancel_connection(&connection("one"));
    assert!(next.stopped());
}

#[test]
fn action_worker_poison_publishes_raw_cancellation_flags_for_every_existing_registration() {
    for phase in ["cancel_all", "register", "drop"] {
        let book = Arc::new(CancellationBook::default());
        let mut first = Some(
            book.register_fixture("run-one", &connection("one"), &invocation('a'))
                .unwrap(),
        );
        let other = book
            .register_fixture("run-two", &connection("two"), &invocation('b'))
            .unwrap();
        let first_flag = first.as_ref().unwrap().flag.clone();
        let other_flag = other.flag.clone();
        let poison = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _held = book.entries.lock().unwrap();
            panic!("fixture cancellation registry poison");
        }));
        assert!(poison.is_err());
        match phase {
            "cancel_all" => book.cancel_all(),
            "register" => assert!(book
                .register_fixture("new", &connection("new"), &invocation('c'))
                .is_err()),
            "drop" => drop(first.take()),
            _ => unreachable!(),
        }
        assert!(
            first_flag.load(Ordering::SeqCst),
            "{phase}: existing raw transport flag remains live after registry poison"
        );
        assert!(
            other_flag.load(Ordering::SeqCst),
            "{phase}: unrelated raw worker flag missed fail-closed retirement"
        );
        assert!(book
            .register_fixture("later", &connection("later"), &invocation('d'))
            .is_err());
    }
}

#[test]
fn action_worker_explicit_global_stop_reaches_finished_cli_workers_without_retiring_book() {
    let book = Arc::new(CancellationBook::default());
    let finished_cli = book
        .register_fixture("already-finished-cli", &connection("one"), &invocation('a'))
        .unwrap();
    let another = book
        .register_fixture("another", &connection("two"), &invocation('b'))
        .unwrap();
    book.stop_all();
    assert!(finished_cli.stopped());
    assert!(another.stopped());
    let later = book
        .register_fixture("new-explicit-work", &connection("one"), &invocation('c'))
        .expect("Stop all is reusable, not owner retirement");
    assert!(!later.stopped());
}
