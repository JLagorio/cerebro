//! Restart never interprets a spent dispatch claim as permission to resubmit.

#[cfg(test)]
mod tests {
    use super::super::service::test_support::*;
    use super::super::types::*;
    #[test]
    fn crash_boundaries_reopen_without_resubmission() {
        let cases: serde_json::Value =
            serde_json::from_str(include_str!("../../fixtures/action-recovery-cases.json"))
                .unwrap();
        for case in cases.as_array().unwrap() {
            let h = Harness::new(case["boundary"].as_str().unwrap());
            let p = h.prepare("durable-request", "first").unwrap();
            let id = p.effect.invocation_id;
            match case["boundary"].as_str().unwrap() {
                "after_prepare" => {}
                "after_allow" => {
                    h.allow(&id).unwrap();
                }
                "after_claim" | "after_response_before_receipt" => {
                    h.allow(&id).unwrap();
                    h.claim_without_receipt(&id);
                }
                _ => unreachable!(),
            }
            h.recover();
            let replay = h.prepare("durable-request", "first").unwrap();
            assert_eq!(replay.effect.invocation_id, id);
            assert_eq!(
                serde_json::to_value(replay.effect.state).unwrap(),
                case["state"]
            );
            assert_eq!(h.invocations(), 1);
            assert_eq!(h.submissions(), 0);
        }
    }
    #[test]
    fn fresh_run_cannot_bypass_unknown_effect_fence() {
        let h = Harness::new("recovery-fence");
        let p = h.prepare("request", "first").unwrap();
        h.allow(&p.effect.invocation_id).unwrap();
        h.claim_without_receipt(&p.effect.invocation_id);
        h.recover();
        assert!(h.prepare_other_run("fresh-key", "different-input").is_err());
        assert_eq!(
            h.prepare("request", "first").unwrap().effect.invocation_id,
            p.effect.invocation_id
        );
        assert_eq!(h.invocations(), 1);
    }
    #[test]
    fn cancel_after_dispatch_is_intent() {
        let h = Harness::new("recovery-cancel");
        let p = h.prepare("request", "first").unwrap();
        h.allow(&p.effect.invocation_id).unwrap();
        h.claim_without_receipt(&p.effect.invocation_id);
        let state = h.cancel(&p.effect.invocation_id).unwrap().state;
        assert_eq!(state, InvocationState::Dispatched);
        h.recover();
        assert_eq!(
            h.details(&p.effect.invocation_id).effect.state,
            InvocationState::OutcomeUnknown
        );
    }
    #[test]
    fn confirmed_non_submission_can_cancel() {
        let h = Harness::new("recovery-cancel-before");
        let p = h.prepare("request", "first").unwrap();
        assert_eq!(
            h.cancel(&p.effect.invocation_id).unwrap().state,
            InvocationState::Cancelled
        );
        assert!(h.service().dispatch(p.effect.invocation_id).is_err());
        assert_eq!(h.attempts(), 0);
    }
    #[test]
    fn unknown_effect_survives_thread_deletion() {
        let h = Harness::new("recovery-thread-delete");
        let p = h.prepare("request", "first").unwrap();
        h.allow(&p.effect.invocation_id).unwrap();
        h.claim_without_receipt(&p.effect.invocation_id);
        h.delete_parent();
        h.recover();
        assert_eq!(
            h.details(&p.effect.invocation_id).effect.state,
            InvocationState::OutcomeUnknown
        );
        assert!(!h.details(&p.effect.invocation_id).effect.can_retry);
    }
    #[test]
    fn invalid_response_keeps_outcome_unknown() {
        let h = Harness::new("recovery-invalid-output");
        h.set_observation("invalid");
        let p = h.prepare("request", "first").unwrap();
        h.allow(&p.effect.invocation_id).unwrap();
        assert_eq!(
            h.service().dispatch(p.effect.invocation_id).unwrap().state,
            InvocationState::OutcomeUnknown
        );
        assert_eq!(h.submissions(), 1);
    } // The child terminates without unwinding. SQLite WAL/transactions and the
      // durable provider fixture are reopened by the parent, not mocked callbacks.
    #[test]
    fn stopped_process_recovers_each_durable_boundary() {
        if let Ok(boundary) = std::env::var("CEREBRO_ACTION_CHILD_BOUNDARY") {
            let h = Harness::new("process-stop");
            let p = h.prepare("process-request", "first").unwrap();
            if boundary != "action-prepared" {
                h.allow(&p.effect.invocation_id).unwrap();
            }
            if !matches!(boundary.as_str(), "action-prepared" | "action-approved") {
                h.service().dispatch(p.effect.invocation_id).unwrap();
            }
            panic!("child missed stop boundary");
        }
        for (boundary, want, submissions) in [
            ("action-prepared", InvocationState::AwaitingApproval, 0),
            ("action-approved", InvocationState::Ready, 0),
            ("action-claimed", InvocationState::OutcomeUnknown, 0),
            (
                "action-response-before-receipt",
                InvocationState::OutcomeUnknown,
                1,
            ),
        ] {
            let h = Harness::new(boundary);
            let output = crate::spawn::command(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "actions::recovery::tests::stopped_process_recovers_each_durable_boundary",
                    "--nocapture",
                ])
                .env("CEREBRO_ACTION_TEST_DIR", h.dir())
                .env("CEREBRO_ACTION_CHILD_BOUNDARY", boundary)
                .env("CEREBRO_STOP_POINT", boundary)
                .output()
                .unwrap();
            assert_eq!(
                output.status.code(),
                Some(86),
                "{boundary}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            h.recover();
            let replay = h.prepare("process-request", "first").unwrap();
            assert_eq!(replay.effect.state, want, "{boundary}");
            assert_eq!(h.invocations(), 1);
            assert_eq!(h.submissions(), submissions);
            if want == InvocationState::OutcomeUnknown {
                assert_eq!(
                    h.service()
                        .dispatch(replay.effect.invocation_id)
                        .unwrap()
                        .state,
                    InvocationState::OutcomeUnknown
                );
                assert_eq!(h.submissions(), submissions);
            }
        }
    }

    #[test]
    fn same_provider_identity_on_another_binding_cannot_bypass_unknown_fence() {
        let h = Harness::new("recovery-alias-fence");
        let p = h.prepare("request", "first").unwrap();
        h.allow(&p.effect.invocation_id).unwrap();
        h.claim_without_receipt(&p.effect.invocation_id);
        h.recover();
        assert_eq!(
            h.prepare_alias_account().unwrap_err().code,
            ActionErrorCode::Denied
        );
        assert_eq!(h.invocations(), 1);
    }
    #[test]
    fn malformed_response_retains_confirmed_remote_identity() {
        let h = Harness::new("recovery-reference");
        h.set_observation("invalid-with-reference");
        let p = h.prepare("request", "first").unwrap();
        h.allow(&p.effect.invocation_id).unwrap();
        let result = h
            .service()
            .dispatch(p.effect.invocation_id.clone())
            .unwrap();
        assert_eq!(result.state, InvocationState::OutcomeUnknown);
        assert_eq!(
            h.details(&p.effect.invocation_id).attempts[0]
                .remote_effect_reference
                .as_deref(),
            Some("fixture-effect:42")
        );
    }
    #[test]
    fn reconcile_can_confirm_a_previously_unknown_effect() {
        let h = Harness::new("recovery-reconcile");
        let p = h.prepare("request", "first").unwrap();
        h.allow(&p.effect.invocation_id).unwrap();
        h.claim_without_receipt(&p.effect.invocation_id);
        h.recover();
        h.set_observation("reconciled");
        let details = h.details(&p.effect.invocation_id);
        let effect = h
            .service()
            .reconcile(
                h.subject(),
                p.effect.invocation_id.clone(),
                details.revision.get(),
            )
            .unwrap();
        assert_eq!(effect.state, InvocationState::Succeeded);
        assert_eq!(h.attempts(), 1);
        assert_eq!(h.submissions(), 0);
    }
    #[test]
    fn cancellation_needs_confirmed_non_application_after_claim() {
        let h = Harness::new("recovery-confirmed-cancel");
        let p = h.prepare("request", "first").unwrap();
        h.allow(&p.effect.invocation_id).unwrap();
        h.claim_without_receipt(&p.effect.invocation_id);
        h.set_observation("cancel-confirmed");
        assert_eq!(
            h.cancel(&p.effect.invocation_id).unwrap().state,
            InvocationState::Cancelled
        );
        assert_eq!(h.submissions(), 0);
        assert_eq!(h.attempts(), 1);
    }
    #[test]
    fn durable_request_key_recovers_original_ids_after_live_catalog_retirement() {
        let h = Harness::new("recovery-retired-catalog");
        let p = h.prepare("request", "first").unwrap();
        h.allow(&p.effect.invocation_id).unwrap();
        h.claim_without_receipt(&p.effect.invocation_id);
        h.recover();
        let replay = h.replay_without_catalog("request", "first").unwrap();
        assert_eq!(replay.effect.invocation_id, p.effect.invocation_id);
        assert_eq!(replay.approval_id, p.approval_id);
        assert_eq!(replay.effect.state, InvocationState::OutcomeUnknown);
        assert_eq!(h.invocations(), 1);
    }
    #[test]
    fn changed_request_conflicts_even_after_live_catalog_retirement() {
        let h = Harness::new("recovery-retired-catalog-conflict");
        h.prepare("request", "first").unwrap();
        assert_eq!(
            h.replay_without_catalog("request", "second")
                .unwrap_err()
                .code,
            ActionErrorCode::RequestKeyConflict
        );
        assert_eq!(h.invocations(), 1);
    }
    fn negative_settlement_cannot_close_live_submission(cancel: bool) {
        let h = Harness::new(if cancel {
            "repair-live-cancel"
        } else {
            "repair-live-reconcile"
        });
        let p = h.prepare("request", "first").unwrap();
        let id = p.effect.invocation_id;
        h.allow(&id).unwrap();
        h.set_observation(if cancel {
            "cancel-confirmed"
        } else {
            "not-applied"
        });
        let (dispatch, entered, resume) = h.paused_submission_service();
        let worker_id = id.clone();
        let worker = std::thread::spawn(move || dispatch.dispatch(worker_id));
        entered
            .recv_timeout(std::time::Duration::from_secs(10))
            .expect("dispatch reaches its durable claim before outside submission");
        assert_eq!(h.submissions(), 0);
        let independent = h.service();
        let revision = h.details(&id).revision.get();
        let disposition = if cancel {
            independent.request_cancel(h.subject(), id.clone(), revision)
        } else {
            independent.reconcile(h.subject(), id.clone(), revision)
        };
        let replacement = h.prepare("replacement", "second");
        if let Ok(ref next) = replacement {
            h.allow(&next.effect.invocation_id).unwrap();
            let _ = h.service().dispatch(next.effect.invocation_id.clone());
        }
        resume.wait();
        let dispatch_result = worker.join().unwrap();
        assert!(disposition.as_ref().map_or(true,|e|matches!(e.state,InvocationState::Dispatched|InvocationState::OutcomeUnknown)),"live owner must retain its unresolved fence: {disposition:?}; dispatch={dispatch_result:?}; submissions={}",h.submissions());
        assert!(
            replacement.is_err(),
            "another business key must remain fenced while an owner may submit"
        );
        assert_eq!(h.submissions(), 1);
        assert_eq!(h.attempts(), 1);
    }
    #[test]
    fn repair_cancel_cannot_release_a_live_submission_fence() {
        negative_settlement_cannot_close_live_submission(true);
    }
    #[test]
    fn repair_reconcile_cannot_release_a_live_submission_fence() {
        negative_settlement_cannot_close_live_submission(false);
    }
    #[test]
    fn repair_live_process_owner_prevents_negative_settlement_and_recovers_on_death() {
        const CHILD: &str = "CEREBRO_ACTION_LIVE_OWNER_CHILD";
        const GATE: &str = "CEREBRO_ACTION_PROCESS_GATE";
        if std::env::var_os(CHILD).is_some() {
            let h = Harness::new("repair-live-owner-child");
            let p = h.prepare("request", "first").unwrap();
            h.allow(&p.effect.invocation_id).unwrap();
            let _ = h.service().dispatch(p.effect.invocation_id);
            return;
        }
        let h = Harness::new("repair-live-owner-process");
        let p = h.prepare("request", "first").unwrap();
        let id = p.effect.invocation_id;
        let gate = h.dir().join("process-gate");
        std::fs::create_dir(&gate).unwrap();
        let mut child=crate::spawn::command(std::env::current_exe().unwrap())
            .args(["--exact","actions::recovery::tests::repair_live_process_owner_prevents_negative_settlement_and_recovers_on_death","--nocapture"])
            .env(CHILD,"1").env(GATE,&gate).env("CEREBRO_ACTION_TEST_DIR",h.dir())
            .stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !gate.join("entered").exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        if !gate.join("entered").exists() {
            let _ = child.kill();
            let _ = child.wait();
            panic!("child did not reach the live submission boundary");
        }
        h.set_observation("cancel-confirmed");
        let negative = h.cancel(&id);
        let replacement = h.prepare("replacement", "second");
        h.recover();
        let live_state = h.details(&id).effect.state;
        child.kill().unwrap();
        let _ = child.wait().unwrap();
        h.recover();
        let after_death = h.details(&id);
        h.set_observation("not-applied");
        let settled = h
            .service()
            .reconcile(h.subject(), id, after_death.revision.get());
        assert!(
            negative.as_ref().map_or(true, |e| matches!(
                e.state,
                InvocationState::Dispatched | InvocationState::OutcomeUnknown
            )),
            "another process must not close a live submission: {negative:?}"
        );
        assert!(matches!(
            live_state,
            InvocationState::Dispatched | InvocationState::OutcomeUnknown
        ));
        assert!(replacement.is_err());
        assert_eq!(after_death.effect.state, InvocationState::OutcomeUnknown);
        assert!(settled.is_ok_and(|e| e.state == InvocationState::Failed));
        assert_eq!(h.submissions(), 0);
        assert_eq!(h.attempts(), 1);
    }
}
