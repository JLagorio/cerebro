//! Synchronous publication shared by the actual stream and provider-free tests.
//! A preparation is checked before the first seat or filesystem/process write.
use super::*;

pub(super) struct Input<'state, 'request> {
    pub state: &'state AgentState,
    pub preparation: &'request RunPreparation,
    pub vault: &'request Path,
    pub request: &'request AgentRequest,
    pub cli: &'request readiness::Observation,
    pub session: &'request CliSession,
    pub config_dir: &'request Path,
    pub meter: Option<&'request meter::Meter>,
    pub configuration_mcp: Option<&'request crate::mcp::McpState>,
    pub seat: Option<(&'request str, Option<&'request str>)>,
    pub pending: Option<transcript::PendingDeferral>,
    pub resumes_a_deferral: bool,
    pub approval: &'request crate::policy::tool_approval::RunApproval,
    pub agents: &'request cli_agents::RunAgents,
}

pub(super) struct Published<'state> {
    pub started: Started,
    pub(super) receipt: Option<NativePublicationReceipt>,
    // The stream retains this until its reader is launched, so an opening
    // cannot sweep a slot before that slot's owner can reap and close it.
    pub guard: admission::Publication<'state>,
}

pub(super) fn publish<'state>(input: Input<'state, '_>) -> Result<Published<'state>, String> {
    publish_linked(input, None, None)
}

pub(super) fn publish_linked<'state>(
    input: Input<'state, '_>,
    answer: Option<&interaction::AnswerLink>,
    generation: Option<Arc<crate::actions::native_owner::NativeGenerationSettlement>>,
) -> Result<Published<'state>, String> {
    let Input {
        state,
        preparation,
        vault,
        request,
        cli,
        session,
        config_dir,
        meter,
        configuration_mcp,
        seat,
        pending,
        resumes_a_deferral,
        approval,
        agents,
    } = input;
    let configuration_capture =
        match configuration::prepare(configuration_mcp, meter, request, vault) {
            Ok(capture) => capture,
            Err(_) => {
                configuration::retire(configuration_mcp, request);
                return Err("Run configuration is unavailable. Nothing was started.".into());
            }
        };
    let guard = match state.guard_prepared(preparation, vault) {
        Ok(guard) => guard,
        Err(refusal) => {
            configuration::retire(configuration_mcp, request);
            return Err(refusal);
        }
    };
    if let Some((run_id, _)) = seat {
        let seat=seat_for(run_id,vault,request,session,approval).with_generation(generation);
        if let Some(answer)=answer {
            if let Err(error)=state.interactions.open_answer_seat(seat,answer) {
                drop(guard);
                configuration::retire(configuration_mcp,request);
                return Err(error);
            }
        } else {
            if let Err(error)=state.interactions.open_unlinked_seat(seat,pending) {
                drop(guard);
                configuration::retire(configuration_mcp,request);
                return Err(error);
            }
        }
    }
    let started = match spawn_run(
        state,
        vault,
        request,
        cli,
        session,
        config_dir,
        meter,
        seat,
        resumes_a_deferral,
        approval,
        agents,
        configuration_capture.as_ref(),
    ) {
        Ok(started) => started,
        Err(refusal) => {
            if let Some((run_id, _)) = seat {
                state.interactions.close_seat(run_id);
            }
            drop(guard);
            configuration::retire(configuration_mcp, request);
            return Err(refusal);
        }
    };
    if let (true, Some(meter)) = (journals(request, meter.is_some()), meter) {
        let waiting = state.waiting_sessions();
        state.journal.open(
            started.run,
            &meter.run_id,
            &vault_key(vault),
            session.id(),
            std::time::Instant::now(),
            &waiting,
        );
    }
    let receipt = NativePublicationReceipt::from_published(
        state,
        vault,
        request,
        meter,
        &started,
        session,
        guard.entry_witness(),
    );
    #[cfg(all(target_os = "macos", feature = "native-action-smoke"))]
    crate::native_read_smoke::record_managed_child_launch(
        config_dir,
        started.run,
        &started.supervised.handle(),
    );
    Ok(Published {
        started,
        receipt,
        guard,
    })
}

// Descriptive publication metadata only. This cannot grant action/account
// authority or establish an opening, person, store or database lineage.
#[derive(Clone)]
pub(crate) struct NativePublicationReceipt {
    run: u64,
    run_id: String,
    actor: String,
    vault: PathBuf,
    fingerprint: String,
    cli_session_id: String,
    entry: admission::EntryWitness,
    slots: std::sync::Weak<Mutex<HashMap<u64, RunSlot>>>,
    cancelled: std::sync::Weak<AtomicBool>,
}
impl NativePublicationReceipt {
    // Read only from this actual successful publication.
    pub(crate) fn cli_session_id(&self) -> Option<&str> {
        Some(&self.cli_session_id)
    }
    pub(super) fn matches_original_entry(
        &self,
        preparation: &RunPreparation,
        vault: &Path,
    ) -> bool {
        self.vault.as_path() == vault
            && self.entry.matches_preparation(preparation)
            && self.is_live()
    }

    fn from_published(
        state: &AgentState,
        vault: &Path,
        request: &AgentRequest,
        meter: Option<&meter::Meter>,
        started: &Started,
        session: &CliSession,
        entry: admission::EntryWitness,
    ) -> Option<Self> {
        let meter = meter?;
        let token = request.mcp_token.as_deref()?;
        Some(Self {
            run: started.run,
            run_id: meter.run_id.clone(),
            actor: crate::mcp::normalize_actor(request.actor.as_deref()).to_owned(),
            vault: vault_key(vault),
            fingerprint: crate::ledger::sha256_hex(token.as_bytes()),
            cli_session_id: session.id().to_owned(),
            entry,
            slots: Arc::downgrade(&state.slots),
            cancelled: Arc::downgrade(&started.cancelled),
        })
    }
    pub(super) fn matches_entry(&self, entry: &admission::EntryWitness) -> bool {
        self.entry.same_entry(entry) && self.is_live()
    }

    pub(crate) fn run_id(&self) -> &str {
        &self.run_id
    }
    pub(crate) fn actor_id(&self) -> &str {
        &self.actor
    }
    pub(crate) fn fingerprint(&self) -> &str {
        &self.fingerprint
    }
    pub(crate) fn same_publication(&self, other: &Self) -> bool {
        self.run == other.run
            && self.run_id == other.run_id
            && self.fingerprint == other.fingerprint
            && self.cli_session_id == other.cli_session_id
            && self.entry.same_entry(&other.entry)
            && self.slots.ptr_eq(&other.slots)
            && self.cancelled.ptr_eq(&other.cancelled)
    }
    pub(crate) fn matches_slot(
        &self,
        run_id: &str,
        actor: &str,
        vault: Option<&Path>,
        fingerprint: &str,
    ) -> bool {
        self.run_id == run_id
            && self.actor == actor
            && vault.is_some_and(|vault| vault_key(vault) == self.vault)
            && crate::mcp::tokens_match(self.fingerprint.as_bytes(), fingerprint.as_bytes())
            && self.is_live()
    }
    fn is_live(&self) -> bool {
        let Some(cancelled) = self.cancelled.upgrade() else {
            return false;
        };
        if cancelled.load(Ordering::SeqCst) {
            return false;
        }
        let Some(slots) = self.slots.upgrade() else {
            return false;
        };
        let slots = lock(&slots);
        slots.get(&self.run).is_some_and(|slot| {
            Arc::ptr_eq(&slot.cancelled, &cancelled)
                && slot.vault == self.vault
                && crate::mcp::normalize_actor(slot.actor.as_deref()) == self.actor
                && !slot.cancelled.load(Ordering::SeqCst)
                && slot.handle.alive()
        })
    }
}
#[cfg(test)]
impl Published<'_> {
    pub(super) fn native_receipt(&self) -> Option<NativePublicationReceipt> {
        self.receipt.clone()
    }
}

impl AgentState {
    // The caller holds original admission; no source mutex survives a check.
    pub(crate) fn install_native_action_read(
        &self,
        receipt: &NativePublicationReceipt,
        origin: Arc<crate::actions::native_owner::NativeActionReadOrigin>,
    ) -> bool {
        if !receipt.is_live() {
            return false;
        }
        let Some(book) = receipt.slots.upgrade() else {
            return false;
        };
        if !Arc::ptr_eq(&book, &self.slots) {
            return false;
        }
        let Some(cancelled) = receipt.cancelled.upgrade() else {
            return false;
        };
        let mut slots = lock(&self.slots);
        let Some(slot) = slots.get_mut(&receipt.run) else {
            return false;
        };
        if slot.native_action_read.is_some()
            || !Arc::ptr_eq(&slot.cancelled, &cancelled)
            || slot.cancelled.load(Ordering::SeqCst)
            || !slot.handle.alive()
            || slot.vault != receipt.vault
            || crate::mcp::normalize_actor(slot.actor.as_deref()) != receipt.actor
        {
            return false;
        }
        slot.native_action_read = Some(origin);
        true
    }
    pub(crate) fn native_action_read(
        &self,
        run: u64,
    ) -> Option<Arc<crate::actions::native_owner::NativeActionReadOrigin>> {
        let slots = lock(&self.slots);
        let slot = slots.get(&run)?;
        if slot.cancelled.load(Ordering::SeqCst) || !slot.handle.alive() {
            return None;
        }
        slot.native_action_read.clone()
    }
}

impl AgentState {
    fn events_for_publication(&self,receipt:&Arc<NativePublicationReceipt>)->Option<Arc<super::run_events::RunEvents>>{
        if !receipt.is_live(){return None;}
        let slots=receipt.slots.upgrade()?;if !Arc::ptr_eq(&slots,&self.slots){return None;}
        let cancelled=receipt.cancelled.upgrade()?;let slots=lock(&self.slots);let slot=slots.get(&receipt.run)?;
        if !Arc::ptr_eq(&slot.cancelled,&cancelled)||slot.cancelled.load(Ordering::SeqCst)||!slot.handle.alive()||slot.vault!=receipt.vault||crate::mcp::normalize_actor(slot.actor.as_deref())!=receipt.actor{return None;}
        slot.events.clone()
    }
    pub(crate) fn native_action_read_for_publication(&self,receipt:&Arc<NativePublicationReceipt>)->Option<Arc<crate::actions::native_owner::NativeActionReadOrigin>>{
        // The native caller additionally compares its retained exact receipt.
        // Only the original successful publication supplies this run number.
        self.events_for_publication(receipt)?;self.native_action_read(receipt.run)
    }
    pub(crate) fn managed_card_for_publication(&self,receipt:&Arc<NativePublicationReceipt>,mut card:interaction::InteractionCard)->Option<interaction::InteractionCard>{
        self.events_for_publication(receipt)?;
        if !matches!(card.kind,interaction::Kind::ManagedAction|interaction::Kind::ManagedAccess)||!card.tool_id.is_empty()||card.id.len()!=32||card.session_id!=receipt.cli_session_id{return None;}
        card.run=Some(crate::actions::SafeCounter::new(receipt.run).ok()?);card.answering=Some(false);Some(card)
    }
    pub(crate) fn publish_managed_interaction(&self,receipt:&Arc<NativePublicationReceipt>,card:interaction::InteractionCard)->bool{
        let Some(card)=self.managed_card_for_publication(receipt,card)else{return false;};
        let Some(events)=self.events_for_publication(receipt)else{return false;};
        events.send(AgentEvent::Interaction{interaction:card})
    }
    pub(crate) fn publish_managed_closed(&self,receipt:&Arc<NativePublicationReceipt>,id:&str)->bool{
        if id.len()!=32{return false;}let Some(events)=self.events_for_publication(receipt)else{return false;};
        events.send(AgentEvent::InteractionClosed{interaction_id:id.into()})
    }
}
