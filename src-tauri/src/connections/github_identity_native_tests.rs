use super::*;
#[test]
fn real_request_builder_pins_identity_endpoint_and_sensitive_authorization() {
    let client = client().unwrap();
    let token = SecretValue::from_bytes(b"sentinel-secret".to_vec()).unwrap();
    let request = request(&client, &token).unwrap();
    assert_eq!(request.method(), reqwest::Method::GET);
    assert_eq!(request.url().as_str(), ENDPOINT);
    assert!(request.body().is_none());
    let authorization = request.headers().get(AUTHORIZATION).unwrap();
    assert!(authorization.is_sensitive());
    assert_eq!(authorization.as_bytes(), b"Bearer sentinel-secret");
    assert!(!format!("{:?}", request.headers()).contains("sentinel-secret"));
    assert_eq!(request.headers()["accept"], "application/vnd.github+json");
    assert_eq!(request.headers()["x-github-api-version"], "2022-11-28");
}
#[test]
fn cancelled_native_reader_exits_before_client_runtime_or_network_work() {
    let token = SecretValue::from_bytes(b"sentinel-secret".to_vec()).unwrap();
    assert_eq!(
        NativeTransport.current_user(&token, &|| true).err(),
        Some(ConnectionError::Cancelled)
    );
}

// No HTTP server/client, credentials, subprocess, Keychain or task spawn. The
// operation itself opens the fake deadline only after it has really been polled.
use std::{
    future::Future,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    task::{Context, Poll, Waker},
};
#[derive(Clone, Default)]
struct OperationWitness {
    polled: Arc<AtomicBool>,
    dropped: Arc<AtomicBool>,
}
struct PendingOperation {
    witness: OperationWitness,
    on_poll: Option<Box<dyn FnOnce()>>,
}
impl Future for PendingOperation {
    type Output = Result<(), ConnectionError>;
    fn poll(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Self::Output> {
        let operation = self.get_mut();
        operation.witness.polled.store(true, Ordering::SeqCst);
        if let Some(on_poll) = operation.on_poll.take() {
            on_poll();
        }
        Poll::Pending
    }
}
impl Drop for PendingOperation {
    fn drop(&mut self) {
        self.witness.dropped.store(true, Ordering::SeqCst);
    }
}
#[derive(Clone, Default)]
struct ManualDeadline {
    open: Arc<AtomicBool>,
    waiter: Arc<Mutex<Option<Waker>>>,
}
impl ManualDeadline {
    fn expire(&self) {
        self.open.store(true, Ordering::SeqCst);
        if let Some(waiter) = self.waiter.lock().unwrap().take() {
            waiter.wake();
        }
    }
}
impl Future for ManualDeadline {
    type Output = ();
    fn poll(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<()> {
        if self.open.load(Ordering::SeqCst) {
            return Poll::Ready(());
        }
        *self.waiter.lock().unwrap() = Some(context.waker().clone());
        if self.open.load(Ordering::SeqCst) {
            Poll::Ready(())
        } else {
            Poll::Pending
        }
    }
}
#[test]
fn pending_owned_transport_is_dropped_when_original_cancellation_arrives() {
    let witness = OperationWitness::default();
    let stopped = Arc::new(AtomicBool::new(false));
    let on_poll = stopped.clone();
    let operation = PendingOperation {
        witness: witness.clone(),
        on_poll: Some(Box::new(move || on_poll.store(true, Ordering::SeqCst))),
    };
    let result =
        tauri::async_runtime::block_on(await_owned(operation, std::future::pending(), &|| {
            stopped.load(Ordering::SeqCst)
        }));
    assert_eq!(result, Err(ConnectionError::Cancelled));
    assert!(witness.polled.load(Ordering::SeqCst));
    assert!(
        witness.dropped.load(Ordering::SeqCst),
        "no owned request survives the cancellation result"
    );
}
#[test]
fn pending_owned_transport_is_dropped_when_its_deadline_expires() {
    let witness = OperationWitness::default();
    let deadline = ManualDeadline::default();
    let on_poll = deadline.clone();
    let operation = PendingOperation {
        witness: witness.clone(),
        on_poll: Some(Box::new(move || on_poll.expire())),
    };
    let result = tauri::async_runtime::block_on(await_owned(operation, deadline, &|| false));
    assert_eq!(result, Err(ConnectionError::Unavailable));
    assert!(
        witness.polled.load(Ordering::SeqCst),
        "deadline opens only after the operation is pending"
    );
    assert!(
        witness.dropped.load(Ordering::SeqCst),
        "no owned request survives the deadline result"
    );
}
#[test]
fn cancelled_owned_transport_is_dropped_without_polling_and_completion_cannot_race_cancel_to_success(
) {
    let witness = OperationWitness::default();
    let operation = PendingOperation {
        witness: witness.clone(),
        on_poll: None,
    };
    let result =
        tauri::async_runtime::block_on(await_owned(operation, std::future::pending(), &|| true));
    assert_eq!(result, Err(ConnectionError::Cancelled));
    assert!(!witness.polled.load(Ordering::SeqCst));
    assert!(witness.dropped.load(Ordering::SeqCst));
    let stopped = AtomicBool::new(false);
    let result = tauri::async_runtime::block_on(await_owned(
        async {
            stopped.store(true, Ordering::SeqCst);
            Ok::<_, ConnectionError>(())
        },
        std::future::pending(),
        &|| stopped.load(Ordering::SeqCst),
    ));
    assert_eq!(result, Err(ConnectionError::Cancelled));
}
#[test]
fn owned_transport_completion_preserves_result_without_waiting_for_deadline() {
    let result = tauri::async_runtime::block_on(await_owned(
        async { Ok::<_, ConnectionError>(7) },
        std::future::pending(),
        &|| false,
    ));
    assert_eq!(result, Ok(7));
    let result = tauri::async_runtime::block_on(await_owned(
        async { Err::<(), _>(ConnectionError::SignInRequired) },
        std::future::pending(),
        &|| false,
    ));
    assert_eq!(result, Err(ConnectionError::SignInRequired));
}
