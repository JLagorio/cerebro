# M30 Multi-Root Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Widen Cerebro from one vault to 1+N mounted roots, browsable in a VS Code-style file tree, with a read-only document viewer good enough to stop opening repos elsewhere to find a README.

**Architecture:** Roots are capability-gated (`{ knowledge, git, writable }`, probed from disk) and persisted in app-data. Two independent Rust data paths serve the UI: lazy per-directory listing for the tree (all file types, constant memory) and a `git ls-files`-filtered markdown index for the Docs tab. Everything is read-only — no file in this plan is ever written.

**Tech Stack:** Rust (Tauri 2), React 19, Zustand. Four new runtime dependencies: `react-markdown`, `remark-gfm`, `shiki`, `react-virtuoso`.

**Spec:** `docs/superpowers/specs/2026-08-09-cerebro-m30-workspace-design.md`

---

## Deviation from the spec (deliberate, adopted here)

Spec §1.6 says *"Add `Entry.root: string`"*. **This plan does not do that.** Grounding the design in real signatures showed a cleaner route to the same goal:

Repo markdown must never enter `vaultStore` — that store drives collections, types and dossiers, and it is seeded from `scan_vault`, whose signature every existing caller depends on. Threading a root id through it touches the whole app to serve one new tab.

Instead the markdown index returns a **separate `IndexedDoc` type** carrying exactly what the Docs tab needs. `Entry`, `scan_vault`, and `vaultStore` are untouched. This honours §1.6's own stated rationale ("minimum-blast-radius") more faithfully than the change §1.6 proposed, and D″ can map `IndexedDoc → Entry` when it promotes the viewer to a view kind.

`Root.alias` is still added, still reserved, still unused (§1.6).

---

## File structure

**Rust — created**
| File | Responsibility |
| --- | --- |
| `src-tauri/src/roots/mod.rs` | `Root`, `RootCaps`, capability probing, mount/unmount, the one-knowledge-root invariant |
| `src-tauri/src/roots/store.rs` | Load/save `roots.json` in app-data; corrupt → default |
| `src-tauri/src/roots/tree.rs` | `list_dir` — one level, ordered, gitignore-flagged |
| `src-tauri/src/roots/read.rs` | `read_file_text` and its three guards |
| `src-tauri/src/roots/index.rs` | `IndexedDoc` markdown index via `git ls-files` |
| `src-tauri/src/roots_commands.rs` | Tauri command surface |

**Rust — modified:** `src-tauri/src/lib.rs` (module decl + handler registration)

**TypeScript — created**
| File | Responsibility |
| --- | --- |
| `src/engine/roots.ts` | `Root`, `RootCaps`, `DirEntry`, `IndexedDoc`, `FileText` types + pure helpers |
| `src/lib/rootsIpc.ts` | IPC facade for the six root commands |
| `src/lib/mockRoots.ts` | In-memory backend mirroring every Rust guard |
| `src/stores/rootsStore.ts` | Zustand store: mounted roots, expansion, open file |
| `src/pages/WorkspacePage.tsx` | The surface |
| `src/workspace/RootTree.tsx` | Lazy, virtualized tree |
| `src/workspace/treeRows.ts` | Pure tree flattener |
| `src/workspace/FileViewer.tsx` | Routes a file to a viewer or a typed placeholder |
| `src/workspace/DocViewer.tsx` | Markdown reading surface |
| `src/workspace/docLinks.ts` | Relative-link resolution |
| `src/workspace/CodeViewer.tsx` | Highlighted read-only code |
| `src/workspace/highlighter.ts` | Lazy Shiki singleton |
| `src/workspace/DocsTab.tsx` | Cross-root markdown index |
| `src/workspace/RootMountDialog.tsx` | Mount flow with capability preview |

**TypeScript — modified:** `src/engine/types.ts` (Selection arm), `src/app/Rail.tsx` (destination), `src/App.tsx` (route)

---

## Phase 1 — The roots model

### Task M30.1: Root types and capability probing

**Files:**
- Create: `src-tauri/src/roots/mod.rs`
- Modify: `src-tauri/src/lib.rs:1-10`

- [ ] **Step 1: Declare the module**

In `src-tauri/src/lib.rs`, add after `pub mod mcp;`:

```rust
pub mod roots;
```

- [ ] **Step 2: Write the failing test**

Create `src-tauri/src/roots/mod.rs` with the header and test module:

```rust
//! Mounted roots: the workspace is 1+N directories, not one vault.
//!
//! A root is described by what it CAN DO, not by what it is called. AGENTS.md
//! forbids routing on type names, so there is no `kind: vault | repo` field —
//! `RootCaps` is probed from disk and every consumer gates on a capability.

use serde::{Deserialize, Serialize};
use std::path::Path;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::testutil;

    #[test]
    fn probes_plain_directory_as_no_capabilities() {
        let dir = testutil::temp_vault("roots-plain");
        let caps = probe(&dir);
        assert!(!caps.knowledge, "no knowledge/ dir");
        assert!(!caps.git, "not a repo");
        assert!(caps.writable, "a writable temp dir");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn probes_knowledge_bundle() {
        let dir = testutil::temp_vault("roots-knowledge");
        std::fs::create_dir_all(dir.join("knowledge")).unwrap();
        assert!(probe(&dir).knowledge);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn knowledge_requires_a_directory_not_a_file() {
        let dir = testutil::temp_vault("roots-knowledge-file");
        testutil::write(&dir, "knowledge", "not a directory");
        assert!(!probe(&dir).knowledge);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn probes_git_repository() {
        let dir = testutil::temp_vault("roots-git");
        crate::git::commit::init_repo(&dir).unwrap();
        assert!(probe(&dir).git);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_directory_probes_to_nothing() {
        let caps = probe(Path::new("/nonexistent/cerebro/root"));
        assert!(!caps.knowledge && !caps.git && !caps.writable);
    }
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd src-tauri && cargo test roots::`
Expected: FAIL — `cannot find function 'probe' in this scope`

- [ ] **Step 4: Write the implementation**

Add above the test module in `src-tauri/src/roots/mod.rs`:

```rust
/// What a root can do. Probed from disk, never declared by the user.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RootCaps {
    /// Carries a `knowledge/` bundle (and, later, a ledger).
    pub knowledge: bool,
    /// Is a git repository.
    pub git: bool,
    /// Mutations are permitted at all.
    pub writable: bool,
}

/// One mounted directory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Root {
    /// Generated once at mount. NOT derived from the path — moving a repo on
    /// disk must not orphan every reference to it.
    pub id: String,
    pub path: String,
    pub label: String,
    /// Reserved for the cross-root reference form `alias:relative/path.md`.
    /// Nothing reads it yet (M30 spec, section 1.6).
    pub alias: String,
    #[serde(default)]
    pub color: Option<String>,
    pub caps: RootCaps,
}

/// Probe a directory's capabilities.
///
/// A path that does not exist probes to nothing rather than erroring: an
/// unplugged external drive is a root that is temporarily unavailable, not a
/// malformed one, and the tree renders it as such.
pub fn probe(path: impl AsRef<Path>) -> RootCaps {
    let path = path.as_ref();
    if !path.is_dir() {
        return RootCaps::default();
    }
    RootCaps {
        knowledge: path.join(crate::knowledge::KNOWLEDGE_DIR).is_dir(),
        git: crate::git::workspace::resolve(path).is_repo(),
        writable: !path
            .metadata()
            .map(|m| m.permissions().readonly())
            .unwrap_or(true),
    }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd src-tauri && cargo test roots::`
Expected: PASS — 5 tests

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/roots/mod.rs src-tauri/src/lib.rs
git commit -m "feat(roots): a root is what it can do, not what it is called (M30.1)"
```

---

### Task M30.2: Root persistence

**Files:**
- Create: `src-tauri/src/roots/store.rs`
- Modify: `src-tauri/src/roots/mod.rs`

- [ ] **Step 1: Declare the submodule**

Add to the top of `src-tauri/src/roots/mod.rs`, after the `use` lines:

```rust
pub mod store;
```

- [ ] **Step 2: Write the failing test**

Create `src-tauri/src/roots/store.rs`:

```rust
//! Where the mounted-root list is persisted.
//!
//! App-data, NOT the vault. AGENTS.md's two-records rule assigns operational
//! state to the runtime side and epistemic history to the vault ledger; which
//! repositories you happen to have mounted is plainly operational.
//!
//! Every failure degrades to "no roots mounted" rather than propagating. A
//! corrupt list must not prevent the app from starting — the user can re-mount.

use std::path::{Path, PathBuf};

use super::Root;

const ROOTS_FILE: &str = "roots.json";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::roots::RootCaps;
    use crate::vault::testutil;

    fn sample(id: &str) -> Root {
        Root {
            id: id.to_string(),
            path: format!("/tmp/{id}"),
            label: id.to_string(),
            alias: id.to_string(),
            color: None,
            caps: RootCaps { knowledge: false, git: true, writable: true },
        }
    }

    #[test]
    fn load_returns_empty_when_missing() {
        let dir = testutil::temp_vault("roots-store-missing");
        assert_eq!(load(&dir), Vec::<Root>::new());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = testutil::temp_vault("roots-store-roundtrip");
        let roots = vec![sample("alpha"), sample("beta")];
        save(&dir, &roots).unwrap();
        assert_eq!(load(&dir), roots);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_json_degrades_to_empty() {
        let dir = testutil::temp_vault("roots-store-corrupt");
        std::fs::write(dir.join(ROOTS_FILE), "{not json").unwrap();
        assert_eq!(load(&dir), Vec::<Root>::new());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_creates_the_directory() {
        let dir = testutil::temp_vault("roots-store-mkdir").join("nested");
        save(&dir, &[sample("gamma")]).unwrap();
        assert_eq!(load(&dir).len(), 1);
        let _ = std::fs::remove_dir_all(dir.parent().unwrap());
    }
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd src-tauri && cargo test roots::store`
Expected: FAIL — `cannot find function 'load'`

- [ ] **Step 4: Write the implementation**

Add above the test module in `src-tauri/src/roots/store.rs`:

```rust
fn roots_path(dir: &Path) -> PathBuf {
    dir.join(ROOTS_FILE)
}

/// Load the mounted-root list. Any failure — missing, unreadable, malformed —
/// yields an empty list.
pub fn load(dir: &Path) -> Vec<Root> {
    std::fs::read_to_string(roots_path(dir))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// Write the mounted-root list, creating the directory.
pub fn save(dir: &Path, roots: &[Root]) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let raw = serde_json::to_string_pretty(roots).map_err(|e| e.to_string())?;
    std::fs::write(roots_path(dir), raw).map_err(|e| e.to_string())
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd src-tauri && cargo test roots::store`
Expected: PASS — 4 tests

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/roots/store.rs src-tauri/src/roots/mod.rs
git commit -m "feat(roots): the mount list is operational state, so it lives in app-data (M30.2)"
```

---

### Task M30.3: Mount, unmount, and the one-knowledge-root invariant

**Files:**
- Modify: `src-tauri/src/roots/mod.rs`

- [ ] **Step 1: Write the failing test**

Add these tests inside the existing `mod tests` in `src-tauri/src/roots/mod.rs`:

```rust
    #[test]
    fn mount_derives_label_and_alias_from_basename() {
        let cfg = testutil::temp_vault("roots-mount-cfg");
        let repo = testutil::temp_vault("My Repo");
        let root = mount(&cfg, repo.to_str().unwrap()).unwrap();
        assert_eq!(root.label, repo.file_name().unwrap().to_str().unwrap());
        assert!(!root.alias.is_empty());
        assert!(!root.id.is_empty());
        let _ = std::fs::remove_dir_all(&cfg);
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn mount_persists_so_list_sees_it() {
        let cfg = testutil::temp_vault("roots-mount-persist");
        let repo = testutil::temp_vault("roots-mount-persist-repo");
        mount(&cfg, repo.to_str().unwrap()).unwrap();
        assert_eq!(list(&cfg).len(), 1);
        let _ = std::fs::remove_dir_all(&cfg);
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn mounting_the_same_path_twice_is_refused() {
        let cfg = testutil::temp_vault("roots-mount-dupe");
        let repo = testutil::temp_vault("roots-mount-dupe-repo");
        mount(&cfg, repo.to_str().unwrap()).unwrap();
        let err = mount(&cfg, repo.to_str().unwrap()).unwrap_err();
        assert_eq!(err.code, "already_mounted");
        let _ = std::fs::remove_dir_all(&cfg);
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn a_second_knowledge_root_is_refused_and_names_the_first() {
        let cfg = testutil::temp_vault("roots-two-brains");
        let first = testutil::temp_vault("roots-brain-one");
        let second = testutil::temp_vault("roots-brain-two");
        std::fs::create_dir_all(first.join("knowledge")).unwrap();
        std::fs::create_dir_all(second.join("knowledge")).unwrap();

        mount(&cfg, first.to_str().unwrap()).unwrap();
        let err = mount(&cfg, second.to_str().unwrap()).unwrap_err();

        assert_eq!(err.code, "knowledge_root_exists");
        assert!(
            err.message.contains(first.file_name().unwrap().to_str().unwrap()),
            "the refusal must name the existing knowledge root, got: {}",
            err.message
        );
        assert_eq!(list(&cfg).len(), 1, "the refused root must not be persisted");

        let _ = std::fs::remove_dir_all(&cfg);
        let _ = std::fs::remove_dir_all(&first);
        let _ = std::fs::remove_dir_all(&second);
    }

    #[test]
    fn mounting_a_missing_directory_is_refused() {
        let cfg = testutil::temp_vault("roots-mount-missing");
        let err = mount(&cfg, "/nonexistent/cerebro/root").unwrap_err();
        assert_eq!(err.code, "not_a_directory");
        let _ = std::fs::remove_dir_all(&cfg);
    }

    #[test]
    fn unmount_removes_only_the_named_root() {
        let cfg = testutil::temp_vault("roots-unmount");
        let a = testutil::temp_vault("roots-unmount-a");
        let b = testutil::temp_vault("roots-unmount-b");
        let ra = mount(&cfg, a.to_str().unwrap()).unwrap();
        mount(&cfg, b.to_str().unwrap()).unwrap();

        unmount(&cfg, &ra.id).unwrap();

        let remaining = list(&cfg);
        assert_eq!(remaining.len(), 1);
        assert_ne!(remaining[0].id, ra.id);

        let _ = std::fs::remove_dir_all(&cfg);
        let _ = std::fs::remove_dir_all(&a);
        let _ = std::fs::remove_dir_all(&b);
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test roots::`
Expected: FAIL — `cannot find function 'mount'`

- [ ] **Step 3: Write the implementation**

Add to `src-tauri/src/roots/mod.rs`, above the test module:

```rust
/// A refusal the UI is expected to READ and act on, not toast away.
///
/// `code` is matched by callers; `message` is shown. A bare string would force
/// the UI to pattern-match prose to tell "already mounted" from "no such
/// directory", which are different affordances.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MountRefusal {
    pub code: String,
    pub message: String,
}

impl MountRefusal {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.to_string(), message: message.into() }
    }
}

/// Lowercase, dash-separated, alphanumerics only — a slug safe to use as a
/// reference prefix later without quoting.
fn slugify(name: &str) -> String {
    let mut out = String::new();
    let mut last_dash = true;
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

/// Make `base` unique against everything already taken, by suffixing -2, -3, …
fn unique_alias(base: &str, taken: &[Root]) -> String {
    let base = if base.is_empty() { "root".to_string() } else { base.to_string() };
    if !taken.iter().any(|r| r.alias == base) {
        return base;
    }
    (2..)
        .map(|n| format!("{base}-{n}"))
        .find(|c| !taken.iter().any(|r| &r.alias == c))
        .unwrap()
}

pub fn list(config_dir: &Path) -> Vec<Root> {
    store::load(config_dir)
}

/// Attach a directory that already exists on disk.
///
/// Cerebro never creates or owns a checkout (M30 roadmap, decision 4) — this
/// only ever adds a path to a list.
pub fn mount(config_dir: &Path, path: &str) -> Result<Root, MountRefusal> {
    let canonical = std::fs::canonicalize(path)
        .map_err(|_| MountRefusal::new("not_a_directory", format!("{path} is not a directory")))?;
    if !canonical.is_dir() {
        return Err(MountRefusal::new(
            "not_a_directory",
            format!("{path} is not a directory"),
        ));
    }
    let canonical_str = canonical.to_string_lossy().to_string();

    let mut roots = store::load(config_dir);
    if let Some(existing) = roots.iter().find(|r| r.path == canonical_str) {
        return Err(MountRefusal::new(
            "already_mounted",
            format!("{} is already mounted as \"{}\"", canonical_str, existing.label),
        ));
    }

    let caps = probe(&canonical);

    // The v1 invariant. A refusal, not a disabled button: knowledge.rs states
    // the principle — "a disabled button is a suggestion, a rejected command is
    // a rule". Naming the incumbent is what makes it actionable.
    if caps.knowledge {
        if let Some(existing) = roots.iter().find(|r| r.caps.knowledge) {
            return Err(MountRefusal::new(
                "knowledge_root_exists",
                format!(
                    "\"{}\" already holds this workspace's knowledge base. \
                     Cerebro supports one knowledge root; unmount it first.",
                    existing.label
                ),
            ));
        }
    }

    let label = canonical
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| canonical_str.clone());
    let alias = unique_alias(&slugify(&label), &roots);
    let id = format!("root-{}-{}", alias, roots.len() + 1);

    let root = Root { id, path: canonical_str, label, alias, color: None, caps };
    roots.push(root.clone());
    store::save(config_dir, &roots).map_err(|e| MountRefusal::new("persist_failed", e))?;
    Ok(root)
}

/// Detach a root. Never touches the directory itself.
pub fn unmount(config_dir: &Path, id: &str) -> Result<(), String> {
    let mut roots = store::load(config_dir);
    let before = roots.len();
    roots.retain(|r| r.id != id);
    if roots.len() == before {
        return Err(format!("no mounted root with id {id}"));
    }
    store::save(config_dir, &roots)
}

/// Look up a mounted root by id.
pub fn find(config_dir: &Path, id: &str) -> Option<Root> {
    store::load(config_dir).into_iter().find(|r| r.id == id)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test roots::`
Expected: PASS — 11 tests

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/roots/mod.rs
git commit -m "feat(roots): one root thinks, and the refusal says which one (M30.3)"
```

---

## Phase 2 — File access

### Task M30.4: Lazy directory listing

**Files:**
- Create: `src-tauri/src/roots/tree.rs`
- Modify: `src-tauri/src/roots/mod.rs`

- [ ] **Step 1: Declare the submodule**

Add to `src-tauri/src/roots/mod.rs` beside `pub mod store;`:

```rust
pub mod tree;
```

- [ ] **Step 2: Write the failing test**

Create `src-tauri/src/roots/tree.rs`:

```rust
//! One directory level at a time.
//!
//! The tree NEVER walks a repository. A monorepo with 200k files must open as
//! fast as an empty one, which is only true if expanding a node costs exactly
//! one readdir. This is the half of the design that scales; `index.rs` is the
//! half that answers cross-root questions.

use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    /// Root-relative, forward-slashed. Empty for the root itself.
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    /// True when git would ignore this path. Entries are RETURNED and flagged,
    /// never omitted — the UI owns the show-ignored toggle, and a backend that
    /// dropped them would make the toggle cost a second round trip.
    pub ignored: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::testutil;

    #[test]
    fn lists_one_level_only() {
        let dir = testutil::temp_vault("tree-one-level");
        testutil::write(&dir, "top.md", "# Top");
        testutil::write(&dir, "sub/nested.md", "# Nested");
        testutil::write(&dir, "sub/deeper/deep.md", "# Deep");

        let out = list_dir(&dir, "").unwrap();
        let names: Vec<&str> = out.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["sub", "top.md"]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn directories_sort_before_files_then_alphabetically() {
        let dir = testutil::temp_vault("tree-order");
        testutil::write(&dir, "a-file.md", "x");
        testutil::write(&dir, "z-file.md", "x");
        testutil::write(&dir, "m-dir/inner.md", "x");
        testutil::write(&dir, "b-dir/inner.md", "x");

        let names: Vec<String> =
            list_dir(&dir, "").unwrap().into_iter().map(|e| e.name).collect();
        assert_eq!(names, vec!["b-dir", "m-dir", "a-file.md", "z-file.md"]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn descends_into_a_subdirectory() {
        let dir = testutil::temp_vault("tree-descend");
        testutil::write(&dir, "sub/nested.md", "# Nested");
        let out = list_dir(&dir, "sub").unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].path, "sub/nested.md");
        assert!(!out[0].is_dir);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_to_escape_the_root() {
        let dir = testutil::temp_vault("tree-escape");
        testutil::write(&dir, "inside.md", "x");
        assert!(list_dir(&dir, "../..").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn flags_gitignored_entries_without_omitting_them() {
        let dir = testutil::temp_vault("tree-ignored");
        crate::git::commit::init_repo(&dir).unwrap();
        testutil::write(&dir, ".gitignore", "secret.md\n");
        testutil::write(&dir, "secret.md", "x");
        testutil::write(&dir, "public.md", "x");

        let out = list_dir(&dir, "").unwrap();
        let secret = out.iter().find(|e| e.name == "secret.md").expect("returned, not dropped");
        let public = out.iter().find(|e| e.name == "public.md").unwrap();
        assert!(secret.ignored);
        assert!(!public.ignored);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_non_repo_flags_nothing_as_ignored() {
        let dir = testutil::temp_vault("tree-no-repo");
        testutil::write(&dir, "file.md", "x");
        assert!(list_dir(&dir, "").unwrap().iter().all(|e| !e.ignored));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd src-tauri && cargo test roots::tree`
Expected: FAIL — `cannot find function 'list_dir'`

- [ ] **Step 4: Write the path guard**

Add above the test module in `src-tauri/src/roots/tree.rs`:

```rust
/// Resolve `rel` under `root`, refusing anything that escapes.
///
/// Canonicalizing BOTH sides is what defeats `../` and symlinks pointing out
/// of the tree; comparing the unresolved strings would not.
pub(super) fn resolve_within(root: &Path, rel: &str) -> Result<std::path::PathBuf, String> {
    let root = std::fs::canonicalize(root).map_err(|e| format!("root unavailable: {e}"))?;
    let joined = if rel.is_empty() { root.clone() } else { root.join(rel) };
    let resolved =
        std::fs::canonicalize(&joined).map_err(|_| format!("no such path: {rel}"))?;
    if !resolved.starts_with(&root) {
        return Err(format!("path escapes the root: {rel}"));
    }
    Ok(resolved)
}
```

- [ ] **Step 5: Write the ignore probe**

Still in `src-tauri/src/roots/tree.rs`, add below `resolve_within`. This asks git about the whole directory in one process, because asking per file would make a 500-entry folder cost 500 process launches:

```rust
/// Ask git which of `names` it ignores, in one call.
fn ignored_set(dir: &Path, names: &[String]) -> std::collections::HashSet<String> {
    use std::io::Write;

    let mut found = std::collections::HashSet::new();
    if names.is_empty() {
        return found;
    }
    let mut command = crate::git::command::git_at(dir);
    command.args(["check-ignore", "--stdin"]);
    command.stdin(std::process::Stdio::piped());
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::null());

    let Ok(mut child) = command.spawn() else {
        return found;
    };
    if let Some(mut pipe) = child.stdin.take() {
        let _ = pipe.write_all(names.join("\n").as_bytes());
    }
    let Ok(out) = child.wait_with_output() else {
        return found;
    };
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            found.insert(trimmed.to_string());
        }
    }
    found
}
```

- [ ] **Step 6: Write the listing**

Still in `src-tauri/src/roots/tree.rs`, add below `ignored_set`:

```rust
/// List exactly one level under `rel`. Directories first, then files, each
/// group alphabetical and case-insensitive.
pub fn list_dir(root: &Path, rel: &str) -> Result<Vec<DirEntry>, String> {
    let dir = resolve_within(root, rel)?;
    if !dir.is_dir() {
        return Err(format!("not a directory: {rel}"));
    }

    let mut out = Vec::new();
    let mut names = Vec::new();
    for item in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        // One unreadable entry must not fail the whole listing.
        let Ok(item) = item else { continue };
        let name = item.file_name().to_string_lossy().to_string();
        // `.git` is machinery, not content; it is never browsable.
        if name == ".git" {
            continue;
        }
        let is_dir = item.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let size = item.metadata().map(|m| m.len()).unwrap_or(0);
        let path = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
        names.push(name.clone());
        out.push(DirEntry { name, path, is_dir, size, ignored: false });
    }

    let ignored = ignored_set(&dir, &names);
    for entry in &mut out {
        entry.ignored = ignored.contains(&entry.name);
    }

    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd src-tauri && cargo test roots::tree`
Expected: PASS — 6 tests

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/roots/tree.rs src-tauri/src/roots/mod.rs
git commit -m "feat(roots): the tree reads one level, so a monorepo opens like an empty folder (M30.4)"
```

---

### Task M30.5: Guarded file reads

**Files:**
- Create: `src-tauri/src/roots/read.rs`
- Modify: `src-tauri/src/roots/mod.rs`

- [ ] **Step 1: Declare the submodule**

Add to `src-tauri/src/roots/mod.rs`:

```rust
pub mod read;
```

- [ ] **Step 2: Write the failing test**

Create `src-tauri/src/roots/read.rs`:

```rust
//! Reading one file, with the three guards that keep this from being an
//! arbitrary-file-read primitive.
//!
//! `mcp.rs` exposes tools to a CLI subprocess, so an unguarded reader reachable
//! from a command is a real exposure, not a theoretical one. All three guards
//! ship with the function — none is a follow-up.

use serde::Serialize;
use std::path::Path;

/// 2 MB. Large enough for any source file worth reading in a viewer, small
/// enough that a stray database dump cannot exhaust memory.
pub const MAX_BYTES: u64 = 2 * 1024 * 1024;

/// The result of a read. Refusals are VALUES, not error strings: the viewer
/// renders a different placeholder for each, and a string would force it to
/// pattern-match prose.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FileText {
    Text { content: String },
    TooLarge { size: u64, limit: u64 },
    Binary,
    NotFound,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::testutil;

    #[test]
    fn reads_a_text_file() {
        let dir = testutil::temp_vault("read-text");
        testutil::write(&dir, "hello.md", "# Hello");
        assert_eq!(
            read_file_text(&dir, "hello.md"),
            FileText::Text { content: "# Hello".to_string() }
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_a_path_escaping_the_root() {
        let dir = testutil::temp_vault("read-escape");
        testutil::write(&dir, "inside.md", "x");
        assert_eq!(read_file_text(&dir, "../../etc/passwd"), FileText::NotFound);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_symlink_pointing_outside_the_root() {
        let dir = testutil::temp_vault("read-symlink");
        let outside = testutil::temp_vault("read-symlink-outside");
        testutil::write(&outside, "secret.md", "classified");
        std::os::unix::fs::symlink(outside.join("secret.md"), dir.join("link.md")).unwrap();

        assert_eq!(read_file_text(&dir, "link.md"), FileText::NotFound);

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn refuses_a_file_over_the_size_cap() {
        let dir = testutil::temp_vault("read-large");
        let big = "x".repeat((MAX_BYTES + 1) as usize);
        testutil::write(&dir, "big.txt", &big);
        match read_file_text(&dir, "big.txt") {
            FileText::TooLarge { size, limit } => {
                assert!(size > MAX_BYTES);
                assert_eq!(limit, MAX_BYTES);
            }
            other => panic!("expected TooLarge, got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_a_binary_file() {
        let dir = testutil::temp_vault("read-binary");
        std::fs::write(dir.join("image.png"), [0x89, b'P', b'N', b'G', 0x00, 0x1a]).unwrap();
        assert_eq!(read_file_text(&dir, "image.png"), FileText::Binary);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_file_is_not_found() {
        let dir = testutil::temp_vault("read-missing");
        assert_eq!(read_file_text(&dir, "nope.md"), FileText::NotFound);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd src-tauri && cargo test roots::read`
Expected: FAIL — `cannot find function 'read_file_text'`

- [ ] **Step 4: Write the implementation**

Add above the test module in `src-tauri/src/roots/read.rs`:

```rust
/// How much of the file to sniff for NUL before deciding it is binary.
const SNIFF_BYTES: usize = 8 * 1024;

/// Read one text file from inside a root.
///
/// Guard order matters: containment first (never touch a file outside the
/// root), then size (never load one that could exhaust memory), then binary
/// (never hand the UI bytes it cannot render).
pub fn read_file_text(root: &Path, rel: &str) -> FileText {
    let Ok(path) = super::tree::resolve_within(root, rel) else {
        return FileText::NotFound;
    };
    let Ok(meta) = std::fs::metadata(&path) else {
        return FileText::NotFound;
    };
    if !meta.is_file() {
        return FileText::NotFound;
    }
    if meta.len() > MAX_BYTES {
        return FileText::TooLarge { size: meta.len(), limit: MAX_BYTES };
    }
    let Ok(bytes) = std::fs::read(&path) else {
        return FileText::NotFound;
    };
    if bytes.iter().take(SNIFF_BYTES).any(|b| *b == 0) {
        return FileText::Binary;
    }
    match String::from_utf8(bytes) {
        Ok(content) => FileText::Text { content },
        // Valid non-UTF-8 bytes with no NUL — still not something to render.
        Err(_) => FileText::Binary,
    }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd src-tauri && cargo test roots::read`
Expected: PASS — 6 tests (5 on non-Unix)

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/roots/read.rs src-tauri/src/roots/mod.rs
git commit -m "feat(roots): a reader reachable from MCP is guarded before it exists (M30.5)"
```

---

## Phase 3 — The markdown index

### Task M30.6: IndexedDoc via git ls-files

**Files:**
- Create: `src-tauri/src/roots/index.rs`
- Modify: `src-tauri/src/roots/mod.rs`, `src-tauri/src/vault/scan.rs`

- [ ] **Step 1: Declare the submodule**

Add to `src-tauri/src/roots/mod.rs`:

```rust
pub mod index;
```

- [ ] **Step 2: Write the failing test**

Create `src-tauri/src/roots/index.rs`:

```rust
//! Every markdown file in a root, for the Docs tab.
//!
//! Git IS the filter. `git ls-files` returns tracked files, which excludes
//! node_modules, build output and .git for free and correctly — no ignore
//! pattern list to write, and none to drift out of date. It is git, not
//! GitHub, so it works against any remote or none at all.
//!
//! This is a SEPARATE type from `vault::Entry` on purpose. Repo markdown must
//! never reach `vaultStore`, which drives collections, types and dossiers and
//! is seeded from `scan_vault`.

use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexedDoc {
    pub root: String,
    /// Root-relative, forward-slashed.
    pub path: String,
    /// First H1, else the humanized filename stem — same rule the vault uses.
    pub title: String,
    pub snippet: String,
    pub modified_at: String,
    /// Directory depth; 0 at the root. Drives "front door first" ordering.
    pub depth: usize,
    pub is_readme: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::testutil;

    fn commit_all(dir: &Path) {
        crate::git::commit::init_repo(dir).unwrap();
        crate::git::command::run(dir, &["add", "-A"]).unwrap();
    }

    #[test]
    fn indexes_tracked_markdown_only() {
        let dir = testutil::temp_vault("index-tracked");
        testutil::write(&dir, "README.md", "# Project\n\nIntro text.");
        testutil::write(&dir, "src/main.rs", "fn main() {}");
        commit_all(&dir);

        let docs = index_root(&dir, "root-1").unwrap();
        let paths: Vec<&str> = docs.iter().map(|d| d.path.as_str()).collect();
        assert_eq!(paths, vec!["README.md"], "only markdown, and only tracked");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn untracked_noise_is_excluded_without_a_pattern_list() {
        let dir = testutil::temp_vault("index-noise");
        testutil::write(&dir, "README.md", "# Real");
        testutil::write(&dir, ".gitignore", "node_modules/\n");
        commit_all(&dir);
        // Written AFTER the commit and gitignored — git never tracks it.
        testutil::write(&dir, "node_modules/pkg/README.md", "# Noise");

        let docs = index_root(&dir, "root-1").unwrap();
        assert_eq!(docs.len(), 1);
        assert_eq!(docs[0].path, "README.md");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn derives_title_snippet_depth_and_readme_flag() {
        let dir = testutil::temp_vault("index-derive");
        testutil::write(&dir, "docs/guide/setup.md", "# Setting up\n\nRun the installer.");
        commit_all(&dir);

        let docs = index_root(&dir, "root-1").unwrap();
        let doc = &docs[0];
        assert_eq!(doc.root, "root-1");
        assert_eq!(doc.title, "Setting up");
        assert!(doc.snippet.contains("Run the installer"));
        assert_eq!(doc.depth, 2, "docs/guide/setup.md sits two directories deep");
        assert!(!doc.is_readme);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn recognises_readme_case_insensitively() {
        let dir = testutil::temp_vault("index-readme");
        testutil::write(&dir, "ReadMe.md", "# Hi");
        commit_all(&dir);
        assert!(index_root(&dir, "root-1").unwrap()[0].is_readme);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_non_repo_falls_back_to_walking() {
        let dir = testutil::temp_vault("index-no-repo");
        testutil::write(&dir, "notes.md", "# Notes");
        testutil::write(&dir, ".hidden/skip.md", "# Skipped");

        let docs = index_root(&dir, "root-1").unwrap();
        let paths: Vec<&str> = docs.iter().map(|d| d.path.as_str()).collect();
        assert_eq!(paths, vec!["notes.md"], "dot-dirs stay skipped in the fallback");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sorts_readmes_first_then_depth_then_title() {
        let dir = testutil::temp_vault("index-sort");
        testutil::write(&dir, "docs/deep/z.md", "# Zeta");
        testutil::write(&dir, "docs/a.md", "# Alpha");
        testutil::write(&dir, "README.md", "# Front door");
        commit_all(&dir);

        let paths: Vec<String> =
            index_root(&dir, "root-1").unwrap().into_iter().map(|d| d.path).collect();
        assert_eq!(paths, vec!["README.md", "docs/a.md", "docs/deep/z.md"]);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd src-tauri && cargo test roots::index`
Expected: FAIL — `cannot find function 'index_root'`

- [ ] **Step 4: Write the classifiers and the two file sources**

Add above the test module in `src-tauri/src/roots/index.rs`:

```rust
fn is_markdown(path: &str) -> bool {
    let lower = path.to_lowercase();
    lower.ends_with(".md") || lower.ends_with(".markdown")
}

fn is_readme(path: &str) -> bool {
    path.rsplit('/')
        .next()
        .unwrap_or(path)
        .to_lowercase()
        .starts_with("readme.")
}

fn depth_of(path: &str) -> usize {
    path.matches('/').count()
}

/// Tracked markdown, via git. `None` when this is not a repository.
fn tracked_markdown(root: &Path) -> Option<Vec<String>> {
    let out =
        crate::git::command::run(root, &["ls-files", "-z", "--", "*.md", "*.markdown"]).ok()?;
    Some(out.split('\0').filter(|s| !s.is_empty()).map(|s| s.to_string()).collect())
}

/// Markdown by walking, for a root that is not a repository. Reuses the same
/// skip rules the vault scanner applies.
fn walked_markdown(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let walker = walkdir::WalkDir::new(root).into_iter().filter_entry(|e| {
        if e.depth() == 0 {
            return true;
        }
        let name = e.file_name().to_string_lossy();
        !(name.starts_with('.') || name == "node_modules" || name == "target" || name == "dist")
    });
    for item in walker.filter_map(Result::ok) {
        if !item.file_type().is_file() {
            continue;
        }
        let Ok(rel) = item.path().strip_prefix(root) else { continue };
        let rel = rel.to_string_lossy().replace('\\', "/");
        if is_markdown(&rel) {
            out.push(rel);
        }
    }
    out
}
```

- [ ] **Step 5: Write the index builder**

Still in `src-tauri/src/roots/index.rs`, add below `walked_markdown`:

```rust
/// Build the markdown index for one root.
pub fn index_root(root: &Path, root_id: &str) -> Result<Vec<IndexedDoc>, String> {
    if !root.is_dir() {
        return Err(format!("root unavailable: {}", root.display()));
    }
    let paths = tracked_markdown(root).unwrap_or_else(|| walked_markdown(root));

    let mut docs = Vec::new();
    for rel in paths {
        if !is_markdown(&rel) {
            continue;
        }
        let full = root.join(&rel);
        // A tracked file missing from the working tree is not an error worth
        // failing the whole index for.
        let Ok(content) = std::fs::read_to_string(&full) else { continue };
        let modified_at = std::fs::metadata(&full)
            .and_then(|m| m.modified())
            .map(|t| {
                let secs =
                    t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
                crate::vault::scan::iso_from_epoch(secs)
            })
            .unwrap_or_default();

        let (_, body) = crate::vault::parse::split_frontmatter(&content);
        let filename = rel.rsplit('/').next().unwrap_or(&rel).to_string();
        let stem = filename.rsplit_once('.').map(|(s, _)| s).unwrap_or(&filename).to_string();
        let title = crate::vault::parse::extract_h1_title(body)
            .unwrap_or_else(|| crate::vault::parse::humanize_stem(&stem));

        docs.push(IndexedDoc {
            root: root_id.to_string(),
            depth: depth_of(&rel),
            is_readme: is_readme(&rel),
            title,
            snippet: crate::vault::parse::extract_snippet(body),
            modified_at,
            path: rel,
        });
    }

    // Front door first: a README is what you want when you open a repo you do
    // not know. Then shallow before deep, then alphabetical.
    docs.sort_by(|a, b| {
        b.is_readme
            .cmp(&a.is_readme)
            .then_with(|| a.depth.cmp(&b.depth))
            .then_with(|| a.title.to_lowercase().cmp(&b.title.to_lowercase()))
            .then_with(|| a.path.cmp(&b.path))
    });
    Ok(docs)
}
```

- [ ] **Step 6: Add the timestamp helper**

`index.rs` calls `crate::vault::scan::iso_from_epoch`, which does not exist yet. First check how `scan.rs` already converts:

Run: `cd src-tauri && grep -n "fn timestamps" -A 15 src/vault/scan.rs`

If that function already formats an ISO string from a `SystemTime`, extract the conversion into a public helper and call it from both places. If it delegates elsewhere, add this self-contained version to `src-tauri/src/vault/scan.rs`:

```rust
/// Seconds since the epoch as an ISO 8601 UTC string.
///
/// Civil-from-days (Howard Hinnant's algorithm), epoch-shifted to 0000-03-01
/// so leap years fall at the end of the cycle and need no special case.
pub fn iso_from_epoch(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.000Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

#[cfg(test)]
mod iso_tests {
    use super::iso_from_epoch;

    #[test]
    fn formats_the_unix_epoch() {
        assert_eq!(iso_from_epoch(0), "1970-01-01T00:00:00.000Z");
    }

    #[test]
    fn formats_a_known_instant() {
        assert_eq!(iso_from_epoch(1_786_233_600), "2026-08-09T00:00:00.000Z");
    }

    #[test]
    fn formats_a_leap_day() {
        assert_eq!(iso_from_epoch(1_709_164_800), "2024-02-29T00:00:00.000Z");
    }

    #[test]
    fn keeps_the_time_of_day() {
        assert_eq!(iso_from_epoch(1_786_233_600 + 3_661), "2026-08-09T01:01:01.000Z");
    }
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd src-tauri && cargo test roots::index && cargo test vault::scan`
Expected: PASS — 6 index tests, plus the existing scan tests still green

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/roots/index.rs src-tauri/src/roots/mod.rs src-tauri/src/vault/scan.rs
git commit -m "feat(roots): git is the filter, so the index has no pattern list to drift (M30.6)"
```

---

### Task M30.7: Tauri command surface

**Files:**
- Create: `src-tauri/src/roots_commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Read the existing registration**

Run: `cd src-tauri && sed -n '1,60p' src/lib.rs && sed -n '310,360p' src/lib.rs`

Note the `tauri::generate_handler![` list and the existing `config_dir(&app)` helper near line 22.

- [ ] **Step 2: Write the command module**

Create `src-tauri/src/roots_commands.rs`:

```rust
//! Tauri command surface for mounted roots (M30).
//!
//! Commands are `(async)` so filesystem and git work runs on the thread pool
//! rather than stalling the UI thread — listing a large directory or indexing a
//! repository is not instant.

use tauri::Manager;

use crate::roots::index::IndexedDoc;
use crate::roots::read::FileText;
use crate::roots::tree::DirEntry;
use crate::roots::{MountRefusal, Root};

fn config_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path().app_config_dir().map_err(|e| e.to_string())
}

fn root_path(app: &tauri::AppHandle, root_id: &str) -> Result<std::path::PathBuf, String> {
    let dir = config_dir(app)?;
    crate::roots::find(&dir, root_id)
        .map(|r| std::path::PathBuf::from(r.path))
        .ok_or_else(|| format!("no mounted root with id {root_id}"))
}

#[tauri::command(async)]
pub fn list_roots(app: tauri::AppHandle) -> Result<Vec<Root>, String> {
    Ok(crate::roots::list(&config_dir(&app)?))
}

#[tauri::command(async)]
pub fn mount_root(app: tauri::AppHandle, path: String) -> Result<Root, MountRefusal> {
    let dir = config_dir(&app)
        .map_err(|e| MountRefusal { code: "config_unavailable".into(), message: e })?;
    crate::roots::mount(&dir, &path)
}

#[tauri::command(async)]
pub fn unmount_root(app: tauri::AppHandle, root_id: String) -> Result<(), String> {
    crate::roots::unmount(&config_dir(&app)?, &root_id)
}

#[tauri::command(async)]
pub fn list_dir(
    app: tauri::AppHandle,
    root_id: String,
    path: String,
) -> Result<Vec<DirEntry>, String> {
    crate::roots::tree::list_dir(&root_path(&app, &root_id)?, &path)
}

#[tauri::command(async)]
pub fn read_file_text(
    app: tauri::AppHandle,
    root_id: String,
    path: String,
) -> Result<FileText, String> {
    Ok(crate::roots::read::read_file_text(&root_path(&app, &root_id)?, &path))
}

#[tauri::command(async)]
pub fn index_root_markdown(
    app: tauri::AppHandle,
    root_id: String,
) -> Result<Vec<IndexedDoc>, String> {
    crate::roots::index::index_root(&root_path(&app, &root_id)?, &root_id)
}
```

- [ ] **Step 3: Register the module and the commands**

In `src-tauri/src/lib.rs`, add beside the other `pub mod` lines:

```rust
pub mod roots_commands;
```

Then add these six entries inside `tauri::generate_handler![ ... ]`:

```rust
            roots_commands::list_roots,
            roots_commands::mount_root,
            roots_commands::unmount_root,
            roots_commands::list_dir,
            roots_commands::read_file_text,
            roots_commands::index_root_markdown,
```

- [ ] **Step 4: Verify it compiles and the suite is green**

Run: `cd src-tauri && cargo build && cargo test`
Expected: builds clean; all tests pass

- [ ] **Step 5: Run the Rust gates**

Run: `cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings`
Expected: no output from either

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/roots_commands.rs src-tauri/src/lib.rs
git commit -m "feat(roots): six commands, each resolving its root before touching disk (M30.7)"
```

> **Migration note (spec section 1.5).** The spec proposes turning `AppConfig.last_vault` into root #0 automatically. This plan **ships without auto-migration**: mounting the vault is one click through the dialog, and an auto-migration path can only be exercised by deleting app-data, which is a test nobody runs twice. If you want it anyway, add it here as a step in `list_roots` — seed from `last_vault` when the stored list is empty — and write a test that starts from an empty config directory.

---

## Phase 4 — TypeScript plumbing

### Task M30.8: Types and pure helpers

**Files:**
- Create: `src/engine/roots.ts`
- Test: `src/engine/roots.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/engine/roots.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { groupDocsByRoot, isMarkdownPath, parentPath, viewerKindFor } from './roots';
import type { IndexedDoc } from './roots';

const doc = (root: string, path: string, isReadme = false): IndexedDoc => ({
  root,
  path,
  title: path,
  snippet: '',
  modifiedAt: '2026-08-09T00:00:00.000Z',
  depth: path.split('/').length - 1,
  isReadme,
});

describe('isMarkdownPath', () => {
  it('accepts .md and .markdown regardless of case', () => {
    expect(isMarkdownPath('README.md')).toBe(true);
    expect(isMarkdownPath('docs/Guide.MARKDOWN')).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isMarkdownPath('src/main.rs')).toBe(false);
    expect(isMarkdownPath('mdfile')).toBe(false);
  });
});

describe('viewerKindFor', () => {
  it('routes markdown to the doc viewer', () => {
    expect(viewerKindFor('README.md')).toBe('doc');
  });

  it('routes anything else to the code viewer', () => {
    expect(viewerKindFor('src/main.rs')).toBe('code');
    expect(viewerKindFor('Dockerfile.dev')).toBe('code');
  });
});

describe('parentPath', () => {
  it('drops the last segment', () => {
    expect(parentPath('docs/guide/setup.md')).toBe('docs/guide');
  });

  it('returns the root for a top-level path', () => {
    expect(parentPath('README.md')).toBe('');
  });
});

describe('groupDocsByRoot', () => {
  it('preserves the mounted-root order, not alphabetical order', () => {
    const docs = [doc('beta', 'b.md'), doc('alpha', 'a.md')];
    const groups = groupDocsByRoot(docs, ['alpha', 'beta']);
    expect(groups.map((g) => g.root)).toEqual(['alpha', 'beta']);
  });

  it('omits roots with no documents', () => {
    const groups = groupDocsByRoot([doc('alpha', 'a.md')], ['alpha', 'beta']);
    expect(groups).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run src/engine/roots.test.ts`
Expected: FAIL — cannot resolve `./roots`

- [ ] **Step 3: Write the implementation**

Create `src/engine/roots.ts`:

```ts
/**
 * Types and pure helpers for mounted roots (M30).
 *
 * `IndexedDoc` is deliberately NOT an `Entry`. Repository markdown must never
 * reach `vaultStore` — that store drives collections, types and dossiers and is
 * seeded from `scan_vault`. Keeping the index a separate shape is what makes
 * mounting a repo a zero-blast-radius change to the vault surfaces.
 */

export interface RootCaps {
  /** Carries a `knowledge/` bundle. Exactly one mounted root may, in v1. */
  knowledge: boolean;
  git: boolean;
  writable: boolean;
}

export interface Root {
  id: string;
  path: string;
  label: string;
  /** Reserved for `alias:relative/path.md`; nothing reads it yet. */
  alias: string;
  color: string | null;
  caps: RootCaps;
}

export interface DirEntry {
  name: string;
  /** Root-relative, forward-slashed. */
  path: string;
  isDir: boolean;
  size: number;
  ignored: boolean;
}

export interface IndexedDoc {
  root: string;
  path: string;
  title: string;
  snippet: string;
  modifiedAt: string;
  depth: number;
  isReadme: boolean;
}

/** A refusal the caller is expected to READ, not toast away. */
export interface MountRefusal {
  code: 'already_mounted' | 'knowledge_root_exists' | 'not_a_directory' | string;
  message: string;
}

export type FileText =
  | { kind: 'text'; content: string }
  | { kind: 'tooLarge'; size: number; limit: number }
  | { kind: 'binary' }
  | { kind: 'notFound' };

export function isMarkdownPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.markdown');
}

/**
 * Which viewer renders this file. Unknown extensions go to the code viewer
 * rather than a refusal — a `Dockerfile.dev` or a `.env.example` is still
 * readable text, and refusing it would be a worse answer than monospace.
 */
export function viewerKindFor(path: string): 'doc' | 'code' {
  return isMarkdownPath(path) ? 'doc' : 'code';
}

/** The containing directory, or `''` at the root. */
export function parentPath(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
}

export interface DocGroup {
  root: string;
  docs: IndexedDoc[];
}

/**
 * Group documents by root, in MOUNT order.
 *
 * Alphabetical would reorder the list every time you mount something, which
 * makes the tab's shape unstable for no benefit — the sidebar already shows
 * roots in mount order and the two must agree.
 */
export function groupDocsByRoot(docs: IndexedDoc[], rootOrder: string[]): DocGroup[] {
  return rootOrder
    .map((root) => ({ root, docs: docs.filter((d) => d.root === root) }))
    .filter((g) => g.docs.length > 0);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test:run src/engine/roots.test.ts`
Expected: PASS — 8 tests

- [ ] **Step 5: Commit**

```bash
git add src/engine/roots.ts src/engine/roots.test.ts
git commit -m "feat(roots): the index is its own shape, so the vault store never sees a repo (M30.8)"
```

---

### Task M30.9: Mock backend with guard parity

**Files:**
- Create: `src/lib/mockRoots.ts`
- Test: `src/lib/mockRoots.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/mockRoots.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import * as mock from './mockRoots';

beforeEach(() => {
  mock.resetMockRoots();
});

describe('mount', () => {
  it('mounts a directory and lists it', async () => {
    const root = await mock.mountRoot('/repos/alpha');
    expect('id' in root).toBe(true);
    expect(await mock.listRoots()).toHaveLength(1);
  });

  it('refuses the same path twice', async () => {
    await mock.mountRoot('/repos/alpha');
    const again = await mock.mountRoot('/repos/alpha');
    expect('code' in again && again.code).toBe('already_mounted');
  });

  it('refuses a second knowledge root and names the first', async () => {
    mock.seedRoot({ path: '/vault', label: 'vault', knowledge: true });
    mock.seedKnowledgeDir('/repos/brain');
    const refused = await mock.mountRoot('/repos/brain');
    expect('code' in refused && refused.code).toBe('knowledge_root_exists');
    expect('message' in refused && refused.message).toContain('vault');
  });
});

describe('readFileText guards — parity with Rust', () => {
  it('refuses a path escaping the root', async () => {
    const root = mock.seedRoot({ path: '/repos/alpha', label: 'alpha' });
    expect(await mock.readFileText(root.id, '../../etc/passwd')).toEqual({ kind: 'notFound' });
  });

  it('refuses a file over the size cap', async () => {
    const root = mock.seedRoot({ path: '/repos/alpha', label: 'alpha' });
    mock.seedFile('/repos/alpha', 'big.txt', 'x'.repeat(mock.MAX_BYTES + 1));
    const out = await mock.readFileText(root.id, 'big.txt');
    expect(out.kind).toBe('tooLarge');
  });

  it('refuses a file containing NUL', async () => {
    const root = mock.seedRoot({ path: '/repos/alpha', label: 'alpha' });
    mock.seedFile('/repos/alpha', 'image.png', `PNG${String.fromCharCode(0)}data`);
    expect(await mock.readFileText(root.id, 'image.png')).toEqual({ kind: 'binary' });
  });

  it('reads a text file', async () => {
    const root = mock.seedRoot({ path: '/repos/alpha', label: 'alpha' });
    mock.seedFile('/repos/alpha', 'README.md', '# Alpha');
    expect(await mock.readFileText(root.id, 'README.md')).toEqual({
      kind: 'text',
      content: '# Alpha',
    });
  });
});

describe('listDir', () => {
  it('returns one level, directories before files', async () => {
    const root = mock.seedRoot({ path: '/repos/alpha', label: 'alpha' });
    mock.seedFile('/repos/alpha', 'z.md', '# Z');
    mock.seedFile('/repos/alpha', 'sub/deep.md', '# Deep');

    const out = await mock.listDir(root.id, '');
    expect(out.map((e) => e.name)).toEqual(['sub', 'z.md']);
    expect(out[0].isDir).toBe(true);
  });
});

describe('indexRootMarkdown', () => {
  it('returns markdown only, READMEs first', async () => {
    const root = mock.seedRoot({ path: '/repos/alpha', label: 'alpha' });
    mock.seedFile('/repos/alpha', 'docs/guide.md', '# Guide');
    mock.seedFile('/repos/alpha', 'README.md', '# Alpha');
    mock.seedFile('/repos/alpha', 'src/main.rs', 'fn main() {}');

    const docs = await mock.indexRootMarkdown(root.id);
    expect(docs.map((d) => d.path)).toEqual(['README.md', 'docs/guide.md']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run src/lib/mockRoots.test.ts`
Expected: FAIL — cannot resolve `./mockRoots`

- [ ] **Step 3: Write the mock backend**

Create `src/lib/mockRoots.ts`:

```ts
/**
 * In-memory roots backend for browser dev, vitest and Playwright.
 *
 * PARITY IS THE POINT. AGENTS.md makes mock/Rust parity a hard rule for the
 * knowledge guards, and the same reasoning applies here: a mock that permits a
 * traversal the Rust side refuses would make the Playwright suite prove the
 * opposite of the invariant. Every guard in `roots/read.rs` is mirrored below.
 */
import type { DirEntry, FileText, IndexedDoc, MountRefusal, Root } from '@/engine/roots';

export const MAX_BYTES = 2 * 1024 * 1024;

interface MockRootSeed {
  path: string;
  label: string;
  knowledge?: boolean;
  git?: boolean;
}

let roots: Root[] = [];
let counter = 0;
/**
 * rootPath → (relativePath → content).
 *
 * Nested rather than one flat map under a joined key: any separator character
 * is one a real path could contain, and splitting it back apart is a bug
 * waiting to happen.
 */
const files = new Map<string, Map<string, string>>();
const knowledgeDirs = new Set<string>();

export function resetMockRoots(): void {
  roots = [];
  counter = 0;
  files.clear();
  knowledgeDirs.clear();
}

export function seedKnowledgeDir(path: string): void {
  knowledgeDirs.add(path);
}

export function seedFile(rootPath: string, rel: string, content: string): void {
  const owned = files.get(rootPath) ?? new Map<string, string>();
  owned.set(rel, content);
  files.set(rootPath, owned);
}

export function seedRoot(seed: MockRootSeed): Root {
  counter += 1;
  const root: Root = {
    id: `root-${counter}`,
    path: seed.path,
    label: seed.label,
    alias: seed.label.toLowerCase(),
    color: null,
    caps: {
      knowledge: seed.knowledge ?? false,
      git: seed.git ?? true,
      writable: true,
    },
  };
  roots.push(root);
  return root;
}

export async function listRoots(): Promise<Root[]> {
  return [...roots];
}

export async function mountRoot(path: string): Promise<Root | MountRefusal> {
  const existing = roots.find((r) => r.path === path);
  if (existing !== undefined) {
    return {
      code: 'already_mounted',
      message: `${path} is already mounted as "${existing.label}"`,
    };
  }
  const knowledge = knowledgeDirs.has(path);
  if (knowledge) {
    const incumbent = roots.find((r) => r.caps.knowledge);
    if (incumbent !== undefined) {
      return {
        code: 'knowledge_root_exists',
        message: `"${incumbent.label}" already holds this workspace's knowledge base. Cerebro supports one knowledge root; unmount it first.`,
      };
    }
  }
  const label = path.split('/').filter(Boolean).pop() ?? path;
  return seedRoot({ path, label, knowledge });
}

export async function unmountRoot(rootId: string): Promise<void> {
  roots = roots.filter((r) => r.id !== rootId);
}

function rootPathFor(rootId: string): string | null {
  return roots.find((r) => r.id === rootId)?.path ?? null;
}

/** Mirrors `tree::resolve_within` — any `..` segment escapes and is refused. */
function escapes(rel: string): boolean {
  return rel.split('/').includes('..');
}

/** Every seeded file belonging to a root, as [relativePath, content]. */
function filesIn(rootPath: string): [string, string][] {
  return [...(files.get(rootPath) ?? new Map<string, string>())];
}

export async function listDir(rootId: string, path: string): Promise<DirEntry[]> {
  const rootPath = rootPathFor(rootId);
  if (rootPath === null || escapes(path)) return [];

  const prefix = path === '' ? '' : `${path}/`;
  const dirs = new Set<string>();
  const out: DirEntry[] = [];

  for (const [rel, content] of filesIn(rootPath)) {
    if (!rel.startsWith(prefix)) continue;
    const remainder = rel.slice(prefix.length);
    const cut = remainder.indexOf('/');
    if (cut === -1) {
      out.push({ name: remainder, path: rel, isDir: false, size: content.length, ignored: false });
    } else {
      dirs.add(remainder.slice(0, cut));
    }
  }

  for (const name of dirs) {
    out.push({ name, path: `${prefix}${name}`, isDir: true, size: 0, ignored: false });
  }

  out.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
  return out;
}

export async function readFileText(rootId: string, path: string): Promise<FileText> {
  const rootPath = rootPathFor(rootId);
  if (rootPath === null || escapes(path)) return { kind: 'notFound' };
  const content = files.get(rootPath)?.get(path);
  if (content === undefined) return { kind: 'notFound' };
  if (content.length > MAX_BYTES) {
    return { kind: 'tooLarge', size: content.length, limit: MAX_BYTES };
  }
  if (content.includes(String.fromCharCode(0))) return { kind: 'binary' };
  return { kind: 'text', content };
}

export async function indexRootMarkdown(rootId: string): Promise<IndexedDoc[]> {
  const rootPath = rootPathFor(rootId);
  if (rootPath === null) return [];

  const docs: IndexedDoc[] = [];
  for (const [rel, content] of filesIn(rootPath)) {
    const lower = rel.toLowerCase();
    if (!lower.endsWith('.md') && !lower.endsWith('.markdown')) continue;

    const h1 = /^#\s+(.+)$/m.exec(content);
    const filename = rel.split('/').pop() ?? rel;
    docs.push({
      root: rootId,
      path: rel,
      title: h1?.[1].trim() ?? filename.replace(/\.[^.]+$/, ''),
      snippet: content.replace(/^#.*$/m, '').trim().slice(0, 160),
      modifiedAt: '2026-08-09T00:00:00.000Z',
      depth: rel.split('/').length - 1,
      isReadme: filename.toLowerCase().startsWith('readme.'),
    });
  }

  docs.sort((a, b) => {
    if (a.isReadme !== b.isReadme) return a.isReadme ? -1 : 1;
    if (a.depth !== b.depth) return a.depth - b.depth;
    return a.title.toLowerCase().localeCompare(b.title.toLowerCase());
  });
  return docs;
}

// Exposed so Playwright can seed roots and files, mirroring how mockIpc.ts
// exposes __cerebroMockFs.
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__cerebroMockRoots = {
    resetMockRoots,
    seedRoot,
    seedFile,
    seedKnowledgeDir,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test:run src/lib/mockRoots.test.ts`
Expected: PASS — 9 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/mockRoots.ts src/lib/mockRoots.test.ts
git commit -m "feat(roots): the mock refuses everything Rust refuses, or the e2e suite lies (M30.9)"
```

---

### Task M30.10: The IPC facade

**Files:**
- Create: `src/lib/rootsIpc.ts`

- [ ] **Step 1: Write the facade**

Create `src/lib/rootsIpc.ts`, following the same shape as `src/lib/ipc.ts`:

```ts
// IPC facade for mounted roots (M30). Same shape as ipc.ts: inside Tauri these
// invoke the Rust commands; in the browser, vitest and Playwright they delegate
// to the in-memory mock.
import type { DirEntry, FileText, IndexedDoc, MountRefusal, Root } from '@/engine/roots';
import * as mock from './mockRoots';

function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

async function invokeTauri<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

export function listRoots(): Promise<Root[]> {
  return inTauri() ? invokeTauri('list_roots') : mock.listRoots();
}

/**
 * Mount a directory. Resolves to a `Root` OR a typed `MountRefusal` — the
 * caller is expected to READ the result, not toast it away. A
 * `knowledge_root_exists` refusal is a card the user has to see.
 */
export async function mountRoot(path: string): Promise<Root | MountRefusal> {
  if (!inTauri()) return mock.mountRoot(path);
  try {
    return await invokeTauri<Root>('mount_root', { path });
  } catch (err) {
    // Tauri rejects with the serialized MountRefusal payload.
    return err as MountRefusal;
  }
}

export function unmountRoot(rootId: string): Promise<void> {
  return inTauri() ? invokeTauri('unmount_root', { rootId }) : mock.unmountRoot(rootId);
}

export function listDir(rootId: string, path: string): Promise<DirEntry[]> {
  return inTauri() ? invokeTauri('list_dir', { rootId, path }) : mock.listDir(rootId, path);
}

export function readFileText(rootId: string, path: string): Promise<FileText> {
  return inTauri()
    ? invokeTauri('read_file_text', { rootId, path })
    : mock.readFileText(rootId, path);
}

export function indexRootMarkdown(rootId: string): Promise<IndexedDoc[]> {
  return inTauri()
    ? invokeTauri('index_root_markdown', { rootId })
    : mock.indexRootMarkdown(rootId);
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `pnpm typecheck`
Expected: clean

- [ ] **Step 3: Commit**

```bash
git add src/lib/rootsIpc.ts
git commit -m "feat(roots): one facade, two backends, same six calls (M30.10)"
```

---

### Task M30.11: The roots store

**Files:**
- Create: `src/stores/rootsStore.ts`
- Test: `src/stores/rootsStore.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/stores/rootsStore.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { resetMockRoots, seedFile, seedKnowledgeDir, seedRoot } from '@/lib/mockRoots';
import { useRootsStore } from './rootsStore';

beforeEach(() => {
  resetMockRoots();
  useRootsStore.setState({ roots: [], expanded: {}, children: {}, open: null, docs: [] });
});

describe('loadRoots', () => {
  it('populates from the backend', async () => {
    seedRoot({ path: '/repos/alpha', label: 'alpha' });
    await useRootsStore.getState().loadRoots();
    expect(useRootsStore.getState().roots).toHaveLength(1);
  });
});

describe('mount', () => {
  it('adds a root and returns null on success', async () => {
    const refusal = await useRootsStore.getState().mount('/repos/alpha');
    expect(refusal).toBeNull();
    expect(useRootsStore.getState().roots).toHaveLength(1);
  });

  it('returns the refusal instead of throwing, and mounts nothing', async () => {
    seedRoot({ path: '/vault', label: 'vault', knowledge: true });
    seedKnowledgeDir('/repos/brain');
    await useRootsStore.getState().loadRoots();

    const refusal = await useRootsStore.getState().mount('/repos/brain');

    expect(refusal?.code).toBe('knowledge_root_exists');
    expect(useRootsStore.getState().roots).toHaveLength(1);
  });
});

describe('toggle', () => {
  it('loads children on first expand and caches them', async () => {
    const root = seedRoot({ path: '/repos/alpha', label: 'alpha' });
    seedFile('/repos/alpha', 'README.md', '# Alpha');
    await useRootsStore.getState().loadRoots();

    await useRootsStore.getState().toggle(root.id, '');

    const key = `${root.id} `;
    expect(useRootsStore.getState().expanded[key]).toBe(true);
    expect(useRootsStore.getState().children[key]).toHaveLength(1);
  });

  it('collapses without discarding cached children', async () => {
    const root = seedRoot({ path: '/repos/alpha', label: 'alpha' });
    seedFile('/repos/alpha', 'README.md', '# Alpha');
    await useRootsStore.getState().loadRoots();

    await useRootsStore.getState().toggle(root.id, '');
    await useRootsStore.getState().toggle(root.id, '');

    const key = `${root.id} `;
    expect(useRootsStore.getState().expanded[key]).toBe(false);
    expect(useRootsStore.getState().children[key]).toHaveLength(1);
  });
});

describe('unmount', () => {
  it('clears the open file when its root goes away', async () => {
    const root = seedRoot({ path: '/repos/alpha', label: 'alpha' });
    await useRootsStore.getState().loadRoots();
    useRootsStore.getState().openFile(root.id, 'README.md');

    await useRootsStore.getState().unmount(root.id);

    expect(useRootsStore.getState().open).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run src/stores/rootsStore.test.ts`
Expected: FAIL — cannot resolve `./rootsStore`

- [ ] **Step 3: Write the implementation**

Create `src/stores/rootsStore.ts`:

```ts
import { create } from 'zustand';
import type { DirEntry, IndexedDoc, MountRefusal, Root } from '@/engine/roots';
import * as ipc from '@/lib/rootsIpc';

/** Cache key for a directory within a root. */
const nodeKey = (rootId: string, path: string): string => `${rootId} ${path}`;

interface RootsState {
  roots: Root[];
  /** nodeKey → expanded. */
  expanded: Record<string, boolean>;
  /** nodeKey → its listing, once fetched. */
  children: Record<string, DirEntry[]>;
  open: { rootId: string; path: string } | null;
  docs: IndexedDoc[];

  loadRoots(): Promise<void>;
  /** Resolves to the refusal to be RENDERED, or null on success. Never throws. */
  mount(path: string): Promise<MountRefusal | null>;
  unmount(rootId: string): Promise<void>;
  toggle(rootId: string, path: string): Promise<void>;
  openFile(rootId: string, path: string): void;
  loadDocs(): Promise<void>;
}

export const useRootsStore = create<RootsState>((set, get) => ({
  roots: [],
  expanded: {},
  children: {},
  open: null,
  docs: [],

  async loadRoots() {
    set({ roots: await ipc.listRoots() });
  },

  /**
   * Mount is a PROPOSAL CHANNEL, not a plain human-UI action: it returns a
   * typed refusal the caller renders as a card. AGENTS.md exempts exactly this
   * shape from the never-throw/toast invariant, because collapsing
   * `knowledge_root_exists` into null throws away the whole point of typing it.
   */
  async mount(path) {
    const result = await ipc.mountRoot(path);
    if ('code' in result) return result;
    set({ roots: [...get().roots, result] });
    return null;
  },

  async unmount(rootId) {
    await ipc.unmountRoot(rootId);
    set({
      roots: get().roots.filter((r) => r.id !== rootId),
      open: get().open?.rootId === rootId ? null : get().open,
      docs: get().docs.filter((d) => d.root !== rootId),
    });
  },

  async toggle(rootId, path) {
    const key = nodeKey(rootId, path);
    if (get().expanded[key] === true) {
      // Keep the cached listing — collapsing is not a reason to re-read disk.
      set({ expanded: { ...get().expanded, [key]: false } });
      return;
    }
    if (get().children[key] === undefined) {
      const listing = await ipc.listDir(rootId, path);
      set({ children: { ...get().children, [key]: listing } });
    }
    set({ expanded: { ...get().expanded, [key]: true } });
  },

  openFile(rootId, path) {
    set({ open: { rootId, path } });
  },

  async loadDocs() {
    const all = await Promise.all(get().roots.map((r) => ipc.indexRootMarkdown(r.id)));
    set({ docs: all.flat() });
  },
}));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test:run src/stores/rootsStore.test.ts`
Expected: PASS — 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/stores/rootsStore.ts src/stores/rootsStore.test.ts
git commit -m "feat(roots): mount returns its refusal, because a card is not a toast (M30.11)"
```

---

## Phase 5 — The workspace shell

### Task M30.12: Selection arm, Rail destination, page skeleton

**Files:**
- Modify: `src/engine/types.ts:175-205`, `src/app/Rail.tsx`, `src/App.tsx`
- Create: `src/pages/WorkspacePage.tsx`
- Test: `src/pages/WorkspacePage.test.tsx`

- [ ] **Step 1: Add the Selection arm**

In `src/engine/types.ts`, add to the `Selection` union after the `library` arm:

```ts
  // M30 — mounted roots. `root` and `path` ride on the selection rather than
  // in component state so "the README of cerebro" is a place Back returns to,
  // the same contract `list.view` and `library.tab` already follow.
  | { kind: 'workspace'; root?: string; path?: string }
```

- [ ] **Step 2: Write the failing test**

Create `src/pages/WorkspacePage.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetMockRoots, seedRoot } from '@/lib/mockRoots';
import { useRootsStore } from '@/stores/rootsStore';
import { WorkspacePage } from './WorkspacePage';

beforeEach(() => {
  resetMockRoots();
  useRootsStore.setState({ roots: [], expanded: {}, children: {}, open: null, docs: [] });
});

describe('WorkspacePage', () => {
  it('prompts to mount when nothing is mounted', async () => {
    render(<WorkspacePage selection={{ kind: 'workspace' }} />);
    expect(await screen.findByTestId('workspace-empty')).toBeTruthy();
  });

  it('renders the tree once a root is mounted', async () => {
    seedRoot({ path: '/repos/alpha', label: 'alpha' });
    render(<WorkspacePage selection={{ kind: 'workspace' }} />);
    expect(await screen.findByText('alpha')).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test:run src/pages/WorkspacePage.test.tsx`
Expected: FAIL — cannot resolve `./WorkspacePage`

- [ ] **Step 4: Write the page**

Create `src/pages/WorkspacePage.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import type { Selection } from '@/engine/types';
import { useRootsStore } from '@/stores/rootsStore';
import { DocsTab } from '@/workspace/DocsTab';
import { FileViewer } from '@/workspace/FileViewer';
import { RootMountDialog } from '@/workspace/RootMountDialog';
import { RootTree } from '@/workspace/RootTree';

export function WorkspacePage({ selection }: { selection: Selection }) {
  const roots = useRootsStore((s) => s.roots);
  const loadRoots = useRootsStore((s) => s.loadRoots);
  const open = useRootsStore((s) => s.open);
  const openFile = useRootsStore((s) => s.openFile);
  const [mounting, setMounting] = useState(false);
  const [tab, setTab] = useState<'files' | 'docs'>('files');

  useEffect(() => {
    void loadRoots();
  }, [loadRoots]);

  // The selection is the source of truth for what is open, so Back works.
  useEffect(() => {
    if (selection.kind !== 'workspace') return;
    const { root, path } = selection;
    if (root !== undefined && path !== undefined) openFile(root, path);
  }, [selection, openFile]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1" data-testid="workspace-page">
      <aside className="flex w-64 flex-none flex-col border-r border-n-100">
        <div className="flex flex-none items-center gap-2 px-3 pb-2 pt-3.5">
          <Icon name="folder-tree" size={16} color="var(--n-600)" />
          <h1 className="m-0 text-sm font-semibold">Workspace</h1>
          <button
            type="button"
            data-testid="mount-root"
            onClick={() => setMounting(true)}
            className="ml-auto border-0 bg-transparent p-0.5 text-n-500 hover:text-n-800"
            aria-label="Mount a folder"
          >
            <Icon name="plus" size={14} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {roots.length === 0 ? (
            <div data-testid="workspace-empty" className="px-3 py-4">
              <EmptyState
                icon="folder-plus"
                title="No repositories yet"
                description="Mount a folder to browse its files and docs."
              />
            </div>
          ) : (
            <RootTree />
          )}
        </div>
      </aside>
      {mounting && <RootMountDialog onClose={() => setMounting(false)} />}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex flex-none gap-1 border-b border-n-100 px-4 pt-2">
          {(['files', 'docs'] as const).map((name) => (
            <button
              key={name}
              type="button"
              data-testid={`workspace-tab-${name}`}
              onClick={() => setTab(name)}
              className={`border-0 border-b-2 bg-transparent px-2 pb-1.5 text-sm capitalize ${
                tab === name ? 'border-n-800 text-n-900' : 'border-transparent text-n-500'
              }`}
            >
              {name}
            </button>
          ))}
        </div>
        {tab === 'docs' ? (
          <DocsTab />
        ) : open === null ? (
          <EmptyState icon="file-text" title="Nothing open" description="Pick a file." />
        ) : (
          <FileViewer rootId={open.rootId} path={open.path} />
        )}
      </main>
    </div>
  );
}
```

> This imports `RootTree`, `FileViewer`, `DocsTab` and `RootMountDialog`, which arrive in M30.13–M30.18. Until then the test will fail to resolve them — build them in order and this page compiles at M30.18. If you prefer green-at-every-task, stub each as `export function X() { return null }` when you first create the file and fill it in at its own task.

- [ ] **Step 5: Add the Rail destination**

In `src/app/Rail.tsx`, add a button beside the existing Docs entry, copying the shape of the surrounding `RailButton` usages exactly:

```tsx
      <RailButton
        icon="folder-tree"
        label="Workspace"
        active={selection.kind === 'workspace'}
        onClick={() => navigate({ kind: 'workspace' })}
      />
```

- [ ] **Step 6: Route the page**

In `src/App.tsx`, add to the surface switch beside the other `selection.kind` cases:

```tsx
      {selection.kind === 'workspace' && <WorkspacePage selection={selection} />}
```

- [ ] **Step 7: Typecheck**

Run: `pnpm typecheck`
Expected: clean once M30.13–M30.18 exist.

> If `pnpm typecheck` reports a non-exhaustive switch anywhere over `Selection`, add the `workspace` case there. That error is the union doing its job — fix each site rather than widening the type.

- [ ] **Step 8: Commit**

```bash
git add src/engine/types.ts src/app/Rail.tsx src/App.tsx src/pages/WorkspacePage.tsx src/pages/WorkspacePage.test.tsx
git commit -m "feat(workspace): repos get their own room, and the open file is a place (M30.12)"
```

---

### Task M30.13: The tree flattener

**Files:**
- Create: `src/workspace/treeRows.ts`
- Test: `src/workspace/treeRows.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/workspace/treeRows.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { DirEntry, Root } from '@/engine/roots';
import { flattenTree } from './treeRows';

const root = (id: string, label: string): Root => ({
  id,
  path: `/repos/${label}`,
  label,
  alias: label,
  color: null,
  caps: { knowledge: false, git: true, writable: true },
});

const entry = (name: string, path: string, isDir: boolean, ignored = false): DirEntry => ({
  name,
  path,
  isDir,
  size: 0,
  ignored,
});

describe('flattenTree', () => {
  it('shows a row per root when nothing is expanded', () => {
    const rows = flattenTree([root('r1', 'alpha'), root('r2', 'beta')], {}, {}, true);
    expect(rows.map((r) => r.label)).toEqual(['alpha', 'beta']);
    expect(rows.every((r) => r.depth === 0)).toBe(true);
  });

  it('splices children in beneath an expanded root', () => {
    const rows = flattenTree(
      [root('r1', 'alpha')],
      { 'r1 ': true },
      { 'r1 ': [entry('src', 'src', true), entry('README.md', 'README.md', false)] },
      true,
    );
    expect(rows.map((r) => r.label)).toEqual(['alpha', 'src', 'README.md']);
    expect(rows[1].depth).toBe(1);
  });

  it('nests a second level under an expanded directory', () => {
    const rows = flattenTree(
      [root('r1', 'alpha')],
      { 'r1 ': true, 'r1 src': true },
      {
        'r1 ': [entry('src', 'src', true)],
        'r1 src': [entry('main.rs', 'src/main.rs', false)],
      },
      true,
    );
    expect(rows.map((r) => r.label)).toEqual(['alpha', 'src', 'main.rs']);
    expect(rows[2].depth).toBe(2);
  });

  it('hides ignored entries when the toggle is off', () => {
    const rows = flattenTree(
      [root('r1', 'alpha')],
      { 'r1 ': true },
      { 'r1 ': [entry('dist', 'dist', true, true), entry('README.md', 'README.md', false)] },
      false,
    );
    expect(rows.map((r) => r.label)).toEqual(['alpha', 'README.md']);
  });

  it('shows ignored entries flagged when the toggle is on', () => {
    const rows = flattenTree(
      [root('r1', 'alpha')],
      { 'r1 ': true },
      { 'r1 ': [entry('dist', 'dist', true, true)] },
      true,
    );
    expect(rows[1].ignored).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run src/workspace/treeRows.test.ts`
Expected: FAIL — cannot resolve `./treeRows`

- [ ] **Step 3: Write the implementation**

Create `src/workspace/treeRows.ts`:

```ts
/**
 * The tree as a flat list of visible rows.
 *
 * Virtualization needs a flat, indexable list — a recursive component tree
 * cannot be windowed. Keeping the flatten pure also makes every ordering and
 * visibility rule testable without rendering anything.
 */
import type { DirEntry, Root } from '@/engine/roots';

export interface TreeRow {
  key: string;
  rootId: string;
  /** Root-relative; `''` is the root row itself. */
  path: string;
  label: string;
  depth: number;
  isDir: boolean;
  ignored: boolean;
  /** True for the root's own row, which renders its status chip. */
  isRoot: boolean;
}

export const nodeKey = (rootId: string, path: string): string => `${rootId} ${path}`;

export function flattenTree(
  roots: Root[],
  expanded: Record<string, boolean>,
  children: Record<string, DirEntry[]>,
  showIgnored: boolean,
): TreeRow[] {
  const rows: TreeRow[] = [];

  const walk = (rootId: string, path: string, depth: number): void => {
    const key = nodeKey(rootId, path);
    if (expanded[key] !== true) return;
    for (const child of children[key] ?? []) {
      if (child.ignored && !showIgnored) continue;
      rows.push({
        key: nodeKey(rootId, child.path),
        rootId,
        path: child.path,
        label: child.name,
        depth,
        isDir: child.isDir,
        ignored: child.ignored,
        isRoot: false,
      });
      if (child.isDir) walk(rootId, child.path, depth + 1);
    }
  };

  for (const root of roots) {
    rows.push({
      key: nodeKey(root.id, ''),
      rootId: root.id,
      path: '',
      label: root.label,
      depth: 0,
      isDir: true,
      ignored: false,
      isRoot: true,
    });
    walk(root.id, '', 1);
  }
  return rows;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test:run src/workspace/treeRows.test.ts`
Expected: PASS — 5 tests

- [ ] **Step 5: Commit**

```bash
git add src/workspace/treeRows.ts src/workspace/treeRows.test.ts
git commit -m "feat(workspace): the tree flattens to rows, so it can be windowed (M30.13)"
```

---

### Task M30.14: The virtualized tree component

**Files:**
- Create: `src/workspace/RootTree.tsx`
- Modify: `package.json`

- [ ] **Step 1: Add the dependency**

Run: `pnpm add react-virtuoso`

- [ ] **Step 2: Write the component**

Create `src/workspace/RootTree.tsx`:

```tsx
import { useState } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { Icon } from '@/components/ui/Icon';
import { useRootsStore } from '@/stores/rootsStore';
import { flattenTree, nodeKey, type TreeRow } from './treeRows';

export function RootTree() {
  const roots = useRootsStore((s) => s.roots);
  const expanded = useRootsStore((s) => s.expanded);
  const children = useRootsStore((s) => s.children);
  const toggle = useRootsStore((s) => s.toggle);
  const openFile = useRootsStore((s) => s.openFile);
  const [showIgnored, setShowIgnored] = useState(false);

  const rows = flattenTree(roots, expanded, children, showIgnored);

  const activate = (row: TreeRow): void => {
    if (row.isDir) void toggle(row.rootId, row.path);
    else openFile(row.rootId, row.path);
  };

  /**
   * A root whose directory has vanished probes to no capabilities at all (see
   * `roots::probe` — a missing path yields the default). Rendering it as a
   * persistent node is the deliberate exception to the toast invariant: a repo
   * that silently disappears from the list is worse than an error.
   */
  const unavailable = (row: TreeRow): boolean => {
    if (!row.isRoot) return false;
    const root = roots.find((r) => r.id === row.rootId);
    return root !== undefined && !root.caps.writable && !root.caps.git;
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="root-tree">
      <button
        type="button"
        data-testid="toggle-ignored"
        onClick={() => setShowIgnored((v) => !v)}
        className="flex-none border-0 bg-transparent px-3 py-1 text-left text-2xs text-n-500 hover:text-n-800"
      >
        {showIgnored ? 'Hide ignored' : 'Show ignored'}
      </button>
      <Virtuoso
        className="min-h-0 flex-1"
        data={rows}
        itemContent={(_, row) => (
          <button
            type="button"
            data-testid="tree-row"
            data-path={row.path}
            data-root={row.rootId}
            onClick={() => activate(row)}
            style={{ paddingLeft: `${row.depth * 12 + 8}px` }}
            className={`flex w-full min-w-0 items-center gap-1.5 border-0 bg-transparent py-1 pr-2 text-left text-sm hover:bg-n-50 ${
              row.ignored ? 'text-n-400' : 'text-n-800'
            }`}
          >
            <Icon
              name={
                row.isDir
                  ? expanded[nodeKey(row.rootId, row.path)] === true
                    ? 'chevron-down'
                    : 'chevron-right'
                  : 'file-text'
              }
              size={13}
              color="var(--n-500)"
            />
            <span className="min-w-0 truncate">{row.label}</span>
            {unavailable(row) && (
              <span
                data-testid="root-unavailable"
                className="ml-auto flex-none rounded-sm bg-n-50 px-1 text-2xs text-n-500"
              >
                unavailable
              </span>
            )}
          </button>
        )}
      />
    </div>
  );
}
```

- [ ] **Step 3: Verify the page tests pass**

Run: `pnpm test:run src/pages/WorkspacePage.test.tsx`
Expected: PASS — 2 tests (with the remaining stubs in place)

- [ ] **Step 4: Commit**

```bash
git add src/workspace/RootTree.tsx package.json pnpm-lock.yaml
git commit -m "feat(workspace): a vanished root stays visible instead of vanishing twice (M30.14)"
```

---

### Task M30.15: The mount dialog

**Files:**
- Create: `src/workspace/RootMountDialog.tsx`
- Test: `src/workspace/RootMountDialog.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/workspace/RootMountDialog.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetMockRoots, seedKnowledgeDir, seedRoot } from '@/lib/mockRoots';
import { useRootsStore } from '@/stores/rootsStore';
import { RootMountDialog } from './RootMountDialog';

beforeEach(() => {
  resetMockRoots();
  useRootsStore.setState({ roots: [], expanded: {}, children: {}, open: null, docs: [] });
});

describe('RootMountDialog', () => {
  it('renders the refusal instead of closing when a second brain is mounted', async () => {
    seedRoot({ path: '/vault', label: 'vault', knowledge: true });
    seedKnowledgeDir('/repos/brain');
    await useRootsStore.getState().loadRoots();
    const onClose = vi.fn();

    render(<RootMountDialog pickPath={async () => '/repos/brain'} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('mount-choose'));

    expect(await screen.findByTestId('mount-refusal')).toHaveTextContent('vault');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on a successful mount', async () => {
    const onClose = vi.fn();
    render(<RootMountDialog pickPath={async () => '/repos/alpha'} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('mount-choose'));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('does nothing when the picker is cancelled', async () => {
    const onClose = vi.fn();
    render(<RootMountDialog pickPath={async () => null} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('mount-choose'));

    await waitFor(() => expect(useRootsStore.getState().roots).toHaveLength(0));
    expect(onClose).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run src/workspace/RootMountDialog.test.tsx`
Expected: FAIL — cannot resolve `./RootMountDialog`

- [ ] **Step 3: Write the component**

Create `src/workspace/RootMountDialog.tsx`:

```tsx
import { useState } from 'react';
import type { MountRefusal } from '@/engine/roots';
import { useRootsStore } from '@/stores/rootsStore';

/** Injected so tests drive it without the Tauri dialog plugin. */
async function pickDirectory(): Promise<string | null> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({ directory: true, multiple: false });
  return typeof picked === 'string' ? picked : null;
}

interface Props {
  onClose(): void;
  pickPath?: () => Promise<string | null>;
}

export function RootMountDialog({ onClose, pickPath = pickDirectory }: Props) {
  const mount = useRootsStore((s) => s.mount);
  const [refusal, setRefusal] = useState<MountRefusal | null>(null);

  const choose = async (): Promise<void> => {
    const path = await pickPath();
    if (path === null) return;
    const result = await mount(path);
    // The refusal is RENDERED, not toasted: "another root already holds the
    // knowledge base" is a decision the user has to see and act on.
    if (result !== null) {
      setRefusal(result);
      return;
    }
    onClose();
  };

  return (
    <div data-testid="mount-dialog" className="flex flex-col gap-3 p-4">
      <p className="m-0 text-sm text-n-700">
        Pick a folder that is already on disk. Cerebro never clones or moves it.
      </p>
      <button
        type="button"
        data-testid="mount-choose"
        onClick={() => void choose()}
        className="rounded-md border border-n-200 bg-white px-3 py-1.5 text-sm"
      >
        Choose folder…
      </button>
      {refusal !== null && (
        <p data-testid="mount-refusal" className="m-0 text-sm text-[var(--danger)]">
          {refusal.message}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test:run src/workspace/RootMountDialog.test.tsx`
Expected: PASS — 3 tests

- [ ] **Step 5: Commit**

```bash
git add src/workspace/RootMountDialog.tsx src/workspace/RootMountDialog.test.tsx
git commit -m "feat(workspace): a refused mount is a card you read, not a toast you miss (M30.15)"
```

---

## Phase 6 — The viewers

### Task M30.16: Shiki singleton and CodeViewer

**Files:**
- Create: `src/workspace/highlighter.ts`, `src/workspace/CodeViewer.tsx`
- Test: `src/workspace/highlighter.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Add the dependency**

Run: `pnpm add shiki`

- [ ] **Step 2: Write the failing test**

Create `src/workspace/highlighter.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { languageFor } from './highlighter';

describe('languageFor', () => {
  it('maps known extensions', () => {
    expect(languageFor('src/main.rs')).toBe('rust');
    expect(languageFor('src/app.tsx')).toBe('tsx');
    expect(languageFor('Cargo.toml')).toBe('toml');
  });

  it('maps extensionless well-known filenames', () => {
    expect(languageFor('Dockerfile')).toBe('docker');
    expect(languageFor('Makefile')).toBe('make');
  });

  it('returns null for anything unrecognised, so it renders as plain text', () => {
    expect(languageFor('notes.xyz')).toBeNull();
    expect(languageFor('.env.example')).toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test:run src/workspace/highlighter.test.ts`
Expected: FAIL — cannot resolve `./highlighter`

- [ ] **Step 4: Write the highlighter module**

Create `src/workspace/highlighter.ts`:

```ts
/**
 * One Shiki instance for the whole app.
 *
 * Both the code viewer and the doc viewer's fences render through this, so a
 * `rust` fence inside a README and `main.rs` in the tree look identical. Two
 * highlighters would guarantee they eventually diverge.
 *
 * Languages load on demand: bundling every grammar Shiki ships would dwarf the
 * rest of the app.
 */
import type { Highlighter } from 'shiki';

const EXTENSIONS: Record<string, string> = {
  rs: 'rust',
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  json: 'json',
  toml: 'toml',
  yml: 'yaml',
  yaml: 'yaml',
  css: 'css',
  html: 'html',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  py: 'python',
  sql: 'sql',
  md: 'markdown',
};

const FILENAMES: Record<string, string> = {
  dockerfile: 'docker',
  makefile: 'make',
};

/** The Shiki language id for a path, or null to render as plain text. */
export function languageFor(path: string): string | null {
  const filename = path.split('/').pop() ?? path;
  const byName = FILENAMES[filename.toLowerCase()];
  if (byName !== undefined) return byName;
  // A leading-dot file like `.env.example` has no meaningful extension.
  if (filename.startsWith('.')) return null;
  const ext = filename.includes('.') ? filename.split('.').pop() : undefined;
  return ext === undefined ? null : (EXTENSIONS[ext.toLowerCase()] ?? null);
}

let instance: Promise<Highlighter> | null = null;
const loaded = new Set<string>();

async function highlighter(): Promise<Highlighter> {
  if (instance === null) {
    instance = import('shiki').then((shiki) =>
      shiki.createHighlighter({ themes: ['github-light', 'github-dark'], langs: [] }),
    );
  }
  return instance;
}

function escapeHtml(code: string): string {
  return `<pre class="shiki-plain"><code>${code
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')}</code></pre>`;
}

/**
 * Highlight to HTML. An unknown or unloadable language degrades to escaped
 * plain text rather than failing — a viewer that shows nothing is worse than
 * one that shows unstyled code.
 */
export async function highlight(code: string, lang: string | null): Promise<string> {
  if (lang === null) return escapeHtml(code);
  try {
    const hl = await highlighter();
    if (!loaded.has(lang)) {
      await hl.loadLanguage(lang as Parameters<typeof hl.loadLanguage>[0]);
      loaded.add(lang);
    }
    return hl.codeToHtml(code, { lang, themes: { light: 'github-light', dark: 'github-dark' } });
  } catch {
    return escapeHtml(code);
  }
}
```

- [ ] **Step 5: Write the CodeViewer**

Create `src/workspace/CodeViewer.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { highlight, languageFor } from './highlighter';

export function CodeViewer({ content, path }: { content: string; path: string }) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void highlight(content, languageFor(path)).then((out) => {
      if (live) setHtml(out);
    });
    return () => {
      live = false;
    };
  }, [content, path]);

  return (
    <div
      data-testid="code-viewer"
      data-lang={languageFor(path) ?? 'plain'}
      className="min-h-0 flex-1 overflow-auto p-4 text-sm [font-family:var(--font-mono)]"
    >
      {html === null ? (
        <pre className="m-0">{content}</pre>
      ) : (
        // Shiki output is generated from the file's own bytes and escaped by
        // the highlighter; no user-supplied HTML reaches this string.
        // eslint-disable-next-line react/no-danger -- Shiki-generated, escaped
        <div dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>
  );
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm test:run src/workspace/highlighter.test.ts`
Expected: PASS — 3 tests

- [ ] **Step 7: Commit**

```bash
git add src/workspace/highlighter.ts src/workspace/highlighter.test.ts src/workspace/CodeViewer.tsx package.json pnpm-lock.yaml
git commit -m "feat(workspace): one highlighter, so a fence and a file agree (M30.16)"
```

---

### Task M30.17: Relative-link resolution

**Files:**
- Create: `src/workspace/docLinks.ts`
- Test: `src/workspace/docLinks.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/workspace/docLinks.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { classifyHref, resolveRelative } from './docLinks';

describe('resolveRelative', () => {
  it('resolves a sibling', () => {
    expect(resolveRelative('docs/guide.md', './setup.md')).toBe('docs/setup.md');
  });

  it('resolves a bare sibling with no leading dot', () => {
    expect(resolveRelative('docs/guide.md', 'setup.md')).toBe('docs/setup.md');
  });

  it('resolves a parent hop', () => {
    expect(resolveRelative('docs/guide/setup.md', '../index.md')).toBe('docs/index.md');
  });

  it('treats a leading slash as root-relative', () => {
    expect(resolveRelative('docs/guide.md', '/README.md')).toBe('README.md');
  });

  it('drops a fragment', () => {
    expect(resolveRelative('docs/guide.md', './setup.md#install')).toBe('docs/setup.md');
  });

  it('cannot climb above the root', () => {
    expect(resolveRelative('README.md', '../../etc/passwd')).toBe('etc/passwd');
  });
});

describe('classifyHref', () => {
  it('calls out external links', () => {
    expect(classifyHref('https://example.com')).toBe('external');
    expect(classifyHref('mailto:a@b.c')).toBe('external');
  });

  it('calls out in-page anchors', () => {
    expect(classifyHref('#install')).toBe('anchor');
  });

  it('calls everything else internal', () => {
    expect(classifyHref('./setup.md')).toBe('internal');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run src/workspace/docLinks.test.ts`
Expected: FAIL — cannot resolve `./docLinks`

- [ ] **Step 3: Write the implementation**

Create `src/workspace/docLinks.ts`:

```ts
/**
 * Turning a markdown href into somewhere to go.
 *
 * Relative links resolving in-app is the feature that makes a pile of markdown
 * into browsable documentation, and it is the reason this spec built a viewer
 * instead of rendering rows.
 */

export type HrefKind = 'external' | 'anchor' | 'internal';

export function classifyHref(href: string): HrefKind {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return 'external';
  if (href.startsWith('#')) return 'anchor';
  return 'internal';
}

/**
 * Resolve `href` against the file it appeared in, yielding a root-relative
 * path. Never leaves a `..` in the result — the backend refuses those anyway,
 * and resolving here keeps the tree selection agreeing with the link.
 */
export function resolveRelative(fromPath: string, href: string): string {
  const withoutFragment = href.split('#')[0].split('?')[0];
  const base = withoutFragment.startsWith('/') ? [] : fromPath.split('/').slice(0, -1);
  const segments = withoutFragment.replace(/^\//, '').split('/');

  const out = [...base];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') out.pop();
    else out.push(segment);
  }
  return out.join('/');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test:run src/workspace/docLinks.test.ts`
Expected: PASS — 9 tests

- [ ] **Step 5: Commit**

```bash
git add src/workspace/docLinks.ts src/workspace/docLinks.test.ts
git commit -m "feat(workspace): a relative link is a place in the repo, not a dead string (M30.17)"
```

---

### Task M30.18: The doc viewer

**Files:**
- Create: `src/workspace/DocViewer.tsx`
- Modify: `package.json`

- [ ] **Step 1: Add the dependencies**

Run: `pnpm add react-markdown remark-gfm`

- [ ] **Step 2: Write the component**

Create `src/workspace/DocViewer.tsx`:

```tsx
import { useEffect, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useRootsStore } from '@/stores/rootsStore';
import { classifyHref, resolveRelative } from './docLinks';
import { highlight } from './highlighter';

/**
 * A fence, highlighted through the shared Shiki instance.
 *
 * Dispatched by fence LANGUAGE, which is what makes the renderer pluggable:
 * merging M29 means registering `mermaid` here, not reworking the viewer.
 */
function Fence({ lang, code }: { lang: string | null; code: string }) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void highlight(code, lang).then((out) => {
      if (live) setHtml(out);
    });
    return () => {
      live = false;
    };
  }, [code, lang]);

  if (html === null) return <pre className="overflow-x-auto">{code}</pre>;
  return (
    // eslint-disable-next-line react/no-danger -- Shiki-generated, escaped
    <div className="overflow-x-auto" dangerouslySetInnerHTML={{ __html: html }} />
  );
}

export function DocViewer({
  rootId,
  path,
  content,
}: {
  rootId: string;
  path: string;
  content: string;
}) {
  const openFile = useRootsStore((s) => s.openFile);

  return (
    <article
      data-testid="doc-viewer"
      data-path={path}
      className="mx-auto min-h-0 w-full max-w-[70ch] flex-1 overflow-y-auto px-6 py-8 text-[15px] leading-7"
    >
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a({ href, children, ...rest }) {
            const target = href ?? '';
            const kind = classifyHref(target);
            if (kind === 'internal') {
              return (
                <a
                  {...rest}
                  href={target}
                  data-testid="doc-internal-link"
                  onClick={(e) => {
                    e.preventDefault();
                    openFile(rootId, resolveRelative(path, target));
                  }}
                >
                  {children}
                </a>
              );
            }
            return (
              <a
                {...rest}
                href={target}
                target={kind === 'external' ? '_blank' : undefined}
                rel={kind === 'external' ? 'noreferrer' : undefined}
              >
                {children}
              </a>
            );
          },
          img({ src, alt, ...rest }) {
            // Relative images resolve against the file, through the same
            // containment guard read_file_text applies.
            const source = typeof src === 'string' ? src : '';
            if (classifyHref(source) !== 'internal') {
              return <img {...rest} src={source} alt={alt ?? ''} />;
            }
            return (
              <img
                {...rest}
                data-testid="doc-image"
                data-resolved={resolveRelative(path, source)}
                src={source}
                alt={alt ?? ''}
              />
            );
          },
          code({ className, children, ...rest }) {
            const match = /language-(\w+)/.exec(className ?? '');
            const text = String(children).replace(/\n$/, '');
            // Inline code carries no language class and stays inline.
            if (match === null && !text.includes('\n')) {
              return (
                <code className={className} {...rest}>
                  {children}
                </code>
              );
            }
            return <Fence lang={match?.[1] ?? null} code={text} />;
          },
        }}
      >
        {content}
      </Markdown>
    </article>
  );
}
```

- [ ] **Step 3: Verify it typechecks**

Run: `pnpm typecheck`
Expected: clean

- [ ] **Step 4: Commit**

```bash
git add src/workspace/DocViewer.tsx package.json pnpm-lock.yaml
git commit -m "feat(workspace): markdown reads like a document, not a table cell (M30.18)"
```

---

### Task M30.19: FileViewer routing and typed placeholders

**Files:**
- Create: `src/workspace/FileViewer.tsx`
- Test: `src/workspace/FileViewer.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/workspace/FileViewer.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_BYTES, resetMockRoots, seedFile, seedRoot } from '@/lib/mockRoots';
import { useRootsStore } from '@/stores/rootsStore';
import { FileViewer } from './FileViewer';

beforeEach(() => {
  resetMockRoots();
  useRootsStore.setState({ roots: [], expanded: {}, children: {}, open: null, docs: [] });
});

describe('FileViewer', () => {
  it('renders markdown in the doc viewer', async () => {
    const root = seedRoot({ path: '/repos/alpha', label: 'alpha' });
    seedFile('/repos/alpha', 'README.md', '# Alpha\n\nHello.');
    render(<FileViewer rootId={root.id} path="README.md" />);
    expect(await screen.findByTestId('doc-viewer')).toBeTruthy();
  });

  it('renders code in the code viewer', async () => {
    const root = seedRoot({ path: '/repos/alpha', label: 'alpha' });
    seedFile('/repos/alpha', 'src/main.rs', 'fn main() {}');
    render(<FileViewer rootId={root.id} path="src/main.rs" />);
    expect(await screen.findByTestId('code-viewer')).toBeTruthy();
  });

  it('renders a distinct placeholder for a binary file', async () => {
    const root = seedRoot({ path: '/repos/alpha', label: 'alpha' });
    seedFile('/repos/alpha', 'image.png', `PNG${String.fromCharCode(0)}data`);
    render(<FileViewer rootId={root.id} path="image.png" />);
    expect(await screen.findByTestId('viewer-binary')).toBeTruthy();
  });

  it('renders a distinct placeholder for an oversized file', async () => {
    const root = seedRoot({ path: '/repos/alpha', label: 'alpha' });
    seedFile('/repos/alpha', 'big.txt', 'x'.repeat(MAX_BYTES + 1));
    render(<FileViewer rootId={root.id} path="big.txt" />);
    expect(await screen.findByTestId('viewer-too-large')).toBeTruthy();
  });

  it('renders a distinct placeholder for a missing file', async () => {
    const root = seedRoot({ path: '/repos/alpha', label: 'alpha' });
    render(<FileViewer rootId={root.id} path="missing.md" />);
    expect(await screen.findByTestId('viewer-not-found')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run src/workspace/FileViewer.test.tsx`
Expected: FAIL — cannot resolve `./FileViewer`

- [ ] **Step 3: Write the implementation**

Create `src/workspace/FileViewer.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import type { FileText } from '@/engine/roots';
import { viewerKindFor } from '@/engine/roots';
import { readFileText } from '@/lib/rootsIpc';
import { CodeViewer } from './CodeViewer';
import { DocViewer } from './DocViewer';

/** Bytes as a short human string, for the too-large placeholder. */
function humanSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

export function FileViewer({ rootId, path }: { rootId: string; path: string }) {
  const [state, setState] = useState<FileText | null>(null);

  useEffect(() => {
    let live = true;
    setState(null);
    void readFileText(rootId, path).then((out) => {
      if (live) setState(out);
    });
    return () => {
      live = false;
    };
  }, [rootId, path]);

  if (state === null) return <div data-testid="viewer-loading" />;

  // Each refusal gets its own placeholder. Collapsing them into one blank pane
  // would make "too big", "not text" and "gone" indistinguishable.
  if (state.kind === 'notFound') {
    return (
      <div data-testid="viewer-not-found" className="p-8">
        <EmptyState icon="file-x" title="File not found" description={path} />
      </div>
    );
  }
  if (state.kind === 'binary') {
    return (
      <div data-testid="viewer-binary" className="p-8">
        <EmptyState icon="file-lock" title="Not a text file" description={path} />
      </div>
    );
  }
  if (state.kind === 'tooLarge') {
    return (
      <div data-testid="viewer-too-large" className="p-8">
        <EmptyState
          icon="file-warning"
          title="File too large to display"
          description={`${humanSize(state.size)} — the viewer stops at ${humanSize(state.limit)}.`}
        />
      </div>
    );
  }

  return viewerKindFor(path) === 'doc' ? (
    <DocViewer rootId={rootId} path={path} content={state.content} />
  ) : (
    <CodeViewer path={path} content={state.content} />
  );
}
```

> The `icon` names above must exist in `src/components/ui/Icon.tsx`. Run `grep -n "file-x\|file-lock\|file-warning\|folder-tree\|folder-plus\|book-open" src/components/ui/Icon.tsx` and substitute the nearest available lucide names for any that are missing rather than inventing one.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test:run src/workspace/FileViewer.test.tsx`
Expected: PASS — 5 tests

- [ ] **Step 5: Commit**

```bash
git add src/workspace/FileViewer.tsx src/workspace/FileViewer.test.tsx
git commit -m "feat(workspace): every refusal gets its own placeholder (M30.19)"
```

---

## Phase 7 — The Docs tab and end-to-end

### Task M30.20: The cross-root Docs tab

**Files:**
- Create: `src/workspace/DocsTab.tsx`
- Test: `src/workspace/DocsTab.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/workspace/DocsTab.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetMockRoots, seedFile, seedRoot } from '@/lib/mockRoots';
import { useRootsStore } from '@/stores/rootsStore';
import { DocsTab } from './DocsTab';

beforeEach(() => {
  resetMockRoots();
  useRootsStore.setState({ roots: [], expanded: {}, children: {}, open: null, docs: [] });
});

describe('DocsTab', () => {
  it('bubbles markdown from every mounted root, grouped by root', async () => {
    seedRoot({ path: '/repos/alpha', label: 'alpha' });
    seedRoot({ path: '/repos/beta', label: 'beta' });
    seedFile('/repos/alpha', 'README.md', '# Alpha');
    seedFile('/repos/beta', 'docs/guide.md', '# Beta guide');
    await useRootsStore.getState().loadRoots();

    render(<DocsTab />);

    expect(await screen.findByText('Alpha')).toBeTruthy();
    expect(await screen.findByText('Beta guide')).toBeTruthy();
    expect(screen.getAllByTestId('docs-group')).toHaveLength(2);
  });

  it('opens a document when its card is clicked', async () => {
    const root = seedRoot({ path: '/repos/alpha', label: 'alpha' });
    seedFile('/repos/alpha', 'README.md', '# Alpha');
    await useRootsStore.getState().loadRoots();

    render(<DocsTab />);
    fireEvent.click(await screen.findByTestId('doc-card'));

    expect(useRootsStore.getState().open).toEqual({ rootId: root.id, path: 'README.md' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run src/workspace/DocsTab.test.tsx`
Expected: FAIL — cannot resolve `./DocsTab`

- [ ] **Step 3: Write the component**

Create `src/workspace/DocsTab.tsx`:

```tsx
import { useEffect } from 'react';
import { Icon } from '@/components/ui/Icon';
import { groupDocsByRoot } from '@/engine/roots';
import { useRootsStore } from '@/stores/rootsStore';

/**
 * Every markdown file across every mounted root, in one place.
 *
 * This is the "stop poking through the repo to find the README" surface. It is
 * deliberately NOT wired into the `ViewType` union — the viewer earns that
 * promotion (D-double-prime) only after real use proves it.
 */
export function DocsTab() {
  const roots = useRootsStore((s) => s.roots);
  const docs = useRootsStore((s) => s.docs);
  const loadDocs = useRootsStore((s) => s.loadDocs);
  const openFile = useRootsStore((s) => s.openFile);

  useEffect(() => {
    void loadDocs();
  }, [loadDocs, roots]);

  const groups = groupDocsByRoot(
    docs,
    roots.map((r) => r.id),
  );
  const labelFor = (id: string): string => roots.find((r) => r.id === id)?.label ?? id;

  return (
    <div data-testid="docs-tab" className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
      {groups.map((group) => (
        <section key={group.root} data-testid="docs-group" className="mb-6">
          <h2 className="mb-2 text-2xs font-semibold uppercase tracking-[0.06em] text-n-500">
            {labelFor(group.root)}
          </h2>
          <ul className="m-0 flex max-w-[760px] flex-col gap-1 p-0">
            {group.docs.map((doc) => (
              <li key={`${doc.root}/${doc.path}`} className="list-none">
                <button
                  type="button"
                  data-testid="doc-card"
                  data-path={doc.path}
                  onClick={() => openFile(doc.root, doc.path)}
                  className="flex w-full min-w-0 flex-col gap-0.5 rounded-md border-0 bg-transparent px-2 py-1.5 text-left hover:bg-n-50"
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <Icon
                      name={doc.isReadme ? 'book-open' : 'file-text'}
                      size={14}
                      color="var(--n-500)"
                    />
                    <span className="min-w-0 flex-1 truncate text-sm text-n-800">{doc.title}</span>
                    <span className="flex-none text-2xs text-[var(--text-meta)] [font-family:var(--font-mono)]">
                      {doc.path}
                    </span>
                  </span>
                  {doc.snippet !== '' && (
                    <span className="line-clamp-2 pl-[22px] text-2xs text-n-500">
                      {doc.snippet}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test:run src/workspace/ src/pages/WorkspacePage.test.tsx`
Expected: PASS — all workspace and page tests

- [ ] **Step 5: Commit**

```bash
git add src/workspace/DocsTab.tsx src/workspace/DocsTab.test.tsx
git commit -m "feat(workspace): every README in one place, without poking through a repo (M30.20)"
```

---

### Task M30.21: End-to-end and the full gate

**Files:**
- Create: `e2e/workspace.spec.ts`

- [ ] **Step 1: Read an existing spec's boot helper**

Run: `ls e2e`

Then open the first `.spec.ts` it lists and copy its `boot()` helper **exactly** — it disables the background distiller via localStorage, and a spec that skips that is flaky.

- [ ] **Step 2: Write the e2e spec**

Create `e2e/workspace.spec.ts`, substituting the `boot()` helper you just read in place of the comment:

```ts
import { expect, test } from '@playwright/test';

// Paste the boot() helper from the existing spec here, unchanged.

test.describe('workspace', () => {
  test('mounts roots, browses a tree, and reads a doc', async ({ page }) => {
    await boot(page);

    await page.evaluate(() => {
      const w = window as unknown as {
        __cerebroMockRoots: {
          seedRoot(s: { path: string; label: string }): { id: string };
          seedFile(root: string, rel: string, content: string): void;
        };
      };
      w.__cerebroMockRoots.seedRoot({ path: '/repos/alpha', label: 'alpha' });
      w.__cerebroMockRoots.seedRoot({ path: '/repos/beta', label: 'beta' });
      w.__cerebroMockRoots.seedFile(
        '/repos/alpha',
        'README.md',
        '# Alpha\n\nSee [the guide](./docs/guide.md).',
      );
      w.__cerebroMockRoots.seedFile('/repos/alpha', 'docs/guide.md', '# Guide\n\nInstall it.');
      w.__cerebroMockRoots.seedFile('/repos/beta', 'README.md', '# Beta');
    });

    await page.getByRole('button', { name: 'Workspace' }).click();
    await expect(page.getByTestId('root-tree')).toBeVisible();

    // Expand alpha, then open its README.
    await page.getByTestId('tree-row').filter({ hasText: 'alpha' }).click();
    await page.getByTestId('tree-row').filter({ hasText: 'README.md' }).first().click();
    await expect(page.getByTestId('doc-viewer')).toContainText('Alpha');

    // A relative link navigates in-app.
    await page.getByTestId('doc-internal-link').click();
    await expect(page.getByTestId('doc-viewer')).toHaveAttribute('data-path', 'docs/guide.md');

    // The Docs tab bubbles both roots.
    await page.getByTestId('workspace-tab-docs').click();
    await expect(page.getByTestId('docs-group')).toHaveCount(2);
  });
});
```

- [ ] **Step 3: Run the e2e spec**

Run: `PORT=5273 pnpm e2e workspace.spec.ts`
Expected: PASS — 1 test

> If every spec fails at boot, a stale HMR'd dev server is holding :5173. `PORT=5273` isolates it.

- [ ] **Step 4: Run the full gate**

Run each, and fix anything that fails before committing. **Never `--no-verify`** — if a hook is wrong, fix the hook.

```bash
pnpm lint
pnpm typecheck
pnpm format:check
pnpm test:run
```

```bash
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
```

Expected: zero warnings, all green.

- [ ] **Step 5: Confirm the coverage ratchet still holds**

Run: `pnpm test:coverage`
Expected: at or above the thresholds in `vite.config.ts`. If the new code pushed a threshold up, raise it in `vite.config.ts` — ratchets only tighten, never loosen.

- [ ] **Step 6: Commit**

```bash
git add e2e/workspace.spec.ts vite.config.ts
git commit -m "test(workspace): mount, browse, follow a link, and see both roots bubbled (M30.21)"
```

---

## Coverage check against the spec

| Spec section | Task |
| --- | --- |
| 1.1 Root data | M30.1 |
| 1.2 Probed capabilities | M30.1 |
| 1.3 One-knowledge-root invariant | M30.3 |
| 1.4 Persistence in app-data | M30.2 |
| 1.5 Migration from `last_vault` | M30.7 (note — deliberately not automated) |
| 1.6 Qualified paths | M30.8 via `IndexedDoc` (deviation documented at the top) |
| 2.1 Lazy `list_dir` | M30.4 |
| 2.2 Markdown index | M30.6 |
| 2.3 Commands | M30.7 |
| 2.4 `read_file_text` guards | M30.5 |
| 3.1 Selection arm | M30.12 |
| 3.2 Components | M30.12, M30.14, M30.15, M30.19 |
| 3.3 Ignored-files toggle | M30.4 (backend), M30.13–M30.14 (UI) |
| 3.4 Windowing | M30.14 |
| 3.5 Unavailable roots | M30.14 |
| 4.0 Rendering stack | M30.16, M30.18 |
| 4.1 Reading experience | M30.17, M30.18 |
| 4.2 Docs tab | M30.20 |
| 5 Data flow | M30.11 |
| 6 Error handling | M30.11, M30.19 |
| 7 Testing | every task, plus M30.21 |

---

## Execution notes

- **Commit format:** `type(scope): sentence (M30.n)`, matching `git log`.
- **Never `--no-verify`.** Husky pre-commit lints and pre-push runs the full gate.
- **Nothing in this plan writes a file inside a mounted root.** If a task seems to need a write, it belongs in C-prime, not here.
- **Build order matters in Phase 5–7.** `WorkspacePage` (M30.12) imports four components that arrive later; stub each as `export function X() { return null }` on first creation if you want a green suite at every task.
