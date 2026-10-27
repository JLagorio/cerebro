use super::*;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::{
    sync::{atomic::Ordering, OnceLock},
    time::Duration,
};
fn key(id: &str) -> Key {
    static OWNER: OnceLock<Arc<()>> = OnceLock::new();
    Key::Run {
        owner: OWNER.get_or_init(|| Arc::new(())).clone(),
        run: id.into(),
        epoch: 1,
    }
}
fn job(id: &str, work: impl FnOnce(&AtomicBool) -> Option<Job> + Send + 'static) -> Job {
    Job {
        key: key(id),
        ready: Instant::now(),
        cancel: Arc::new(|| {}),
        work: Box::new(work),
    }
}
struct Gate(Option<Sender<()>>);
impl Drop for Gate {
    fn drop(&mut self) {
        if let Some(tx) = self.0.take() {
            let _ = tx.send(());
        }
    }
}
struct JoinedGate {
    release: Option<Gate>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Drop for JoinedGate {
    fn drop(&mut self) {
        drop(self.release.take());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
fn gate() -> (Gate, Receiver<()>) {
    let (tx, rx) = channel();
    (Gate(Some(tx)), rx)
}
#[test]
fn workflow_worker_retains_one_running_job_and_bounds_total_admitted_tickets() {
    let book = OwnedBook::new(2);
    let (release, rx) = gate();
    let (started, seen) = channel();
    let (done, finished) = channel();
    assert_eq!(
        book.submit(job("first", move |_| {
            started.send(()).unwrap();
            let _ = rx.recv();
            done.send(()).unwrap();
            None
        })),
        Admission::Queued
    );
    let _release = release;
    seen.recv_timeout(Duration::from_secs(2)).unwrap();
    let (second, second_seen) = channel();
    assert_eq!(
        book.submit(job("second", move |_| {
            second.send(()).unwrap();
            None
        })),
        Admission::Queued
    );
    assert_eq!(book.submit(job("third", |_| None)), Admission::Busy);
    assert!(second_seen.try_recv().is_err());
    drop(_release);
    finished.recv_timeout(Duration::from_secs(2)).unwrap();
    second_seen.recv_timeout(Duration::from_secs(2)).unwrap();
    book.shutdown();
}
#[test]
fn workflow_worker_duplicate_admission_keeps_original_job_without_replacing_payload() {
    let book = OwnedBook::new(2);
    let (release, rx) = gate();
    let (started, seen) = channel();
    assert_eq!(
        book.submit(job("same", move |_| {
            started.send(()).unwrap();
            let _ = rx.recv();
            None
        })),
        Admission::Queued
    );
    let _release = release;
    seen.recv_timeout(Duration::from_secs(2)).unwrap();
    let (replaced, was_replaced) = channel();
    assert_eq!(
        book.submit(job("same", move |_| {
            let _ = replaced.send(());
            None
        })),
        Admission::Observed
    );
    drop(_release);
    book.shutdown();
    assert!(was_replaced.try_recv().is_err());
}
#[test]
fn workflow_worker_stop_publishes_cancellation_but_never_claims_physical_completion_early() {
    let book = Arc::new(OwnedBook::new(2));
    let (release, rx) = gate();
    let (started, seen) = channel();
    let (stopped, stop_seen) = channel();
    let (cancelled, cancel_seen) = channel();
    let mut first = job("active", move |stop| {
        started.send(()).unwrap();
        let _ = rx.recv();
        stopped.send(stop.load(Ordering::SeqCst)).unwrap();
        None
    });
    first.cancel = Arc::new(move || {
        let _ = cancelled.send(());
    });
    assert_eq!(book.submit(first), Admission::Queued);
    let _release = release;
    seen.recv_timeout(Duration::from_secs(2)).unwrap();
    let (queued, queued_seen) = channel();
    assert_eq!(
        book.submit(job("queued", move |_| {
            let _ = queued.send(());
            None
        })),
        Admission::Queued
    );
    book.stop();
    cancel_seen.recv_timeout(Duration::from_secs(2)).unwrap();
    let (stopping, stopping_seen) = channel();
    let (joined, join_seen) = channel();
    let other = book.clone();
    let waiter = std::thread::spawn(move || {
        stopping.send(()).unwrap();
        other.shutdown();
        joined.send(()).unwrap();
    });
    let mut cleanup = JoinedGate {
        release: Some(_release),
        thread: Some(waiter),
    };
    stopping_seen.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(
        matches!(
            join_seen.recv_timeout(Duration::from_millis(50)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ),
        "shutdown remains owned until active job releases"
    );
    drop(cleanup.release.take());
    assert!(stop_seen.recv_timeout(Duration::from_secs(2)).unwrap());
    join_seen.recv_timeout(Duration::from_secs(2)).unwrap();
    cleanup.thread.take().unwrap().join().unwrap();
    assert!(queued_seen.try_recv().is_err());
}
#[test]
fn workflow_worker_panicked_job_is_joined_by_owned_dispatcher_and_does_not_poison_next_job() {
    let book = OwnedBook::new(2);
    let (first, first_seen) = channel();
    let (second, second_seen) = channel();
    assert_eq!(
        book.submit(job("panic", move |_| {
            first.send(()).unwrap();
            panic!("controlled worker panic")
        })),
        Admission::Queued
    );
    first_seen.recv_timeout(Duration::from_secs(2)).unwrap();
    assert_eq!(
        book.submit(job("next", move |_| {
            second.send(()).unwrap();
            None
        })),
        Admission::Queued
    );
    second_seen.recv_timeout(Duration::from_secs(2)).unwrap();
    book.shutdown();
}
#[test]
fn workflow_worker_shutdown_is_permanent_and_never_starts_rejected_job() {
    let book = OwnedBook::new(2);
    book.shutdown();
    let (started, seen) = channel();
    assert_eq!(
        book.submit(job("late", move |_| {
            let _ = started.send(());
            None
        })),
        Admission::Retired
    );
    assert!(seen.try_recv().is_err());
}

// These fixtures exercise the actual owned queue; closures observe execution
// only. Arc identity here is process-capacity data, never native authority.
fn reservation_key(id: &str) -> ReservationKey {
    ReservationKey {
        owner: key("capacity").owner().clone(),
        occurrence: id.into(),
    }
}
fn held(book: &OwnedBook, id: &str) -> Reservation {
    match book.reserve(reservation_key(id)) {
        Reserved::Held(value) => value,
        Reserved::Observed => panic!("unexpected observed reservation"),
        Reserved::Busy => panic!("reservation unexpectedly busy"),
        Reserved::Retired => panic!("reservation unexpectedly retired"),
    }
}
#[test]
fn automatic_reservation_prevents_ordinary_job_overbooking_before_run_commit() {
    let book = OwnedBook::new(1);
    let _slot = held(&book, "occurrence");
    let (started, seen) = channel();
    assert_eq!(
        book.submit(job("ordinary", move |_| {
            let _ = started.send(());
            None
        })),
        Admission::Busy
    );
    assert!(seen.try_recv().is_err());
}
#[test]
fn abandoned_automatic_reservation_releases_exact_capacity() {
    let book = OwnedBook::new(1);
    let slot = held(&book, "rolled-back");
    drop(slot);
    let (started, seen) = channel();
    assert_eq!(
        book.submit(job("ordinary", move |_| {
            let _ = started.send(());
            None
        })),
        Admission::Queued
    );
    seen.recv_timeout(Duration::from_secs(2)).unwrap();
    book.shutdown();
}
#[test]
fn automatic_duplicate_reservation_is_observational_and_runtime_seals_are_distinct() {
    let book = OwnedBook::new(2);
    let first = held(&book, "same");
    assert!(matches!(
        book.reserve(reservation_key("same")),
        Reserved::Observed
    ));
    let other = ReservationKey {
        owner: Arc::new(()),
        occurrence: "same".into(),
    };
    let second = match book.reserve(other) {
        Reserved::Held(slot) => slot,
        _ => panic!("distinct original runtime must occupy its own slot"),
    };
    assert!(matches!(
        book.reserve(reservation_key("third")),
        Reserved::Busy
    ));
    drop(first);
    assert!(matches!(
        book.reserve(reservation_key("third")),
        Reserved::Held(_)
    ));
    drop(second);
}
#[test]
fn reserved_transfer_runs_one_actual_job_without_double_charging_its_slot() {
    let book = OwnedBook::new(1);
    let slot = held(&book, "committed");
    let (release, rx) = gate();
    let (started, seen) = channel();
    assert_eq!(
        book.submit_reserved(
            slot,
            job("actual-run", move |_| {
                let _ = started.send(());
                let _ = rx.recv();
                None
            })
        ),
        Transfer::Queued
    );
    let _release = release;
    seen.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(matches!(
        book.reserve(reservation_key("next")),
        Reserved::Busy
    ));
    assert_eq!(book.submit(job("overflow", |_| None)), Admission::Busy);
    drop(_release);
    book.shutdown();
}
#[test]
fn reservation_from_another_book_cannot_queue_or_hold_the_wrong_worker() {
    let original = OwnedBook::new(1);
    let replacement = OwnedBook::new(1);
    let slot = held(&original, "original");
    let (started, seen) = channel();
    assert_eq!(
        replacement.submit_reserved(
            slot,
            job("wrong", move |_| {
                let _ = started.send(());
                None
            })
        ),
        Transfer::Rejected
    );
    assert!(seen.try_recv().is_err());
    let _released = held(&original, "after-refusal");
    let _other = held(&replacement, "replacement");
}
#[test]
fn reservation_cannot_transfer_job_from_another_original_runtime_seal() {
    let book = OwnedBook::new(1);
    let slot = held(&book, "original");
    let (started, seen) = channel();
    let mut foreign = job("wrong-owner", move |_| {
        let _ = started.send(());
        None
    });
    foreign.key = Key::Run {
        owner: Arc::new(()),
        run: "wrong-owner".into(),
        epoch: 1,
    };
    assert_eq!(book.submit_reserved(slot, foreign), Transfer::Rejected);
    assert!(seen.try_recv().is_err());
    let _next = held(&book, "next");
}
#[test]
fn stop_invalidates_old_reservation_without_releasing_new_same_key_slot() {
    let book = OwnedBook::new(1);
    let old = held(&book, "same");
    book.stop();
    let fresh = held(&book, "same");
    let (started, seen) = channel();
    assert_eq!(
        book.submit_reserved(
            old,
            job("old", move |_| {
                let _ = started.send(());
                None
            })
        ),
        Transfer::Rejected
    );
    assert!(seen.try_recv().is_err());
    assert_eq!(book.submit(job("overflow", |_| None)), Admission::Busy);
    let (started, seen) = channel();
    assert_eq!(
        book.submit_reserved(
            fresh,
            job("new", move |_| {
                let _ = started.send(());
                None
            })
        ),
        Transfer::Queued
    );
    seen.recv_timeout(Duration::from_secs(2)).unwrap();
    book.shutdown();
}
#[test]
fn shutdown_permanently_refuses_automatic_capacity() {
    let book = OwnedBook::new(1);
    book.shutdown();
    assert!(matches!(
        book.reserve(reservation_key("late")),
        Reserved::Retired
    ));
}

// A running Sweep already owns the sole dispatcher. Holding the real handle
// mutex here models shutdown's join order without sleeping or detaching work.
#[test]
fn dispatcher_reserves_capacity_without_waiting_for_its_own_join_handle() {
    let book = OwnedBook::new(2);
    let shared = book.shared.clone();
    let (release, go) = gate();
    let (started, seen) = channel();
    let (result, done) = channel();
    assert_eq!(
        book.submit(job("sweep", move |stop| {
            let _ = started.send(());
            let _ = go.recv();
            let slot = reserve_running(&shared, &key("sweep"), stop, reservation_key("due"));
            let _ = result.send(matches!(slot, Reserved::Held(_)));
            drop(slot);
            None
        })),
        Admission::Queued
    );
    let release = release;
    seen.recv_timeout(Duration::from_secs(2)).unwrap();
    let handle = book.thread.lock().unwrap();
    drop(release);
    let immediate = done.recv_timeout(Duration::from_secs(2));
    let lock_free = immediate.is_ok();
    drop(handle);
    let accepted = immediate.or_else(|_| done.recv_timeout(Duration::from_secs(2)));
    book.shutdown();
    assert!(
        lock_free,
        "the active dispatcher must not wait for its own handle mutex"
    );
    assert!(
        accepted.unwrap(),
        "actual running sweep has one available process slot"
    );
}
#[test]
fn dispatcher_transfers_reserved_job_without_waiting_for_its_own_join_handle() {
    let book = OwnedBook::new(2);
    let slot = held(&book, "committed");
    let shared = book.shared.clone();
    let (release, go) = gate();
    let (started, seen) = channel();
    let (result, done) = channel();
    let (executed, execution) = channel();
    assert_eq!(
        book.submit(job("sweep", move |stop| {
            let _ = started.send(());
            let _ = go.recv();
            let outcome = transfer_running(
                &shared,
                &key("sweep"),
                stop,
                slot,
                job("actual-committed-run", move |_| {
                    let _ = executed.send(());
                    None
                }),
            );
            let _ = result.send(outcome);
            None
        })),
        Admission::Queued
    );
    let release = release;
    seen.recv_timeout(Duration::from_secs(2)).unwrap();
    let handle = book.thread.lock().unwrap();
    drop(release);
    let immediate = done.recv_timeout(Duration::from_secs(2));
    let lock_free = immediate.is_ok();
    drop(handle);
    let outcome = immediate.or_else(|_| done.recv_timeout(Duration::from_secs(2)));
    let ran = execution.recv_timeout(Duration::from_secs(2));
    book.shutdown();
    assert!(
        lock_free,
        "known-committed transfer cannot wait for its own join handle"
    );
    assert_eq!(outcome.unwrap(), Transfer::Queued);
    assert!(
        ran.is_ok(),
        "the existing dispatcher must execute its transferred job"
    );
}
#[test]
fn dispatcher_reservation_counts_its_running_sweep_against_capacity() {
    let book = OwnedBook::new(1);
    let shared = book.shared.clone();
    let (result, done) = channel();
    assert_eq!(
        book.submit(job("sweep", move |stop| {
            let _ = result.send(matches!(
                reserve_running(&shared, &key("sweep"), stop, reservation_key("due")),
                Reserved::Busy
            ));
            None
        })),
        Admission::Queued
    );
    let outcome = done.recv_timeout(Duration::from_secs(2));
    book.shutdown();
    assert!(outcome.unwrap());
}
#[test]
fn dispatcher_capacity_refuses_a_different_actual_running_stop_token() {
    let book = OwnedBook::new(2);
    let shared = book.shared.clone();
    let (result, done) = channel();
    assert_eq!(
        book.submit(job("sweep", move |_| {
            let foreign = AtomicBool::new(false);
            let _ = result.send(matches!(
                reserve_running(&shared, &key("sweep"), &foreign, reservation_key("due")),
                Reserved::Retired
            ));
            None
        })),
        Admission::Queued
    );
    let outcome = done.recv_timeout(Duration::from_secs(2));
    book.shutdown();
    assert!(
        outcome.unwrap(),
        "same key is not the current running dispatch identity"
    );
}
#[test]
fn dispatcher_stop_refuses_capacity_while_original_join_handle_is_retained() {
    let book = OwnedBook::new(2);
    let shared = book.shared.clone();
    let (release, go) = gate();
    let (started, seen) = channel();
    let (result, done) = channel();
    assert_eq!(
        book.submit(job("sweep", move |stop| {
            let _ = started.send(());
            let _ = go.recv();
            let _ = result.send(matches!(
                reserve_running(&shared, &key("sweep"), stop, reservation_key("due")),
                Reserved::Retired
            ));
            None
        })),
        Admission::Queued
    );
    let release = release;
    seen.recv_timeout(Duration::from_secs(2)).unwrap();
    let handle = book.thread.lock().unwrap();
    book.stop();
    drop(release);
    let immediate = done.recv_timeout(Duration::from_secs(2));
    let lock_free = immediate.is_ok();
    drop(handle);
    let outcome = immediate.or_else(|_| done.recv_timeout(Duration::from_secs(2)));
    book.shutdown();
    assert!(
        lock_free,
        "Stop cleanup cannot invert dispatcher/handle ownership"
    );
    assert!(
        outcome.unwrap(),
        "stopped running ticket cannot reserve another occurrence"
    );
}

#[test]
fn empty_first_sweep_page_releases_idle_monitor() {
    assert!(
        !sweep_has_work(None, true),
        "an ordinary vault must not retain an empty polling job"
    );
}
#[test]
fn empty_continuation_sweep_page_rechecks_first_page() {
    assert!(sweep_has_work(Some("previous-activation"), true));
    assert!(sweep_has_work(None, false));
}
