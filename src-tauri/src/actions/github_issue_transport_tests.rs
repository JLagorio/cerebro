use super::*;
use crate::actions::{catalog::ActionCatalog, effect_types::DefinitionMaterial};
use reqwest::header::{HeaderValue, AUTHORIZATION, CONTENT_ENCODING, CONTENT_LENGTH, CONTENT_TYPE};
use std::{
    future::Future,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    task::{Context, Poll, Waker},
};
fn plan(create: bool) -> IssuePlan {
    let source: serde_json::Value = serde_json::from_str(include_str!(
        "../../../shared/actions/github-issues.v1.json"
    ))
    .unwrap();
    let material: DefinitionMaterial =
        serde_json::from_value(source["definitions"][usize::from(create)].clone()).unwrap();
    let definition = ActionCatalog::default().insert(material, "{}").unwrap();
    super::super::prepare(
        &definition,
        if create {
            r#"{"repository":"owner/repo","title":"Native title","body":"One\n\nTwo"}"#
        } else {
            r#"{"repository":"owner/repo","number":42}"#
        },
    )
    .unwrap()
}
fn body() -> Vec<u8> {
    br#"{"id":9007199254740993,"number":42,"title":"Native title","body":"One\n\nTwo","repository_url":"https://api.github.com/repos/owner/repo","html_url":"https://github.com/owner/repo/issues/42"}"#.to_vec()
}
fn headers() -> HeaderMap {
    let mut h = HeaderMap::new();
    h.insert(
        CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    h
}
#[test]
fn real_request_builder_uses_checked_method_url_body_and_sensitive_authorization() {
    let c = client().unwrap();
    let token = SecretValue::from_bytes(b"fake-transport-secret".to_vec()).unwrap();
    for create in [false, true] {
        let plan = plan(create);
        let req = request(&c, &plan, &token).expect("checked plan becomes native request");
        assert_eq!(req.url().as_str(), plan.endpoint);
        assert_eq!(req.method().as_str(), plan.method);
        assert_eq!(
            req.body().and_then(|v| v.as_bytes()),
            plan.body.as_ref().map(|v| v.as_bytes())
        );
        assert_eq!(req.headers()["accept"], "application/vnd.github+json");
        assert_eq!(req.headers()["x-github-api-version"], "2022-11-28");
        assert!(req.headers()[AUTHORIZATION].is_sensitive());
        assert!(!format!("{:?}", req.headers()).contains("fake-transport-secret"));
        assert_eq!(
            req.headers()[AUTHORIZATION].as_bytes(),
            b"Bearer fake-transport-secret"
        );
        if create {
            assert_eq!(req.headers()[CONTENT_TYPE], "application/json");
        }
    }
}
#[test]
fn invalid_authorization_never_becomes_a_request() {
    let token = SecretValue::from_bytes(b"fake\r\nX-Injected: yes".to_vec()).unwrap();
    assert!(request(&client().unwrap(), &plan(true), &token).is_err());
}
#[test]
fn exact_framed_success_and_documented_refusal_reach_the_real_semantic_adapter() {
    let plan = plan(true);
    let body = body();
    let mut h = headers();
    h.insert(
        CONTENT_LENGTH,
        HeaderValue::from_str(&body.len().to_string()).unwrap(),
    );
    assert!(matches!(
        checked_response(&plan, 201, &h, &body),
        IssueOutcome::Succeeded { .. }
    ));
    assert_eq!(
        checked_response(&plan, 403, &HeaderMap::new(), b"ignored secret diagnostic"),
        IssueOutcome::NotApplied
    );
}
#[test]
fn ambiguous_framing_encoding_length_and_limits_never_prove_success() {
    let plan = plan(true);
    let body = body();
    for case in 0..8 {
        let mut h = headers();
        match case {
            0 => {
                h.append(CONTENT_TYPE, HeaderValue::from_static("application/json"));
            }
            1 => {
                h.insert(CONTENT_LENGTH, HeaderValue::from_static("1"));
            }
            2 => {
                h.insert(CONTENT_LENGTH, HeaderValue::from_static("+1"));
            }
            3 => {
                h.insert(CONTENT_ENCODING, HeaderValue::from_static("gzip"));
            }
            4 => {
                h.insert(CONTENT_LENGTH, HeaderValue::from_static("65537"));
            }
            5 => {
                h.insert("transfer-encoding", HeaderValue::from_static("chunked"));
                h.insert(
                    CONTENT_LENGTH,
                    HeaderValue::from_str(&body.len().to_string()).unwrap(),
                );
            }
            6 => {
                h.insert(CONTENT_TYPE, HeaderValue::from_static("text/html"));
            }
            7 => {
                h.insert(
                    "x-oversized",
                    HeaderValue::from_str(&"x".repeat(16_385)).unwrap(),
                );
            }
            _ => unreachable!(),
        }
        assert_eq!(
            checked_response(&plan, 201, &h, &body),
            IssueOutcome::Unknown,
            "case {case}"
        );
    }
}
#[derive(Clone, Default)]
struct Witness {
    polled: Arc<AtomicBool>,
    dropped: Arc<AtomicBool>,
}
struct Pending {
    witness: Witness,
    on_poll: Option<Box<dyn FnOnce()>>,
}
impl Future for Pending {
    type Output = IssueOutcome;
    fn poll(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Self::Output> {
        let x = self.get_mut();
        x.witness.polled.store(true, Ordering::SeqCst);
        if let Some(f) = x.on_poll.take() {
            f();
        }
        Poll::Pending
    }
}
impl Drop for Pending {
    fn drop(&mut self) {
        self.witness.dropped.store(true, Ordering::SeqCst);
    }
}
#[derive(Clone, Default)]
struct Deadline {
    open: Arc<AtomicBool>,
    waker: Arc<Mutex<Option<Waker>>>,
}
impl Deadline {
    fn expire(&self) {
        self.open.store(true, Ordering::SeqCst);
        if let Some(w) = self.waker.lock().unwrap().take() {
            w.wake();
        }
    }
}
impl Future for Deadline {
    type Output = ();
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
        if self.open.load(Ordering::SeqCst) {
            Poll::Ready(())
        } else {
            *self.waker.lock().unwrap() = Some(cx.waker().clone());
            Poll::Pending
        }
    }
}
fn observed() -> IssueOutcome {
    IssueOutcome::Succeeded {
        output: "{}".into(),
        remote_reference: "https://github.com/owner/repo/issues/42".into(),
    }
}
#[test]
fn cancellation_before_first_poll_drops_request_without_submission() {
    let w = Witness::default();
    let p = Pending {
        witness: w.clone(),
        on_poll: None,
    };
    assert_eq!(
        tauri::async_runtime::block_on(await_owned(p, std::future::pending(), &|| true)),
        TransportOutcome::NotSubmitted
    );
    assert!(!w.polled.load(Ordering::SeqCst));
    assert!(w.dropped.load(Ordering::SeqCst));
}
#[test]
fn already_elapsed_deadline_does_not_poll_a_new_request() {
    let w = Witness::default();
    let p = Pending {
        witness: w.clone(),
        on_poll: None,
    };
    assert_eq!(
        tauri::async_runtime::block_on(await_owned(p, std::future::ready(()), &|| false)),
        TransportOutcome::NotSubmitted
    );
    assert!(!w.polled.load(Ordering::SeqCst));
    assert!(w.dropped.load(Ordering::SeqCst));
}
#[test]
fn pending_request_cancellation_returns_unknown_only_after_owned_future_is_dropped() {
    let w = Witness::default();
    let cancel = Arc::new(AtomicBool::new(false));
    let flag = cancel.clone();
    let p = Pending {
        witness: w.clone(),
        on_poll: Some(Box::new(move || flag.store(true, Ordering::SeqCst))),
    };
    assert_eq!(
        tauri::async_runtime::block_on(
            await_owned(p, std::future::pending(), &|| cancel.load(Ordering::SeqCst))
        ),
        TransportOutcome::Observed(IssueOutcome::Unknown)
    );
    assert!(w.polled.load(Ordering::SeqCst));
    assert!(w.dropped.load(Ordering::SeqCst));
}
#[test]
fn pending_request_deadline_returns_unknown_after_owned_future_is_dropped() {
    let w = Witness::default();
    let deadline = Deadline::default();
    let trigger = deadline.clone();
    let p = Pending {
        witness: w.clone(),
        on_poll: Some(Box::new(move || trigger.expire())),
    };
    assert_eq!(
        tauri::async_runtime::block_on(await_owned(p, deadline, &|| false)),
        TransportOutcome::Observed(IssueOutcome::Unknown)
    );
    assert!(w.polled.load(Ordering::SeqCst));
    assert!(w.dropped.load(Ordering::SeqCst));
}
#[test]
fn validated_completion_preserves_observed_fact_when_cancellation_arrives_in_its_final_poll() {
    for outcome in [observed(), IssueOutcome::NotApplied] {
        let cancel = AtomicBool::new(false);
        let expected = format!("{outcome:?}");
        let result = tauri::async_runtime::block_on(await_owned(
            async {
                cancel.store(true, Ordering::SeqCst);
                outcome
            },
            std::future::pending(),
            &|| cancel.load(Ordering::SeqCst),
        ));
        let TransportOutcome::Observed(result) = result else {
            panic!("lost observed effect")
        };
        assert_eq!(format!("{result:?}"), expected);
    }
}
#[test]
fn validated_completion_preserves_success_when_deadline_opens_in_its_final_poll() {
    let deadline = Deadline::default();
    let trigger = deadline.clone();
    let result = tauri::async_runtime::block_on(await_owned(
        async {
            trigger.expire();
            observed()
        },
        deadline,
        &|| false,
    ));
    assert_eq!(result, TransportOutcome::Observed(observed()));
}

#[test]
fn critical_duplicate_or_non_decimal_length_is_unknown_even_for_status_only_rejection() {
    for status in [201, 403] {
        for case in 0..6 {
            let mut h = headers();
            match case {
                0 => {
                    h.append(CONTENT_LENGTH, HeaderValue::from_static("2"));
                    h.append(CONTENT_LENGTH, HeaderValue::from_static("2"));
                }
                1 => {
                    h.append(CONTENT_LENGTH, HeaderValue::from_static("2"));
                    h.append(CONTENT_LENGTH, HeaderValue::from_static("3"));
                }
                2 => {
                    h.append(CONTENT_ENCODING, HeaderValue::from_static("identity"));
                    h.append(CONTENT_ENCODING, HeaderValue::from_static("gzip"));
                }
                3 => {
                    h.insert(CONTENT_LENGTH, HeaderValue::from_static("2, 2"));
                }
                4 => {
                    h.insert(
                        CONTENT_LENGTH,
                        HeaderValue::from_static("184467440737095516160"),
                    );
                }
                5 => {
                    h.insert(CONTENT_LENGTH, HeaderValue::from_static("2x"));
                }
                _ => unreachable!(),
            }
            assert_eq!(
                checked_response(&plan(true), status, &h, &body()),
                IssueOutcome::Unknown,
                "status {status}, case {case}"
            );
        }
    }
}
#[test]
fn header_count_is_bounded_independently_of_header_bytes() {
    let mut h = headers();
    for n in 0..63 {
        h.insert(
            format!("x-test-{n}")
                .parse::<reqwest::header::HeaderName>()
                .unwrap(),
            HeaderValue::from_static("a"),
        );
    }
    assert!(matches!(
        checked_response(&plan(true), 201, &h, &body()),
        IssueOutcome::Succeeded { .. }
    ));
    h.insert("x-over-count", HeaderValue::from_static("a"));
    assert_eq!(
        checked_response(&plan(true), 201, &h, &body()),
        IssueOutcome::Unknown
    );
}
#[test]
fn chunked_success_without_length_and_exact_length_have_the_same_observed_result() {
    let mut h = headers();
    h.insert("transfer-encoding", HeaderValue::from_static("chunked"));
    let chunked = checked_response(&plan(true), 201, &h, &body());
    h.remove("transfer-encoding");
    h.insert(
        CONTENT_LENGTH,
        HeaderValue::from_str(&body().len().to_string()).unwrap(),
    );
    assert!(matches!(&chunked, IssueOutcome::Succeeded { .. }));
    assert_eq!(chunked, checked_response(&plan(true), 201, &h, &body()));
}
