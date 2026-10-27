//! A preparation belongs to one opening and one AgentState. Publication and
//! opening invalidation share this lock; no ActiveRoot lock is taken under it.
use super::{lock, vault_key, AgentState};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, Weak};

const CLOSED: &str = "The workspace changed or is opening. Nothing was started.";

struct Generation {
    number: u64,
    enabled: bool,
    root: Option<PathBuf>,
}
impl Default for Generation {
    fn default() -> Self {
        // Preserve AgentState's standalone legacy lifecycle. Actual app opens
        // disable admission at entry and bind an exact root on publication.
        Self {
            number: 0,
            enabled: true,
            root: None,
        }
    }
}
#[derive(Default, Clone)]
pub(super) struct Admission {
    state: Arc<Mutex<Generation>>,
}

/// Opaque and never serialized: not a renderer- or agent-supplied capability.
pub(crate) struct RunPreparation {
    owner: Arc<Mutex<Generation>>,
    generation: u64,
    vault: PathBuf,
    entry: Arc<()>,
}

// Sealed only by guard_prepared after the original preparation is admitted.
// It preserves that entry identity, not a second opening generation.
#[derive(Clone)]
pub(crate) struct EntryWitness {
    owner: Weak<Mutex<Generation>>,
    entry: Weak<()>,
    generation: u64,
    vault: PathBuf,
}
impl EntryWitness {
    pub(super) fn same_entry(&self, other: &Self) -> bool {
        self.owner.ptr_eq(&other.owner)
            && self.entry.ptr_eq(&other.entry)
            && self.generation == other.generation
            && self.vault == other.vault
    }
    pub(crate) fn matches_preparation(&self, preparation: &RunPreparation) -> bool {
        self.owner.ptr_eq(&Arc::downgrade(&preparation.owner))
            && self
                .entry
                .upgrade()
                .is_some_and(|entry| Arc::ptr_eq(&entry, &preparation.entry))
            && self.generation == preparation.generation
            && self.vault == preparation.vault
    }
}
// One generation predicate serves original publication and retained reads.
fn generation_matches(
    owner: &Weak<Mutex<Generation>>,
    expected: u64,
    expected_vault: &Path,
    admission: &Admission,
    generation: &Generation,
    vault: &Path,
) -> bool {
    owner.ptr_eq(&Arc::downgrade(&admission.state))
        && generation.enabled
        && generation.number == expected
        && expected_vault == vault
        && generation
            .root
            .as_ref()
            .is_none_or(|root| root.as_path() == vault)
}
impl RunPreparation {
    fn matches(&self, admission: &Admission, generation: &Generation, vault: &Path) -> bool {
        generation_matches(
            &Arc::downgrade(&self.owner),
            self.generation,
            &self.vault,
            admission,
            generation,
            vault,
        )
    }
}
pub(crate) struct Publication<'a> {
    _held: MutexGuard<'a, Generation>,
    entry: EntryWitness,
}
impl Publication<'_> {
    pub(crate) fn entry_witness(&self) -> EntryWitness {
        self.entry.clone()
    }
}

// Held by retained provenance registration after the original stream returns.
// It cannot be constructed from a new preparation or callback supplied proof.
pub(crate) struct PublicationEntryGuard<'a> {
    _held: MutexGuard<'a, Generation>,
    state: &'a AgentState,
    preparation: &'a RunPreparation,
    receipt: &'a super::NativePublicationReceipt,
    vault: PathBuf,
}
impl PublicationEntryGuard<'_> {
    pub(crate) fn recheck(&self) -> bool {
        !self.state.closing()
            && self
                .receipt
                .matches_original_entry(self.preparation, &self.vault)
    }
}

impl AgentState {
    // Existing tests retain their boolean projection; production holds the
    // exact original entry gate through the retained provenance transaction.
    #[cfg(test)]
    pub(crate) fn matches_publication_entry(
        &self,
        preparation: &RunPreparation,
        vault: &Path,
        receipt: &super::NativePublicationReceipt,
    ) -> bool {
        self.guard_publication_entry(preparation, vault, receipt)
            .is_ok()
    }
    pub(crate) fn guard_publication_entry<'a>(
        &'a self,
        preparation: &'a RunPreparation,
        vault: &Path,
        receipt: &'a super::NativePublicationReceipt,
    ) -> Result<PublicationEntryGuard<'a>, String> {
        let vault = vault_key(vault);
        let generation = lock(&self.admission.state);
        if !preparation.matches(&self.admission, &generation, &vault)
            || self.closing()
            || !receipt.matches_original_entry(preparation, &vault)
        {
            return Err(CLOSED.into());
        }
        // This run already owns its process slot; do not re-admit capacity.
        Ok(PublicationEntryGuard {
            _held: generation,
            state: self,
            preparation,
            receipt,
            vault,
        })
    }

    pub(super) fn check_run_admission(&self) -> Result<(), String> {
        if !lock(&self.admission.state).enabled {
            return Err(CLOSED.into());
        }
        Ok(())
    }

    /// Capture opening identity before preparation, without requiring a process
    /// slot: ambient sweep/deterministic work must still run at process capacity.
    pub(crate) fn prepare_run(&self, vault: &Path) -> Result<RunPreparation, String> {
        let vault = vault_key(vault);
        let generation = lock(&self.admission.state);
        if !generation.enabled || generation.root.as_ref().is_some_and(|root| root != &vault) {
            return Err(CLOSED.into());
        }
        if self.closing() {
            return Err(super::QUITTING.into());
        }
        Ok(RunPreparation {
            owner: self.admission.state.clone(),
            generation: generation.number,
            vault,
            entry: Arc::new(()),
        })
    }

    /// Check an original preparation for metadata admission without allocating
    /// process capacity. Idempotent observations do not need a process slot.
    pub(crate) fn guard_generation_preparation(
        &self,
        preparation: &RunPreparation,
        vault: &Path,
    ) -> Result<Publication<'_>, String> {
        let vault=vault_key(vault);
        let generation=lock(&self.admission.state);
        if !preparation.matches(&self.admission,&generation,&vault)||self.closing() {
            return Err(CLOSED.into());
        }
        Ok(Publication {_held:generation,entry:EntryWitness {
            owner:Arc::downgrade(&self.admission.state),entry:Arc::downgrade(&preparation.entry),generation:preparation.generation,vault,
        }})
    }

    /// Hold through seat/config/child/slot/journal publication, never through
    /// discovery or a reader wait. Reopening the same root cannot revive a
    /// preparation from a prior generation.
    pub(super) fn guard_prepared(
        &self,
        preparation: &RunPreparation,
        vault: &Path,
    ) -> Result<Publication<'_>, String> {
        let vault = vault_key(vault);
        let generation = lock(&self.admission.state);
        if !preparation.matches(&self.admission, &generation, &vault) {
            return Err(CLOSED.into());
        }
        self.admit_limits()?;
        Ok(Publication {
            _held: generation,
            entry: EntryWitness {
                owner: Arc::downgrade(&preparation.owner),
                entry: Arc::downgrade(&preparation.entry),
                generation: preparation.generation,
                vault,
            },
        })
    }

    /// Use the root authority's generation, before waiting for OPEN_LOCK.
    /// Context generations can reach this lock out of order across handlers.
    pub(crate) fn begin_open(&self, number: u64) -> Result<(), String> {
        let mut generation = lock(&self.admission.state);
        if number <= generation.number {
            return Err(CLOSED.into());
        }
        generation.number = number;
        generation.enabled = false;
        generation.root = None;
        Ok(())
    }

    pub(crate) fn suspend_run_admission(&self) {
        lock(&self.admission.state).enabled = false;
    }

    /// Only the successful, still-current Legacy publication calls this, under
    /// ActiveRoot after its listener callback returned. Failed opens stay shut.
    pub(crate) fn complete_open(&self, number: u64, root: &Path) -> Result<(), String> {
        let root = vault_key(root);
        let mut generation = lock(&self.admission.state);
        if number != generation.number {
            return Err(CLOSED.into());
        }
        generation.root = Some(root);
        generation.enabled = true;
        Ok(())
    }
}

// Only successful committed native finalization retains the original seal.
pub(crate) struct RetainedPublicationEntry {
    witness: EntryWitness,
    _original: Arc<()>,
}
pub(crate) struct RetainedPublicationGuard<'a> {
    _held: MutexGuard<'a, Generation>,
    state: &'a AgentState,
    entry: &'a RetainedPublicationEntry,
    receipt: &'a super::NativePublicationReceipt,
}
impl RetainedPublicationGuard<'_> {
    pub(crate) fn recheck(&self) -> bool {
        !self.state.closing()
            && self.entry.witness.entry.upgrade().is_some()
            && self.receipt.matches_entry(&self.entry.witness)
    }
}
impl PublicationEntryGuard<'_> {
    pub(crate) fn retain_original_entry(&self) -> RetainedPublicationEntry {
        RetainedPublicationEntry {
            _original: self.preparation.entry.clone(),
            witness: EntryWitness {
                owner: Arc::downgrade(&self.preparation.owner),
                entry: Arc::downgrade(&self.preparation.entry),
                generation: self.preparation.generation,
                vault: self.preparation.vault.clone(),
            },
        }
    }
}
impl AgentState {
    pub(crate) fn guard_retained_publication<'a>(
        &'a self,
        entry: &'a RetainedPublicationEntry,
        receipt: &'a super::NativePublicationReceipt,
    ) -> Result<RetainedPublicationGuard<'a>, String> {
        let generation = lock(&self.admission.state);
        let witness = &entry.witness;
        if !generation_matches(
            &witness.owner,
            witness.generation,
            &witness.vault,
            &self.admission,
            &generation,
            &witness.vault,
        ) || witness.entry.upgrade().is_none()
            || self.closing()
            || !receipt.matches_entry(witness)
        {
            return Err(CLOSED.into());
        }
        Ok(RetainedPublicationGuard {
            _held: generation,
            state: self,
            entry,
            receipt,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::testutil;
    use crate::workspace_service::authority::AuthorityContext;
    use std::sync::mpsc;
    use std::time::Duration;

    fn open_legacy(context: &AuthorityContext, agents: &AgentState, root: &Path) {
        let generation = context.begin_open().unwrap();
        agents.begin_open(generation).unwrap();
        crate::finish_legacy_open(context, generation, root, agents, || {}).unwrap();
    }

    #[test]
    fn selected_roundtrip_refuses_stale_preparation_and_allows_a_fresh_legacy_run() {
        let _sink = crate::runtime::sink::test_lock();
        let _shadow = crate::ledger::shadow::testing::lock();
        let root = testutil::temp_vault("m99-admission-roundtrip");
        let origin = testutil::temp_vault("m99-admission-roundtrip-origin");
        let context = AuthorityContext::new(origin.clone());
        let agents = AgentState::default();
        open_legacy(&context, &agents, &root);
        let stale = agents.prepare_run(&root).unwrap();
        crate::suspend_legacy_for_selected(&Default::default(), &Default::default(), &agents)
            .unwrap();
        assert!(agents.prepare_run(&root).is_err());
        open_legacy(&context, &agents, &root);
        assert!(agents.guard_prepared(&stale, &root).is_err());
        let fresh = agents.prepare_run(&root).unwrap();
        assert!(agents.guard_prepared(&fresh, &root).is_ok());
        assert!(AgentState::default().guard_prepared(&fresh, &root).is_err());
        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(origin).unwrap();
    }

    #[test]
    fn selected_roundtrip_blocks_a_preparing_worker_before_resource_publication() {
        let _sink = crate::runtime::sink::test_lock();
        let _shadow = crate::ledger::shadow::testing::lock();
        let root = testutil::temp_vault("m99-admission-worker");
        let origin = testutil::temp_vault("m99-admission-worker-origin");
        let context = AuthorityContext::new(origin.clone());
        let agents = AgentState::default();
        open_legacy(&context, &agents, &root);
        let worker_agents = agents.clone();
        let worker_root = root.clone();
        let (prepared_tx, prepared_rx) = mpsc::channel();
        let (continue_tx, continue_rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let preparation = worker_agents.prepare_run(&worker_root).unwrap();
            prepared_tx.send(()).unwrap();
            continue_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            let _publication = worker_agents.guard_prepared(&preparation, &worker_root)?;
            // Same real guard as stream's first resource publication. If the
            // generation check regresses, this durable side effect catches it.
            std::fs::write(worker_root.join("unexpected-run-config"), "created").unwrap();
            Ok::<(), String>(())
        });
        prepared_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        crate::suspend_legacy_for_selected(&Default::default(), &Default::default(), &agents)
            .unwrap();
        open_legacy(&context, &agents, &root);
        continue_tx.send(()).unwrap();
        assert!(worker.join().unwrap().is_err());
        assert!(!root.join("unexpected-run-config").exists());
        assert_eq!(agents.live(), 0);
        assert!(agents.interactions.pending(&root).is_empty());
        assert!(agents.journal.vaults().is_empty());
        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(origin).unwrap();
    }

    #[test]
    fn opening_invalidation_waits_for_publication_then_closes_admission() {
        let agents = AgentState::default();
        let preparation = agents.prepare_run(Path::new("/v")).unwrap();
        let publication = agents
            .guard_prepared(&preparation, Path::new("/v"))
            .unwrap();
        let next = agents.clone();
        let (trying_tx, trying_rx) = mpsc::channel();
        let (opened_tx, opened_rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            trying_tx.send(()).unwrap();
            next.begin_open(1).unwrap();
            opened_tx.send(()).unwrap();
        });
        trying_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(opened_rx.recv_timeout(Duration::from_millis(100)).is_err());
        drop(publication);
        opened_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        worker.join().unwrap();
        assert!(agents.admit().is_err());
    }

    #[test]
    fn failed_or_superseded_open_cannot_enable_a_later_generation() {
        let agents = AgentState::default();
        agents.begin_open(1).unwrap();
        assert!(agents.admit().is_err());
        agents.begin_open(2).unwrap();
        assert!(agents.complete_open(1, Path::new("/v")).is_err());
        assert!(agents.begin_open(1).is_err());
        assert!(agents.admit().is_err());
        agents.complete_open(2, Path::new("/v")).unwrap();
        assert!(agents.prepare_run(Path::new("/v")).is_ok());
        assert!(agents.prepare_run(Path::new("/other")).is_err());
        agents.stop_all().unwrap();
        assert!(agents.prepare_run(Path::new("/v")).is_ok());
    }
}
