//! Explicit offline observer of the existing M96 broker and deterministic provider.
//! Root registers this file under actions only in cfg(test); it activates no app route.
use super::{service::test_support::Harness, types::*};
use crate::native_producer_identity as producer_identity;
use serde_json::json;
use std::{fs, io::Write, path::PathBuf};

#[test]
#[ignore = "explicit offline outcome capture; requires a new report path in an empty disposable directory"]
fn record_lost_response() {
    let native_inputs = producer_identity::native_input_identity();
    // Existing harness overrides are deliberately refused: this test must never
    // reuse a caller's database or a process gate that can cause outside effects.
    for key in ["CEREBRO_ACTION_TEST_DIR", "CEREBRO_ACTION_PROCESS_GATE"] {
        assert!(
            std::env::var_os(key).is_none(),
            "fixture override is not permitted"
        );
    }
    let output = PathBuf::from(
        std::env::var_os("CEREBRO_OUTCOMES_NATIVE_OUT")
            .expect("CEREBRO_OUTCOMES_NATIVE_OUT must name a new disposable report file"),
    );
    assert!(output.is_absolute(), "report path must be absolute");
    assert!(!output.exists(), "report file must be new");
    let parent = output.parent().expect("report needs a parent directory");
    assert!(parent.is_dir(), "create the disposable directory first");
    assert_eq!(
        fs::canonicalize(parent).unwrap(),
        parent,
        "report parent must be canonical"
    );
    assert!(
        fs::read_dir(parent).unwrap().next().is_none(),
        "report directory must be empty"
    );
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&output)
        .expect("reserve a new report file");

    let h = Harness::new("m97-outcome-lost-response");
    h.set_observation("unknown");
    let prepared = h
        .prepare("m97-lost-response", "Synthetic outcome fixture")
        .unwrap();
    let id = prepared.effect.invocation_id;
    h.allow(&id).unwrap();
    let before = h.service().dispatch(id.clone()).unwrap();
    h.recover();
    let retry = h.retry(&id, false);
    let retry_refusal = retry.as_ref().err().map(|error| error.code);
    // A successful remote observation may settle the same spent claim; it must
    // not spend a second provider submission merely because the reply was lost.
    h.set_observation("reconciled");
    let revision = h.details(&id).revision.get();
    let after = h
        .service()
        .reconcile(h.subject(), id.clone(), revision)
        .unwrap();
    let details = h.details(&id);
    let attempts = h.attempts();
    let submissions = h.submissions();
    assert_eq!(before.state, InvocationState::OutcomeUnknown);
    assert!(
        retry.is_err(),
        "unknown outcome must not automatically retry"
    );
    assert_eq!(after.state, InvocationState::Succeeded);
    assert_eq!(attempts, 1);
    assert_eq!(submissions, 1);
    assert!(details
        .attempts
        .last()
        .unwrap()
        .remote_effect_reference
        .is_some());

    let report = json!({
        "version":1,
        "scenario":"lost-response",
        "producer":"actions::service::test_support::Harness",
        "observedAt":crate::runtime::now_utc(),
        "clock":"wall_clock_not_injected",
        "nativeInputs":native_inputs,
        "broker":{
            "stateBefore":before.state,"stateAfter":after.state,
            "submissions":submissions,"attempts":attempts,
            "retryAcknowledged":false,"retryRefusal":retry_refusal,
            "producer":"actions::service::test_support::Harness"
        },
        "effects":[{"kind":"external_mutation","target":"fixture:issue-create","actor":"human:fixture"}],
        "artifacts":[{"id":"broker:lost-response","state":after.state}],
        "limits":["Synthetic provider, not a real account.","Native broker clock is observed wall time.","Complete declared repository code, shared, fixture and dependency-lock inputs are compiled into the identity; actual toolchain, Cargo cache contents, environment, OS and system dependencies are not recorded.","Bundled demo-vault and other packaging resources are outside this offline broker input scope.","No mail draft or connector auth repair is claimed."]
    });
    let bytes = serde_json::to_vec_pretty(&report).unwrap();
    assert!(bytes.len() <= 65536, "native observation exceeds its cap");
    file.write_all(&bytes).unwrap();
    file.write_all(b"\n").unwrap();
    file.sync_all().unwrap();
    fs::remove_dir_all(h.dir()).unwrap();
}
