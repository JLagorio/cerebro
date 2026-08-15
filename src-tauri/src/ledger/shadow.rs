//! Shadow-mode recording (M21.8): the ledger observes what the app already
//! does. Existing write paths are unchanged from every caller's point of
//! view — shadow events flow AFTER a write commits, `v: 0`, additive-only
//! from here on. No UI, no frontend events, zero behavioral change.
//!
//! Best-effort by constitution: `record` never fails the write it shadows.
//! It is a silent no-op whenever there is no active writer — unit tests and
//! browser builds (never activated), a vault whose verdict refused the
//! writer, or a second app instance that lost the single-writer lock. What
//! IS active is visible through `status`, never through behavior.

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
/// ledger simply records nothing, and says why through `ledger_status`.
pub fn activate(config_dir: &Path, vault: &Path) -> Verdict {
    let vault = normalize(vault);
    let dir = ledger_dir(&vault);

    let id = match writer_id(config_dir) {
        Ok(id) => id,
        Err(detail) => {
            let verdict = Verdict::Corrupt {
                detail: format!("writer identity unavailable: {detail}"),
            };
            replace_active(Active {
                vault,
                writer: None,
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

    let mut writer = match &verdict {
        Verdict::Valid | Verdict::TornTail { .. } | Verdict::SealPending | Verdict::NoLedger => {
            // Recoverable (or empty) — open performs the recovery actions
            // and mints on first contact. A held lock (second instance)
            // lands in the None arm below: shadow stays silent there.
            LedgerWriter::open(&vault, &id).ok()
        }
        _ => None,
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
        // The M23.6 launch scan: safe recoveries execute, out-of-band edits
        // park for M23.7, divergence records once and opens the mode. Its
        // own failure must never block activation.
        let _ = super::reconcile::launch_scan(
            writer,
            &vault,
            migration_signal,
            remembered.as_ref().map(|r| r.head_hash.as_str()),
        );
    }

    // Replay the disposable index and remember the (possibly recovered)
    // head — only when a writer opened: a refused ledger must not overwrite
    // the remembered head that named the refusal.
    let index = if writer.is_some() {
        read_ledger(&dir).ok().and_then(|read| {
            let mut index = Index::open(config_dir, &read.store.store_id).ok()?;
            match index.replay(&read, &id) {
                Ok(()) => Some(index),
                // A cache that refuses (diverged) is rebuilt from zero —
                // the segments on disk are the authority.
                Err(_) => index.rebuild(&read, &id).ok(),
            }
        })
    } else {
        None
    };

    replace_active(Active {
        vault,
        writer,
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
/// full-ledger fold under `active()`'s mutex would stall every note save's
/// shadow event and every `with_writer` closure.
///
/// **The no-writer fallback is part of the contract.** When no Active
/// writer holds this vault (a refused verdict, a second instance that lost
/// the single-writer lock, tests without activation), this folds from disk
/// and returns the result UNCACHED — today's pure-disk read-only ask path,
/// preserved exactly. There is no live head to validate a memo against, so
/// there is no memo.
///
/// Never call from inside a `with_writer`/`record` closure — the active
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
/// for the vault (unit fixtures, browser builds, a refused ledger, a
/// second instance that lost the lock); the caller keeps its legacy
/// file-first behavior there, and `ledger_status` names why.
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
    Some(f(writer))
}

/// Record one shadow event for `vault`. Best-effort and invisible — see
/// the module doc. A failed append is swallowed: shadow mode observes
/// writes, it never gates them.
pub fn record(vault: &Path, kind: &str, body: serde_json::Value) {
    let Ok(mut guard) = active().lock() else {
        return;
    };
    let Some(active) = guard.as_mut() else {
        return;
    };
    if active.vault != normalize(vault) {
        return;
    }
    let Some(writer) = active.writer.as_mut() else {
        return;
    };
    // Belt (M31.7): every append through this door drops the memo before
    // the write; the head check in `state_of` is the suspenders.
    active.folded = None;
    if writer.append(kind, body).is_ok() {
        // Keep the secondary anchor fresh: remember the new head after
        // every commit (cheap meta upsert; events replay at next activate).
        if let (Some(index), Some(head)) = (active.index.as_mut(), writer.head()) {
            if let Ok(Some(remembered)) = index.remembered() {
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
    /// The verdict's human sentence — periodic-anchoring language included.
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
}

pub fn status(config_dir: Option<&Path>, vault: &Path) -> LedgerStatus {
    let dir = ledger_dir(&normalize(vault));
    let id = config_dir.and_then(existing_writer_id);
    let remembered = config_dir.and_then(|config| {
        let store = store::load(&dir).ok().flatten()?;
        let path = super::index::index_path(config, &store.store_id);
        if !path.exists() {
            return None;
        }
        let index = Index::open(config, &store.store_id).ok()?;
        index.remembered().ok().flatten()
    });
    let recovery = classify(&dir, id.as_deref(), remembered.as_ref());
    let verdict_tag = serde_json::to_value(&recovery.verdict)
        .ok()
        .and_then(|v| v.get("state").and_then(|s| s.as_str()).map(String::from))
        .unwrap_or_else(|| "unknown".to_string());
    let (head, seq, segments, anomalies, reconciliation_open, divergences) = match &recovery.read {
        Some(read) => {
            let state = super::reduce::reduce(&read.frames, &read.store.store_id);
            (
                Some(read.head_hash.clone()),
                read.head_seq,
                read.segments.len() as u64,
                read.frames.iter().filter(|f| f.wall_clock_anomaly).count() as u64,
                state.reconciliation_open(),
                state.reconciliation_divergences.keys().cloned().collect(),
            )
        }
        None => (None, None, 0, 0, false, Vec::new()),
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
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::testutil;
    use crate::vault::write as vw;

    /// The Active slot is process-global; tests that touch it take this
    /// lock so parallel test threads cannot swap each other's vaults.
    static SHADOW_LOCK: Mutex<()> = Mutex::new(());

    fn lock() -> std::sync::MutexGuard<'static, ()> {
        SHADOW_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn fm(pairs: &[(&str, serde_json::Value)]) -> serde_json::Map<String, serde_json::Value> {
        pairs
            .iter()
            .cloned()
            .map(|(k, v)| (k.to_string(), v))
            .collect()
    }

    #[test]
    fn record_is_a_silent_noop_when_never_activated() {
        let _guard = lock();
        deactivate();
        let vault = testutil::temp_vault("shadow-inactive");
        testutil::write(&vault, "items/a.md", "# A\n");
        vw::save_note(&vault, "items/a.md", "\n# A\n\nEdited.\n").unwrap();
        record(&vault, "vault.write", serde_json::json!({"path": "x"}));
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
    fn an_append_through_either_door_invalidates() {
        let _guard = lock();
        deactivate();
        let (config, vault) = test_vault("either-door");
        activate(&config, &vault);
        // Door one: ledger-first, through `with_writer` — the door no
        // shadow hook observes, the bypass D4 exists to survive.
        let before = state_of(&vault).unwrap();
        append_test_event(&vault);
        let after = state_of(&vault).unwrap();
        assert!(
            !std::sync::Arc::ptr_eq(&before, &after),
            "the cache served a fold from before the with_writer append"
        );
        // Door two: the vault-file shadow path, through `record`.
        record(
            &vault,
            "vault.write",
            serde_json::json!({ "path": "records/shadowed.md" }),
        );
        let again = state_of(&vault).unwrap();
        assert!(
            !std::sync::Arc::ptr_eq(&after, &again),
            "the cache served a fold from before the record append"
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
        vw::verify_frontmatter(
            &vault,
            "knowledge/concepts/soak.md",
            &fm(&[(
                "verified",
                serde_json::json!({"by": "human", "at": "2026-08-07"}),
            )]),
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
        // Twelve writes, sixteen events. Thirteen are M23's — the verify is
        // a field revision PLUS its attestation — and three are M24.4's
        // governed concept write: `proposal.submitted`, then the apply batch
        // (`belief.created` + `proposal.applied`) under its `batch.committed`
        // marker.
        let read = read_ledger(&ledger_dir(&vault)).unwrap();
        assert_eq!(read.records, baseline + 16, "no write lost, none doubled");
        let kinds: std::collections::BTreeSet<&str> =
            read.frames.iter().map(|f| f.kind.as_str()).collect();
        assert!(kinds.contains("vault.write"));
        assert!(kinds.contains("vault.rename"));
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
        let rename = read
            .frames
            .iter()
            .find(|f| f.kind == "vault.rename")
            .unwrap();
        assert_eq!(rename.body["from"], "records/soak-note.md");
        assert_eq!(rename.body["to"], "records/soak-renamed.md");

        // Diagnostics agree, live.
        let status = status(Some(config.as_path()), &vault);
        assert_eq!(status.verdict, "valid");
        assert_eq!(status.seq, Some(baseline + 16));
        assert_eq!(status.head, Some(read.head_hash.clone()));
        assert_eq!(status.segments, 1);
        assert_eq!(status.anomalies, 0);

        // The secondary anchor stayed fresh: the index remembers the head
        // after every commit, not just at activate.
        let index = Index::open(&config, &read.store.store_id).unwrap();
        let remembered = index.remembered().unwrap().unwrap();
        assert_eq!(remembered.head_seq, Some(baseline + 16));
        assert_eq!(remembered.head_hash, read.head_hash);

        deactivate();
        let _ = std::fs::remove_dir_all(&vault);
        let _ = std::fs::remove_dir_all(&config);
    }
}
