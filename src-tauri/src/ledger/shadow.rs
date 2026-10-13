//! The active ledger writer (M21.8, M23.3): one per process, for the open
//! vault.
//!
//! `with_writer` is the one door every ledger write goes through (concepts,
//! verify, capture, proposals, ingest). Without an active writer it returns
//! `None`, and the knowledge writers turn that into a
//! `ledger_writer_unavailable` refusal (M49.1): nothing writes the bundle
//! beside the ledger.
//!
//! The module's name is historical. It began as SHADOW recording — ordinary
//! vault writes observed into the chain as `vault.*` events — and M49.10
//! moved those to runtime.db (`runtime::vault_writes`): the ledger is the
//! epistemic record, and nothing ever read them.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;

use crate::assembly::corpus::Corpus;

use super::index::Index;
use super::recovery::{classify, Remembered, Verdict};
use super::reduce::EpistemicState;
use super::writer::{existing_writer_id, writer_id, LedgerWriter};
use super::{ledger_dir, read_ledger, store, LedgerHead, LedgerRead};

/// The one active shadow target (the app has one vault open at a time —
/// the watcher has the same shape). Replacing it drops the old writer,
/// which releases the ledger lock.
struct Active {
    vault: PathBuf,
    /// None when the startup verdict refused a writer.
    writer: Option<LedgerWriter>,
    /// Why `writer` is None — the refused verdict's sentence or the open
    /// error (a lost lock names its holder). `ledger_status` reports it
    /// (M49.2, K4); before, the reason was discarded with `.ok()`.
    absence: Option<String>,
    index: Option<Index>,
    writer_id: String,
    /// The M31.7 fold cache (D4): one `(state, corpus, head)` from ONE
    /// read, validated against the live writer head before every serve.
    /// `None` until the first cached read and after every conservative
    /// clear — a memo, never an authority.
    folded: Option<Arc<Folded>>,
}

/// One fold of one moment: what ask::read returns, cached whole so the
/// three can never describe different moments (ask.rs's invariant).
#[derive(Debug)]
pub struct Folded {
    pub state: EpistemicState,
    pub corpus: Corpus,
    /// Validation pair — comparable against `LedgerWriter::head()` and
    /// `LedgerRead` alike. seq `None` = folded from an empty ledger (a
    /// valid moment, not a sentinel).
    pub head_seq: Option<u64>,
    pub head_hash: String,
    /// What ask::read RETURNS as its head: the last frame's `event_id`, or
    /// its "genesis:" fallback. Carried, never compared — it is a different
    /// value from the chain hash and no writer-side counterpart exists.
    pub ask_head: String,
}

impl Folded {
    /// Does this fold describe the moment `head` names?
    fn describes(&self, head: &LedgerHead) -> bool {
        self.head_seq == head.seq && self.head_hash == head.hash
    }
}

fn active() -> &'static Mutex<Option<Active>> {
    static ACTIVE: OnceLock<Mutex<Option<Active>>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(None))
}

/// Best-effort canonicalization, same reasoning as the watcher's: recorded
/// and queried vault paths must agree even through symlinks.
fn normalize(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

/// Activate shadow recording for a vault — the M21.8 startup step, called
/// when the app starts watching it. Runs the M21.4 verification against the
/// index's remembered head, records the verdict, opens the single writer on
/// the recoverable verdicts (performing their recovery actions), replays
/// the M21.5 index, and remembers the head. Never an error: a refused
/// ledger holds no writer, every knowledge write refuses with
/// `ledger_writer_unavailable` (M49.1), and `ledger_status` says why.
///
/// Idempotent for the vault that already holds a live writer (M49.1, K2):
/// the webview re-runs `start_watcher` on every reload, and a second
/// `LedgerWriter::open` here would fail on the flock this same process
/// holds — replacing the working writer with that failure switched
/// recording off mid-session.
pub fn activate(config_dir: &Path, vault: &Path) -> Verdict {
    let vault = normalize(vault);
    let dir = ledger_dir(&vault);

    if let Some(live_id) = live_writer_id(&vault) {
        return classify(&dir, Some(&live_id), None).verdict;
    }
    // A stopped writer for THIS vault still holds the flock; it is released
    // before a fresh one opens, or the reopen would lose the lock to it.
    release_stopped_writer(&vault);

    let id = match writer_id(config_dir) {
        Ok(id) => id,
        Err(detail) => {
            let verdict = Verdict::Corrupt {
                detail: format!("writer identity unavailable: {detail}"),
            };
            replace_active(Active {
                vault,
                writer: None,
                absence: Some(verdict.to_string()),
                index: None,
                writer_id: String::new(),
                folded: None,
            });
            return verdict;
        }
    };

    // The startup verification (M21.4), with the remembered head when one
    // exists — this is where a restored-older-head or foreign store gets
    // named before anything opens for append.
    let remembered = store::load(&dir)
        .ok()
        .flatten()
        .and_then(|s| Index::open(config_dir, &s.store_id).ok())
        .and_then(|index| index.remembered().ok().flatten());
    let verdict = classify(&dir, Some(&id), remembered.as_ref()).verdict;

    let (mut writer, absence) = match &verdict {
        Verdict::Valid | Verdict::TornTail { .. } | Verdict::SealPending | Verdict::NoLedger => {
            // Recoverable (or empty) — open performs the recovery actions
            // and mints on first contact. A held lock (second instance)
            // leaves no writer: knowledge writes refuse,
            // and `ledger_status` reports `lost-lock` with the holder.
            match LedgerWriter::open(&vault, &id) {
                Ok(writer) => (Some(writer), None),
                Err(error) => (None, Some(error)),
            }
        }
        refused => (None, Some(refused.to_string())),
    };

    // M49.10 (K26): the store this machine last saw in THIS FOLDER. The
    // index is keyed by store, so a vault whose `.cerebro/` was deleted
    // mints a fresh store, meets a fresh empty index, and used to start a
    // new baseline in silence — forgeries included. A different store in
    // the same folder (same path AND same birth time) is a rewound history,
    // and says so. A NEW folder at a known path — the vault re-cloned there,
    // the demo vault re-created — is a new vault and a new baseline.
    let current_store = store::load(&dir).ok().flatten().map(|s| s.store_id);
    let born = folder_birth(&vault);
    let reminted = match (known_store(config_dir, &vault), current_store.as_deref()) {
        (Some(known), Some(current)) => {
            known.store_id != current && known.born.is_some() && known.born == born
        }
        _ => false,
    };

    // Arm the migrator (M23.0) BEFORE the index replay, so the index sees
    // the migration events it appends. A typed refusal becomes the M23.6
    // circuit breaker's migration signal; the writer stays open either way
    // (agent writes continue).
    if let Some(writer) = writer.as_mut() {
        let arming = super::arm::arm(writer, &vault);
        let migration_signal = match &arming {
            super::arm::Arming::Refused(err) => match err.signal() {
                Some("migration_source_changed") => {
                    Some(super::schema::DivergenceSignal::MigrationSourceChanged)
                }
                Some("migration_idempotency_conflict") => {
                    Some(super::schema::DivergenceSignal::MigrationIdempotencyConflict)
                }
                _ => None,
            },
            _ => None,
        };
        // A re-mint with no concepts has nothing a fresh baseline could
        // launder, and a divergence over zero projections could never be
        // resolved — so it is only flagged when there is knowledge to lose.
        let flag_remint = reminted
            && read_ledger(&dir)
                .map(|read| {
                    !super::reduce::reduce(&read.frames, writer.store_id())
                        .projection_paths
                        .is_empty()
                })
                .unwrap_or(false);
        let signal = migration_signal
            .or(flag_remint.then_some(super::schema::DivergenceSignal::RememberedHeadRegression));
        // The M23.6 launch scan: safe recoveries execute, out-of-band edits
        // park for M23.7, divergence records once and opens the mode. Its
        // own failure must never block activation.
        let scanned = super::reconcile::launch_scan(
            writer,
            &vault,
            signal,
            remembered.as_ref().map(|r| r.head_hash.as_str()),
        );
        // The folder's store is remembered only once a re-mint it names is
        // RECORDED — remembered first, a failed record would absorb it.
        let recorded = !flag_remint
            || scanned
                .as_ref()
                .is_ok_and(|outcome| outcome.divergence_recorded.is_some());
        if let (true, Some(current)) = (recorded, current_store.as_deref()) {
            remember_store(config_dir, &vault, current, born);
        }
    }

    // Replay the disposable index and remember the (possibly recovered)
    // head — only when a writer opened: a refused ledger must not overwrite
    // the remembered head that named the refusal.
    let index = if writer.is_some() {
        read_ledger(&dir).ok().and_then(|read| {
            let mut index = Index::open(config_dir, &read.store.store_id).ok()?;
            match index.replay(&read, &id) {
                Ok(()) => Some(index),
                // A cache that refuses because it has seen a DIFFERENT
                // history at a seq it holds (M49.10, K26): the ledger was
                // rewound or replaced underneath it. That is recorded as a
                // divergence first — it used to be rebuilt in silence — and
                // then the cache is rebuilt from the segments. A replay that
                // failed for an operational reason (a full disk, an I/O
                // error in the cache) is only rebuilt: a disposable cache
                // failing is not a rewound history.
                Err(e) => {
                    let rewound = e.contains("diverged, not replayable");
                    if let (true, Some(writer)) = (rewound, writer.as_mut()) {
                        let _ = super::reconcile::launch_scan(
                            writer,
                            &vault,
                            Some(super::schema::DivergenceSignal::RememberedHeadRegression),
                            remembered.as_ref().map(|r| r.head_hash.as_str()),
                        );
                    }
                    index.rebuild(&read, &id).ok()
                }
            }
        })
    } else {
        None
    };

    replace_active(Active {
        vault,
        writer,
        absence,
        index,
        writer_id: id,
        folded: None,
    });
    // The verdict is "recorded" as the writer gate above and as the live
    // ledger_status surface — returned here for the startup caller.
    verdict
}

/// The M31.7 fold cache (D4): one `read_ledger` + `reduce` +
/// `Corpus::from_frames`, cached as a whole triple and VALIDATED against
/// the live writer head before every serve — so a ledger-first append that
/// went through `with_writer` (which no shadow hook observes) turns a
/// stale memo into a cache miss, never a divergence.
///
/// Snapshot under the lock, fold OUTSIDE it, install only if unchanged: a
/// full-ledger fold under `active()`'s mutex would stall every
/// `with_writer` closure.
///
/// **The no-writer fallback is part of the contract.** When no Active
/// writer holds this vault (a refused verdict, a second instance that lost
/// the single-writer lock, tests without activation), this folds from disk
/// and returns the result UNCACHED — today's pure-disk read-only ask path,
/// preserved exactly. There is no live head to validate a memo against, so
/// there is no memo.
///
/// Never call from inside a `with_writer` closure — the active
/// lock is held there and `std::sync::Mutex` is non-reentrant; a closure
/// calling this would deadlock. (Nothing does it today; this sentence is
/// the fence.)
pub fn state_of(vault: &Path) -> Result<Arc<Folded>, String> {
    let vault = normalize(vault);
    if let Some(cached) = cached_if_current(&vault) {
        return Ok(cached);
    }
    // The miss path: fold from the committed bytes, holding no lock.
    let read = read_ledger(&ledger_dir(&vault)).map_err(|e| format!("ledger: {e}"))?;
    let folded = Arc::new(fold(&read));
    install_if_unchanged(&vault, &folded);
    Ok(folded)
}

/// The whole triple from one `LedgerRead` — the same three derivations
/// ask::read performed inline before M31.7, taken from the same one pass.
fn fold(read: &LedgerRead) -> Folded {
    Folded {
        state: super::reduce::reduce(&read.frames, &read.store.store_id),
        corpus: Corpus::from_frames(&read.frames),
        head_seq: read.head_seq,
        head_hash: read.head_hash.clone(),
        ask_head: read
            .frames
            .last()
            .map(|frame| frame.event_id.clone())
            .unwrap_or_else(|| format!("genesis:{}", read.store.store_id)),
    }
}

/// Serve the memo only when it describes the writer's live head, this
/// moment, under the lock. Any other answer — no Active entry, another
/// vault, no writer, a fail-stopped writer with no head to compare, no
/// memo, a stale memo — is a miss.
fn cached_if_current(vault: &Path) -> Option<Arc<Folded>> {
    let guard = active().lock().ok()?;
    let active = guard.as_ref()?;
    if active.vault != *vault {
        return None;
    }
    let head = active.writer.as_ref()?.head()?;
    let folded = active.folded.as_ref()?;
    if folded.describes(&head) {
        Some(Arc::clone(folded))
    } else {
        None
    }
}

/// Re-lock and install ONLY if the writer's live head still equals the
/// head the fold was read at. On a mismatch the fresh fold goes back to
/// the caller UNCACHED rather than being refolded in a loop: the caller
/// still gets one coherent moment (merely no longer the newest), which is
/// exactly what the raw `read_ledger` gave it under a concurrent append
/// before M31.7 — and a retry loop could chase a busy writer without
/// bound.
fn install_if_unchanged(vault: &Path, folded: &Arc<Folded>) {
    let Ok(mut guard) = active().lock() else {
        return;
    };
    let Some(active) = guard.as_mut() else {
        return;
    };
    if active.vault != *vault {
        return;
    }
    let Some(head) = active.writer.as_ref().and_then(LedgerWriter::head) else {
        return;
    };
    if folded.describes(&head) {
        active.folded = Some(Arc::clone(folded));
    }
}

/// Which store this machine last saw at each vault path (M49.10, K26), in
/// app-data beside the index. A missing or unreadable file knows nothing,
/// which is the same as never having seen the path.
const KNOWN_STORES: &str = "vault-stores.json";

/// The store last seen in one vault folder, and the folder's birth time —
/// what tells "this folder's ledger was deleted" from "a new folder now
/// sits at this path".
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
struct KnownStore {
    store_id: String,
    born: Option<u64>,
}

/// The vault folder's creation time (nanoseconds), where the filesystem
/// keeps one (APFS does). `None` makes a re-mint undetectable rather than
/// guessed.
fn folder_birth(vault: &Path) -> Option<u64> {
    let created = std::fs::metadata(vault).ok()?.created().ok()?;
    u64::try_from(
        created
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?
            .as_nanos(),
    )
    .ok()
}

fn known_stores(config_dir: &Path) -> std::collections::BTreeMap<String, KnownStore> {
    std::fs::read_to_string(config_dir.join(KNOWN_STORES))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn known_store(config_dir: &Path, vault: &Path) -> Option<KnownStore> {
    known_stores(config_dir).remove(&*vault.to_string_lossy())
}

fn remember_store(config_dir: &Path, vault: &Path, store_id: &str, born: Option<u64>) {
    let mut map = known_stores(config_dir);
    let next = KnownStore {
        store_id: store_id.to_string(),
        born,
    };
    if map.get(&*vault.to_string_lossy()) == Some(&next) {
        return;
    }
    map.insert(vault.to_string_lossy().into_owned(), next);
    if let Ok(raw) = serde_json::to_string_pretty(&map) {
        let _ = std::fs::create_dir_all(config_dir);
        let _ = std::fs::write(config_dir.join(KNOWN_STORES), raw);
    }
}

/// The writer id of the live writer already holding `vault`, if one does.
/// A FAIL-STOPPED writer is not live: reopening the vault is the recovery
/// its refusal tells the person to do, and that has to replace it (M49.10).
fn live_writer_id(vault: &Path) -> Option<String> {
    let guard = active().lock().ok()?;
    let active = guard.as_ref()?;
    let live = active
        .writer
        .as_ref()
        .and_then(LedgerWriter::head)
        .is_some();
    (active.vault == vault && live).then(|| active.writer_id.clone())
}

/// Drop this vault's writer if it is still held but no longer live.
fn release_stopped_writer(vault: &Path) {
    if let Ok(mut guard) = active().lock() {
        if let Some(active) = guard.as_mut().filter(|a| a.vault == vault) {
            active.writer = None;
            active.index = None;
            active.folded = None;
        }
    }
}

fn replace_active(next: Active) {
    if let Ok(mut guard) = active().lock() {
        *guard = Some(next);
    }
}

/// Drop the active shadow target (releases the ledger lock). Used by tests;
/// the app itself just replaces the target on vault switch.
#[cfg(test)]
pub(crate) fn deactivate() {
    if let Ok(mut guard) = active().lock() {
        *guard = None;
    }
}

/// Run `f` against this vault's ACTIVE ledger writer — the door the M23.3
/// canonical knowledge write paths use. `None` when no writer is active
/// for the vault (unit fixtures, a refused ledger, a second instance that
/// lost the lock). `None` is a refusal, never a cue to write the file
/// directly: the knowledge writers turn it into `ledger_writer_unavailable`
/// (M49.1), and `ledger_status` names why.
pub fn with_writer<T>(vault: &Path, f: impl FnOnce(&mut LedgerWriter) -> T) -> Option<T> {
    let mut guard = active().lock().ok()?;
    let active = guard.as_mut()?;
    if active.vault != normalize(vault) {
        return None;
    }
    let writer = active.writer.as_mut()?;
    // Belt (M31.7): the closure may append, so the memo is conservatively
    // dropped before it runs. `state_of`'s head check is the suspenders —
    // a missed clear is a cache miss, never a divergence.
    active.folded = None;
    let out = f(writer);
    // M49.10 (K26): the secondary anchor follows EVERY append — it used to
    // follow only the shadow events, and a head remembered behind the real
    // one is a rewind the next launch cannot see.
    remember_head(active);
    Some(out)
}

/// Keep the index's remembered head at the writer's live head.
fn remember_head(active: &mut Active) {
    let head = active.writer.as_ref().and_then(LedgerWriter::head);
    if let (Some(index), Some(head)) = (active.index.as_mut(), head) {
        if let Ok(Some(remembered)) = index.remembered() {
            if remembered.head_seq != head.seq || remembered.head_hash != head.hash {
                let _ = index.remember(
                    &Remembered {
                        store_id: remembered.store_id,
                        head_seq: head.seq,
                        head_hash: head.hash,
                    },
                    &active.writer_id,
                );
            }
        }
    }
}

/// Diagnostics for `ledger_status` (M21.8): a LIVE classification — the
/// stored startup verdict ages, disk does not. Read-only: no minting, no
/// index creation, no side effects.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LedgerStatus {
    /// The verdict's kebab-case state tag (`valid`, `torn-tail`, …).
    pub verdict: String,
    /// The verdict's human sentence.
    pub detail: String,
    /// Committed head hash (the store id for an empty ledger).
    pub head: Option<String>,
    pub seq: Option<u64>,
    pub segments: u64,
    /// Wall-clock anomalies recorded across the committed history (D3:
    /// recorded, never smoothed over).
    pub anomalies: u64,
    /// The M23.6 circuit breaker: is the named reconciliation mode open?
    pub reconciliation_open: bool,
    /// Unresolved divergence detection keys while the mode is open.
    pub divergences: Vec<String>,
    /// Every file that is not the ledger's, with why (M49.6, K13) — empty
    /// when every file matches its recorded history.
    pub quarantined: Vec<super::reconcile::QuarantinedPath>,
    /// Is capture stopped for the WHOLE vault (a mass mismatch, a
    /// migration refusal, a rewound head) rather than per file? (M49.5)
    pub stopped: bool,
    /// The vault HAS a ledger and its history could not be read (corrupt,
    /// forked, a second writer) — so `quarantined` above could not be
    /// computed and is not "nothing quarantined". The UI trusts no file's
    /// review claim while this holds, as `knowledge::trust_label` does.
    pub history_unreadable: bool,
    /// `[replacement, replaced]` supersessions a person approved on a card
    /// (M49.8, K22) — what `listConcepts` gates retirement on, as
    /// `knowledge::about` does.
    pub approved_supersessions: Vec<(String, String)>,
    /// Concepts whose current revision the ledger records as reviewed by a
    /// person (`knowledge::recorded_human`) — what `listConcepts` gates
    /// supersession on, as `knowledge::about` does, instead of the file's
    /// own stamp.
    pub recorded_human: Vec<String>,
    /// Whether THIS process is recording this vault right now (M49.2, K4).
    /// The verdict above is classified from disk and cannot say it: a valid
    /// ledger with no writer — a lost lock, a vault switch — refuses every
    /// knowledge write, and that went unseen at least 8 times in August.
    pub writer: WriterStatus,
}

/// The live writer, as `ledger_status` reports it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WriterStatus {
    /// `held` — recording. `lost-lock` — another Cerebro process holds this
    /// vault's ledger. `refused` — the startup verdict (or the writer
    /// identity) refused a writer. `fail-stopped` — the writer stopped after
    /// a failed write, fsync, or segment rotation (M49.10, K34).
    /// `other-vault` — this process records a different
    /// vault. `inactive` — nothing has been activated in this process.
    pub state: &'static str,
    /// The reason, verbatim, for every state but `held`.
    pub detail: Option<String>,
}

fn writer_status(vault: &Path) -> WriterStatus {
    let status = |state, detail: Option<String>| WriterStatus { state, detail };
    let Ok(guard) = active().lock() else {
        return status("inactive", Some("the ledger state lock is poisoned".into()));
    };
    let Some(active) = guard.as_ref() else {
        return status(
            "inactive",
            Some("no vault has been opened for recording".into()),
        );
    };
    if active.vault != vault {
        return status(
            "other-vault",
            Some(format!("recording {} instead", active.vault.display())),
        );
    }
    match (&active.writer, &active.absence) {
        (Some(writer), _) if writer.head().is_some() => status("held", None),
        (Some(_), _) => status(
            "fail-stopped",
            Some(
                "the ledger writer stopped after a failed write, fsync, or segment rotation — \
                 reopen the vault to restart it"
                    .into(),
            ),
        ),
        (None, Some(reason)) if reason.starts_with(super::writer::LEDGER_LOCK_HELD) => {
            status("lost-lock", Some(reason.clone()))
        }
        (None, reason) => status("refused", reason.clone()),
    }
}

pub fn status(config_dir: Option<&Path>, vault: &Path) -> LedgerStatus {
    let dir = ledger_dir(&normalize(vault));
    let id = config_dir.and_then(existing_writer_id);
    // Read-only (M49.10, K35): a status read never deletes, creates, or
    // migrates the index.
    let remembered = config_dir.and_then(|config| {
        let store = store::load(&dir).ok().flatten()?;
        let index = Index::open_read_only(config, &store.store_id)
            .ok()
            .flatten()?;
        index.remembered().ok().flatten()
    });
    let recovery = classify(&dir, id.as_deref(), remembered.as_ref());
    let verdict_tag = serde_json::to_value(&recovery.verdict)
        .ok()
        .and_then(|v| v.get("state").and_then(|s| s.as_str()).map(String::from))
        .unwrap_or_else(|| "unknown".to_string());
    let vault_path = normalize(vault);
    let history_unreadable =
        recovery.read.is_none() && !matches!(recovery.verdict, Verdict::NoLedger);
    let state = recovery
        .read
        .as_ref()
        .map(|read| super::reduce::reduce(&read.frames, &read.store.store_id));
    let approved_supersessions = state
        .as_ref()
        .map(crate::knowledge::approved_supersessions)
        .unwrap_or_default();
    let recorded_human = state
        .as_ref()
        .map(crate::knowledge::recorded_human)
        .unwrap_or_default();
    let (head, seq, segments, anomalies, reconciliation_open, divergences, quarantined, stopped) =
        match (&recovery.read, &state) {
            (Some(read), Some(state)) => {
                (
                    Some(read.head_hash.clone()),
                    read.head_seq,
                    read.segments.len() as u64,
                    read.frames.iter().filter(|f| f.wall_clock_anomaly).count() as u64,
                    state.reconciliation_open(),
                    state.reconciliation_divergences.keys().cloned().collect(),
                    // A report that could not be computed is not "nothing
                    // quarantined": the unreadable path is named instead.
                    super::reconcile::quarantine_report(&vault_path, state).unwrap_or_else(|e| {
                        vec![super::reconcile::QuarantinedPath {
                            path: "knowledge/".to_string(),
                            class: "refused",
                            reason: format!("the bundle could not be compared: {e}"),
                        }]
                    }),
                    super::reconcile::global_stop(&vault_path, state).unwrap_or(true),
                )
            }
            _ => (None, None, 0, 0, false, Vec::new(), Vec::new(), false),
        };
    LedgerStatus {
        verdict: verdict_tag,
        detail: recovery.verdict.to_string(),
        head,
        seq,
        segments,
        anomalies,
        reconciliation_open,
        divergences,
        quarantined,
        stopped,
        history_unreadable,
        approved_supersessions,
        recorded_human,
        writer: writer_status(&vault_path),
    }
}

/// The Active slot is process-global, so every test in the crate that
/// touches it shares one lock.
#[cfg(test)]
pub(crate) mod testing {
    use std::path::Path;
    use std::sync::{Mutex, MutexGuard};

    static SHADOW_LOCK: Mutex<()> = Mutex::new(());

    pub(crate) fn lock() -> MutexGuard<'static, ()> {
        SHADOW_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Make `vault` the active target with a live writer, the way the app's
    /// startup does. Hold the guard for as long as the test writes: the
    /// knowledge writers refuse without an active writer (M49.1).
    pub(crate) fn activated(vault: &Path) -> MutexGuard<'static, ()> {
        let guard = lock();
        super::deactivate();
        let config = crate::vault::testutil::temp_vault("shadow-activated-config");
        super::activate(&config, vault);
        guard
    }
}

#[cfg(test)]
mod tests {
    use super::testing::lock;
    use super::*;
    use crate::vault::testutil;
    use crate::vault::write as vw;

    fn fm(pairs: &[(&str, serde_json::Value)]) -> serde_json::Map<String, serde_json::Value> {
        pairs
            .iter()
            .cloned()
            .map(|(k, v)| (k.to_string(), v))
            .collect()
    }

    #[test]
    fn an_ordinary_write_never_grows_a_ledger() {
        let _guard = lock();
        deactivate();
        let vault = testutil::temp_vault("shadow-inactive");
        testutil::write(&vault, "items/a.md", "# A\n");
        vw::save_note(&vault, "items/a.md", "\n# A\n\nEdited.\n").unwrap();
        assert!(
            !ledger_dir(&vault).exists(),
            "no activation, no ledger — unit tests and browser builds never grow one"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_refused_ledger_records_nothing_and_never_fails_the_write() {
        let _guard = lock();
        deactivate();
        let vault = testutil::temp_vault("shadow-refused");
        let config = testutil::temp_vault("shadow-refused-config");
        testutil::write(&vault, "items/a.md", "# A\n");
        // A pre-damaged ledger: store.json plus terminated garbage where a
        // segment should be.
        let dir = ledger_dir(&vault);
        store::load_or_mint(&dir).unwrap();
        let id = writer_id(&config).unwrap();
        std::fs::write(
            dir.join(format!("{id}-{:016}.ndjsonl.open", 1)),
            "terminated garbage\n",
        )
        .unwrap();

        let verdict = activate(&config, &vault);
        assert!(matches!(verdict, Verdict::Corrupt { .. }), "{verdict:?}");
        // The write it would have shadowed goes through untouched…
        vw::save_note(&vault, "items/a.md", "\n# A\n\nStill works.\n").unwrap();
        // …no event was recorded anywhere…
        assert!(
            read_ledger(&dir).is_err(),
            "ledger unchanged, still corrupt"
        );
        // …and status says why, live.
        let status = status(Some(config.as_path()), &vault);
        assert_eq!(status.verdict, "corrupt");
        assert!(status.detail.contains("corrupt"), "{}", status.detail);
        deactivate();
        let _ = std::fs::remove_dir_all(&vault);
        let _ = std::fs::remove_dir_all(&config);
    }

    #[test]
    fn status_on_a_bare_vault_is_no_ledger() {
        let vault = testutil::temp_vault("shadow-status-none");
        let status = status(None, &vault);
        assert_eq!(status.verdict, "no-ledger");
        assert_eq!(status.head, None);
        assert_eq!(status.seq, None);
        assert_eq!(status.segments, 0);
        assert_eq!(status.anomalies, 0);
        let _ = std::fs::remove_dir_all(&vault);
    }

    /// A config dir and a bare vault, ready for `activate` — the M31.7 fold
    /// cache tests fold real ledgers, so the vault is real, just empty.
    fn test_vault(label: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        let config = testutil::temp_vault(&format!("{label}-config"));
        let vault = testutil::temp_vault(label);
        (config, vault)
    }

    /// Append one event through `with_writer` — DELIBERATELY the ledger-first
    /// door `record` never sees. That choice is itself the regression test
    /// for the bypass D4 exists to survive: the cache must stay honest even
    /// when no shadow hook observed the append.
    fn append_test_event(vault: &Path) {
        with_writer(vault, |writer| {
            writer
                .append(
                    "vault.write",
                    serde_json::json!({ "path": "records/poke.md" }),
                )
                .unwrap();
        })
        .expect("an active writer holds this vault");
    }

    /// A vault whose ledger already holds `n` events, seeded through a raw
    /// writer BEFORE activation (dropped at return so `activate` can take
    /// the single-writer lock).
    fn seeded_vault_with_events(label: &str, n: u64) -> (std::path::PathBuf, std::path::PathBuf) {
        let (config, vault) = test_vault(label);
        let id = writer_id(&config).unwrap();
        let mut writer = LedgerWriter::open(&vault, &id).unwrap();
        for i in 0..n {
            writer
                .append(
                    "vault.write",
                    serde_json::json!({ "path": format!("records/seed-{i}.md") }),
                )
                .unwrap();
        }
        (config, vault)
    }

    #[test]
    fn the_state_is_folded_once_and_reused() {
        let _guard = lock();
        deactivate();
        let (config, vault) = test_vault("fold-once");
        activate(&config, &vault);
        let a = state_of(&vault).unwrap();
        let b = state_of(&vault).unwrap();
        assert!(
            std::sync::Arc::ptr_eq(&a, &b),
            "a second read re-folded the ledger"
        );
        deactivate();
        let _ = std::fs::remove_dir_all(&vault);
        let _ = std::fs::remove_dir_all(&config);
    }

    #[test]
    fn an_append_through_with_writer_invalidates() {
        let _guard = lock();
        deactivate();
        let (config, vault) = test_vault("either-door");
        activate(&config, &vault);
        // The one door since M49.10 moved the shadow path (`record`) to
        // runtime.db: ledger-first, through `with_writer`.
        let before = state_of(&vault).unwrap();
        append_test_event(&vault);
        let after = state_of(&vault).unwrap();
        assert!(
            !std::sync::Arc::ptr_eq(&before, &after),
            "the cache served a fold from before the with_writer append"
        );
        deactivate();
        let _ = std::fs::remove_dir_all(&vault);
        let _ = std::fs::remove_dir_all(&config);
    }

    #[test]
    fn the_cache_is_a_memo_and_never_a_divergence() {
        let _guard = lock();
        deactivate();
        let (config, vault) = seeded_vault_with_events("memo", 40);
        activate(&config, &vault);
        for _ in 0..5 {
            append_test_event(&vault);
            let cached = state_of(&vault).unwrap();
            let read = read_ledger(&ledger_dir(&vault)).unwrap();
            let fresh = crate::ledger::reduce::reduce(&read.frames, &read.store.store_id);
            assert_eq!(
                cached.state, fresh,
                "a cached state equals a fresh fold, always"
            );
            // The cached UNIT is the triple (D4) — pin the other two limbs.
            assert_eq!(cached.corpus, Corpus::from_frames(&read.frames));
            assert_eq!(
                cached.ask_head,
                read.frames.last().unwrap().event_id,
                "ask_head is the fresh last frame's event id"
            );
        }
        deactivate();
        let _ = std::fs::remove_dir_all(&vault);
        let _ = std::fs::remove_dir_all(&config);
    }

    /// Copy the golden corpus READ-ONLY into a scratch vault. The source is
    /// never written and no mtime moves — the distiller trap stays cold.
    fn copy_demo_vault(label: &str) -> std::path::PathBuf {
        let src = Path::new("../demo-vault");
        let dst = testutil::temp_vault(label);
        for entry in walkdir::WalkDir::new(src)
            .into_iter()
            .filter_map(Result::ok)
        {
            let rel = entry.path().strip_prefix(src).unwrap();
            if rel.as_os_str().is_empty() {
                continue;
            }
            let target = dst.join(rel);
            if entry.file_type().is_dir() {
                std::fs::create_dir_all(&target).unwrap();
            } else if entry.file_type().is_file() {
                if let Some(parent) = target.parent() {
                    std::fs::create_dir_all(parent).unwrap();
                }
                std::fs::copy(entry.path(), &target).unwrap();
            }
        }
        dst
    }

    // The M21 exit criterion: a ledger-enabled vault soaked with every
    // write path, and the chain verifies at the end. (vault.delete's
    // emission is wired in delete_note but not soaked — its happy path
    // routes through the OS trash, which the write.rs tests already decline
    // to pollute; the record() call it makes is the same one soaked here.)
    #[test]
    fn demo_vault_soak_chain_verifies_and_every_kind_flows() {
        let _guard = lock();
        deactivate();
        let vault = copy_demo_vault("shadow-soak");
        let config = testutil::temp_vault("shadow-soak-config");
        let verdict = activate(&config, &vault);
        assert_eq!(verdict, Verdict::NoLedger, "fresh copy starts unledgered");
        // Activation armed the migrator (M23.0): the knowledge corpus is now
        // committed history and the initial projection manifest exists. The
        // soak's own writes land on top of that baseline.
        let baseline = read_ledger(&ledger_dir(&vault)).unwrap().records;
        assert!(baseline > 2, "migration outputs plus the two brackets");
        assert!(super::super::manifest::load(&vault).unwrap().is_some());

        let rel = vw::create_note(
            &vault,
            "records",
            "soak-note",
            &fm(&[("type", serde_json::json!("Work item"))]),
            "# Soak note\n",
        )
        .unwrap();
        vw::save_note(&vault, &rel, "\n# Soak note\n\nEdited body.\n").unwrap();
        vw::update_frontmatter(&vault, &rel, &fm(&[("status", serde_json::json!("done"))]))
            .unwrap();
        vw::set_note_title(&vault, &rel, "Soaked").unwrap();
        vw::write_concept(
            &vault,
            "knowledge/concepts/soak.md",
            &fm(&[
                ("about", serde_json::json!("soak")),
                (
                    "generated",
                    serde_json::json!({"by": "soak-agent", "at": "2026-08-07"}),
                ),
            ]),
            "The soak concept.",
        )
        .unwrap();
        let viewed = crate::ledger::sha256_hex(
            vw::read_note(&vault, "knowledge/concepts/soak.md")
                .unwrap()
                .as_bytes(),
        );
        vw::verify_frontmatter(
            &vault,
            "knowledge/concepts/soak.md",
            &fm(&[(
                "verified",
                serde_json::json!({"by": "human", "at": "2026-08-07"}),
            )]),
            &viewed,
        )
        .unwrap();
        vw::write_source(
            &vault,
            "sources/soak-src.md",
            &fm(&[("url", serde_json::json!("https://example.com"))]),
            "Cached body.",
        )
        .unwrap();
        vw::append_knowledge_log(&vault, "knowledge/concepts/soak.md", "Soak", false).unwrap();
        vw::save_collection(&vault, "soak-collection", "name: Soak\n").unwrap();
        vw::save_list(&vault, "soak-collection", "soak-list", "name: Soak list\n").unwrap();
        vw::save_view(&vault, "soak-view", "name: Soak view\n", None).unwrap();
        vw::rename_note(&vault, &rel, "records/soak-renamed.md").unwrap();

        // The soak's point: the chain over everything above VERIFIES.
        // Twelve writes, seven events — the epistemic ones. The governed
        // concept write is four (`proposal.submitted`, then the apply batch:
        // `belief.created` + `proposal.applied` under `batch.committed`),
        // the verify two (a field revision plus its attestation), the log
        // append one. The nine ordinary vault writes are operational and
        // go to runtime.db since M49.10 — none of them is in the chain.
        let read = read_ledger(&ledger_dir(&vault)).unwrap();
        assert_eq!(read.records, baseline + 7, "no write lost, none doubled");
        let kinds: std::collections::BTreeSet<&str> =
            read.frames.iter().map(|f| f.kind.as_str()).collect();
        assert!(!kinds.contains("vault.write"));
        assert!(!kinds.contains("vault.rename"));
        // The M23.3/M23.4 flip: a concept write is a committed Belief
        // creation (the log append its revision), and a human verify is a
        // field revision plus its attestation — no shadow observations.
        assert!(kinds.contains("belief.created"));
        assert!(kinds.contains("belief.revised"));
        assert!(kinds.contains("belief.attested"));
        // The M24.4 flip: that creation is the PROJECTION of an applied
        // proposal, not a decision the adapter made on its own.
        assert!(kinds.contains("proposal.submitted"));
        assert!(kinds.contains("proposal.applied"));
        assert!(kinds.contains("batch.committed"));

        // Bodies carry what the plan says they carry.
        let concept = read
            .frames
            .iter()
            .find(|f| {
                f.kind == "belief.created"
                    && f.body["subject"]["aliases"] == serde_json::json!(["concepts/soak.md"])
            })
            .unwrap();
        assert_eq!(concept.body["actor"]["id"], "soak-agent");
        assert_eq!(concept.body["fields"]["generated"]["by"], "soak-agent");
        let soak_belief = serde_json::json!(crate::ledger::schema::migrate_id(
            &read.store.store_id,
            "belief",
            "concepts/soak.md"
        ));
        assert!(
            read.frames
                .iter()
                .any(|f| f.kind == "belief.attested" && f.body["belief_id"] == soak_belief),
            "the verify attested the soak concept (migration attested others)"
        );
        // The file on disk is the byte-stable projection, stamp included in
        // canonical spelling.
        let disk = std::fs::read_to_string(vault.join("knowledge/concepts/soak.md")).unwrap();
        assert!(
            disk.contains("verified: { by: human, at: 2026-08-07 }"),
            "{disk}"
        );
        // Diagnostics agree, live.
        let status = status(Some(config.as_path()), &vault);
        assert_eq!(status.verdict, "valid");
        assert_eq!(status.seq, Some(baseline + 7));
        assert_eq!(status.head, Some(read.head_hash.clone()));
        assert_eq!(status.segments, 1);
        assert_eq!(status.anomalies, 0);

        // The secondary anchor stayed fresh: the index remembers the head
        // after every commit, not just at activate.
        let index = Index::open(&config, &read.store.store_id).unwrap();
        let remembered = index.remembered().unwrap().unwrap();
        assert_eq!(remembered.head_seq, Some(baseline + 7));
        assert_eq!(remembered.head_hash, read.head_hash);

        deactivate();
        let _ = std::fs::remove_dir_all(&vault);
        let _ = std::fs::remove_dir_all(&config);
    }

    // M49.1 (K2): the webview re-runs start_watcher on every reload. A
    // second open on the same vault used to fail on this process's own
    // flock and replace the working writer with None.
    #[test]
    fn activate_twice_keeps_writer() {
        let _guard = lock();
        deactivate();
        let vault = testutil::temp_vault("shadow-activate-twice");
        let config = testutil::temp_vault("shadow-activate-twice-config");
        assert_eq!(activate(&config, &vault), Verdict::NoLedger);
        assert_eq!(activate(&config, &vault), Verdict::Valid);
        assert!(
            with_writer(&vault, |_| ()).is_some(),
            "the live writer survived"
        );

        let before = read_ledger(&ledger_dir(&vault)).unwrap().records;
        vw::write_concept(
            &vault,
            "knowledge/concepts/twice.md",
            &fm(&[("description", serde_json::json!("Still recording."))]),
            "# Twice\n\nStill recording.",
        )
        .unwrap();
        assert!(read_ledger(&ledger_dir(&vault)).unwrap().records > before);

        deactivate();
        let _ = std::fs::remove_dir_all(&vault);
        let _ = std::fs::remove_dir_all(&config);
    }

    // M49.1 (K1): the incident's direct cause was a file-first fallback
    // that wrote concepts, verifies and log lines beside the ledger. With
    // no writer for the vault — never activated, or another vault active —
    // each of the three refuses and the disk is byte-for-byte unchanged.
    #[test]
    fn write_concept_without_writer_refuses_and_writes_nothing() {
        let _guard = lock();
        deactivate();
        let other = testutil::temp_vault("shadow-writerless-other");
        let config = testutil::temp_vault("shadow-writerless-config");
        let vault = testutil::temp_vault("shadow-writerless");
        let concept = "knowledge/concepts/kept.md";
        let original = "---\ntype: Reference\ndescription: Kept.\n---\n\n# Kept\n";
        testutil::write(&vault, concept, original);
        let unchanged = |label: &str| {
            assert_eq!(
                std::fs::read_to_string(vault.join(concept)).unwrap(),
                original,
                "{label}: the concept is untouched"
            );
            assert!(
                !vault.join("knowledge/concepts/fresh.md").exists(),
                "{label}"
            );
            assert!(!vault.join(crate::knowledge::LOG_PATH).exists(), "{label}");
            assert!(!ledger_dir(&vault).exists(), "{label}: nothing minted");
        };

        for (label, active_other) in [("never activated", false), ("another vault", true)] {
            if active_other {
                activate(&config, &other);
            }
            let refusals = [
                vw::write_concept(
                    &vault,
                    concept,
                    &fm(&[("description", serde_json::json!("Rewritten."))]),
                    "# Kept\n\nRewritten.",
                ),
                vw::write_concept(
                    &vault,
                    "knowledge/concepts/fresh.md",
                    &fm(&[("description", serde_json::json!("New."))]),
                    "# Fresh",
                ),
                vw::verify_frontmatter(
                    &vault,
                    concept,
                    &fm(&[(
                        "verified",
                        serde_json::json!({"by": "human", "at": "2026-09-26"}),
                    )]),
                    "",
                ),
                vw::append_knowledge_log(&vault, concept, "Kept", true),
            ];
            for refusal in refusals {
                let err = refusal.expect_err(label);
                assert!(
                    err.starts_with(super::super::concepts::LEDGER_WRITER_UNAVAILABLE),
                    "{label}: {err}"
                );
            }
            unchanged(label);
        }

        deactivate();
        for dir in [&vault, &other, &config] {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    // M49.2 (K4): the verdict is read from disk and cannot say whether this
    // process is recording. The writer state can — each state, observed.
    #[test]
    fn status_reports_whether_this_process_is_recording() {
        let _guard = lock();
        deactivate();
        let vault = testutil::temp_vault("shadow-writer-state");
        let other = testutil::temp_vault("shadow-writer-state-other");
        let config = testutil::temp_vault("shadow-writer-state-config");
        let state = |vault: &Path| status(Some(config.as_path()), vault).writer;

        assert_eq!(state(&vault).state, "inactive");

        activate(&config, &vault);
        assert_eq!(
            state(&vault),
            WriterStatus {
                state: "held",
                detail: None
            }
        );
        let elsewhere = state(&other);
        assert_eq!(elsewhere.state, "other-vault");
        assert!(elsewhere
            .detail
            .unwrap()
            .contains(&*normalize(&vault).to_string_lossy()));

        // Another process holds `other`'s ledger (stood in for by a writer
        // this test opens itself): activating it loses the lock, and the
        // status names the holder rather than reading "valid".
        let holder = LedgerWriter::open(&other, &writer_id(&config).unwrap()).unwrap();
        activate(&config, &other);
        let lost = state(&other);
        assert_eq!(lost.state, "lost-lock");
        let detail = lost.detail.unwrap();
        assert!(
            detail.contains(&format!("held by pid {}", std::process::id())),
            "{detail}"
        );
        assert!(super::super::concepts::write_concept(
            &other,
            "knowledge/concepts/x.md",
            &fm(&[("description", serde_json::json!("X."))]),
            "# X",
        )
        .unwrap_err()
        .starts_with(super::super::concepts::LEDGER_WRITER_UNAVAILABLE));
        drop(holder);

        deactivate();
        for dir in [&vault, &other, &config] {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    // M49.10 (K35): a status read is a question. It used to delete and
    // recreate an index it judged unhealthy.
    #[test]
    fn a_status_read_never_touches_the_index() {
        let _guard = lock();
        deactivate();
        let vault = testutil::temp_vault("shadow-status-readonly");
        let config = testutil::temp_vault("shadow-status-readonly-config");
        activate(&config, &vault);
        deactivate();
        let store = store::load(&ledger_dir(&vault)).unwrap().unwrap();
        let path = super::super::index::index_path(&config, &store.store_id);
        std::fs::write(&path, b"not a database").unwrap();
        let _ = status(Some(config.as_path()), &vault);
        assert_eq!(std::fs::read(&path).unwrap(), b"not a database");
        for dir in [&vault, &config] {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    // M49.10 (K26): deleting `.cerebro/` used to mint a fresh ledger and a
    // fresh baseline in silence. A different store at a path this machine
    // has seen before is flagged as a rewound history.
    #[test]
    fn a_reminted_ledger_at_a_known_path_is_flagged() {
        let _guard = lock();
        deactivate();
        let vault = copy_demo_vault("shadow-remint");
        let config = testutil::temp_vault("shadow-remint-config");
        activate(&config, &vault);
        let first = status(Some(config.as_path()), &vault);
        assert!(!first.reconciliation_open, "a first open is a baseline");
        deactivate();

        std::fs::remove_dir_all(vault.join(".cerebro")).unwrap();
        activate(&config, &vault);
        let after = status(Some(config.as_path()), &vault);
        assert!(
            after.reconciliation_open,
            "the re-mint is named, not absorbed"
        );
        assert!(after.stopped, "a rewound history is a vault-wide stop");
        let read = read_ledger(&ledger_dir(&vault)).unwrap();
        let divergence = read
            .frames
            .iter()
            .find(|f| f.kind == super::super::schema::KIND_LEDGER_DIVERGENCE)
            .expect("recorded in the new ledger");
        assert!(divergence.body["signals"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s == "remembered_head_regression"));
        deactivate();
        for dir in [&vault, &config] {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    // Review fix: a NEW folder at a known path — re-cloned, the demo vault
    // re-created — is a new baseline, not a rewound history.
    #[test]
    fn a_new_folder_at_a_known_path_is_a_new_baseline() {
        let _guard = lock();
        deactivate();
        let vault = copy_demo_vault("shadow-new-folder");
        let config = testutil::temp_vault("shadow-new-folder-config");
        activate(&config, &vault);
        deactivate();
        // Trash the whole folder and put a fresh copy at the same path.
        let fresh = copy_demo_vault("shadow-new-folder-source");
        std::fs::remove_dir_all(&vault).unwrap();
        std::fs::rename(&fresh, &vault).unwrap();
        std::fs::remove_dir_all(vault.join(".cerebro")).ok();
        activate(&config, &vault);
        let status = status(Some(config.as_path()), &vault);
        assert!(!status.reconciliation_open, "a new vault, not a rewind");
        deactivate();
        for dir in [&vault, &config] {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    // Review fix: reopening the vault is the recovery a fail-stopped writer
    // tells the person to do — it must replace the stopped writer.
    #[test]
    fn reopening_replaces_a_fail_stopped_writer() {
        let _guard = lock();
        deactivate();
        let vault = testutil::temp_vault("shadow-reopen-stopped");
        let config = testutil::temp_vault("shadow-reopen-stopped-config");
        activate(&config, &vault);
        with_writer(&vault, |writer| {
            writer.inject_write_failure();
            writer
                .append("vault.write", serde_json::json!({"path": "x.md"}))
                .unwrap_err();
        });
        assert_eq!(
            status(Some(config.as_path()), &vault).writer.state,
            "fail-stopped"
        );
        activate(&config, &vault);
        assert_eq!(status(Some(config.as_path()), &vault).writer.state, "held");
        deactivate();
        for dir in [&vault, &config] {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}
