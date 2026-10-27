//! Actual Tokio children, no socket, DNS, provider, or secret access.
use super::*;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc, Mutex,
};

struct Completion(Arc<AtomicBool>);
impl Drop for Completion {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}
#[derive(Default)]
struct ChildCleanup(Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>);
impl ChildCleanup {
    fn settle(&mut self) {
        let child = self.0.lock().unwrap().take();
        if let Some(child) = child {
            child.abort();
            // These fake children have no unbounded work. The blocking case's
            // release guard opens its gate before this join, including unwind.
            let _ = tauri::async_runtime::block_on(child);
        }
    }
}
impl Drop for ChildCleanup {
    fn drop(&mut self) {
        self.settle();
    }
}

#[test]
fn owned_runtime_drops_a_started_async_child_before_returning_cancelled_outcome() {
    let completed = Arc::new(AtomicBool::new(false));
    let cancelled = Arc::new(AtomicBool::new(false));
    let mut cleanup = ChildCleanup::default();
    let children = cleanup.0.clone();
    let child_completed = completed.clone();
    let request_cancel = cancelled.clone();
    let observed = with_owned_runtime(move || async move {
        let (started, ready) = tokio::sync::oneshot::channel();
        let child = tokio::spawn(async move {
            let _completion = Completion(child_completed);
            let _ = started.send(());
            std::future::pending::<()>().await;
        });
        *children.lock().unwrap() = Some(child);
        tokio::time::timeout(Duration::from_secs(5), ready)
            .await
            .unwrap()
            .unwrap();
        // Actual child has been polled before the request becomes cancellable.
        await_owned(
            async {
                request_cancel.store(true, Ordering::SeqCst);
                std::future::pending::<IssueOutcome>().await
            },
            std::future::pending(),
            &|| cancelled.load(Ordering::SeqCst),
        )
        .await
    });
    let completed_at_return = completed.load(Ordering::SeqCst);
    cleanup.settle();
    assert_eq!(
        observed,
        Ok(TransportOutcome::Observed(IssueOutcome::Unknown))
    );
    assert!(
        completed_at_return,
        "transport returned before its started async child was dropped"
    );
}

// A test controller releases the fake resolver only after the outer operation
// has ended and it has checked whether the transport prematurely returned.
// Drop releases every gate and joins the controller before joining the child,
// including failed assertions and panics in work/runtime construction.
struct BlockingCleanup {
    release: mpsc::Sender<()>,
    outer_done: mpsc::Sender<()>,
    returned: mpsc::Sender<()>,
    controller: Option<std::thread::JoinHandle<bool>>,
    child: ChildCleanup,
}
impl BlockingCleanup {
    fn join_controller(&mut self) -> bool {
        self.controller.take().unwrap().join().unwrap()
    }
}
impl Drop for BlockingCleanup {
    fn drop(&mut self) {
        let _ = self.release.send(());
        let _ = self.outer_done.send(());
        let _ = self.returned.send(());
        if let Some(controller) = self.controller.take() {
            let _ = controller.join();
        }
        self.child.settle();
    }
}
struct ReleaseOnDrop(mpsc::Sender<()>);
impl Drop for ReleaseOnDrop {
    fn drop(&mut self) {
        let _ = self.0.send(());
    }
}

#[test]
fn owned_runtime_waits_for_started_blocking_child_before_returning_cancelled_outcome() {
    let (release, released) = mpsc::channel();
    let (outer_done, outer_ended) = mpsc::channel();
    let (returned, return_observed) = mpsc::channel();
    let controller_release = release.clone();
    let controller = std::thread::spawn(move || {
        let _release = ReleaseOnDrop(controller_release);
        // Timeouts are bounded failure guards; ordering uses channel handshakes.
        outer_ended.recv_timeout(Duration::from_secs(5)).unwrap();
        match return_observed.recv_timeout(Duration::from_secs(2)) {
            Ok(()) => true,
            Err(mpsc::RecvTimeoutError::Timeout) => false,
            Err(mpsc::RecvTimeoutError::Disconnected) => panic!("return witness disconnected"),
        }
    });
    let mut cleanup = BlockingCleanup {
        release,
        outer_done: outer_done.clone(),
        returned,
        controller: Some(controller),
        child: ChildCleanup::default(),
    };
    let completed = Arc::new(AtomicBool::new(false));
    let child_completed = completed.clone();
    let children = cleanup.child.0.clone();
    let cancelled = Arc::new(AtomicBool::new(false));
    let request_cancel = cancelled.clone();
    let observed = with_owned_runtime(move || async move {
        let (started, ready) = tokio::sync::oneshot::channel();
        let child = tokio::task::spawn_blocking(move || {
            let _completion = Completion(child_completed);
            let _ = started.send(());
            // Only a test-controlled gate, never real DNS or unbounded I/O.
            released.recv_timeout(Duration::from_secs(10)).unwrap();
        });
        *children.lock().unwrap() = Some(child);
        tokio::time::timeout(Duration::from_secs(5), ready)
            .await
            .unwrap()
            .unwrap();
        let outcome = await_owned(
            async {
                request_cancel.store(true, Ordering::SeqCst);
                std::future::pending::<IssueOutcome>().await
            },
            std::future::pending(),
            &|| cancelled.load(Ordering::SeqCst),
        )
        .await;
        let _ = outer_done.send(());
        outcome
    });
    let completed_at_return = completed.load(Ordering::SeqCst);
    let _ = cleanup.returned.send(());
    let returned_early = cleanup.join_controller();
    cleanup.child.settle();
    assert_eq!(
        observed,
        Ok(TransportOutcome::Observed(IssueOutcome::Unknown))
    );
    assert!(
        !returned_early,
        "transport returned while its started blocking child still held the gate"
    );
    assert!(
        completed_at_return,
        "transport returned before actual blocking child completion"
    );
}
