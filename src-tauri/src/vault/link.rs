//! Wikilink target → vault entry (M33a.5).
//!
//! Twins `resolveLink` in src/engine/wikilink.ts, which is the rule the whole
//! app resolves `about:`, `project:` and every other wikilink field by. The
//! two have to agree: a tool that answered "nothing is anchored to this" where
//! the surface beside it lists three concepts would be worse than no tool at
//! all. Both replay src-tauri/fixtures/wikilink-targets.json (M55.8).
//!
//! It lives here rather than in `knowledge.rs` because it is not a knowledge
//! rule — it is what a wikilink MEANS in this vault, and the bundle is only
//! the first caller that needed it in Rust.

use std::collections::HashMap;

use super::entry::Entry;

/// The resolution rule, prepared once for a corpus.
///
/// A name is three ordered passes and each takes the FIRST entry that
/// matches, so three first-wins maps tried in the same order answer
/// identically — and answer in constant time. A target is that rule run on
/// the whole target, then on the page before its first `#` (see `resolve`). That matters because the
/// callers resolve MANY targets against one vault: every `about:` anchor of
/// every concept, plus every relation either end of the graph declared. Done
/// as a scan per target that is quadratic in the vault.
pub struct TargetIndex<'a> {
    stems: HashMap<String, &'a Entry>,
    folders: HashMap<String, &'a Entry>,
    titles: HashMap<String, &'a Entry>,
}

impl<'a> TargetIndex<'a> {
    pub fn build(entries: &'a [Entry]) -> Self {
        let mut stems = HashMap::new();
        let mut folders = HashMap::new();
        let mut titles = HashMap::new();
        for entry in entries {
            let filename = entry.filename.to_lowercase();
            let stem = filename.strip_suffix(".md").unwrap_or(&filename);
            stems.entry(stem.to_string()).or_insert(entry);
            // A project IS its folder: every project's file is named
            // `project.md`, so a stem match can never name one and `[[atlas]]`
            // would dangle against `projects/atlas/project.md`.
            if filename == "project.md" {
                let folder = entry.folder.rsplit('/').next().unwrap_or(&entry.folder);
                folders.entry(folder.to_lowercase()).or_insert(entry);
            }
            titles.entry(entry.title.to_lowercase()).or_insert(entry);
        }
        TargetIndex {
            stems,
            folders,
            titles,
        }
    }

    /// The entry a wikilink target names (M55.8): the whole target first,
    /// then, when that names nothing, the page before its first `#`, so
    /// `[[notes#Risks]]` reaches `notes`. The whole target goes first so that
    /// nothing that resolved before section links changes (`C# notes` stays
    /// a title link). The section itself is only the editor's business, so
    /// nothing here returns it.
    pub fn resolve(&self, target: &str) -> Option<&'a Entry> {
        self.resolve_name(target).or_else(|| {
            let (page, _section) = target.split_once('#')?;
            self.resolve_name(page)
        })
    }

    /// One name: filename-stem match first, then project folder, then exact
    /// title; all case-insensitive (the Tolaria rule). The folder pass sits
    /// above the title pass because a folder name is an identifier and a
    /// title is prose. An empty name resolves nothing.
    fn resolve_name(&self, name: &str) -> Option<&'a Entry> {
        let needle = name.trim().to_lowercase();
        if needle.is_empty() {
            return None;
        }
        self.stems
            .get(&needle)
            .or_else(|| self.folders.get(&needle))
            .or_else(|| self.titles.get(&needle))
            .copied()
    }
}

/// One target against one corpus. Build a [`TargetIndex`] instead when there
/// is more than one target to resolve.
pub fn resolve_target<'a>(target: &str, entries: &'a [Entry]) -> Option<&'a Entry> {
    TargetIndex::build(entries).resolve(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(path: &str, title: &str) -> Entry {
        let mut e = Entry::empty_for_test(path);
        e.title = title.to_string();
        e
    }

    fn corpus() -> Vec<Entry> {
        vec![
            entry("projects/atlas/project.md", "Atlas rollout"),
            entry("records/risks/rq-84b-kestrel.md", "RQ-84B Kestrel"),
            entry("docs/notes.md", "Atlas"),
        ]
    }

    #[test]
    fn the_stem_wins_and_case_never_decides() {
        let entries = corpus();
        assert_eq!(
            resolve_target("RQ-84B-Kestrel", &entries).map(|e| e.path.as_str()),
            Some("records/risks/rq-84b-kestrel.md")
        );
        assert_eq!(
            resolve_target("  notes  ", &entries).map(|e| e.path.as_str()),
            Some("docs/notes.md")
        );
    }

    #[test]
    fn a_project_is_reached_by_its_folder_and_the_folder_outranks_a_title() {
        // `[[atlas]]` has to land on the project, not on the unrelated doc
        // that happens to be TITLED Atlas — every project file is
        // `project.md`, so without this pass a project is unreachable by name.
        let entries = corpus();
        assert_eq!(
            resolve_target("atlas", &entries).map(|e| e.path.as_str()),
            Some("projects/atlas/project.md")
        );
    }

    #[test]
    fn an_exact_title_is_the_last_resort() {
        let entries = corpus();
        assert_eq!(
            resolve_target("rq-84b kestrel", &entries).map(|e| e.path.as_str()),
            Some("records/risks/rq-84b-kestrel.md")
        );
    }

    #[test]
    fn a_name_nothing_carries_resolves_to_nothing() {
        let entries = corpus();
        assert!(resolve_target("mpm-410", &entries).is_none());
        assert!(resolve_target("   ", &entries).is_none());
        assert!(resolve_target("", &entries).is_none());
    }

    #[test]
    fn a_section_link_resolves_the_page_before_its_first_hash() {
        let entries = corpus();
        let at = |target: &str| resolve_target(target, &entries).map(|e| e.path.as_str());
        assert_eq!(at("notes#Risks"), Some("docs/notes.md"));
        assert_eq!(at("atlas#Timeline"), Some("projects/atlas/project.md"));
        assert_eq!(at("notes#A#B"), Some("docs/notes.md"));
        // No page half is no page: only the page holding the link can answer.
        assert_eq!(at("#Risks"), None);
        assert_eq!(at("mpm-410#Risks"), None);
    }

    #[test]
    fn a_whole_target_that_names_a_page_wins_over_its_hash() {
        let mut entries = corpus();
        entries.push(entry("docs/c-sharp.md", "C# notes"));
        entries.push(entry("docs/c.md", "C"));
        assert_eq!(
            resolve_target("C# notes", &entries).map(|e| e.path.as_str()),
            Some("docs/c-sharp.md")
        );
    }

    /// The cases src/engine/wikilink.test.ts replays through `resolveLink`.
    const TARGET_CASES: &str = include_str!("../../fixtures/wikilink-targets.json");

    #[test]
    fn replays_the_shared_target_cases() {
        let fixture: serde_json::Value = serde_json::from_str(TARGET_CASES).unwrap();
        assert_eq!(fixture["format"], 1);
        let entries: Vec<Entry> = fixture["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| entry(e["path"].as_str().unwrap(), e["title"].as_str().unwrap()))
            .collect();
        let index = TargetIndex::build(&entries);
        let cases = fixture["cases"].as_array().unwrap();
        assert!(!cases.is_empty());
        for case in cases {
            let target = case["target"].as_str().unwrap();
            assert_eq!(
                index.resolve(target).map(|e| e.path.as_str()),
                case["path"].as_str(),
                "{target:?}"
            );
        }
    }

    #[test]
    fn the_earliest_entry_wins_a_tie_in_every_pass() {
        // Each pass took the first match in entry order; the maps are
        // first-wins so that they answer identically.
        let entries = vec![
            entry("a/dup.md", "Same title"),
            entry("b/dup.md", "Same title"),
        ];
        assert_eq!(
            resolve_target("dup", &entries).map(|e| e.path.as_str()),
            Some("a/dup.md")
        );
        assert_eq!(
            resolve_target("same title", &entries).map(|e| e.path.as_str()),
            Some("a/dup.md")
        );
    }
}
