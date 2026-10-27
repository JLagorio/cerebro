//! Attended decisions are native capabilities, never deserialized model input.

#[cfg(test)]
mod tests {
    use super::super::service::test_support::*;
    use super::super::types::*;
    use std::sync::{Arc, Barrier};

    // Removing the transaction, approval CAS, or unique attempt constraint admits
    // two independent native windows to one remote dispatch.
    #[test]
    fn two_windows_consume_one_dispatch_claim() {
        let h = Harness::new("approval-two-windows");
        let prepared = h.prepare("request", "first").unwrap();
        h.allow(&prepared.effect.invocation_id).unwrap();
        let barrier = Arc::new(Barrier::new(2));
        let workers: Vec<_> = (0..2)
            .map(|_| {
                let service = h.service();
                let id = prepared.effect.invocation_id.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    service.dispatch(id)
                })
            })
            .collect();
        for worker in workers {
            let _ = worker.join().unwrap();
        }
        assert_eq!(h.attempts(), 1);
        assert_eq!(h.submissions(), 1);
    }
    #[test]
    fn prepare_same_key_returns_original_approval() {
        let h = Harness::new("approval-key-replay");
        let first = h.prepare("request", "first").unwrap();
        let replay = h.prepare("request", "first").unwrap();
        assert_eq!(first.approval_id, replay.approval_id);
        assert_eq!(first.effect.invocation_id, replay.effect.invocation_id);
        assert_eq!(h.invocations(), 1);
    }
    #[test]
    fn prepare_key_different_input_conflicts() {
        let h = Harness::new("approval-key-conflict");
        h.prepare("request", "first").unwrap();
        assert_eq!(
            h.prepare("request", "second").unwrap_err().code,
            ActionErrorCode::RequestKeyConflict
        );
        assert_eq!(h.invocations(), 1);
    }
    #[test]
    fn edited_input_retires_old_approval() {
        let h = Harness::new("approval-edited");
        let prepared = h.prepare("request", "first").unwrap();
        let id = prepared.effect.invocation_id;
        let old = h.decision(&id, true, Some("edited"));
        let effect = h.service().answer(old).unwrap();
        assert_eq!(effect.state, InvocationState::AwaitingApproval);
        assert_ne!(effect.approval_id, prepared.approval_id);
        assert_eq!(
            h.service()
                .answer(h.stale_decision(&id, prepared.approval_id.unwrap()))
                .unwrap_err()
                .code,
            ActionErrorCode::RevisionConflict
        );
        assert!(h.service().dispatch(id.clone()).is_err());
        h.allow(&id).unwrap();
        let details = h.details(&id);
        assert!(details
            .approval
            .unwrap()
            .approved_preview
            .unwrap()
            .fields
            .iter()
            .any(|f| f.value == "edited"));
    }
    #[test]
    fn revocation_after_allow_prevents_dispatch() {
        let h = Harness::new("approval-revoked");
        let p = h.prepare("request", "first").unwrap();
        h.allow(&p.effect.invocation_id).unwrap();
        h.change_authority("revocation");
        assert!(h.service().dispatch(p.effect.invocation_id).is_err());
        assert_eq!(h.submissions(), 0);
        assert_eq!(h.attempts(), 0);
    }
    #[test]
    fn account_replacement_requires_review() {
        let h = Harness::new("approval-replacement");
        let p = h.prepare("request", "first").unwrap();
        h.allow(&p.effect.invocation_id).unwrap();
        h.change_authority("account");
        assert!(h
            .service()
            .dispatch(p.effect.invocation_id.clone())
            .is_err());
        assert_eq!(h.submissions(), 0);
        let details = h.details(&p.effect.invocation_id);
        assert_eq!(details.effect.state, InvocationState::AwaitingApproval);
        assert!(details.effect.approval_id.is_none());
        assert!(details.approval.is_none());
        assert!(!details.effect.can_retry);
    }
    #[test]
    fn same_account_refresh_keeps_binding() {
        let h = Harness::new("approval-refresh");
        let p = h.prepare("request", "first").unwrap();
        h.allow(&p.effect.invocation_id).unwrap();
        h.change_authority("secret");
        assert_eq!(
            h.service().dispatch(p.effect.invocation_id).unwrap().state,
            InvocationState::Succeeded
        );
        assert_eq!(h.submissions(), 1);
    }
    #[test]
    fn grant_schema_and_policy_drift_prevent_dispatch() {
        for drift in ["grant", "schema", "policy"] {
            let h = Harness::new(drift);
            let p = h.prepare("request", "first").unwrap();
            h.allow(&p.effect.invocation_id).unwrap();
            h.change_authority(drift);
            assert!(h
                .service()
                .dispatch(p.effect.invocation_id.clone())
                .is_err());
            assert_eq!(h.submissions(), 0);
            let details = h.details(&p.effect.invocation_id);
            assert_eq!(details.effect.state, InvocationState::AwaitingApproval);
            assert!(details.effect.approval_id.is_none());
            assert!(details.approval.is_none());
            assert!(!details.effect.can_retry);
        }
    }
    #[test]
    fn spoofed_vault_actor_child_client_ids_are_denied() {
        let h = Harness::new("approval-spoof");
        for field in ["vault", "run", "actor", "child", "client"] {
            assert_eq!(
                h.spoofed_prepare(field).unwrap_err().code,
                ActionErrorCode::Denied
            );
        }
        assert_eq!(h.invocations(), 0);
        assert_eq!(h.submissions(), 0);
    }
    #[test]
    fn stale_details_cannot_approve() {
        let h = Harness::new("approval-stale");
        let p = h.prepare("request", "first").unwrap();
        let stale = h.decision(&p.effect.invocation_id, true, None);
        h.allow(&p.effect.invocation_id).unwrap();
        assert_eq!(
            h.service().answer(stale).unwrap_err().code,
            ActionErrorCode::RevisionConflict
        );
    }
    #[test]
    fn details_cross_subject_read_denied() {
        let h = Harness::new("approval-details-scope");
        let p = h.prepare("request", "first").unwrap();
        let wrong = h.other_subject();
        assert_eq!(
            h.service()
                .effect_details(wrong, p.effect.invocation_id)
                .unwrap_err()
                .code,
            ActionReadErrorCode::Denied
        );
    }
    #[test]
    fn expiry_prevents_claim() {
        let h = Harness::new("approval-expiry");
        let p = h.prepare("request", "first").unwrap();
        h.allow(&p.effect.invocation_id).unwrap();
        h.expire();
        assert!(h
            .service()
            .dispatch(p.effect.invocation_id.clone())
            .is_err());
        assert_eq!(h.submissions(), 0);
        let details = h.details(&p.effect.invocation_id);
        assert_eq!(details.effect.state, InvocationState::AwaitingApproval);
        assert!(details.effect.approval_id.is_none());
        assert!(details.approval.is_none());
        assert!(!details.effect.can_retry);
    }
    #[test]
    fn unknown_retry_requires_adapter_proof_even_with_attended_acknowledgement() {
        let h = Harness::new("retry-unknown");
        let p = h.prepare("request", "first").unwrap();
        h.allow(&p.effect.invocation_id).unwrap();
        h.claim_without_receipt(&p.effect.invocation_id);
        h.recover();
        assert!(h.retry(&p.effect.invocation_id, true).is_err());
        assert_eq!(h.attempts(), 1);
        assert!(!h.details(&p.effect.invocation_id).effect.can_retry);
    }
    #[test]
    fn confirmed_non_application_retry_requires_fresh_approval_and_claim() {
        let h = Harness::idempotent("retry-confirmed");
        h.set_observation("failed");
        let p = h.prepare("request", "first").unwrap();
        let id = p.effect.invocation_id;
        let old_approval = p.approval_id;
        h.allow(&id).unwrap();
        assert_eq!(
            h.service().dispatch(id.clone()).unwrap().state,
            InvocationState::Failed
        );
        assert!(h.retry(&id, false).is_err());
        assert_eq!(h.attempts(), 1);
        let retry = h.retry(&id, true).unwrap();
        assert_eq!(retry.state, InvocationState::AwaitingApproval);
        assert_ne!(retry.approval_id, old_approval);
        assert!(h.service().dispatch(id.clone()).is_err());
        h.allow(&id).unwrap();
        h.set_observation("success");
        assert_eq!(
            h.service().dispatch(id.clone()).unwrap().state,
            InvocationState::Succeeded
        );
        let details = h.details(&id);
        assert_eq!(details.attempts.len(), 2);
        assert_eq!(details.attempts[0].ordinal.get(), 1);
        assert_eq!(details.attempts[1].ordinal.get(), 2);
        assert_eq!(h.invocations(), 1);
        assert_eq!(h.submissions(), 2);
    }
    #[test]
    fn safe_details_never_serialize_unrestricted_provider_output() {
        let h = Harness::new("details-redaction");
        h.set_observation("sentinel");
        let p = h.prepare("request", "first").unwrap();
        h.allow(&p.effect.invocation_id).unwrap();
        h.service()
            .dispatch(p.effect.invocation_id.clone())
            .unwrap();
        let wire = serde_json::to_string(&h.details(&p.effect.invocation_id)).unwrap();
        for forbidden in [
            "TOKEN_SENTINEL",
            "HEADER_SENTINEL",
            "ENV_SENTINEL",
            "secret_ref",
            "canonical_input",
        ] {
            assert!(!wire.contains(forbidden));
        }
    }
    #[test]
    fn authority_drift_disables_retry_and_reconciliation_in_details() {
        let h = Harness::idempotent("retry-details-drift");
        h.set_observation("failed");
        let p = h.prepare("request", "first").unwrap();
        h.allow(&p.effect.invocation_id).unwrap();
        h.service()
            .dispatch(p.effect.invocation_id.clone())
            .unwrap();
        assert!(h.details(&p.effect.invocation_id).effect.can_retry);
        h.change_authority("grant");
        assert!(!h.details(&p.effect.invocation_id).effect.can_retry);
        assert!(h.retry(&p.effect.invocation_id, true).is_err());
        assert_eq!(h.attempts(), 1);
        let u = Harness::new("reconcile-details-drift");
        let p = u.prepare("request", "first").unwrap();
        u.allow(&p.effect.invocation_id).unwrap();
        u.claim_without_receipt(&p.effect.invocation_id);
        u.recover();
        assert!(u.details(&p.effect.invocation_id).effect.can_reconcile);
        u.change_authority("account");
        assert!(!u.details(&p.effect.invocation_id).effect.can_reconcile);
    }

    #[test]
    fn attended_decision_records_person_and_time_durably() {
        let h = Harness::new("approval-person-audit");
        let p = h.prepare("request", "first").unwrap();
        h.allow(&p.effect.invocation_id).unwrap();
        let audit = h.approval_audit(&p.effect.invocation_id);
        assert_eq!(audit["decided_by"], "human:fixture");
        assert_eq!(audit["decision"], "allow");
        assert!(audit["decided_at"]
            .as_str()
            .is_some_and(|s| s.ends_with('Z')));
    }
    #[test]
    fn repair_edited_input_is_revalidated_against_current_grants() {
        let h = Harness::new("repair-edited-authority");
        let original = h.prepare("request", "first").unwrap();
        let id = original.effect.invocation_id;
        let service = h.input_restricted_service();
        let edited = service.answer(h.decision(&id, true, Some("edited")));
        if edited.is_ok() && service.answer(h.decision(&id, true, None)).is_ok() {
            let _ = service.dispatch(id.clone());
        }
        assert_eq!(
            h.submissions(),
            0,
            "current edited input must not pass original-input grants"
        );
        assert_eq!(
            h.prepare("request", "first").unwrap().effect.invocation_id,
            id
        );
        assert_eq!(
            h.prepare("request", "edited").unwrap_err().code,
            ActionErrorCode::RequestKeyConflict
        );
    }
    #[test]
    fn repair_current_input_restriction_masks_the_edited_approval() {
        let h = Harness::new("repair-edited-details");
        let p = h.prepare("request", "first").unwrap();
        let id = p.effect.invocation_id;
        h.service()
            .answer(h.decision(&id, true, Some("edited")))
            .unwrap();
        let details = h
            .input_restricted_service()
            .effect_details(h.subject(), id)
            .unwrap();
        assert!(details.effect.approval_id.is_none());
        assert!(details.approval.is_none());
    }

    // These literal bytes and digests are the persistence protocol, independent
    // of the order in which Rust's transport DTO fields happen to be declared.
    const FIX2_SCOPE_V1_BYTES: &str = r#"["cerebro.action.subject-scope",1,"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","run","human:fixture",null,null]"#;
    const FIX2_REQUEST_V1_BYTES: &str = r#"["cerebro.action.request",1,"fixture:issue-create","8bae67dbf1020c8f16812cedf058cc2c2b650c15d0123729424027f3cd35c355","connection","account","snapshot-1","{\"title\":\"first\"}","request"]"#;
    const FIX2_SCOPE_V1: &str = "8eb4d8914f78638d275926d49be14929c0fddfb280464dcc23b03042b3d764c6";
    const FIX2_REQUEST_V1: &str =
        "5f4f832c722cb5d1bfe730eac7e3db3c091374d0e2bff8d085761138d2594174";
    const FIX2_LEGACY_SCOPE_BYTES: &str = r#"{"vaultId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","runId":"run","actorId":"human:fixture","childJobId":null,"clientId":null}"#;
    const FIX2_LEGACY_REQUEST_BYTES: &str = r#"{"actionId":"fixture:issue-create","definitionDigest":"8bae67dbf1020c8f16812cedf058cc2c2b650c15d0123729424027f3cd35c355","connectionId":"connection","accountId":"account","snapshotDigest":"snapshot-1","input":"{\"title\":\"first\"}","requestKey":"request"}"#;
    const FIX2_LEGACY_SCOPE: &str =
        "8f93832db109025cdc7224fbe69626ed3ed19792026f3afa4d0f67abfb65ea2a";
    const FIX2_LEGACY_REQUEST: &str =
        "50d5483421b1c3ebc8d9f2e52d0c8bb28aff436e877f9e9306b19128d16f48b5";

    #[test]
    fn fix2_new_lookup_columns_match_literal_versioned_goldens() {
        use sha2::{Digest, Sha256};
        assert_eq!(
            format!("{:x}", Sha256::digest(FIX2_SCOPE_V1_BYTES)),
            FIX2_SCOPE_V1
        );
        assert_eq!(
            format!("{:x}", Sha256::digest(FIX2_REQUEST_V1_BYTES)),
            FIX2_REQUEST_V1
        );
        let h = Harness::new("fix2-lookup-v1-golden");
        let p = h.prepare("request", "first").unwrap();
        assert_eq!(
            h.lookup_columns(&p.effect.invocation_id),
            (FIX2_SCOPE_V1.into(), FIX2_REQUEST_V1.into()),
            "new persistence must use the documented domain-tagged tuple bytes"
        );
    }
    #[test]
    fn fix2_legacy_lookup_reopens_without_rewrite_or_duplicate() {
        use sha2::{Digest, Sha256};
        assert_eq!(
            format!("{:x}", Sha256::digest(FIX2_LEGACY_SCOPE_BYTES)),
            FIX2_LEGACY_SCOPE
        );
        assert_eq!(
            format!("{:x}", Sha256::digest(FIX2_LEGACY_REQUEST_BYTES)),
            FIX2_LEGACY_REQUEST
        );
        let h = Harness::new("fix2-legacy-reopen");
        let p = h.prepare("request", "first").unwrap();
        h.fixture_lookup(
            &p.effect.invocation_id,
            FIX2_LEGACY_SCOPE,
            FIX2_LEGACY_REQUEST,
        );
        let before = h.raw_action_rows();
        // Each service operation opens an independent connection. Catalog removal
        // also proves replay reads the durable original rather than preparing anew.
        let replay = h.replay_without_catalog("request", "first").unwrap();
        assert_eq!(replay.effect.invocation_id, p.effect.invocation_id);
        assert_eq!(replay.approval_id, p.approval_id);
        assert_eq!(
            h.replay_without_catalog("request", "changed")
                .unwrap_err()
                .code,
            ActionErrorCode::RequestKeyConflict
        );
        assert_eq!(h.raw_action_rows(), before);
        assert_eq!(h.invocations(), 1);
        assert_eq!(h.submissions(), 0);
    }
    #[test]
    fn fix2_duplicate_lookup_versions_are_unavailable_without_allocation() {
        let h = Harness::new("fix2-lookup-dual-conflict");
        let p = h.prepare("request", "first").unwrap();
        h.fixture_lookup(
            &p.effect.invocation_id,
            FIX2_LEGACY_SCOPE,
            FIX2_LEGACY_REQUEST,
        );
        h.duplicate_fixture_lookup(&p.effect.invocation_id, FIX2_SCOPE_V1, FIX2_REQUEST_V1);
        let before = h.raw_action_rows();
        assert_eq!(
            h.prepare("request", "first").unwrap_err().code,
            ActionErrorCode::Unavailable
        );
        assert_eq!(h.raw_action_rows(), before);
        assert_eq!(h.invocations(), 2);
        assert_eq!(h.attempts(), 0);
        assert_eq!(h.submissions(), 0);
    }
    #[test]
    fn fix2_unknown_request_digest_version_is_unavailable_not_a_fresh_key() {
        let h = Harness::new("fix2-lookup-unknown-version");
        let p = h.prepare("request", "first").unwrap();
        h.fixture_lookup(
            &p.effect.invocation_id,
            FIX2_LEGACY_SCOPE,
            FIX2_LEGACY_REQUEST,
        );
        h.fixture_lookup_version(&p.effect.invocation_id, 99);
        let before = h.raw_action_rows();
        assert_eq!(
            h.prepare("request", "first").unwrap_err().code,
            ActionErrorCode::Unavailable
        );
        assert_eq!(h.raw_action_rows(), before);
        assert_eq!(h.invocations(), 1);
    }
    #[test]
    fn fix2_lookup_row_version_must_match_its_scope_encoding() {
        for (label, scope, request, version) in [
            (
                "legacy-marked-v1",
                FIX2_LEGACY_SCOPE,
                FIX2_LEGACY_REQUEST,
                1,
            ),
            ("v1-marked-legacy", FIX2_SCOPE_V1, FIX2_REQUEST_V1, 0),
        ] {
            let h = Harness::new(&format!("fix2-lookup-{label}"));
            let p = h.prepare("request", "first").unwrap();
            h.fixture_lookup(&p.effect.invocation_id, scope, request);
            h.fixture_lookup_version(&p.effect.invocation_id, version);
            let before = h.raw_action_rows();
            assert_eq!(
                h.prepare("request", "first").unwrap_err().code,
                ActionErrorCode::Unavailable
            );
            assert_eq!(h.raw_action_rows(), before);
            assert_eq!(h.invocations(), 1);
            assert_eq!(h.submissions(), 0);
        }
    }
    #[test]
    fn fix2_expired_approval_reads_and_replay_are_non_actionable_and_select_only() {
        for approved in [false, true] {
            let h = Harness::new(if approved {
                "fix2-expired-ready-read"
            } else {
                "fix2-expired-waiting-read"
            });
            let p = h.prepare("request", "first").unwrap();
            if approved {
                h.allow(&p.effect.invocation_id).unwrap();
            }
            let revision = h.details(&p.effect.invocation_id).revision;
            h.expire_id(&p.effect.invocation_id);
            let before = h.raw_action_rows();
            let details = h.details(&p.effect.invocation_id);
            let effect = h
                .service()
                .effect_ref(h.subject(), p.effect.invocation_id.clone())
                .unwrap();
            let replay = h.prepare("request", "first").unwrap();
            assert_eq!(details.effect.state, InvocationState::AwaitingApproval);
            assert!(
                details.approval.is_none(),
                "expired approval cannot be presented as actionable"
            );
            assert!(details.effect.approval_id.is_none());
            assert_eq!(effect, details.effect);
            assert_eq!(replay.effect, details.effect);
            assert!(replay.approval_id.is_none());
            assert_eq!(details.revision, revision);
            assert_eq!(
                h.raw_action_rows(),
                before,
                "SELECT projection and replay cannot renew or retire history"
            );
            assert_eq!(h.attempts(), 0);
            assert_eq!(h.submissions(), 0);
        }
    }
    #[test]
    fn fix2_expired_refresh_preserves_request_and_requires_a_fresh_allow() {
        let h = Harness::new("fix2-refresh-expired");
        let p = h.prepare("request", "first").unwrap();
        let old = p.approval_id.unwrap();
        let stale_allow = h.decision(&p.effect.invocation_id, true, None);
        let revision = h.details(&p.effect.invocation_id).revision.get();
        let lookup = h.lookup_columns(&p.effect.invocation_id);
        h.expire_id(&p.effect.invocation_id);
        let refreshed = h
            .service()
            .refresh_approval(h.subject(), p.effect.invocation_id.clone(), revision)
            .unwrap();
        assert_eq!(refreshed.invocation_id, p.effect.invocation_id);
        assert_eq!(refreshed.state, InvocationState::AwaitingApproval);
        assert_ne!(refreshed.approval_id.as_ref(), Some(&old));
        assert_eq!(h.lookup_columns(&p.effect.invocation_id), lookup);
        let current = h.details(&p.effect.invocation_id);
        assert_eq!(current.revision.get(), revision + 1);
        assert!(current
            .approval
            .as_ref()
            .unwrap()
            .approved_input_digest
            .is_none());
        assert!(current
            .approval
            .as_ref()
            .unwrap()
            .approved_preview
            .is_none());
        let retired = h.approval_by_id(&old);
        assert_eq!(retired["retired"], true);
        assert!(retired["decided_by"].is_null());
        assert!(retired["decision"].is_null());
        assert_eq!(
            h.service().answer(stale_allow).unwrap_err().code,
            ActionErrorCode::RevisionConflict
        );
        assert!(h
            .service()
            .dispatch(p.effect.invocation_id.clone())
            .is_err());
        assert_eq!(
            h.prepare("request", "first").unwrap().approval_id,
            refreshed.approval_id
        );
        assert_eq!(h.attempts(), 0);
        assert_eq!(h.submissions(), 0);
        h.allow(&p.effect.invocation_id).unwrap();
        assert_eq!(
            h.service().dispatch(p.effect.invocation_id).unwrap().state,
            InvocationState::Succeeded
        );
        assert_eq!(h.attempts(), 1);
        assert_eq!(h.submissions(), 1);
    }
    #[test]
    fn fix2_two_refreshes_consume_one_revision_and_preserve_human_audit() {
        let h = Harness::new("fix2-refresh-cas");
        let p = h.prepare("request", "first").unwrap();
        let old = p.approval_id.unwrap();
        h.allow(&p.effect.invocation_id).unwrap();
        let revision = h.details(&p.effect.invocation_id).revision.get();
        let prior_audit = h.approval_by_id(&old);
        h.expire_id(&p.effect.invocation_id);
        let gate = Arc::new(Barrier::new(2));
        let workers: Vec<_> = (0..2)
            .map(|_| {
                let service = h.service();
                let subject = h.subject();
                let id = p.effect.invocation_id.clone();
                let gate = gate.clone();
                std::thread::spawn(move || {
                    gate.wait();
                    service.refresh_approval(subject, id, revision)
                })
            })
            .collect();
        let results: Vec<_> = workers.into_iter().map(|w| w.join().unwrap()).collect();
        assert_eq!(
            results.iter().filter(|r| r.is_ok()).count(),
            1,
            "one refresh owns the expected revision: {results:?}"
        );
        assert_eq!(
            results
                .iter()
                .filter(|r| r
                    .as_ref()
                    .is_err_and(|e| e.code == ActionErrorCode::RevisionConflict))
                .count(),
            1
        );
        let retired = h.approval_by_id(&old);
        assert_eq!(retired["retired"], true);
        for key in ["decided_by", "decided_at", "decision", "approved_input"] {
            assert_eq!(retired[key], prior_audit[key]);
        }
        assert_eq!(
            h.details(&p.effect.invocation_id).effect.state,
            InvocationState::AwaitingApproval
        );
        assert_eq!(h.attempts(), 0);
        assert_eq!(h.submissions(), 0);
    }
    #[test]
    fn fix2_refresh_rejects_authority_drift_cancel_intent_and_unknown() {
        for drift in ["account", "grant", "schema", "policy", "revocation"] {
            let h = Harness::new(&format!("fix2-refresh-drift-{drift}"));
            let p = h.prepare("request", "first").unwrap();
            let revision = h.details(&p.effect.invocation_id).revision.get();
            h.expire_id(&p.effect.invocation_id);
            h.change_authority(drift);
            let before = h.raw_action_rows();
            assert_eq!(
                h.service()
                    .refresh_approval(h.subject(), p.effect.invocation_id, revision)
                    .unwrap_err()
                    .code,
                ActionErrorCode::Denied
            );
            assert_eq!(h.raw_action_rows(), before);
            assert_eq!(h.submissions(), 0);
        }
        let h = Harness::new("fix2-refresh-cancelled");
        let p = h.prepare("request", "first").unwrap();
        h.cancel(&p.effect.invocation_id).unwrap();
        h.expire_id(&p.effect.invocation_id);
        let revision = h.details(&p.effect.invocation_id).revision.get();
        let before = h.raw_action_rows();
        assert_eq!(
            h.service()
                .refresh_approval(h.subject(), p.effect.invocation_id, revision)
                .unwrap_err()
                .code,
            ActionErrorCode::Denied
        );
        assert_eq!(h.raw_action_rows(), before);
        let h = Harness::new("fix2-refresh-unknown");
        h.set_observation("unknown");
        let p = h.prepare("request", "first").unwrap();
        h.allow(&p.effect.invocation_id).unwrap();
        h.service()
            .dispatch(p.effect.invocation_id.clone())
            .unwrap();
        h.expire_id(&p.effect.invocation_id);
        let revision = h.details(&p.effect.invocation_id).revision.get();
        let before = h.raw_action_rows();
        assert_eq!(
            h.service()
                .refresh_approval(h.subject(), p.effect.invocation_id, revision)
                .unwrap_err()
                .code,
            ActionErrorCode::Denied
        );
        assert_eq!(h.raw_action_rows(), before);
        assert_eq!(h.attempts(), 1);
        assert_eq!(h.submissions(), 1);
    }
    #[test]
    fn fix2_refresh_cannot_bypass_another_unresolved_target() {
        let h = Harness::new("fix2-refresh-fenced");
        let first = h.prepare("request", "first").unwrap();
        let revision = h.details(&first.effect.invocation_id).revision.get();
        let other = h.prepare("other-request", "second").unwrap();
        h.allow(&other.effect.invocation_id).unwrap();
        h.set_observation("unknown");
        h.service().dispatch(other.effect.invocation_id).unwrap();
        h.expire_id(&first.effect.invocation_id);
        let before = h.raw_action_rows();
        assert_eq!(
            h.service()
                .refresh_approval(h.subject(), first.effect.invocation_id, revision)
                .unwrap_err()
                .code,
            ActionErrorCode::Denied
        );
        assert_eq!(h.raw_action_rows(), before);
        assert_eq!(h.attempts(), 1);
        assert_eq!(h.submissions(), 1);
    }
    #[test]
    fn fix2_expired_postclaim_approval_remains_truthful_history() {
        let h = Harness::new("fix2-expired-completed-history");
        let p = h.prepare("request", "first").unwrap();
        h.allow(&p.effect.invocation_id).unwrap();
        h.service()
            .dispatch(p.effect.invocation_id.clone())
            .unwrap();
        h.expire_id(&p.effect.invocation_id);
        let before = h.raw_action_rows();
        let details = h.details(&p.effect.invocation_id);
        assert_eq!(details.effect.state, InvocationState::Succeeded);
        assert!(details.approval.unwrap().approved_input_digest.is_some());
        assert_eq!(h.raw_action_rows(), before);
        assert_eq!(h.attempts(), 1);
        assert_eq!(h.submissions(), 1);
    }
}
