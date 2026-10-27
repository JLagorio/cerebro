#![cfg(test)]
//! Original-publication/retained SQL-owner coordinator. No native window proof.
use super::*;
pub(crate) use crate::runtime::child_jobs::{Allocation, Intent, Refusal};

// Borrowed observations/selectors, never an origin/capability constructor.
pub(crate) struct ParentProbe<'a> {
    pub agents: &'a crate::agent::AgentState,
    pub preparation: &'a crate::agent::RunPreparation,
    pub mcp: &'a crate::mcp::McpState,
    pub slot: &'a crate::mcp::NativeSlotWitness,
    pub receipt: &'a Arc<crate::agent::NativePublicationReceipt>,
    pub root: &'a Path,
    pub scope: &'a crate::runtime::VaultScope,
    pub authority: &'a str,
    pub attempt: &'a str,
}
impl PublicationSqlOwner {
    pub(crate) fn m95_prepare_intent(
        &mut self,
        parent: &ParentProbe<'_>,
        ordinal: u32,
    ) -> Result<Intent, Refusal> {
        self.m95_delegation_transaction(parent, |tx, native, attempt| {
            crate::runtime::child_jobs::prepare_intent_rows(tx, native, attempt, ordinal)
        })
    }
    pub(crate) fn m95_reserve(
        &mut self,
        parent: &ParentProbe<'_>,
        intent: &Intent,
        spec: &crate::agent::ChildJobSpec,
        now: u64,
    ) -> Result<Allocation, Refusal> {
        self.m95_delegation_transaction(parent, |tx, native, attempt| {
            crate::runtime::child_jobs::reserve_rows(tx, native, attempt, intent, spec, now)
        })
    }
    pub(crate) fn m95_release_provisional_slot(
        &mut self,
        parent: &ParentProbe<'_>,
        allocation: &Allocation,
    ) -> Result<(), Refusal> {
        self.m95_delegation_transaction(parent, |tx, native, attempt| {
            crate::runtime::child_jobs::release_provisional_rows(tx, native, attempt, allocation)
        })
    }
    // Private fixed-door implementation only. No caller can export/inject a
    // connection callback, synthesize an installed origin or obtain this owner.
    fn m95_delegation_transaction<T>(
        &mut self,
        parent: &ParentProbe<'_>,
        operation: impl FnOnce(
            &Connection,
            &crate::runtime::native_runs::NativeRun,
            &str,
        ) -> Result<T, Refusal>,
    ) -> Result<T, Refusal> {
        let current = parent
            .mcp
            .current_native_publication(parent.slot)
            .ok_or(Refusal::Unavailable)?;
        if !Arc::ptr_eq(&current, parent.receipt) {
            return Err(Refusal::Unavailable);
        }
        let publication = parent
            .agents
            .guard_publication_entry(parent.preparation, parent.root, parent.receipt)
            .map_err(|_| Refusal::Unavailable)?;
        // Only after matching the original publication's root may this harness
        // observe its store. This operation-local file is not the installed
        // native origin's retained store/opening; that integration stays open.
        let store = read_native_store(parent.root).map_err(|_| Refusal::Unavailable)?;
        if Some(store.info.store_id.as_str()) != parent.scope.store_uuid.as_deref() {
            return Err(Refusal::Unavailable);
        }
        let mut domain_error = None;
        let result = self.owner.classified_transaction(|tx| {
            RuntimeOwner::verify_open_session(tx, parent.root, parent.scope)?;
            store.recheck()?;
            let rules = crate::actions::native_rules::admission_rules();
            let binding = crate::actions::native_lineage::NativeBinding {
                run_id: parent.receipt.run_id(),
                vault_id: &parent.scope.vault_id,
                store_uuid: parent
                    .scope
                    .store_uuid
                    .as_deref()
                    .ok_or(NativeOwnerError::Unavailable)?,
                canonical_vault: parent.root,
                owner_person: &rules.owner_storage_key,
                actor_id: parent.receipt.actor_id(),
                source_kind: "run",
                app_session_id: crate::runtime::sessions::session_id(),
                cli_session_id: parent.receipt.cli_session_id(),
                parent_run_id: None,
                client_id: None,
                child_job_id: None,
            };
            let joined = crate::actions::native_lineage::resolve_lineage(
                crate::actions::native_db::AuthorityDb::Writer(tx),
                &binding,
                false,
            )
            .map_err(unavailable)?;
            let attempt: Option<(String,String)> = tx.query_row(
                "SELECT attempt_id,authority_id FROM chat_parent_attempts WHERE parent_run_id=?1",
                [parent.receipt.run_id()],|r|Ok((r.get(0)?,r.get(1)?)),
            ).optional().map_err(unavailable)?;
            if !joined.can_call
                || joined.row.authority_id != parent.authority
                || attempt != Some((parent.attempt.to_owned(), parent.authority.to_owned()))
                || !publication.recheck()
            {
                return Err(NativeOwnerError::Unavailable);
            }
            let value = operation(tx, &joined.row, parent.attempt).map_err(|error| {
                domain_error = Some(error);
                NativeOwnerError::Unavailable
            })?;
            store.recheck()?;
            if !publication.recheck() {
                return Err(NativeOwnerError::Unavailable);
            }
            Ok(value)
        });
        drop(publication);
        // All authority/SQLite guards are gone before current source lookup.
        let current = parent
            .mcp
            .current_native_publication(parent.slot)
            .ok_or(Refusal::Unavailable)?;
        if !Arc::ptr_eq(&current, parent.receipt) || store.recheck().is_err() {
            return Err(Refusal::Unavailable);
        }
        match result {
            RuntimeTransactionOutcome::Committed(value) => Ok(value),
            RuntimeTransactionOutcome::NotCommitted(_) if !self.owner.retired => {
                Err(domain_error.unwrap_or(Refusal::Unavailable))
            }
            RuntimeTransactionOutcome::NotCommitted(_)
            | RuntimeTransactionOutcome::CommitUncertain => Err(Refusal::Unavailable),
        }
    }
}

// Additive fault observations use the existing real commit acknowledgment seam.
// No SQL callback, owner constructor or native proof factory is exposed.
impl PublicationSqlOwner {
    pub(crate) fn m95_prepare_losing_ack(
        &mut self,
        parent: &ParentProbe<'_>,
        ordinal: u32,
    ) -> Result<Intent, Refusal> {
        super::with_transaction_ack_probe(|| {
            super::lose_next_transaction_ack();
            self.m95_prepare_intent(parent, ordinal)
        })
    }
    pub(crate) fn m95_reserve_losing_ack(
        &mut self,
        parent: &ParentProbe<'_>,
        intent: &Intent,
        spec: &crate::agent::ChildJobSpec,
        now: u64,
    ) -> Result<Allocation, Refusal> {
        super::with_transaction_ack_probe(|| {
            super::lose_next_transaction_ack();
            self.m95_reserve(parent, intent, spec, now)
        })
    }
    pub(crate) fn m95_owner_is_retired(&self) -> bool {
        self.owner.retired
    }
}

// Additive V40 row-kernel observations under the real retained SQL owner. This
// test door returns inert Allocation data only, never a native caller/capsule.
impl PublicationSqlOwner {
    pub(crate) fn m95_freeze_metadata(
        &mut self,
        parent: &ParentProbe<'_>,
        intent: &Intent,
        spec: &crate::agent::ChildJobSpec,
        digests: &crate::runtime::child_jobs::FreezeDigests<'_>,
        retained: Option<&Allocation>,
        now: u64,
    ) -> Result<Allocation, Refusal> {
        let observed = parent
            .mcp
            .current_native_observation(parent.slot)
            .ok_or(Refusal::Unavailable)?;
        if !Arc::ptr_eq(observed.receipt(), parent.receipt)
            || observed.grant().run_id != spec.parent_run_id
        {
            return Err(Refusal::Unavailable);
        }
        let result = self.m95_delegation_transaction(parent, |tx, native, attempt| {
            crate::runtime::child_jobs::freeze_rows(
                tx, native, attempt, intent, spec, digests, retained, now,
            )
        });
        let current = parent
            .mcp
            .current_native_observation(parent.slot)
            .ok_or(Refusal::Unavailable)?;
        if !current.same_as(&observed) {
            return Err(Refusal::Unavailable);
        }
        result
    }
    pub(crate) fn m95_freeze_metadata_losing_ack(
        &mut self,
        parent: &ParentProbe<'_>,
        intent: &Intent,
        spec: &crate::agent::ChildJobSpec,
        digests: &crate::runtime::child_jobs::FreezeDigests<'_>,
        now: u64,
    ) -> Result<Allocation, Refusal> {
        super::with_transaction_ack_probe(|| {
            super::lose_next_transaction_ack();
            self.m95_freeze_metadata(parent, intent, spec, digests, None, now)
        })
    }
}
