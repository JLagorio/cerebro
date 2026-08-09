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
use std::sync::{Mutex, OnceLock};

use serde::Serialize;

use super::index::Index;
use super::recovery::{classify, Remembered, Verdict};
use super::writer::{existing_writer_id, writer_id, LedgerWriter};
use super::{ledger_dir, read_ledger, store};

/// The one active shadow target (the app has one vault open at a time —
/// the watcher has the same shape). Replacing it drops the old writer,
/// which releases the ledger lock.
struct Active {
    vault: PathBuf,
    /// None when the startup verdict refused a writer.
    writer: Option<LedgerWriter>,
    index: Option<Index>,
    writer_id: String,
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
    // the migration events it appends. A typed refusal or failure is a
    // state, not an error: the writer stays open (agent writes continue)
    // and M23.6's circuit breaker surfaces the stored signal.
    if let Some(writer) = writer.as_mut() {
        let _ = super::arm::arm(writer, &vault);
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
    });
    // The verdict is "recorded" as the writer gate above and as the live
    // ledger_status surface — returned here for the startup caller.
    verdict
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
    let (head, seq, segments, anomalies) = match &recovery.read {
        Some(read) => (
            Some(read.head_hash.clone()),
            read.head_seq,
            read.segments.len() as u64,
            read.frames.iter().filter(|f| f.wall_clock_anomaly).count() as u64,
        ),
        None => (None, None, 0, 0),
    };
    LedgerStatus {
        verdict: verdict_tag,
        detail: recovery.verdict.to_string(),
        head,
        seq,
        segments,
        anomalies,
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
        let read = read_ledger(&ledger_dir(&vault)).unwrap();
        assert_eq!(
            read.records,
            baseline + 12,
            "one event per write, none lost"
        );
        let kinds: std::collections::BTreeSet<&str> =
            read.frames.iter().map(|f| f.kind.as_str()).collect();
        assert!(kinds.contains("vault.write"));
        assert!(kinds.contains("vault.rename"));
        assert!(kinds.contains("knowledge.write_concept"));
        assert!(kinds.contains("knowledge.verify"));

        // Bodies carry what the plan says they carry.
        let concept = read
            .frames
            .iter()
            .find(|f| f.kind == "knowledge.write_concept")
            .unwrap();
        assert_eq!(concept.body["path"], "knowledge/concepts/soak.md");
        assert_eq!(concept.body["actor"], "soak-agent");
        let verify = read
            .frames
            .iter()
            .find(|f| f.kind == "knowledge.verify")
            .unwrap();
        let disk = std::fs::read(vault.join("knowledge/concepts/soak.md")).unwrap();
        assert_eq!(
            verify.body["content_hash"],
            serde_json::json!(crate::ledger::sha256_hex(&disk)),
            "the recorded hash is the bytes on disk"
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
        assert_eq!(status.seq, Some(baseline + 12));
        assert_eq!(status.head, Some(read.head_hash.clone()));
        assert_eq!(status.segments, 1);
        assert_eq!(status.anomalies, 0);

        // The secondary anchor stayed fresh: the index remembers the head
        // after every commit, not just at activate.
        let index = Index::open(&config, &read.store.store_id).unwrap();
        let remembered = index.remembered().unwrap().unwrap();
        assert_eq!(remembered.head_seq, Some(baseline + 12));
        assert_eq!(remembered.head_hash, read.head_hash);

        deactivate();
        let _ = std::fs::remove_dir_all(&vault);
        let _ = std::fs::remove_dir_all(&config);
    }
}
