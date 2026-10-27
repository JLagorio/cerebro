//! cfg(test)-only gate at the actual owned background join. No native authority.
//! Thread-local installation cannot be selected by an IPC payload or normal build.
use crate::connections::{metadata::CredentialAcquisitionView, ConnectionError};
use std::{
    cell::RefCell,
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc::{self, Receiver, SyncSender},
        Arc, Mutex,
    },
    time::Duration,
};
type Completion = Result<CredentialAcquisitionView, ConnectionError>;
thread_local! {
    static CURRENT: RefCell<Option<Arc<Probe>>> = const { RefCell::new(None) };
}
pub(crate) struct Probe {
    fail_worker: bool,
    fail_join: bool,
    worker_launches: AtomicUsize,
    join_launches: AtomicUsize,
    ready: SyncSender<()>,
    gate: Mutex<Receiver<()>>,
    done: SyncSender<Completion>,
    worker_done: SyncSender<()>,
}
pub(crate) struct Control {
    probe: Arc<Probe>,
    release: SyncSender<()>,
    ready: Receiver<()>,
    done: Receiver<Completion>,
    worker_done: Receiver<()>,
}
impl Control {
    pub(crate) fn new(fail_worker: bool, fail_join: bool) -> Self {
        let (ready_send, ready) = mpsc::sync_channel(1);
        let (release, gate) = mpsc::sync_channel(1);
        let (done_send, done) = mpsc::sync_channel(1);
        let (worker_done_send, worker_done) = mpsc::sync_channel(1);
        Self {
            probe: Arc::new(Probe {
                fail_worker,
                fail_join,
                worker_launches: AtomicUsize::new(0),
                join_launches: AtomicUsize::new(0),
                ready: ready_send,
                gate: Mutex::new(gate),
                done: done_send,
                worker_done: worker_done_send,
            }),
            release,
            ready,
            done,
            worker_done,
        }
    }
    pub(crate) fn enter<T>(&self, work: impl FnOnce() -> T) -> T {
        struct Reset(Option<Arc<Probe>>);
        impl Drop for Reset {
            fn drop(&mut self) {
                CURRENT.with(|slot| {
                    slot.replace(self.0.take());
                });
            }
        }
        let previous = CURRENT.with(|slot| slot.replace(Some(self.probe.clone())));
        let _reset = Reset(previous);
        work()
    }
    pub(crate) fn wait_until_parked(&self) {
        self.ready
            .recv_timeout(Duration::from_secs(2))
            .expect("real worker and owned join parked");
    }
    pub(crate) fn release_and_wait(&self) -> Completion {
        self.release
            .try_send(())
            .expect("one release of owned join");
        self.done
            .recv_timeout(Duration::from_secs(2))
            .expect("owned worker join completed")
    }
    pub(crate) fn wait_worker_finished(&self) {
        self.worker_done
            .recv_timeout(Duration::from_secs(2))
            .expect("original worker finished after failed transfer");
    }
    pub(crate) fn launches(&self) -> (usize, usize) {
        (
            self.probe.worker_launches.load(Ordering::SeqCst),
            self.probe.join_launches.load(Ordering::SeqCst),
        )
    }
}
impl Drop for Control {
    fn drop(&mut self) {
        let _ = self.release.try_send(());
    }
}
impl Probe {
    pub(super) fn park(&self) {
        self.ready.try_send(()).expect("one parked observation");
        self.gate
            .lock()
            .unwrap()
            .recv_timeout(Duration::from_secs(2))
            .expect("test releases parked join");
    }
    pub(super) fn worker_finished(&self) {
        let _ = self.worker_done.try_send(());
    }
    pub(super) fn complete(&self, result: Completion) {
        let _ = self.done.try_send(result);
    }
}
pub(super) fn current() -> Option<Arc<Probe>> {
    CURRENT.with(|slot| slot.borrow().clone())
}
pub(super) fn reject_launch(name: &str) -> bool {
    current().is_some_and(|probe| match name {
        "credential-acquisition" => {
            probe.worker_launches.fetch_add(1, Ordering::SeqCst);
            probe.fail_worker
        }
        "credential-acquisition-join" => {
            probe.join_launches.fetch_add(1, Ordering::SeqCst);
            probe.fail_join
        }
        _ => panic!("unexpected credential launch boundary"),
    })
}
