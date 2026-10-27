//! Search's corpus (M59.4): every note's entry and searchable body, kept
//! between searches and re-read only where a file changed.
//!
//! search_notes used to scan the vault and then read every note a second
//! time for its body, on every call, and ⌘K's page-text search asks once per
//! pause in typing. So the corpus is cached, keyed by each file's stat: a
//! file whose stat matches is not read again, and a changed or new one is
//! read once, its entry and its body taken from that one read.
//!
//! It is a cache and never an index (M17.19): nothing in it is derived
//! beyond what one read of the file gives, it is rebuilt from the disk
//! whenever a stat moves, and dropping it loses nothing. `scan_vault` stays
//! uncached: a stale entry there would hide a change from M55.2's triggers.
//!
//! A stat can lie on a disk with coarse times: a file rewritten at the same
//! size within its old mtime's tick keeps its len and mtime. So the key adds
//! the ctime and the inode on unix, and a file read less than
//! `RACY_WINDOW` after its mtime is racily clean and is read again next time.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::{Duration, SystemTime};

use super::entry::Entry;
use super::parse;
use super::scan::{assign_projects, entry_from_read, note_files, NoteFile};

/// The most of a body search reads, in bytes. A longer note is searched in
/// its first 100 KiB, and both searches say so.
pub const SEARCH_BODY_CAP: usize = 100 * 1024;

/// A file read sooner than this after its mtime is read again next time: a
/// write in the same tick of a coarse clock would leave its stat unchanged.
const RACY_WINDOW: Duration = Duration::from_secs(2);

/// How many vaults the shared cache keeps: the open one, and the one just
/// switched away from.
const SHARED_VAULTS: usize = 2;

/// One note's searchable text: its body as `read_note` returns it, cut at
/// `SEARCH_BODY_CAP` on a char boundary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CorpusText {
    /// Search-only canonical text, never a legacy property DTO or read grant.
    pub(crate) search_fields: Option<Vec<crate::search::MetaField>>,
    pub source: Option<crate::source_location::SourceSnapshot>,
    pub body: String,
    /// True when the body was longer than `SEARCH_BODY_CAP` and was cut.
    pub capped: bool,
}

/// Every note the scan lists, sorted by path, with projects assigned as the
/// scan assigns them. `entries[i]` and `texts[i]` are one note.
#[derive(Debug, Default)]
pub struct Corpus {
    pub entries: Vec<Entry>,
    pub texts: Vec<CorpusText>,
}

/// What a file's stat said when it was read. Two equal keys mean the file
/// has not changed, unless it was read inside `RACY_WINDOW` of its mtime.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct StatKey {
    len: u64,
    mtime: SystemTime,
    #[cfg(unix)]
    ctime: (i64, i64),
    #[cfg(unix)]
    inode: u64,
}

impl StatKey {
    /// `None` when the stat could not be read, or names no mtime: such a
    /// file is read every time.
    fn of(meta: Option<&std::fs::Metadata>) -> Option<StatKey> {
        let meta = meta?;
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        Some(StatKey {
            len: meta.len(),
            mtime: meta.modified().ok()?,
            #[cfg(unix)]
            ctime: (meta.ctime(), meta.ctime_nsec()),
            #[cfg(unix)]
            inode: meta.ino(),
        })
    }
}

/// A file as last read: its stat then, and when the read began.
#[derive(Debug, Clone, Copy)]
struct Stamp {
    key: StatKey,
    read_at: SystemTime,
}

impl Stamp {
    /// The file may be reused: its stat is unchanged, and it was read late
    /// enough after its mtime that a same-tick write cannot hide behind it.
    fn reusable(&self, now: StatKey) -> bool {
        self.key == now
            && self
                .read_at
                .duration_since(self.key.mtime)
                .is_ok_and(|after| after >= RACY_WINDOW)
    }
}

/// One vault's cache: each file's stamp, and the corpus they built.
#[derive(Default)]
struct VaultCache {
    stamps: HashMap<String, Stamp>,
    selected_identity: Option<String>,
    corpus: Arc<Corpus>,
}

#[derive(Default)]
struct State {
    /// Least recently used first.
    vaults: Vec<(PathBuf, VaultCache)>,
    #[cfg(test)]
    reads: usize,
}

/// A stat-keyed corpus cache holding up to `capacity` vaults, the least
/// recently used dropped first. An instance, so a test can hold its own and
/// count its reads while other tests search their own vaults in parallel;
/// the app shares one ([`shared`]).
pub struct CorpusCache {
    capacity: usize,
    state: Mutex<State>,
}

impl CorpusCache {
    pub fn new(capacity: usize) -> Self {
        CorpusCache {
            capacity: capacity.max(1),
            state: Mutex::new(State::default()),
        }
    }

    /// The vault's corpus as the disk holds it now. Refuses a path that is
    /// not a directory, as the scan does. Each changed or new file is read
    /// once; an unchanged one is reused; a vanished one leaves. The lock is
    /// held only while the cache is brought up to date and is released
    /// before this returns, so nothing ranks under it.
    pub fn snapshot(&self, vault: &Path) -> Result<Arc<Corpus>, String> {
        if matches!(
            crate::workspace_service::authority::resolve(vault).map_err(|e| e.message)?,
            crate::workspace_service::authority::Authority::Selected
        ) {
            let fresh = crate::workspace_service::selected::corpus_snapshot(vault)
                .map_err(|e| e.message)?;
            let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
            let old = state
                .vaults
                .iter()
                .position(|(root, _)| root == vault)
                .map(|i| state.vaults.remove(i).1);
            let cache = match old {
                Some(old) if old.selected_identity.as_deref() == Some(&fresh.identity) => old,
                _ => VaultCache {
                    selected_identity: Some(fresh.identity),
                    corpus: Arc::new(fresh.corpus),
                    ..Default::default()
                },
            };
            let result = Arc::clone(&cache.corpus);
            state.vaults.push((vault.to_path_buf(), cache));
            if state.vaults.len() > self.capacity {
                state.vaults.remove(0);
            }
            return Ok(result);
        }
        let inventory = note_files(vault)?;
        let files = &inventory.files;
        // A poisoned lock means a search panicked mid-update. The stamps
        // are only ever replaced whole, so what is there is still sound.
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        let mut cache = match state.vaults.iter().position(|(v, _)| v == vault) {
            Some(at) => state.vaults.remove(at).1,
            None => VaultCache::default(),
        };

        let old = Arc::clone(&cache.corpus);
        let reused: Vec<Option<usize>> = files
            .iter()
            .map(|file| reusable(&cache, &old, file))
            .collect();
        let unchanged = files.len() == old.entries.len() && reused.iter().all(Option::is_some);
        if !unchanged {
            let mut stamps = HashMap::with_capacity(files.len());
            let mut notes: Vec<(Entry, CorpusText)> = Vec::with_capacity(files.len());
            for (file, reuse) in files.iter().zip(&reused) {
                if let Some(at) = reuse {
                    stamps.insert(file.rel.clone(), cache.stamps[&file.rel]);
                    notes.push((old.entries[*at].clone(), old.texts[*at].clone()));
                    continue;
                }
                let read_at = SystemTime::now();
                let read = super::scan::read_content(file).map_err(|e| e.message)?;
                #[cfg(test)]
                {
                    state.reads += 1;
                }
                let entry = entry_from_read(&file.rel, &read, file.meta.as_ref());
                let text = match &read {
                    Ok(content) => text_of(&file.rel, content),
                    Err(_) => CorpusText {
                        search_fields: None,
                        source: None,
                        body: String::new(),
                        capped: false,
                    },
                };
                if let Some(key) = StatKey::of(file.meta.as_ref()) {
                    stamps.insert(file.rel.clone(), Stamp { key, read_at });
                }
                notes.push((entry, text));
            }
            notes.sort_by(|a, b| a.0.path.cmp(&b.0.path));
            let (mut entries, texts): (Vec<Entry>, Vec<CorpusText>) = notes.into_iter().unzip();
            assign_projects(&mut entries);
            cache.stamps = stamps;
            cache.corpus = Arc::new(Corpus { entries, texts });
        }

        inventory.boundary.revalidate().map_err(|e| e.message)?;
        let corpus = Arc::clone(&cache.corpus);
        state.vaults.push((vault.to_path_buf(), cache));
        if state.vaults.len() > self.capacity {
            state.vaults.remove(0);
        }
        Ok(corpus)
    }

    /// Search-only projection. Selected reads are fresh and never replace the
    /// strict ordinary corpus cache with text-flattened canonical metadata.
    pub(crate) fn search_snapshot(&self, vault: &Path) -> Result<Arc<Corpus>, String> {
        match crate::workspace_service::authority::resolve(vault).map_err(|error| error.message)? {
            crate::workspace_service::authority::Authority::Selected => {
                crate::workspace_service::selected::search_snapshot(vault)
                    .map(Arc::new)
                    .map_err(|error| error.message)
            }
            crate::workspace_service::authority::Authority::Legacy => self.snapshot(vault),
        }
    }

    /// How many files this cache has read, for the read-once tests.
    #[cfg(test)]
    pub(crate) fn reads(&self) -> usize {
        self.state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .reads
    }
}

/// Where `file` sits in `old`, when its stamp lets it be reused.
fn reusable(cache: &VaultCache, old: &Corpus, file: &NoteFile) -> Option<usize> {
    let now = StatKey::of(file.meta.as_ref())?;
    if !cache.stamps.get(&file.rel)?.reusable(now) {
        return None;
    }
    old.entries
        .binary_search_by(|e| e.path.as_str().cmp(&file.rel))
        .ok()
}

/// Search reads card text for boards, raw Mermaid for diagrams, or a page's
/// body after frontmatter, then cuts at SEARCH_BODY_CAP. Unreadable boards
/// already carry their parse_error in the corresponding Entry.
fn text_of(rel: &str, content: &str) -> CorpusText {
    let canvas_text;
    let body = if crate::files::kinds::is_whiteboard(rel) {
        canvas_text = crate::canvas::read::read(content)
            .map(|b| crate::canvas::read::search_text(&b))
            .unwrap_or_default();
        canvas_text.as_str()
    } else if rel.ends_with(".mmd") {
        content
    } else {
        parse::split_frontmatter(content).1
    };
    let mut at = body.len().min(SEARCH_BODY_CAP);
    while !body.is_char_boundary(at) {
        at -= 1;
    }
    let markdown = rel.ends_with(".md");
    let capped = at < body.len();
    CorpusText {
        search_fields: None,
        source: Some(crate::source_location::SourceSnapshot {
            raw_sha256: crate::ledger::sha256_hex(content.as_bytes()),
            carrier: if markdown { "markdown" } else { "unsupported" },
            body_start_utf8: if markdown {
                content.len() - body.len()
            } else {
                0
            },
            searched_body_bytes: at,
            capped,
        }),
        body: body[..at].to_string(),
        capped,
    }
}

/// The app's one cache: up to two vaults.
pub fn shared() -> &'static CorpusCache {
    static SHARED: OnceLock<CorpusCache> = OnceLock::new();
    SHARED.get_or_init(|| CorpusCache::new(SHARED_VAULTS))
}

/// The vault's corpus, from the shared cache.
pub fn snapshot(vault: &Path) -> Result<Arc<Corpus>, String> {
    shared().snapshot(vault)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::testutil;

    /// Long enough ago that no read is racily clean.
    fn settled() -> SystemTime {
        SystemTime::now() - Duration::from_secs(3600)
    }

    /// Write `content` at `rel` and set its mtime to `at`.
    fn write_at(vault: &Path, rel: &str, content: &str, at: SystemTime) {
        testutil::write(vault, rel, content);
        let file = std::fs::File::options()
            .write(true)
            .open(vault.join(rel))
            .expect("open to set the mtime");
        file.set_modified(at).expect("set the mtime");
    }

    fn paths(corpus: &Corpus) -> Vec<&str> {
        corpus.entries.iter().map(|e| e.path.as_str()).collect()
    }

    #[test]
    fn failed_read_has_no_source_snapshot() {
        let vault = testutil::temp_vault("source-unreadable");
        std::fs::write(vault.join("bad.md"), [0xff, 0xfe]).unwrap();
        let corpus = CorpusCache::new(1).snapshot(&vault).unwrap();
        assert!(corpus.entries[0].parse_error.is_some());
        assert!(corpus.entries[0].hash.is_none());
        assert!(corpus.texts[0].source.is_none());
        let _ = std::fs::remove_dir_all(vault);
    }

    #[test]
    fn metadata_only_edit_changes_source_snapshot() {
        let vault = testutil::temp_vault("source-metadata");
        let old = "---\r\nowner: Ada\r\n---\r\n😀 body";
        let new = "---\r\nowner: Bo\r\n---\r\n😀 body";
        write_at(&vault, "a.md", old, settled());
        let cache = CorpusCache::new(1);
        let before = cache.snapshot(&vault).unwrap();
        write_at(&vault, "a.md", new, settled());
        let after = cache.snapshot(&vault).unwrap();
        assert_eq!(before.texts[0].body, after.texts[0].body);
        let first = before.texts[0].source.as_ref().unwrap();
        let second = after.texts[0].source.as_ref().unwrap();
        assert_eq!(first.raw_sha256, crate::ledger::sha256_hex(old.as_bytes()));
        assert_eq!(second.raw_sha256, crate::ledger::sha256_hex(new.as_bytes()));
        assert_ne!(first.raw_sha256, second.raw_sha256);
        assert_eq!(first.body_start_utf8, 22);
        assert_eq!(second.body_start_utf8, 21);
        assert_eq!(cache.reads(), 2);
        let _ = std::fs::remove_dir_all(vault);
    }

    #[test]
    fn unchanged_search_reuses_source_snapshot() {
        let vault = testutil::temp_vault("source-reuse");
        write_at(&vault, "a.md", "# A\n😀 body", settled());
        let cache = CorpusCache::new(1);
        let before = cache.snapshot(&vault).unwrap();
        let after = cache.snapshot(&vault).unwrap();
        assert!(Arc::ptr_eq(&before, &after));
        assert_eq!(before.texts[0].source, after.texts[0].source);
        assert!(before.texts[0].source.is_some());
        assert_eq!(cache.reads(), 1);
        let _ = std::fs::remove_dir_all(vault);
    }

    #[test]
    fn an_unchanged_file_is_not_read_again() {
        let vault = testutil::temp_vault("corpus-unchanged");
        write_at(&vault, "a.md", "# A\n\nalpha\n", settled());
        write_at(&vault, "b.md", "# B\n\nbeta\n", settled());
        let cache = CorpusCache::new(2);
        let first = cache.snapshot(&vault).unwrap();
        assert_eq!(cache.reads(), 2);
        let second = cache.snapshot(&vault).unwrap();
        assert_eq!(cache.reads(), 2, "nothing changed, so nothing was read");
        assert!(
            Arc::ptr_eq(&first, &second),
            "an unchanged corpus is not rebuilt"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_board_is_searched_by_its_card_text_never_json_field_names() {
        let vault = testutil::temp_vault("corpus-whiteboard");
        testutil::write(
            &vault,
            "plan.canvas",
            include_str!("../../../shared/canvas/goldens/obsidian-layout.canvas"),
        );
        let cache = CorpusCache::new(1);
        let corpus = cache.snapshot(&vault).unwrap();
        assert_eq!(corpus.texts[0].body, "Roadmap [[Vision]]\nRelease");
        assert!(!corpus.texts[0].body.contains("nodes"));
        assert_eq!(cache.reads(), 1);
        std::fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn a_changed_or_new_file_is_read_once() {
        let vault = testutil::temp_vault("corpus-changed");
        write_at(&vault, "a.md", "# A\n\nalpha\n", settled());
        write_at(&vault, "b.md", "# B\n\nbeta\n", settled());
        let cache = CorpusCache::new(2);
        cache.snapshot(&vault).unwrap();
        assert_eq!(cache.reads(), 2);

        let later = settled() + Duration::from_secs(60);
        write_at(&vault, "a.md", "# A\n\nalpha, longer now\n", later);
        write_at(&vault, "c.md", "# C\n\ngamma\n", later);
        let corpus = cache.snapshot(&vault).unwrap();
        assert_eq!(cache.reads(), 4, "a.md and c.md, each once");
        assert_eq!(paths(&corpus), ["a.md", "b.md", "c.md"]);
        assert!(corpus.texts[0].body.contains("longer now"));
        cache.snapshot(&vault).unwrap();
        assert_eq!(cache.reads(), 4);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_vanished_file_leaves_the_corpus() {
        let vault = testutil::temp_vault("corpus-vanished");
        write_at(&vault, "a.md", "# A\n", settled());
        write_at(&vault, "b.md", "# B\n", settled());
        let cache = CorpusCache::new(2);
        assert_eq!(paths(&cache.snapshot(&vault).unwrap()), ["a.md", "b.md"]);
        std::fs::remove_file(vault.join("b.md")).unwrap();
        let corpus = cache.snapshot(&vault).unwrap();
        assert_eq!(paths(&corpus), ["a.md"]);
        assert_eq!(corpus.texts.len(), 1);
        assert_eq!(cache.reads(), 2, "a.md was not read again");
        let _ = std::fs::remove_dir_all(&vault);
    }

    /// An Entry without its file times, which the scan and the corpus take
    /// from two stats a moment apart.
    fn timeless(entry: &Entry) -> serde_json::Value {
        let mut value = serde_json::to_value(entry).unwrap();
        let fields = value.as_object_mut().unwrap();
        fields.shift_remove("createdAt");
        fields.shift_remove("modifiedAt");
        value
    }

    #[test]
    fn the_corpus_entries_equal_the_scan() {
        let demo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../demo-vault");
        let scanned = crate::vault::scan::scan_vault(&demo).unwrap();
        let corpus = CorpusCache::new(1).snapshot(&demo).unwrap();
        assert_eq!(corpus.entries.len(), scanned.len());
        assert!(scanned.len() > 20, "the demo vault was scanned");
        for (cached, scanned) in corpus.entries.iter().zip(&scanned) {
            // Every field, the hash and the project included.
            assert_eq!(timeless(cached), timeless(scanned), "{}", scanned.path);
        }
        for (entry, text) in corpus.entries.iter().zip(&corpus.texts) {
            if text.capped {
                continue;
            }
            let body = crate::vault::write::read_note(&demo, &entry.path).unwrap();
            assert_eq!(
                text.body, body,
                "{} reads as read_note reads it",
                entry.path
            );
        }
    }

    #[test]
    fn a_long_body_is_capped_at_a_char_boundary_and_flagged() {
        let vault = testutil::temp_vault("corpus-cap");
        // Three-byte chars after one byte of padding, so the cap falls
        // mid-char and must step back.
        let body = format!("x{}", "\u{20AC}".repeat(SEARCH_BODY_CAP / 3 + 10));
        write_at(
            &vault,
            "long.md",
            &format!("---\ntype: Note\n---\n{body}"),
            settled(),
        );
        write_at(&vault, "short.md", "# Short\n", settled());
        let corpus = CorpusCache::new(1).snapshot(&vault).unwrap();
        let long = &corpus.texts[0];
        assert!(long.capped);
        assert!(long.body.len() <= SEARCH_BODY_CAP);
        assert!(long.body.len() > SEARCH_BODY_CAP - 3);
        assert!(body.starts_with(&long.body));
        assert!(!corpus.texts[1].capped);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[cfg(unix)]
    #[test]
    fn a_same_size_rewrite_under_its_old_mtime_is_reread() {
        let vault = testutil::temp_vault("corpus-same-size");
        let at = settled();
        write_at(&vault, "a.md", "# A\n\naaaa\n", at);
        let cache = CorpusCache::new(1);
        cache.snapshot(&vault).unwrap();
        cache.snapshot(&vault).unwrap();
        assert_eq!(cache.reads(), 1);
        // Same length, same mtime: only the ctime says it changed.
        write_at(&vault, "a.md", "# A\n\nbbbb\n", at);
        let corpus = cache.snapshot(&vault).unwrap();
        assert_eq!(cache.reads(), 2);
        assert!(corpus.texts[0].body.contains("bbbb"));
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_racily_clean_file_is_reread_next_time() {
        let vault = testutil::temp_vault("corpus-racy");
        // Written just now: read within RACY_WINDOW of its mtime.
        testutil::write(&vault, "a.md", "# A\n");
        let cache = CorpusCache::new(1);
        cache.snapshot(&vault).unwrap();
        cache.snapshot(&vault).unwrap();
        assert_eq!(cache.reads(), 2, "a fresh file is read again");
        // Settled, it is read once more and then reused.
        write_at(&vault, "a.md", "# A\n", settled());
        cache.snapshot(&vault).unwrap();
        cache.snapshot(&vault).unwrap();
        assert_eq!(cache.reads(), 3);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_new_project_md_reassigns_containment() {
        let vault = testutil::temp_vault("corpus-project");
        write_at(&vault, "work/atlas/notes.md", "# Notes\n", settled());
        let cache = CorpusCache::new(1);
        let before = cache.snapshot(&vault).unwrap();
        assert_eq!(before.entries[0].project, None);
        write_at(
            &vault,
            "work/atlas/project.md",
            "---\ntype: Project\n---\n\n# Atlas\n",
            settled(),
        );
        let after = cache.snapshot(&vault).unwrap();
        assert_eq!(cache.reads(), 2, "notes.md itself was not read again");
        let notes = after
            .entries
            .iter()
            .find(|e| e.path == "work/atlas/notes.md")
            .unwrap();
        assert_eq!(notes.project.as_deref(), Some("work/atlas/project.md"));
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_third_vault_evicts_the_oldest_cache() {
        let vaults: Vec<PathBuf> = ["one", "two", "three"]
            .iter()
            .map(|label| {
                let vault = testutil::temp_vault(&format!("corpus-evict-{label}"));
                write_at(&vault, "a.md", "# A\n", settled());
                vault
            })
            .collect();
        let cache = CorpusCache::new(2);
        for vault in &vaults {
            cache.snapshot(vault).unwrap();
        }
        assert_eq!(cache.reads(), 3);
        cache.snapshot(&vaults[1]).unwrap();
        cache.snapshot(&vaults[2]).unwrap();
        assert_eq!(cache.reads(), 3, "the two newest are still cached");
        cache.snapshot(&vaults[0]).unwrap();
        assert_eq!(cache.reads(), 4, "the oldest was evicted and read again");
        for vault in &vaults {
            let _ = std::fs::remove_dir_all(vault);
        }
    }

    #[test]
    fn the_shared_snapshot_agrees_with_a_private_cache_and_refuses_a_file() {
        // Other tests share this cache and can evict this vault at any
        // moment, so only what eviction cannot change is asserted.
        let vault = testutil::temp_vault("corpus-shared");
        write_at(&vault, "a.md", "# A\n\nalpha\n", settled());
        write_at(&vault, "b.md", "# B\n\nbeta\n", settled());
        let shared = snapshot(&vault).unwrap();
        let private = CorpusCache::new(1).snapshot(&vault).unwrap();
        let entries = |c: &Corpus| c.entries.iter().map(timeless).collect::<Vec<_>>();
        assert_eq!(entries(&shared), entries(&private));
        assert_eq!(shared.texts, private.texts);
        assert!(snapshot(&vault.join("a.md")).is_err());
        assert!(CorpusCache::new(1)
            .snapshot(&vault.join("missing"))
            .is_err());
        let _ = std::fs::remove_dir_all(&vault);
    }
}
