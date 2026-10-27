//! ACT-owned retained historical disclosure. No connection constructor or executor.
use super::{
    effect_record::*, effect_types::*, native_owner::RetainedRead, recovery_read_types::*, schema,
};
use crate::connections::metadata::{decode_status, ConnectionHealth};
use rusqlite::{types::ValueRef, OptionalExtension};
use std::collections::BTreeSet;
fn unavailable() -> ActionReadError {
    ActionReadError {
        code: ActionReadErrorCode::Unavailable,
        retry_disposition: RetryDisposition::Never,
        message: "Historical action inventory is unavailable.".into(),
    }
}
#[derive(Clone, PartialEq, Eq)]
struct Candidate {
    id: String,
    scope: String,
    key: String,
    digest: String,
    revision: u64,
    state: InvocationState,
    bytes: usize,
}
fn state(raw: &str) -> Option<InvocationState> {
    Some(match raw {
        "prepared" => InvocationState::Prepared,
        "awaiting_approval" => InvocationState::AwaitingApproval,
        "ready" => InvocationState::Ready,
        "dispatched" => InvocationState::Dispatched,
        "succeeded" => InvocationState::Succeeded,
        "failed" => InvocationState::Failed,
        "outcome_unknown" => InvocationState::OutcomeUnknown,
        "cancelled" => InvocationState::Cancelled,
        _ => return None,
    })
}
fn metadata(row: &rusqlite::Row<'_>, used: &mut usize) -> Result<Candidate, HistoryReason> {
    let l = schema::history_limits();
    let mut strings = Vec::with_capacity(5);
    // Sum borrowed bytes and validate types before allocating any metadata strings.
    let columns = [
        ("invocation_id", l.max_id_bytes),
        ("subject_scope", 64),
        ("request_key", 256),
        ("request_digest", 64),
        ("state", 32),
    ];
    let mut total = 0usize;
    for (name, cap) in columns {
        let ValueRef::Text(raw) = row
            .get_ref(name)
            .map_err(|_| HistoryReason::InvalidRecord)?
        else {
            return Err(HistoryReason::InvalidRecord);
        };
        if raw.is_empty() || raw.len() > cap {
            return Err(HistoryReason::InvalidRecord);
        }
        total = total
            .checked_add(raw.len())
            .ok_or(HistoryReason::MetadataLimit)?;
        strings.push(std::str::from_utf8(raw).map_err(|_| HistoryReason::InvalidRecord)?);
    }
    *used = used
        .checked_add(total)
        .filter(|n| *n <= l.max_metadata_bytes)
        .ok_or(HistoryReason::MetadataLimit)?;
    let revision: i64 = row
        .get("revision")
        .map_err(|_| HistoryReason::InvalidRecord)?;
    let bytes: i64 = row
        .get("payload_bytes")
        .map_err(|_| HistoryReason::InvalidRecord)?;
    if !hex_id(strings[0], 32)
        || !hex_id(strings[1], 64)
        || !hex_id(strings[3], 64)
        || !(1..=9_007_199_254_740_991).contains(&revision)
        || bytes < 0
    {
        return Err(HistoryReason::InvalidRecord);
    }
    Ok(Candidate {
        id: strings[0].into(),
        scope: strings[1].into(),
        key: strings[2].into(),
        digest: strings[3].into(),
        revision: revision as u64,
        state: state(strings[4]).ok_or(HistoryReason::InvalidRecord)?,
        bytes: usize::try_from(bytes).map_err(|_| HistoryReason::StoredPayloadLimit)?,
    })
}
#[derive(Clone, Copy)]
enum Disclosure {
    Allowed,
    Denied,
    Unavailable,
}
// Health is historical disclosure policy, not live execution eligibility.
fn disclosure(read: &RetainedRead<'_>, owner: &str, record: &ActionInvocation) -> Disclosure {
    let request = &record.request;
    let binding = &record.binding;
    if request.account_id != binding.account_id
        || record.details.account.as_ref().is_none_or(|a| {
            a.account_id != binding.account_id
                || a.account_revision.get() != binding.account_revision
        })
    {
        return Disclosure::Denied;
    }
    const SQL:&str="SELECT c.connection_id,c.person,c.status,c.observation_revision,EXISTS(SELECT 1 FROM managed_secret_cleanup q WHERE q.connection_id=c.connection_id) AS cleanup_pending FROM managed_connections c WHERE c.connection_id=?1 AND c.person=?2";
    let answer = read
        .query(SQL, &[&request.connection_id.0, owner], |row| {
            let decode = (|| {
                let limits = &schema::admission_rules().limits;
                let ValueRef::Text(raw) = row.get_ref("status").ok()? else {
                    return None;
                };
                if raw.len() > limits.grant_bytes {
                    return None;
                }
                let raw = std::str::from_utf8(raw).ok()?;
                structural_check(raw).ok()?;
                let status = decode_status(raw, row.get("cleanup_pending").ok()?).ok()?;
                let ValueRef::Text(id) = row.get_ref("connection_id").ok()? else {
                    return None;
                };
                let ValueRef::Text(person) = row.get_ref("person").ok()? else {
                    return None;
                };
                let revision: i64 = row.get("observation_revision").ok()?;
                if id.len() > limits.identity_bytes
                    || id != request.connection_id.0.as_bytes()
                    || person != owner.as_bytes()
                    || status.connection_id != request.connection_id
                    || !(0..=9_007_199_254_740_991).contains(&revision)
                {
                    return None;
                }
                Some(status)
            })();
            Ok(decode)
        })
        .optional();
    let status = match answer {
        Ok(Some(Some(status))) => status,
        Ok(_) => return Disclosure::Denied,
        Err(_) => return Disclosure::Unavailable,
    };
    if status.cleanup_pending || status.health == ConnectionHealth::Disabled {
        return Disclosure::Denied;
    }
    if matches!(
        status.health,
        ConnectionHealth::Unavailable | ConnectionHealth::Unsupported
    ) {
        return Disclosure::Unavailable;
    }
    let Some(account) = status.account else {
        return Disclosure::Denied;
    };
    let identity = match serde_json::to_vec(&(&account.issuer, &account.subject)) {
        Ok(value) => schema::digest(&value),
        Err(_) => return Disclosure::Denied,
    };
    if account.account_id != binding.account_id
        || account.account_revision != binding.account_revision
        || status.revocation_generation != binding.revocation_generation
        || identity != binding.account_identity_digest
    {
        return Disclosure::Denied;
    }
    match status.health {
        ConnectionHealth::Ready | ConnectionHealth::SignInRequired => Disclosure::Allowed,
        ConnectionHealth::Unavailable | ConnectionHealth::Unsupported => Disclosure::Unavailable,
        ConnectionHealth::Disabled => Disclosure::Denied,
    }
}
// An explicit non-capability: no projection can preserve stale decision flags.
struct NoExecutor;
fn project(
    mut record: ActionInvocation,
    disclosure: Disclosure,
    _executor: NoExecutor,
) -> HistoryEffect {
    record.details.effect.can_retry = false;
    record.details.effect.can_reconcile = false;
    match disclosure {
        Disclosure::Allowed => HistoryEffect {
            effect: record.details.effect.clone(),
            details_read: DetailsRead::Available,
            details: Some(record.details),
            reason: None,
        },
        Disclosure::Denied | Disclosure::Unavailable => {
            let mut effect = record.details.effect;
            effect.account_label = None;
            effect.approval_id = None;
            let (details_read, reason) = if matches!(disclosure, Disclosure::Denied) {
                (DetailsRead::Denied, HistoryReason::AccountDenied)
            } else {
                (DetailsRead::Unavailable, HistoryReason::AccountUnavailable)
            };
            HistoryEffect {
                effect,
                details_read,
                details: None,
                reason: Some(reason),
            }
        }
    }
}
fn omit_details(effect: &mut HistoryEffect) {
    effect.details = None;
    effect.effect.account_label = None;
    effect.effect.approval_id = None;
    effect.details_read = DetailsRead::Unavailable;
    effect.reason = Some(HistoryReason::OutputLimit);
}
fn issue(answer: &mut ChatRecoveryInspection, reason: HistoryReason) {
    answer.broker_inventory.state = InventoryState::Incomplete;
    if !answer.broker_inventory.reasons.contains(&reason) {
        answer.broker_inventory.reasons.push(reason);
    }
    if answer.issues.len() < schema::history_limits().max_issues {
        answer.issues.push(HistoryIssue { reason });
    }
}
pub(super) fn inspect(
    read: &RetainedRead<'_>,
    origin: HistoryOrigin,
    owner: &str,
) -> Result<ChatRecoveryInspection, ActionReadError> {
    let l = schema::history_limits();
    let scope = ActionSubjectView {
        vault_id: origin.vault_id.clone(),
        run_id: origin.run_id.clone(),
        actor_id: origin.actor_id.clone(),
        client_id: None,
        child_job_id: None,
    };
    let v0 = legacy_scope_key(&scope).map_err(|_| unavailable())?;
    let v1 = scope_key(&scope).map_err(|_| unavailable())?;
    let mut answer = ChatRecoveryInspection {
        broker_inventory: BrokerInventory {
            state: InventoryState::Complete,
            inspected_run_ids: vec![origin.run_id.clone()],
            observed_count: SafeCounter::new(0).map_err(|_| unavailable())?,
            overflow: false,
            reasons: vec![],
        },
        origin,
        effects: vec![],
        generation_coverage: GenerationCoverage {
            state: UnknownCoverageState::Unknown,
            reason: GenerationReason::RootOnlyNoGenerationBinding,
        },
        external_effects_coverage: ExternalEffectsCoverage {
            state: UnknownCoverageState::Unknown,
            reason: ExternalEffectsReason::UnbrokeredExecutionNotCovered,
        },
        issues: vec![],
    };
    serialized_size(&answer, l.output_metadata_reserve_bytes).map_err(|_| unavailable())?;
    let limit = (l.max_effects + 1).to_string();
    let mut metadata_bytes = 0;
    let candidates=read.query_all("SELECT invocation_id,subject_scope,request_key,request_digest,revision,state,length(CAST(payload AS BLOB)) AS payload_bytes FROM action_invocations WHERE subject_scope IN (?1,?2) ORDER BY invocation_id LIMIT ?3",&[&v0,&v1,&limit],|row|Ok(metadata(row,&mut metadata_bytes))).map_err(|_|unavailable())?;
    #[cfg(all(test, target_os = "macos"))]
    super::native_owner::native_chat_recovery::inventory_observed();
    if candidates.len() > l.max_effects {
        answer.broker_inventory.overflow = true;
        issue(&mut answer, HistoryReason::Overflow);
    }
    let mut conflicts = BTreeSet::new();
    for (i, left) in candidates.iter().enumerate() {
        if let Ok(left) = left {
            for right in candidates.iter().skip(i + 1).flatten() {
                if (left.id == right.id && left != right)
                    || (left.key == right.key && left.scope != right.scope)
                {
                    conflicts.insert(left.id.clone());
                    conflicts.insert(right.id.clone());
                }
            }
        }
    }
    let mut seen = BTreeSet::new();
    let mut raw_total = 0usize;
    let mut output_total = 0usize;
    let mut observed = 0u64;
    for candidate in candidates.into_iter().take(l.max_effects) {
        let candidate = match candidate {
            Ok(value) => value,
            Err(reason) => {
                issue(&mut answer, reason);
                continue;
            }
        };
        if conflicts.contains(&candidate.id) {
            issue(&mut answer, HistoryReason::InvalidRecord);
            continue;
        }
        if !seen.insert(candidate.id.clone()) {
            continue;
        }
        if candidate.bytes > l.max_stored_payload_bytes {
            issue(&mut answer, HistoryReason::StoredPayloadLimit);
            continue;
        }
        let Some(next_total) = raw_total
            .checked_add(candidate.bytes)
            .filter(|n| *n <= l.max_stored_payload_bytes_total)
        else {
            issue(&mut answer, HistoryReason::AggregateLimit);
            continue;
        };
        raw_total = next_total;
        #[cfg(all(test, target_os = "macos"))]
        super::native_owner::native_chat_recovery::payload_observed();
        let record = read
            .query(
                "SELECT payload FROM action_invocations WHERE invocation_id=?1",
                &[&candidate.id],
                |row| {
                    let value = (|| {
                        let ValueRef::Text(bytes) = row
                            .get_ref("payload")
                            .map_err(|_| HistoryReason::InvalidRecord)?
                        else {
                            return Err(HistoryReason::InvalidRecord);
                        };
                        if bytes.len() != candidate.bytes
                            || bytes.len() > l.max_stored_payload_bytes
                        {
                            return Err(HistoryReason::StoredPayloadLimit);
                        }
                        let raw =
                            std::str::from_utf8(bytes).map_err(|_| HistoryReason::InvalidRecord)?;
                        decode_history(raw)
                    })();
                    Ok(value)
                },
            )
            .map_err(|_| unavailable())?;
        let record = match record {
            Ok(record) => record,
            Err(reason) => {
                issue(&mut answer, reason);
                continue;
            }
        };
        let stored_scope = if record.lookup_version == 0 { &v0 } else { &v1 };
        if record.scope != scope
            || candidate.scope != *stored_scope
            || record.details.effect.invocation_id.0 != candidate.id
            || record.details.revision.get() != candidate.revision
            || record.details.effect.state != candidate.state
            || record.request.request_key != candidate.key
            || record.request_digest != candidate.digest
        {
            issue(&mut answer, HistoryReason::InvalidRecord);
            continue;
        }
        observed += 1;
        let disclosure = disclosure(read, owner, &record);
        let mut effect = project(record, disclosure, NoExecutor);
        if effect
            .details
            .as_ref()
            .is_some_and(|d| serialized_size(d, l.max_effect_details_bytes).is_err())
        {
            omit_details(&mut effect);
        }
        let entry_budget = l
            .max_output_bytes
            .saturating_sub(l.output_metadata_reserve_bytes)
            .saturating_sub(output_total);
        let size = match serialized_size(&effect, entry_budget) {
            Ok(size) => Some(size),
            Err(_) => {
                omit_details(&mut effect);
                issue(&mut answer, HistoryReason::OutputLimit);
                serialized_size(&effect, entry_budget).ok()
            }
        };
        if let Some(size) = size {
            output_total += size + 1;
            answer.effects.push(effect);
        } else {
            issue(&mut answer, HistoryReason::OutputLimit);
        }
    }
    answer.broker_inventory.observed_count =
        SafeCounter::new(observed).map_err(|_| unavailable())?;
    serialized_size(&answer, l.max_output_bytes).map_err(|_| unavailable())?;
    Ok(answer)
}
