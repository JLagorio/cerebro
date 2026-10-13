//! Disk writes: frontmatter patching, note bodies, note creation, views.
//! All writes go through `write_file` so the watcher (Task 8) can register
//! own-writes for suppression in one place. All caller-supplied paths are
//! validated by `safe_join`/`safe_component` — Task 7 exposes these functions
//! over IPC, so vault containment is enforced here, not in the callers. The
//! writers that change a NOTE go one step further through `note_join`, which
//! also refuses anything that is not a note (PLATFORM-API-1) — the same
//! mechanism under the agent's MCP doors and the human IPC commands — and the
//! ledger's projection writer goes through `bundle_join`, which keeps a
//! projection inside the bundle.

use std::path::{Component, Path, PathBuf};

use super::parse;

/// Raw List file — a database: a source type, filters, and one view (M10).
///
/// Three shapes live on disk, and all three load:
/// - `<collection>/<id>.list.yml` — the M10 form, inside a Collection folder.
/// - `views/<id>.yml` — legacy vault-global; surfaces with no collection.
/// - `<project dir>/views/<id>.yml` — legacy project-scoped.
///
/// Nothing has to move for a vault written before M10 to keep working; the
/// legacy paths are read but never written back to.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ViewYaml {
    pub id: String,
    pub yaml: String,
    pub project: Option<String>,
    /// Folder of the owning Collection (the dir holding `collection.yml`);
    /// None for a top-level List, which is how legacy views surface.
    pub collection: Option<String>,
    /// Vault-relative file path — what a rename or delete operates on.
    pub path: String,
}

/// Raw Collection file: `<folder>/collection.yml`. A Collection is a container,
/// so it is a FOLDER, the same way a project is — containers on screen should be
/// containers on disk in a markdown app.
#[derive(Debug, Clone, serde::Serialize)]
pub struct CollectionYaml {
    /// Vault-relative folder path, e.g. "product".
    pub folder: String,
    pub yaml: String,
}

/// The `<name>.list.yml` suffix that marks a List file.
const LIST_SUFFIX: &str = ".list.yml";
/// The marker that makes a folder a Collection.
const COLLECTION_MARKER: &str = "collection.yml";

fn rel_path(vault: &Path, path: &Path) -> Result<String, String> {
    Ok(path
        .strip_prefix(vault)
        .map_err(|e| e.to_string())?
        .components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/"))
}

/// Marker every atomic-write temp file carries: `.{name}.cerebro-tmp-{hex}`.
/// Dot-prefixed and non-`.md`, so the scanner and the watcher never see one.
const TEMP_MARKER: &str = ".cerebro-tmp-";

/// How old a temp must be before `clean_orphan_temps` may reap it. The engine
/// is stateless and concurrent commands re-scan constantly, so an in-flight
/// write's temp must never be reaped — age is the only guard.
const ORPHAN_TEMP_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(60);

/// Single funnel for all vault file writes; registers each write with the
/// watcher so our own saves don't bounce back as `vault-changed` events.
///
/// Atomic since M21.1: content lands in a same-directory temp, is fsynced,
/// then renamed over the destination, and the parent directory is fsynced so
/// the rename itself is durable. A crash at any point leaves either the old
/// bytes or the new bytes at the destination, never a truncated mix. Known
/// limitations (the same trade-off every atomic-save editor makes): xattrs
/// are not preserved across the rename, and a symlinked destination is
/// replaced by a regular file; plain permissions are preserved.
fn write_file(abs: &Path, content: &str) -> Result<(), String> {
    let parent = abs
        .parent()
        .ok_or_else(|| format!("no parent directory: {}", abs.display()))?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let name = abs
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| format!("unusable file name: {}", abs.display()))?;
    let temp = parent.join(format!(
        ".{name}{TEMP_MARKER}{:016x}",
        rand::random::<u64>()
    ));
    let result = write_via_temp(abs, parent, &temp, content);
    if result.is_err() {
        // Best-effort: after a successful rename the temp no longer exists,
        // and a failure here still gets reaped by clean_orphan_temps later.
        let _ = std::fs::remove_file(&temp);
    }
    result
}

/// The commit sequence for one atomic write. Split out so `write_file` owns
/// exactly one job: cleaning up the temp on any error path.
fn write_via_temp(abs: &Path, parent: &Path, temp: &Path, content: &str) -> Result<(), String> {
    use std::io::Write;

    let mut file = std::fs::File::create(temp).map_err(|e| e.to_string())?;
    file.write_all(content.as_bytes())
        .map_err(|e| e.to_string())?;
    // Re-point permissions at the temp BEFORE the rename, so replacing the
    // destination cannot widen a user-tightened mode (chmod 600 stays 600).
    match std::fs::metadata(abs) {
        Ok(meta) => file
            .set_permissions(meta.permissions())
            .map_err(|e| e.to_string())?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.to_string()),
    }
    file.sync_all().map_err(|e| e.to_string())?;
    crate::crash::crash_point("temp-written");
    // Register BEFORE the rename: the suppression entry must exist by the
    // time the OS can deliver a change event for the destination path. With
    // the content hash (M21.6), so the echo is recognized by bytes, not by
    // clock.
    super::watcher::note_own_write_hashed(abs, crate::ledger::sha256_hex(content.as_bytes()));
    std::fs::rename(temp, abs).map_err(|e| e.to_string())?;
    crate::crash::crash_point("renamed-pre-dirsync");
    // The rename is durable only once the directory entry itself is on disk.
    std::fs::File::open(parent)
        .and_then(|dir| dir.sync_all())
        .map_err(|e| e.to_string())
}

/// Reap atomic-write temps abandoned by a crash, anywhere in the vault
/// (skipping dot-directories, where `write_file` never writes). Best-effort
/// janitor run once per `scan_vault` command; temps younger than
/// [`ORPHAN_TEMP_MAX_AGE`] are spared — they may belong to a write in flight.
pub fn clean_orphan_temps(vault: &Path) {
    let walker = walkdir::WalkDir::new(vault)
        .into_iter()
        .filter_entry(|e| {
            e.depth() == 0
                || e.file_type().is_file()
                || !e.file_name().to_string_lossy().starts_with('.')
        })
        .filter_map(Result::ok);
    for item in walker {
        if !item.file_type().is_file() || !item.file_name().to_string_lossy().contains(TEMP_MARKER)
        {
            continue;
        }
        let stale = item
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| std::time::SystemTime::now().duration_since(t).ok())
            .is_some_and(|age| age >= ORPHAN_TEMP_MAX_AGE);
        if stale {
            let _ = std::fs::remove_file(item.path());
        }
    }
}

/// Join a vault-relative path onto the vault root, rejecting empty paths,
/// absolute paths (`Path::join` would replace the base!), any `..`
/// traversal, AND any symlink — planted anywhere along the path, leaf or
/// intermediate — that resolves outside the vault. The component check
/// alone only looks at the string; a name with no `..` in it can still be a
/// symlink pointing wherever it likes, so containment has to be verified
/// against the resolved filesystem path, not the requested one.
fn safe_join(vault: &Path, rel: &str) -> Result<PathBuf, String> {
    resolve(vault, rel).map(|resolved| resolved.joined)
}

/// A contained vault-relative path, and where it actually lands.
struct Resolved {
    /// `vault.join(rel)` — what the writers open.
    joined: PathBuf,
    /// Where `joined` lands, relative to the vault: its longest existing
    /// ancestor as the filesystem resolves it — symlinks followed, and every
    /// name as the disk stores it, which `realpath` answers with on APFS even
    /// when the request folded case — then the part that does not exist yet.
    landing: PathBuf,
}

/// `safe_join`'s whole check, keeping the resolution it already has to do
/// for `note_join` to judge.
fn resolve(vault: &Path, rel: &str) -> Result<Resolved, String> {
    let contained = !rel.is_empty()
        && Path::new(rel)
            .components()
            .all(|c| matches!(c, Component::Normal(_) | Component::CurDir));
    if !contained {
        return Err(format!("path escapes the vault: {rel:?}"));
    }
    let joined = vault.join(rel);
    let canonical_vault = vault
        .canonicalize()
        .map_err(|e| format!("resolving vault root: {e}"))?;
    // `canonicalize` requires the path to exist, and most of the paths this
    // function sees are about to be CREATED. Walk up to the longest
    // existing ancestor (the vault root itself always exists, so this
    // terminates) and resolve symlinks from there — a symlink further up
    // the chain than the leaf is exactly as much an escape as one at the
    // leaf.
    let mut existing = joined.as_path();
    while !existing.exists() {
        match existing.parent() {
            Some(parent) => existing = parent,
            None => break,
        }
    }
    let canonical_existing = existing
        .canonicalize()
        .map_err(|e| format!("resolving path: {e}"))?;
    let Ok(inside) = canonical_existing.strip_prefix(&canonical_vault) else {
        return Err(format!("path escapes the vault: {rel:?}"));
    };
    // `existing` was walked up from `joined` by `parent`, so it is a prefix
    // and this cannot miss; if it ever did, refusing is the safe answer.
    let rest = joined
        .strip_prefix(existing)
        .map_err(|_| format!("resolving path: {rel:?}"))?;
    let landing = inside.join(rest);
    Ok(Resolved { joined, landing })
}

/// Require a single normal path component: non-empty, no separators, no
/// traversal. Used for note slugs and view ids.
fn safe_component(kind: &str, value: &str) -> Result<(), String> {
    let mut components = Path::new(value).components();
    let single_normal = matches!(
        (components.next(), components.next()),
        (Some(Component::Normal(_)), None)
    );
    if single_normal && !value.contains(['/', '\\']) {
        Ok(())
    } else {
        Err(format!("invalid {kind}: {value:?}"))
    }
}

// --- Note targets (PLATFORM-API-1, CANVAS-1) --------------------------------

/// What the markdown-only note writers accept.
const MARKDOWN: &[&str] = &["md"];

/// `save_note`'s set: the diagram page and the whiteboard tab save a `.mmd`
/// raw, through the body editor's own door (M29.20, M29.46).
const MARKDOWN_OR_DIAGRAM: &[&str] = &["md", "mmd"];

/// Why `path` is not a note a note writer may touch, or `None` when it is.
///
/// Judged per component, the way the scanner judges folders:
/// - No component may start with `.`: not `.git/`, whose config the app's
///   own `git status` poll and auto-commit execute (`core.fsmonitor`,
///   `gpg.program`, and more); not `.cerebro/`, with its write-once ledger
///   segments and connector config; not `.claude/`, any other dot-folder, or
///   any dotfile. Heard as HFS+ hears a name (`disk_folded`), which ignores
///   U+200C, U+FEFF and their kind: there, `\u{200c}.claude/` IS `.claude/`
///   (git's `core.protectHFS` class), and with no such folder yet the landing
///   check has nothing to resolve.
/// - The extension must be one of `extensions`, spelled exactly as the
///   scanner spells it. An append adds markdown and a frontmatter patch
///   prepends YAML, and in a `.canvas`, `.csv`, `.json` or `.yml` either one
///   is corruption.
/// - A markdown note may not sit in a folder the scanner skips, asked with
///   the scanner's own predicate (`scan::is_skipped_dir`): exactly `views/`
///   and `attachments/`, at any depth. This rule only decides what is
///   VISIBLE — the two above are the boundary — so it says exactly what the
///   scanner says. `Attachments/`, `Views/` and `views./` are folders the
///   scanner lists, so their notes save; where a disk folds `Views/` onto an
///   existing `views/`, the LANDING is `views/` (see `note_join`), and that
///   refuses.
///
/// Two consequences, both deliberate:
/// - A dotfile note the scanner still lists (`records/.draft.md`) is
///   read-only in the app. PLATFORM-API-1 refuses every dotfile; whether the
///   scanner should hide them too is the owner's call, and
///   note-targets.json records the decision as it stands.
/// - A `.mmd` is exempt from the folder rule because something writes one
///   there today: `WhiteboardView` files a legacy `views/<id>.yml` List's
///   canvases under `views/whiteboards/`, and refusing would strand every
///   canvas such a List already has. Only the human doors take a `.mmd`.
///
/// Mirrored by `noteRefusal` in src/lib/mockIpc.ts; both replay
/// src-tauri/fixtures/note-targets.json.
fn note_refusal(path: &Path, extensions: &[&str]) -> Option<String> {
    let names: Vec<_> = path
        .components()
        .filter_map(|c| match c {
            Component::Normal(name) => Some(name.to_string_lossy()),
            _ => None,
        })
        .collect();
    if names.iter().any(|name| disk_folded(name).starts_with('.')) {
        return Some("dot-folders and dotfiles hold no notes".to_string());
    }
    let leaf = names.last().map(|name| name.as_ref()).unwrap_or_default();
    let folders = &names[..names.len().saturating_sub(1)];
    let extension = Path::new(leaf)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default();
    if !extensions.contains(&extension) {
        let kinds: Vec<String> = extensions.iter().map(|e| format!(".{e}")).collect();
        return Some(format!("only {} files are notes", kinds.join(" and ")));
    }
    if extension == "md" && folders.iter().any(|name| super::scan::is_skipped_dir(name)) {
        return Some("views/ and attachments/ hold no notes".to_string());
    }
    None
}

/// `name` as a disk that folds names may hear it: Unicode case folded — APFS
/// hears U+212A KELVIN SIGN as `k` — with the code points HFS+ ignores in a
/// name dropped. Two names that fold alike may be one folder on such a disk.
fn disk_folded(name: &str) -> String {
    let heard: String = name
        .chars()
        .filter(|c| {
            !matches!(
                c,
                '\u{200c}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{206a}'..='\u{206f}' | '\u{feff}'
            )
        })
        .collect();
    heard.to_uppercase().to_lowercase()
}

/// Where the bundle is on this disk, relative to the vault: what
/// `vault/knowledge` resolves to — through a symlink, and under the name the
/// disk stores, which `realpath` answers with even for a folder planted as
/// U+212A + `nowledge`. `None` while the vault holds no bundle.
fn bundle_root(vault: &Path) -> Option<PathBuf> {
    let canonical_vault = vault.canonicalize().ok()?;
    let root = vault
        .join(crate::knowledge::KNOWLEDGE_DIR)
        .canonicalize()
        .ok()?;
    root.strip_prefix(&canonical_vault)
        .ok()
        .map(Path::to_path_buf)
}

/// The first named component of `path`.
fn first_name(path: &Path) -> Option<String> {
    path.components().find_map(|c| match c {
        Component::Normal(name) => Some(name.to_string_lossy().into_owned()),
        _ => None,
    })
}

/// Is `path`'s first component one a folding disk hears as `knowledge`?
fn names_the_bundle(path: &Path) -> bool {
    first_name(path).is_some_and(|name| disk_folded(&name) == crate::knowledge::KNOWLEDGE_DIR)
}

/// A vault-relative path `/`-joined, for a message.
fn slashed(path: &Path) -> String {
    path.components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

/// `safe_join` for a writer that changes a NOTE (PLATFORM-API-1): the target
/// must be contained, AND be a note.
///
/// Every note writer below resolves its target here before it reads a byte —
/// `save_note`, `update_frontmatter`, `set_note_title`, `create_note`, the
/// agent's append (`appended_body`), `write_source` and `write_text_file` —
/// so the agent's MCP doors and the human IPC commands share one boundary,
/// and a refused file is never opened, let alone rewritten. It lives in the
/// mechanism because the grant cannot hold it: panel turns, and every Agent
/// record without `scope:`, run unscoped, so nothing upstream ever stopped an
/// append to `.git/config`. Writers whose job IS config (`save_view`,
/// `save_list`, `save_collection`, the ledger, the connector settings) do not
/// come through here.
///
/// Judged twice: once as asked, and once where it LANDS (see `Resolved`), so
/// a symlink with an innocent name cannot carry the write into `.git/`, and a
/// name a folding disk hears as a skipped folder (`view` + U+017F LONG S IS
/// `views` on APFS) is judged as the folder it reaches.
///
/// And it may not reach `knowledge/` by any name but the bundle's own. The
/// bundle's guards (`knowledge::canonical_path`) read the name and fold ASCII
/// case only, so a write reaching the bundle another way — a symlink, or a
/// spelling APFS folds onto it (U+212A KELVIN SIGN + `nowledge`) — walks past
/// every one of them. Membership is IDENTITY (it lands under where
/// `knowledge/` resolves) or NAME (a first component that folds to
/// `knowledge`, as asked or as landed). Identity alone misses the plant: a
/// folder made under the folded spelling before the bundle exists, which the
/// bundle's own writes then land in, and which no name-based guard would
/// ever recognise again.
fn note_join(vault: &Path, rel: &str, extensions: &[&str]) -> Result<PathBuf, String> {
    let resolved = resolve(vault, rel)?;
    if let Some(reason) = note_refusal(Path::new(rel), extensions) {
        return Err(format!("not a note: {rel} — {reason}"));
    }
    let landing = slashed(&resolved.landing);
    if let Some(reason) = note_refusal(&resolved.landing, extensions) {
        return Err(format!(
            "not a note: {rel} resolves to {landing} — {reason}"
        ));
    }
    let in_bundle = names_the_bundle(Path::new(rel))
        || names_the_bundle(&resolved.landing)
        || bundle_root(vault).is_some_and(|root| resolved.landing.starts_with(root));
    if in_bundle && !crate::knowledge::is_knowledge_path(rel) {
        let lands = if landing == slashed(Path::new(rel)) {
            String::new()
        } else {
            format!(" (it resolves to {landing})")
        };
        return Err(format!(
            "{rel} is inside knowledge/ by another name{lands} — the bundle is reached by its own \
             name or not at all"
        ));
    }
    Ok(resolved.joined)
}

/// `safe_join` for the ledger's projection writer (`ledger::manifest`): the
/// file must land INSIDE the bundle — under where `knowledge/` resolves, not
/// merely at a path spelled `knowledge/…` — and be markdown.
///
/// A projection path is `knowledge/` plus the path a write named, so a
/// symlink inside the bundle (`knowledge/sys` → `.git/hooks`, or a folder
/// outside the vault) carried `write_concept`, a capture or a governed apply
/// wherever it pointed. Judged before anything is recorded or written, and
/// by the concept writers before anything commits (`manifest::ensure_writable`).
///
/// Containment and nothing more, because this writer also writes back what a
/// PERSON filed: a concept moved into `knowledge/.archive/` is adopted where
/// it went (`reconcile::adopt_moves`), and every reconciliation exit
/// rewrites every projection, so a path refused here fails the whole vault's
/// exits, not one write. Which folders a NEW concept may go in is the agent
/// doors' rule (`concept_refusal`).
pub fn bundle_join(vault: &Path, rel: &str) -> Result<PathBuf, String> {
    let resolved = resolve(vault, rel)?;
    let landing = slashed(&resolved.landing);
    let inside = match bundle_root(vault) {
        Some(root) => resolved.landing.starts_with(root),
        // No bundle yet: the folder this write creates is the one it names.
        None => first_name(&resolved.landing).as_deref() == Some(crate::knowledge::KNOWLEDGE_DIR),
    };
    if !inside {
        return Err(format!(
            "{rel} resolves to {landing}, outside knowledge/ — a projection is written inside the \
             bundle or not at all"
        ));
    }
    if resolved.landing.extension().and_then(|e| e.to_str()) != Some("md") {
        return Err(format!("{rel}: a projection is a .md file"));
    }
    Ok(resolved.joined)
}

/// Why an agent's concept door refuses `rel`, or `None`: a concept an agent
/// writes or rechecks is a note the scan can list — no dot-folder or dotfile,
/// a `.md`, not under `views/` or `attachments/` (`note_refusal`). Written
/// where the scan cannot see it, a concept sits in the ledger and nowhere in
/// the app — no Knowledge row, no Review card, no `get_note` — while the
/// tool tells the agent it waits in Knowledge for review.
pub(crate) fn concept_refusal(rel: &str) -> Option<String> {
    note_refusal(Path::new(rel), MARKDOWN)
}

/// `read_file` for a note writer: `note_join` judges the target before a byte
/// of it is read.
fn read_note_target(vault: &Path, rel: &str, extensions: &[&str]) -> Result<String, String> {
    std::fs::read_to_string(note_join(vault, rel, extensions)?).map_err(|e| format!("{rel}: {e}"))
}

fn read_file(vault: &Path, rel: &str) -> Result<String, String> {
    std::fs::read_to_string(safe_join(vault, rel)?).map_err(|e| format!("{rel}: {e}"))
}

/// Recompose a file from a raw frontmatter block (with trailing newline) and
/// an untouched body. Empty/absent block → body only.
fn compose(block: Option<&str>, body: &str) -> String {
    match block {
        Some(b) if !b.trim().is_empty() => format!("---\n{b}---\n{body}"),
        _ => body.to_string(),
    }
}

fn serialize_mapping(mapping: &serde_yaml::Mapping) -> Result<Option<String>, String> {
    if mapping.is_empty() {
        return Ok(None);
    }
    serde_yaml::to_string(mapping)
        .map(Some)
        .map_err(|e| e.to_string())
}

/// Convert a JSON patch value to YAML for insertion into a mapping.
fn json_to_yaml(value: &serde_json::Value) -> serde_yaml::Value {
    match value {
        serde_json::Value::Null => serde_yaml::Value::Null,
        serde_json::Value::Bool(b) => serde_yaml::Value::Bool(*b),
        serde_json::Value::Number(n) => {
            serde_yaml::from_str(&n.to_string()).unwrap_or(serde_yaml::Value::Null)
        }
        serde_json::Value::String(s) => serde_yaml::Value::String(s.clone()),
        serde_json::Value::Array(items) => {
            serde_yaml::Value::Sequence(items.iter().map(json_to_yaml).collect())
        }
        serde_json::Value::Object(map) => {
            let mut m = serde_yaml::Mapping::new();
            for (k, v) in map {
                m.insert(serde_yaml::Value::String(k.clone()), json_to_yaml(v));
            }
            serde_yaml::Value::Mapping(m)
        }
    }
}

/// Record one committed write's hash in runtime.db's `vault_writes` (M21.8;
/// moved out of the epistemic ledger in M49.10) — see
/// `runtime::vault_writes`. Best-effort and invisible: it observes writes,
/// it never gates them.
fn shadow_write(vault: &Path, rel: &str, content: &str, kind: &str, actor: Option<&str>) {
    // Operational, not epistemic (M49.10, Q4): runtime.db, not the ledger.
    let hash = crate::ledger::sha256_hex(content.as_bytes());
    crate::runtime::vault_writes::record(vault, kind, rel, None, Some(&hash), actor);
}

/// The exact bytes `update_frontmatter` will write for a patch.
///
/// Public for the same reason as `compose_new_note`: a guard has to read what
/// LANDS ON DISK. A patch that nulls out every remaining key leaves an empty
/// mapping, which serialises as no block at all — and then the body is the
/// whole file, so a `---` fence sitting in that body arrives at byte zero and
/// becomes the frontmatter the scanner reads (PR #17 security review).
pub fn patched_frontmatter(
    vault: &Path,
    rel: &str,
    patch: &serde_json::Map<String, serde_json::Value>,
) -> Result<String, String> {
    // A .mmd has NO frontmatter to patch (M29.23): its leading `---` block is
    // mermaid config — valid YAML, so without this guard a patch (including
    // the agent's MCP update_frontmatter) would merge into the diagram's
    // config header and reserialize it. Refused at the mechanism, not the
    // callers, same as vault containment.
    if rel.ends_with(".mmd") {
        return Err(format!(
            "{rel}: a .mmd is raw diagram source and has no frontmatter to update"
        ));
    }
    let content = read_note_target(vault, rel, MARKDOWN)?;
    let (block, body) = parse::split_frontmatter(&content);
    let mut mapping = match block {
        Some(b) => parse::parse_frontmatter(b)
            .map_err(|e| format!("{rel}: cannot patch malformed frontmatter: {e}"))?,
        None => serde_yaml::Mapping::new(),
    };
    for (key, value) in patch {
        let key = serde_yaml::Value::String(key.clone());
        if value.is_null() {
            mapping.shift_remove(&key); // shift_remove preserves key order
        } else {
            mapping.insert(key, json_to_yaml(value)); // existing keys keep position
        }
    }
    let new_block = serialize_mapping(&mapping)?;
    Ok(compose(new_block.as_deref(), body))
}

/// Apply a JSON patch to a note's frontmatter. `null` deletes a key; existing
/// keys keep their position; new keys append; unknown keys and the body are
/// untouched.
///
/// CRLF/BOM/trailing-whitespace-fence files (see the round-trip caveat at the
/// top of parse.rs) are normalized: the frontmatter block is reserialized and
/// the fences rewritten in LF form. The body is preserved byte-for-byte.
/// YAML comments and the original scalar quoting style inside the frontmatter
/// block are not preserved through reserialization.
pub fn update_frontmatter(
    vault: &Path,
    rel: &str,
    patch: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    let content = patched_frontmatter(vault, rel, patch)?;
    write_file(&note_join(vault, rel, MARKDOWN)?, &content)?;
    shadow_write(vault, rel, &content, "vault.write", None);
    Ok(())
}

/// The verify path (M23.4): the stamp is a field revision plus a
/// `belief.attested` pinned to the reviewed revision event and its
/// projection hash, and the file regenerates as the projection. Refuses
/// with `ledger_writer_unavailable` when no ledger writer is active
/// (M49.1). The lib.rs `verify_concept` command is the only caller.
pub fn verify_frontmatter(
    vault: &Path,
    rel: &str,
    patch: &serde_json::Map<String, serde_json::Value>,
    viewed_body_hash: &str,
) -> Result<(), String> {
    crate::ledger::concepts::verify_concept(vault, rel, patch, viewed_body_hash)
}

/// Replace the note body, preserving the frontmatter block byte-for-byte.
///
/// `.mmd` files are RAW (M29.20): mermaid's own `---` config header is
/// diagram syntax, so the body IS the whole file — no frontmatter compose.
pub fn save_note(vault: &Path, rel: &str, body: &str) -> Result<(), String> {
    let composed = saved_note(vault, rel, body)?;
    write_file(&note_join(vault, rel, MARKDOWN_OR_DIAGRAM)?, &composed)?;
    if !rel.ends_with(".mmd") {
        shadow_write(vault, rel, &composed, "vault.write", None);
    }
    Ok(())
}

/// The exact bytes `save_note` will write for a new body.
///
/// Public for the same reason as `compose_new_note` and `patched_frontmatter`:
/// a guard has to read what LANDS ON DISK. `save_note` keeps the note's
/// existing frontmatter block and composes the body under it — so a note that
/// has NO block has its body as the whole file, and a `---` fence the new body
/// completes arrives at byte zero as the frontmatter the scanner will read
/// (PR #17 security review).
pub fn saved_note(vault: &Path, rel: &str, body: &str) -> Result<String, String> {
    let content = read_note_target(vault, rel, MARKDOWN_OR_DIAGRAM)?;
    if rel.ends_with(".mmd") {
        // Read anyway: same contract as .md, save only overwrites.
        return Ok(body.to_string());
    }
    let (block, _) = parse::split_frontmatter(&content);
    Ok(compose(block, body))
}

/// The `type` a note's frontmatter declares, if the file exists and parses.
/// The MCP layer uses this to refuse agent writes to `type: Type` docs — the
/// vault's schema (M13.5). Malformed frontmatter reads as untyped, which is
/// also how scan.rs reads it: a doc the scanner does not type is not schema.
pub fn note_type(vault: &Path, rel: &str) -> Option<String> {
    // A .mmd is always untyped: its `---` header is mermaid config, and a
    // stray `type:` key in there is diagram data, not vault schema (M29.23).
    if rel.ends_with(".mmd") {
        return None;
    }
    // Not a note, so no type worth asking for: every note writer refuses the
    // file anyway, and judging it first means the agent's governed-type
    // checks never open `.git/` or a ledger segment to find out
    // (PLATFORM-API-1).
    parse::declared_type(&read_note_target(vault, rel, MARKDOWN).ok()?)
}

/// Return the note body only (frontmatter stripped). `.mmd` files pass
/// through verbatim — their `---` header is mermaid config, not frontmatter.
pub fn read_note(vault: &Path, rel: &str) -> Result<String, String> {
    let content = read_file(vault, rel)?;
    if rel.ends_with(".mmd") {
        return Ok(content);
    }
    let (_, body) = parse::split_frontmatter(&content);
    Ok(body.to_string())
}

/// The body the agent's `append_to_note` saves (mcp.rs): the note's body with
/// `addition` appended as its own paragraph.
///
/// Markdown notes only, judged before a byte is read (PLATFORM-API-1). A
/// `.mmd` is refused outright rather than with the other non-notes because it
/// IS a note elsewhere — just not one markdown can be appended to: the text
/// lands in raw mermaid source, and the diagram stops parsing.
pub fn appended_body(vault: &Path, rel: &str, addition: &str) -> Result<String, String> {
    if rel.ends_with(".mmd") {
        return Err(format!(
            "{rel}: a .mmd is raw diagram source, and markdown appended to it is not a diagram"
        ));
    }
    let content = read_note_target(vault, rel, MARKDOWN)?;
    let (_, body) = parse::split_frontmatter(&content);
    Ok(format!("{}\n\n{}\n", body.trim_end(), addition.trim()))
}

fn unique_rel_path(vault: &Path, folder: &str, slug: &str) -> String {
    // '' means the vault root — no separator, or the path grows a leading '/'.
    let prefix = if folder.is_empty() {
        String::new()
    } else {
        format!("{folder}/")
    };
    let first = format!("{prefix}{slug}.md");
    if !vault.join(&first).exists() {
        return first;
    }
    let mut n = 2;
    loop {
        let candidate = format!("{prefix}{slug}-{n}.md");
        if !vault.join(&candidate).exists() {
            return candidate;
        }
        n += 1;
    }
}

/// Extensions `write_text_file` may create. `.mmd` only for now: the command
/// exists so a mermaid block can move its source out into a standalone
/// diagram file (M29.22) — it is not a general file-writing door.
const TEXT_FILE_EXTENSIONS: [&str; 1] = ["mmd"];

/// Write a raw text file at `rel`, deduping the STEM (`-2`, `-3`, …) when the
/// path is taken. Returns the vault-relative path actually written.
///
/// The extension allowlist and the knowledge guard live HERE, beside the
/// dedupe, rather than in the lib.rs command: a raw-bytes writer that could
/// be pointed at `knowledge/` or at a `.md` would bypass every invariant the
/// note pipeline enforces, so the policy sits with the mechanism. So do the
/// note-target rules (`note_join`): a diagram in a dot-folder is not one the
/// scanner will ever show.
pub fn write_text_file(vault: &Path, rel: &str, content: &str) -> Result<String, String> {
    crate::knowledge::guard_human_write(rel)?;
    let Some((stem, ext)) = rel.rsplit_once('.') else {
        return Err(format!("write_text_file requires an extension: {rel}"));
    };
    if !TEXT_FILE_EXTENSIONS.contains(&ext) {
        return Err(format!(
            "write_text_file only writes {TEXT_FILE_EXTENSIONS:?} files: {rel}"
        ));
    }
    note_join(vault, rel, &TEXT_FILE_EXTENSIONS)?;
    let mut n = 1;
    let actual = loop {
        let candidate = if n == 1 {
            rel.to_string()
        } else {
            format!("{stem}-{n}.{ext}")
        };
        if !vault.join(&candidate).exists() {
            break candidate;
        }
        n += 1;
    };
    write_file(&note_join(vault, &actual, &TEXT_FILE_EXTENSIONS)?, content)?;
    Ok(actual)
}

/// The one folder attachments live in.
///
/// Already excluded from the scanner (`scan.rs`), the watcher, and the folder
/// walker below, which is why a copied binary never surfaces as a note or
/// bounces back as a `vault-changed` event. Attachment writes are the first
/// thing that puts files there on purpose (M16.13c).
pub const ATTACHMENTS_DIR: &str = "attachments";

/// `report.pdf` → `attachments/report.pdf`, then `-2`, `-3`, …
///
/// Not `unique_rel_path`: that one hardcodes `.md`, and `report.pdf-2` is a
/// file the OS can no longer open. The dedupe goes on the STEM.
fn unique_attachment_path(vault: &Path, name: &str) -> String {
    // A leading dot is the whole name (".gitignore"), not an extension.
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s, format!(".{e}")),
        _ => (name, String::new()),
    };
    let mut n = 1;
    loop {
        let suffix = if n == 1 {
            String::new()
        } else {
            format!("-{n}")
        };
        let candidate = format!("{ATTACHMENTS_DIR}/{stem}{suffix}{ext}");
        if !vault.join(&candidate).exists() {
            return candidate;
        }
        n += 1;
    }
}

/// Copy a file from anywhere on disk into the vault's `attachments/` folder
/// and return its VAULT-RELATIVE path (M16.13c).
///
/// The destination folder is fixed here rather than taken from the caller.
/// A files field stores whatever string it is handed, so letting the frontend
/// choose would let a field drop a `.md` into a records folder, where the very
/// next scan would adopt it as a note — and `attachments/` is precisely the
/// one directory the scanner and the watcher already agree to ignore.
///
/// Removing a chip in the UI does NOT delete the copy. Dropping a reference is
/// not deleting a file, and in a files-first app the vault folder is the user's
/// to prune.
pub fn import_attachment(vault: &Path, source: &str) -> Result<String, String> {
    let src = Path::new(source);
    if !src.is_absolute() {
        return Err(format!("attachment source must be absolute: {source}"));
    }
    let meta = std::fs::metadata(src).map_err(|e| format!("{source}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("not a file: {source}"));
    }
    let name = src
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| format!("unusable file name: {source}"))?;
    safe_component("attachment name", name)?;
    let rel = unique_attachment_path(vault, name);
    let dest = safe_join(vault, &rel)?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::copy(src, &dest).map_err(|e| format!("{source}: {e}"))?;
    super::watcher::note_own_write(&dest);
    Ok(rel)
}

/// The exact bytes `create_note` will write for a frontmatter map and a body.
///
/// Split out because a guard has to read what LANDS ON DISK, not what was
/// typed into the `frontmatter` argument: an all-empty mapping serialises as
/// no YAML block at all, and then `body` is the whole file — so a body that
/// opens with its own `---` fence becomes the frontmatter the scanner reads
/// (PR #17 security review). Composing in one place is what keeps the guard
/// and the write from ever disagreeing about that.
pub fn compose_new_note(
    frontmatter: &serde_json::Map<String, serde_json::Value>,
    slug: &str,
    body: &str,
) -> Result<String, String> {
    let mut mapping = serde_yaml::Mapping::new();
    for (k, v) in frontmatter {
        if v.is_null() {
            continue;
        }
        mapping.insert(serde_yaml::Value::String(k.clone()), json_to_yaml(v));
    }
    let block = serialize_mapping(&mapping)?;
    let body = if body.trim().is_empty() {
        format!("# {}\n", parse::humanize_stem(slug))
    } else {
        body.to_string()
    };
    Ok(match block {
        Some(b) => format!("---\n{b}---\n\n{body}"),
        None => body,
    })
}

/// Create `<folder>/<slug>.md` (deduping to `-2`, `-3`, …) with the given
/// frontmatter and body; empty body gets a humanized `# Title` line.
/// Returns the vault-relative path.
pub fn create_note(
    vault: &Path,
    folder: &str,
    slug: &str,
    frontmatter: &serde_json::Map<String, serde_json::Value>,
    body: &str,
) -> Result<String, String> {
    safe_join(vault, folder)?; // folder must stay inside the vault
    safe_component("slug", slug)?;
    let rel = unique_rel_path(vault, folder, slug);
    // Judged on the file it will actually write (PLATFORM-API-1): the folder
    // can be a dot-folder (`.git/hooks`), a skipped one, or a symlink into
    // either, and the slug can make a dotfile.
    let target = note_join(vault, &rel, MARKDOWN)?;
    let content = compose_new_note(frontmatter, slug, body)?;
    write_file(&target, &content)?;
    shadow_write(vault, &rel, &content, "vault.write", None);
    Ok(rel)
}

/// Create or REPLACE a knowledge concept at an exact path (M6).
///
/// Unlike `create_note` this does not uniquify the filename: a concept has a
/// stable identity (its path is its OKF concept ID), so an agent revising one
/// must overwrite it rather than leave `churn-2.md` beside `churn.md`.
/// Intermediate directories are created — the agent organizes the bundle.
///
/// The concept write is a committed Belief transition and the file is its
/// byte-stable projection, written through the manifest-first protocol
/// (M23.3). Refuses with `ledger_writer_unavailable` when no ledger writer
/// is active (M49.1) — there is no file-first fallback.
pub fn write_concept(
    vault: &Path,
    rel: &str,
    frontmatter: &serde_json::Map<String, serde_json::Value>,
    body: &str,
) -> Result<(), String> {
    crate::ledger::concepts::write_concept(vault, rel, frontmatter, body)
}

/// `write_concept`, booked under the run that asked for it (M49.9).
pub fn write_concept_in_run(
    vault: &Path,
    rel: &str,
    frontmatter: &serde_json::Map<String, serde_json::Value>,
    body: &str,
    run: &str,
) -> Result<(), String> {
    crate::ledger::concepts::write_concept_in_run(vault, rel, frontmatter, body, run)
}

/// The exact-path writer behind `write_source`.
fn concept_write(
    vault: &Path,
    rel: &str,
    frontmatter: &serde_json::Map<String, serde_json::Value>,
    body: &str,
) -> Result<String, String> {
    // A cached source is a note like any other (PLATFORM-API-1), and the
    // frontend finds one by SCANNING for its path — a copy written where the
    // scan cannot see it reads as never fetched, forever.
    let target = note_join(vault, rel, MARKDOWN)?;
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{rel}: {e}"))?;
    }
    let mut mapping = serde_yaml::Mapping::new();
    for (k, v) in frontmatter {
        if v.is_null() {
            continue;
        }
        mapping.insert(serde_yaml::Value::String(k.clone()), json_to_yaml(v));
    }
    let block = serialize_mapping(&mapping)?;
    let body = body.trim_end();
    let content = match block {
        Some(b) => format!("---\n{b}---\n\n{body}\n"),
        None => format!("{body}\n"),
    };
    write_file(&target, &content)?;
    Ok(content)
}

/// Cached copies of fetched external material. Mirrors SOURCES_DIR in
/// src/engine/ingest.ts.
pub const SOURCES_DIR: &str = "sources";

/// Write a cached source doc. Same shape as `write_concept` but bounded to
/// `sources/`: the two folders are both machine-written, and letting one tool
/// write into the other's territory would make the boundary decorative.
pub fn write_source(
    vault: &Path,
    rel: &str,
    frontmatter: &serde_json::Map<String, serde_json::Value>,
    body: &str,
) -> Result<(), String> {
    if !(rel == SOURCES_DIR || rel.starts_with(&format!("{SOURCES_DIR}/"))) {
        return Err(format!(
            "cache_source only writes into {SOURCES_DIR}/; {rel} is outside it"
        ));
    }
    // A cached source is a vault write, not a knowledge event — the five
    // M21.8 kinds reserve knowledge.* for the bundle.
    let content = concept_write(vault, rel, frontmatter, body)?;
    shadow_write(vault, rel, &content, "vault.write", None);
    Ok(())
}

/// Does a concept already live at this path? Read BEFORE writing, so the log
/// can say whether the write created something or revised it.
pub fn concept_exists(vault: &Path, rel: &str) -> bool {
    safe_join(vault, rel).map(|p| p.is_file()).unwrap_or(false)
}

/// Append the write to `knowledge/log.md`, creating the log if it is absent.
pub fn append_knowledge_log(
    vault: &Path,
    rel: &str,
    title: &str,
    existed: bool,
) -> Result<(), String> {
    // M23.3: the log is a projection too — the append is a Belief body
    // revision and the file is regenerated. No writer, no append (M49.1).
    crate::ledger::concepts::append_log(vault, rel, title, existed)
}

/// Replace the H1 line that `parse::extract_h1_title` would read the title
/// from (fenced/indented code lines are never the H1), or prepend one when
/// the body has no real H1. Only the H1 line itself is spliced; every other
/// byte of the body (including CRLF line endings) is preserved.
fn replace_h1(body: &str, title: &str) -> String {
    let h1_line = format!("# {title}");
    match parse::first_h1_line_start(body) {
        Some(start) => {
            let rest = &body[start..];
            // End of the H1 text, excluding the line terminator (LF or CRLF).
            let end = match rest.find('\n') {
                Some(i) if rest[..i].ends_with('\r') => start + i - 1,
                Some(i) => start + i,
                None => body.len(),
            };
            format!("{}{h1_line}{}", &body[..start], &body[end..])
        }
        None => format!("{h1_line}\n\n{body}"),
    }
}

/// Replace the first H1 line of the body, or insert one as the first line.
pub fn set_note_title(vault: &Path, rel: &str, title: &str) -> Result<(), String> {
    // A .mmd's title IS its filename stem, and `# title` spliced into raw
    // mermaid source is a broken diagram (M29.21: the file tree already
    // declines to ask). Refused here, so no other caller can.
    if rel.ends_with(".mmd") {
        return Err(format!(
            "{rel}: a .mmd is raw diagram source, and its title is its filename — there is no H1 \
             to set"
        ));
    }
    let content = read_note_target(vault, rel, MARKDOWN)?;
    let (block, body) = parse::split_frontmatter(&content);
    let new_body = replace_h1(body, title);
    let composed = compose(block, &new_body);
    write_file(&note_join(vault, rel, MARKDOWN)?, &composed)?;
    shadow_write(vault, rel, &composed, "vault.write", None);
    Ok(())
}

fn collect_views_dir(
    vault: &Path,
    dir: &Path,
    project: Option<&str>,
    views: &mut Vec<ViewYaml>,
) -> Result<(), String> {
    if !dir.is_dir() {
        return Ok(());
    }
    for item in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let item = item.map_err(|e| e.to_string())?;
        let path = item.path();
        if path.extension().and_then(|e| e.to_str()) != Some("yml") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let yaml = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        views.push(ViewYaml {
            id: id.to_string(),
            yaml,
            project: project.map(str::to_string),
            // A legacy view has no Collection; it surfaces at the top level of
            // the sidebar rather than being force-fitted into one.
            collection: None,
            path: rel_path(vault, &path)?,
        });
    }
    Ok(())
}

/// Walk the vault the way the scanner does — skipping dot dirs, the legacy
/// `views/` dirs, and `attachments/`.
fn vault_walker(vault: &Path) -> impl Iterator<Item = walkdir::DirEntry> + '_ {
    walkdir::WalkDir::new(vault)
        .into_iter()
        .filter_entry(|e| {
            e.depth() == 0
                || e.file_type().is_file()
                || !{
                    let name = e.file_name().to_string_lossy();
                    name.starts_with('.') || name == "views" || name == "attachments"
                }
        })
        .filter_map(Result::ok)
}

/// Every Collection in the vault: each folder holding a `collection.yml`.
pub fn list_collections(vault: &Path) -> Result<Vec<CollectionYaml>, String> {
    let mut out = Vec::new();
    for item in vault_walker(vault) {
        if !item.file_type().is_file() || item.file_name().to_string_lossy() != COLLECTION_MARKER {
            continue;
        }
        let Some(dir) = item.path().parent() else {
            continue;
        };
        out.push(CollectionYaml {
            folder: rel_path(vault, dir)?,
            yaml: std::fs::read_to_string(item.path()).map_err(|e| e.to_string())?,
        });
    }
    out.sort_by(|a, b| a.folder.cmp(&b.folder));
    Ok(out)
}

/// The Collection a path belongs to: the nearest ANCESTOR folder holding a
/// `collection.yml`. Same containment rule projects already use, so a List in a
/// sub-folder belongs to the Collection above it without restating it.
/// True when this folder's own note declares it a Collection (M47.5).
///
/// `delivery/delivery.md` carrying `type: Collection` is what a
/// `collection.yml` used to be. Only the FOLDER NOTE speaks for its folder —
/// a page of that type sitting anywhere else describes nothing but itself.
fn declared_by_page(dir: &Path) -> bool {
    let Some(name) = dir.file_name() else {
        return false;
    };
    let note = dir.join(format!("{}.md", name.to_string_lossy()));
    let Ok(text) = std::fs::read_to_string(&note) else {
        return false;
    };
    // The scanner's own read of `type:`, because the app believes the scanner:
    // a hand-rolled line match missed CRLF, a BOM, a quoted value and a trailing
    // comment, calling the folder a Collection while its Lists came back at the
    // vault root. Frontmatter only — `type: Collection` in prose is prose.
    parse::declared_type(&text).as_deref() == Some("Collection")
}

fn collection_of(vault: &Path, file: &Path) -> Option<String> {
    let mut dir = file.parent();
    while let Some(current) = dir {
        // Either marker counts. A vault mid-conversion has both shapes in it,
        // and a List whose container declared itself with a PAGE must not be
        // reported as living at the vault root — the app would then look for
        // it under a collection it does not have and find nothing.
        if current.join(COLLECTION_MARKER).is_file() || declared_by_page(current) {
            return rel_path(vault, current).ok();
        }
        if current == vault {
            break;
        }
        dir = current.parent();
    }
    None
}

/// Every List in the vault, in all three on-disk shapes (see `ViewYaml`).
/// Sorted by (collection, project, id) so the sidebar order is stable.
pub fn list_views(vault: &Path) -> Result<Vec<ViewYaml>, String> {
    let mut views = Vec::new();
    collect_views_dir(vault, &vault.join("views"), None, &mut views)?;

    for item in vault_walker(vault) {
        if !item.file_type().is_file() {
            continue;
        }
        let name = item.file_name().to_string_lossy().to_string();

        // Legacy project-scoped views: a views/ dir next to any project.md.
        if name == "project.md" {
            let Some(project_dir) = item.path().parent() else {
                continue;
            };
            let rel_project = rel_path(vault, item.path())?;
            collect_views_dir(
                vault,
                &project_dir.join("views"),
                Some(&rel_project),
                &mut views,
            )?;
            continue;
        }

        // M10 Lists: `<name>.list.yml` anywhere.
        if let Some(id) = name.strip_suffix(LIST_SUFFIX) {
            if id.is_empty() {
                continue;
            }
            views.push(ViewYaml {
                id: id.to_string(),
                yaml: std::fs::read_to_string(item.path()).map_err(|e| e.to_string())?,
                project: None,
                collection: collection_of(vault, item.path()),
                path: rel_path(vault, item.path())?,
            });
        }
    }

    views.sort_by(|a, b| {
        a.collection
            .cmp(&b.collection)
            .then(a.project.cmp(&b.project))
            .then(a.id.cmp(&b.id))
    });
    Ok(views)
}

/// Write `<folder>/collection.yml`, creating the folder if needed. Passing ""
/// is rejected: the vault root is not a Collection.
pub fn save_collection(vault: &Path, folder: &str, yaml: &str) -> Result<(), String> {
    let dir = safe_join(vault, folder)?;
    write_file(&dir.join(COLLECTION_MARKER), yaml)?;
    let rel = format!("{folder}/{COLLECTION_MARKER}");
    shadow_write(vault, &rel, yaml, "vault.write", None);
    Ok(())
}

/// Write a List. `folder` empty means the vault root (a top-level List);
/// otherwise `<folder>/<id>.list.yml`.
pub fn save_list(vault: &Path, folder: &str, id: &str, yaml: &str) -> Result<(), String> {
    safe_component("list id", id)?;
    let base = if folder.is_empty() {
        vault.to_path_buf()
    } else {
        safe_join(vault, folder)?
    };
    write_file(&base.join(format!("{id}{LIST_SUFFIX}")), yaml)?;
    let rel = if folder.is_empty() {
        format!("{id}{LIST_SUFFIX}")
    } else {
        format!("{folder}/{id}{LIST_SUFFIX}")
    };
    shadow_write(vault, &rel, yaml, "vault.write", None);
    Ok(())
}

/// Write `<folder>/views/<id>.yml` verbatim (vault-root `views/` when folder
/// is None), creating the directory if needed. Legacy shape — kept so a vault
/// written before M10 can still be edited in place.
pub fn save_view(vault: &Path, id: &str, yaml: &str, folder: Option<&str>) -> Result<(), String> {
    safe_component("view id", id)?;
    let base = match folder {
        Some(f) => safe_join(vault, f)?,
        None => vault.to_path_buf(),
    };
    write_file(&base.join("views").join(format!("{id}.yml")), yaml)?;
    let rel = match folder {
        Some(f) => format!("{f}/views/{id}.yml"),
        None => format!("views/{id}.yml"),
    };
    shadow_write(vault, &rel, yaml, "vault.write", None);
    Ok(())
}

// --- Vault format v2 file operations (M2 Task 3) ---

/// Create a directory (and parents) inside the vault.
pub fn create_folder(vault: &Path, rel: &str) -> Result<(), String> {
    let abs = safe_join(vault, rel)?;
    std::fs::create_dir_all(&abs).map_err(|e| e.to_string())
}

/// Move a note — or a whole folder — within the vault. Refuses to clobber an
/// existing target. Both paths register as own-writes so the watcher doesn't
/// bounce our move back as external changes.
pub fn rename_note(vault: &Path, from: &str, to: &str) -> Result<(), String> {
    let src = safe_join(vault, from)?;
    let dst = safe_join(vault, to)?;
    if dst.exists() {
        return Err(format!("target already exists: {to}"));
    }
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&src, &dst).map_err(|e| format!("{from}: {e}"))?;
    super::watcher::note_own_write(&src);
    super::watcher::note_own_write(&dst);
    crate::runtime::vault_writes::record(vault, "vault.rename", from, Some(to), None, None);
    Ok(())
}

/// Move a note or folder to the OS trash — user markdown is never
/// hard-deleted.
pub fn delete_note(vault: &Path, rel: &str) -> Result<(), String> {
    let abs = safe_join(vault, rel)?;
    if !abs.exists() {
        return Err(format!("not found: {rel}"));
    }
    trash::delete(&abs).map_err(|e| e.to_string())?;
    super::watcher::note_own_write(&abs);
    crate::runtime::vault_writes::record(vault, "vault.delete", rel, None, None, None);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::testutil;

    const NOTE: &str = "---\ntype: Work item\nkey: ATL-1\nstatus: todo\ncustom_field: kept\n---\n\n# Ship the scanner\n\nBody stays.\n";

    fn vault_with_note(label: &str) -> std::path::PathBuf {
        let vault = testutil::temp_vault(label);
        testutil::write(&vault, "items/atl-1.md", NOTE);
        vault
    }

    fn read(vault: &Path, rel: &str) -> String {
        std::fs::read_to_string(vault.join(rel)).unwrap()
    }

    fn patch(pairs: &[(&str, serde_json::Value)]) -> serde_json::Map<String, serde_json::Value> {
        pairs
            .iter()
            .cloned()
            .map(|(k, v)| (k.to_string(), v))
            .collect()
    }

    #[test]
    fn update_preserves_order_and_unknown_keys_byte_for_byte() {
        let vault = vault_with_note("wfm-update");
        update_frontmatter(
            &vault,
            "items/atl-1.md",
            &patch(&[("status", serde_json::json!("done"))]),
        )
        .unwrap();
        assert_eq!(
            read(&vault, "items/atl-1.md"),
            "---\ntype: Work item\nkey: ATL-1\nstatus: done\ncustom_field: kept\n---\n\n# Ship the scanner\n\nBody stays.\n"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn null_patch_value_deletes_the_key_preserving_order() {
        let vault = vault_with_note("wfm-delete");
        update_frontmatter(
            &vault,
            "items/atl-1.md",
            &patch(&[("key", serde_json::Value::Null)]),
        )
        .unwrap();
        assert_eq!(
            read(&vault, "items/atl-1.md"),
            "---\ntype: Work item\nstatus: todo\ncustom_field: kept\n---\n\n# Ship the scanner\n\nBody stays.\n"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn new_keys_are_appended_at_the_end() {
        let vault = vault_with_note("wfm-append");
        update_frontmatter(
            &vault,
            "items/atl-1.md",
            &patch(&[("due", serde_json::json!("2026-08-01"))]),
        )
        .unwrap();
        let raw = read(&vault, "items/atl-1.md");
        assert!(
            raw.contains("custom_field: kept\ndue: 2026-08-01\n---\n"),
            "{raw}"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    // split_frontmatter's byte-reproduction invariant only holds for LF-only,
    // BOM-free files with a bare `---` closing fence (parse.rs:9-15). Writes
    // may normalize fences to LF form but must never corrupt such files.
    #[test]
    fn update_normalizes_crlf_fences_without_corrupting_the_file() {
        let vault = testutil::temp_vault("wfm-crlf");
        testutil::write(
            &vault,
            "items/crlf.md",
            "---\r\ntype: Work item\r\nstatus: todo\r\n---\r\n\r\n# Crlf note\r\n\r\nBody stays.\r\n",
        );
        update_frontmatter(
            &vault,
            "items/crlf.md",
            &patch(&[("status", serde_json::json!("done"))]),
        )
        .unwrap();
        let raw = read(&vault, "items/crlf.md");
        // No duplicated or dropped fences.
        assert_eq!(raw.matches("---").count(), 2, "{raw}");
        // Frontmatter survives the patch (fences may be normalized to LF).
        let (block, body) = parse::split_frontmatter(&raw);
        let mapping = parse::parse_frontmatter(block.expect("frontmatter kept")).unwrap();
        assert_eq!(
            mapping.get("type").and_then(|v| v.as_str()),
            Some("Work item")
        );
        assert_eq!(mapping.get("status").and_then(|v| v.as_str()), Some("done"));
        // Body is untouched.
        assert_eq!(body, "\r\n# Crlf note\r\n\r\nBody stays.\r\n");
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn save_note_replaces_body_and_keeps_frontmatter_bytes() {
        let vault = vault_with_note("wfm-save");
        save_note(
            &vault,
            "items/atl-1.md",
            "\n# Ship the scanner\n\nNew body.\n",
        )
        .unwrap();
        assert_eq!(
            read(&vault, "items/atl-1.md"),
            "---\ntype: Work item\nkey: ATL-1\nstatus: todo\ncustom_field: kept\n---\n\n# Ship the scanner\n\nNew body.\n"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn read_note_returns_body_only() {
        let vault = vault_with_note("wfm-read");
        assert_eq!(
            read_note(&vault, "items/atl-1.md").unwrap(),
            "\n# Ship the scanner\n\nBody stays.\n"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    // M29.20: the raw round-trip. A .mmd whose first bytes are mermaid's own
    // `---` config header must survive read→save byte-identically — the note
    // pipeline would strip that header as frontmatter and destroy the file.
    #[test]
    fn mmd_round_trips_raw_through_read_and_save() {
        const MMD: &str =
            "---\ntitle: Pipeline\nconfig:\n  layout: elk\n---\nflowchart TD\n  A --> B\n";
        let vault = testutil::temp_vault("wfm-mmd-raw");
        testutil::write(&vault, "diagrams/pipeline.mmd", MMD);
        let read_back = read_note(&vault, "diagrams/pipeline.mmd").unwrap();
        assert_eq!(read_back, MMD);
        save_note(&vault, "diagrams/pipeline.mmd", &read_back).unwrap();
        assert_eq!(read(&vault, "diagrams/pipeline.mmd"), MMD);
        // Saving edited source writes exactly those bytes, header included.
        let edited = format!("{MMD}  B --> C\n");
        save_note(&vault, "diagrams/pipeline.mmd", &edited).unwrap();
        assert_eq!(read(&vault, "diagrams/pipeline.mmd"), edited);
        // Same contract as .md: save only overwrites an existing file.
        assert!(save_note(&vault, "diagrams/nope.mmd", "flowchart TD\n").is_err());
        let _ = std::fs::remove_dir_all(&vault);
    }

    // The other doors stay shut too (M29.23): mermaid's config header IS
    // valid YAML, so without these guards a frontmatter patch — including the
    // agent's MCP update_frontmatter — would merge into it and reserialize.
    #[test]
    fn mmd_refuses_frontmatter_updates_and_reads_as_untyped() {
        const MMD: &str = "---\ntype: Should never surface\nconfig:\n  layout: elk\n---\nflowchart TD\n  A --> B\n";
        let vault = testutil::temp_vault("wfm-mmd-doors");
        testutil::write(&vault, "diagrams/pipeline.mmd", MMD);
        let err = update_frontmatter(
            &vault,
            "diagrams/pipeline.mmd",
            &patch(&[("status", serde_json::json!("done"))]),
        )
        .unwrap_err();
        assert!(err.contains("no frontmatter"), "{err}");
        // The file is byte-identical — the refusal happened before any write.
        assert_eq!(read(&vault, "diagrams/pipeline.mmd"), MMD);
        // The header's `type:` key is diagram data, never vault schema.
        assert_eq!(note_type(&vault, "diagrams/pipeline.mmd"), None);
        let _ = std::fs::remove_dir_all(&vault);
    }

    // --- write_text_file (M29.22) -------------------------------------------

    #[test]
    fn write_text_file_writes_mmd_and_dedupes_the_stem() {
        let vault = testutil::temp_vault("wfm-textfile");
        let first = write_text_file(&vault, "diagrams/flowchart.mmd", "flowchart TD\n").unwrap();
        let second = write_text_file(&vault, "diagrams/flowchart.mmd", "graph LR\n").unwrap();
        assert_eq!(first, "diagrams/flowchart.mmd");
        assert_eq!(second, "diagrams/flowchart-2.mmd");
        // Neither clobbered the other, and the bytes are verbatim.
        assert_eq!(read(&vault, "diagrams/flowchart.mmd"), "flowchart TD\n");
        assert_eq!(read(&vault, "diagrams/flowchart-2.mmd"), "graph LR\n");
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn write_text_file_rejects_disallowed_extensions_knowledge_and_escapes() {
        let vault = testutil::temp_vault("wfm-textfile-guard");
        // A raw writer aimed at .md would bypass the whole note pipeline.
        assert!(write_text_file(&vault, "notes/evil.md", "# hi\n").is_err());
        assert!(write_text_file(&vault, "notes/evil.sh", "rm -rf\n").is_err());
        assert!(write_text_file(&vault, "notes/no-extension", "x\n").is_err());
        // The bundle is the agent's to write — same guard as every human door.
        assert!(write_text_file(&vault, "knowledge/concept.mmd", "graph TD\n").is_err());
        // Containment, same as every other write.
        assert!(write_text_file(&vault, "../outside.mmd", "graph TD\n").is_err());
        assert!(write_text_file(&vault, "/tmp/abs.mmd", "graph TD\n").is_err());
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn create_note_writes_frontmatter_and_dedupes_slug() {
        let vault = testutil::temp_vault("wfm-create");
        let fm = patch(&[
            ("type", serde_json::json!("Work item")),
            ("status", serde_json::json!("todo")),
        ]);
        let first = create_note(&vault, "items", "new-item", &fm, "# New item\n").unwrap();
        let second = create_note(&vault, "items", "new-item", &fm, "# New item\n").unwrap();
        let third = create_note(&vault, "items", "new-item", &fm, "# New item\n").unwrap();
        assert_eq!(first, "items/new-item.md");
        assert_eq!(second, "items/new-item-2.md");
        assert_eq!(third, "items/new-item-3.md");
        assert_eq!(
            read(&vault, "items/new-item.md"),
            "---\ntype: Work item\nstatus: todo\n---\n\n# New item\n"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn create_note_with_empty_body_gets_default_h1() {
        let vault = testutil::temp_vault("wfm-create-empty");
        create_note(&vault, "items", "empty-note", &patch(&[]), "").unwrap();
        // Sentence case per humanize_stem (mockParse.ts parity).
        assert_eq!(read(&vault, "items/empty-note.md"), "# Empty note\n");
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn set_note_title_replaces_existing_h1() {
        let vault = vault_with_note("wfm-title");
        set_note_title(&vault, "items/atl-1.md", "Renamed item").unwrap();
        assert_eq!(
            read(&vault, "items/atl-1.md"),
            "---\ntype: Work item\nkey: ATL-1\nstatus: todo\ncustom_field: kept\n---\n\n# Renamed item\n\nBody stays.\n"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn set_note_title_inserts_h1_when_missing() {
        let vault = testutil::temp_vault("wfm-title-insert");
        testutil::write(&vault, "items/no-title.md", "Just prose.\n");
        set_note_title(&vault, "items/no-title.md", "Now titled").unwrap();
        assert_eq!(
            read(&vault, "items/no-title.md"),
            "# Now titled\n\nJust prose.\n"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    // set_note_title must agree with parse::extract_h1_title about which line
    // is the H1: fenced/indented code lines are never the title.
    #[test]
    fn set_note_title_skips_h1_inside_code_fences() {
        let vault = testutil::temp_vault("wfm-title-fence");
        testutil::write(
            &vault,
            "items/fenced.md",
            "---\ntype: Work item\n---\n\nintro\n\n```bash\n# a comment in code\necho hi\n```\n\n# Real title\n\nBody stays.\n",
        );
        set_note_title(&vault, "items/fenced.md", "Renamed").unwrap();
        assert_eq!(
            read(&vault, "items/fenced.md"),
            "---\ntype: Work item\n---\n\nintro\n\n```bash\n# a comment in code\necho hi\n```\n\n# Renamed\n\nBody stays.\n"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn set_note_title_prepends_h1_when_only_fenced_h1_exists() {
        let vault = testutil::temp_vault("wfm-title-fence-only");
        testutil::write(&vault, "items/code.md", "```\n# only in code\n```\n");
        set_note_title(&vault, "items/code.md", "Now titled").unwrap();
        assert_eq!(
            read(&vault, "items/code.md"),
            "# Now titled\n\n```\n# only in code\n```\n"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn set_note_title_preserves_crlf_body_bytes_outside_the_h1_line() {
        let vault = testutil::temp_vault("wfm-title-crlf");
        testutil::write(
            &vault,
            "items/crlf-title.md",
            "# Old title\r\n\r\nBody stays.\r\n",
        );
        set_note_title(&vault, "items/crlf-title.md", "New title").unwrap();
        assert_eq!(
            read(&vault, "items/crlf-title.md"),
            "# New title\r\n\r\nBody stays.\r\n"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_list_belongs_to_the_collection_its_folder_note_declares() {
        // M47.5. A container used to be a folder holding `collection.yml`; it
        // is a folder whose own PAGE says `type: Collection` now. A List in
        // such a folder must report that folder as its collection — reported
        // as root-level, the app looks for it under a collection it does not
        // have and renders "This list no longer exists" on a list it just
        // created. Found exactly that way, on a freshly converted vault.
        let vault = testutil::temp_vault("wfm-collection-page");
        std::fs::create_dir_all(vault.join("delivery")).unwrap();
        std::fs::write(
            vault.join("delivery/delivery.md"),
            "---\ntype: Collection\nicon: rocket\n---\n\n# Delivery\n",
        )
        .unwrap();
        std::fs::write(
            vault.join("delivery/smoke.list.yml"),
            "name: Smoke\npresentation:\n  type: table\n",
        )
        .unwrap();

        let views = list_views(&vault).unwrap();
        assert_eq!(views.len(), 1);
        assert_eq!(views[0].collection.as_deref(), Some("delivery"));
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_page_of_that_type_elsewhere_does_not_declare_a_collection() {
        // Only the FOLDER NOTE speaks for its folder. A page merely carrying
        // the type would otherwise let any file rename a container it is not
        // even in.
        let vault = testutil::temp_vault("wfm-collection-stray");
        std::fs::create_dir_all(vault.join("inbox")).unwrap();
        std::fs::write(
            vault.join("inbox/delivery.md"),
            "---\ntype: Collection\n---\n\n# Delivery\n",
        )
        .unwrap();
        std::fs::write(vault.join("inbox/smoke.list.yml"), "name: Smoke\n").unwrap();

        let views = list_views(&vault).unwrap();
        assert_eq!(views.len(), 1);
        assert_eq!(views[0].collection, None);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_folder_note_declares_a_collection_exactly_when_the_scanner_types_it_one() {
        // M48.7. A hand-rolled `---\n` + `type: Collection` line match
        // disagreed with the scanner, and the app reads the scanner: it called
        // the first four folders Collections while their Lists came back at
        // the vault root. Parity cases: mockIpc.test.ts.
        let vault = testutil::temp_vault("wfm-collection-shapes");
        let shapes = [
            (
                "crlf",
                "---\r\ntype: Collection\r\n---\r\n\r\n# Crlf\r\n",
                true,
            ),
            ("bom", "\u{feff}---\ntype: Collection\n---\n\n# Bom\n", true),
            (
                "quoted",
                "---\ntype: \"Collection\"\n---\n\n# Quoted\n",
                true,
            ),
            (
                "commented",
                "---\ntype: Collection # container\n---\n\n# C\n",
                true,
            ),
            (
                "prose",
                "---\ntitle: Prose\n---\n\ntype: Collection\n",
                false,
            ),
            (
                "nested",
                "---\nmeta:\n  type: Collection\n---\n\n# Nested\n",
                false,
            ),
        ];
        for (folder, note, _) in shapes {
            std::fs::create_dir_all(vault.join(folder)).unwrap();
            std::fs::write(vault.join(format!("{folder}/{folder}.md")), note).unwrap();
            std::fs::write(
                vault.join(format!("{folder}/{folder}.list.yml")),
                "name: L\n",
            )
            .unwrap();
        }

        let views = list_views(&vault).unwrap();
        assert_eq!(views.len(), shapes.len());
        for (folder, _, declares) in shapes {
            let view = views.iter().find(|v| v.id == folder).unwrap();
            let expected = declares.then_some(folder);
            assert_eq!(view.collection.as_deref(), expected, "{folder}");
        }
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn views_round_trip_as_raw_yaml() {
        let vault = testutil::temp_vault("wfm-views");
        assert!(list_views(&vault).unwrap().is_empty());
        save_view(
            &vault,
            "all-items",
            "name: All items\npresentation:\n  type: list\n",
            None,
        )
        .unwrap();
        save_view(&vault, "board", "name: Board\n", None).unwrap();
        let views = list_views(&vault).unwrap();
        assert_eq!(views.len(), 2);
        assert_eq!(views[0].id, "all-items");
        assert_eq!(
            views[0].yaml,
            "name: All items\npresentation:\n  type: list\n"
        );
        assert_eq!(views[0].project, None);
        assert_eq!(views[1].id, "board");
        let _ = std::fs::remove_dir_all(&vault);
    }

    // --- M10 Collections ---------------------------------------------------

    #[test]
    fn collections_are_folders_holding_a_marker() {
        let vault = testutil::temp_vault("wfm-collections");
        assert!(list_collections(&vault).unwrap().is_empty());
        save_collection(&vault, "product", "name: Product\nicon: package\n").unwrap();
        save_collection(&vault, "ops", "name: Ops\n").unwrap();
        // A nested Collection is legal — a Collection is just a marked folder.
        save_collection(&vault, "product/platform", "name: Platform\n").unwrap();

        let found = list_collections(&vault).unwrap();
        assert_eq!(
            found.iter().map(|c| c.folder.as_str()).collect::<Vec<_>>(),
            vec!["ops", "product", "product/platform"],
        );
        assert_eq!(found[1].yaml, "name: Product\nicon: package\n");
        assert!(vault.join("product/collection.yml").is_file());
        // Containment is enforced here, not in the caller.
        assert!(save_collection(&vault, "../outside", "name: E\n").is_err());
        assert!(save_collection(&vault, "", "name: E\n").is_err());
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn lists_belong_to_the_nearest_ancestor_collection() {
        let vault = testutil::temp_vault("wfm-lists");
        save_collection(&vault, "product", "name: Product\n").unwrap();
        save_list(&vault, "product", "roadmap", "name: Roadmap\n").unwrap();
        // A List in a plain sub-FOLDER still belongs to the Collection above
        // it — same containment rule projects already use.
        save_list(&vault, "product/q3", "risks", "name: Risks\n").unwrap();
        // A top-level List has no Collection rather than being force-fitted.
        save_list(&vault, "", "inbox-triage", "name: Triage\n").unwrap();

        let lists = list_views(&vault).unwrap();
        let by_id = |id: &str| lists.iter().find(|l| l.id == id).unwrap().clone();
        assert_eq!(by_id("roadmap").collection.as_deref(), Some("product"));
        assert_eq!(by_id("risks").collection.as_deref(), Some("product"));
        assert_eq!(by_id("inbox-triage").collection, None);
        assert_eq!(by_id("roadmap").path, "product/roadmap.list.yml");
        assert_eq!(by_id("risks").path, "product/q3/risks.list.yml");
        assert_eq!(by_id("inbox-triage").path, "inbox-triage.list.yml");
        assert!(save_list(&vault, "../outside", "evil", "name: E\n").is_err());
        assert!(save_list(&vault, "product", "sub/dir", "name: E\n").is_err());
        let _ = std::fs::remove_dir_all(&vault);
    }

    // The migration guarantee: a vault written before M10 keeps working, with
    // its legacy views surfacing as top-level Lists. Nothing has to move.
    #[test]
    fn legacy_views_load_beside_m10_lists() {
        let vault = testutil::temp_vault("wfm-legacy-lists");
        testutil::write(
            &vault,
            "projects/atlas/project.md",
            "---\ntype: Project\n---\n\n# Atlas\n",
        );
        save_view(&vault, "old-global", "name: Old global\n", None).unwrap();
        save_view(
            &vault,
            "old-scoped",
            "name: Old scoped\n",
            Some("projects/atlas"),
        )
        .unwrap();
        save_collection(&vault, "product", "name: Product\n").unwrap();
        save_list(&vault, "product", "roadmap", "name: Roadmap\n").unwrap();

        let lists = list_views(&vault).unwrap();
        assert_eq!(lists.len(), 3);
        let by_id = |id: &str| lists.iter().find(|l| l.id == id).unwrap().clone();
        // Legacy views carry no collection, so they list at the top level.
        assert_eq!(by_id("old-global").collection, None);
        assert_eq!(by_id("old-global").path, "views/old-global.yml");
        assert_eq!(
            by_id("old-scoped").project.as_deref(),
            Some("projects/atlas/project.md")
        );
        assert_eq!(by_id("roadmap").collection.as_deref(), Some("product"));
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn a_bare_list_suffix_is_not_a_list() {
        let vault = testutil::temp_vault("wfm-bare-list");
        // `.list.yml` with no name would produce an empty id, which is not a
        // thing the UI can navigate to or the writer can round-trip.
        testutil::write(&vault, ".list.yml", "name: Nameless\n");
        testutil::write(&vault, "notes.yml", "name: Not a list\n");
        assert!(list_views(&vault).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&vault);
    }

    // M2 Task 6: views/ dirs inside project folders are project-scoped.
    #[test]
    fn project_views_carry_their_project_and_sort_after_globals() {
        let vault = testutil::temp_vault("wfm-project-views");
        testutil::write(
            &vault,
            "projects/atlas/project.md",
            "---\ntype: Project\n---\n\n# Atlas\n",
        );
        save_view(&vault, "global", "name: Global\n", None).unwrap();
        save_view(
            &vault,
            "delivery",
            "name: Delivery\n",
            Some("projects/atlas"),
        )
        .unwrap();
        let views = list_views(&vault).unwrap();
        assert_eq!(views.len(), 2);
        assert_eq!(views[0].id, "global");
        assert_eq!(views[0].project, None);
        assert_eq!(views[1].id, "delivery");
        assert_eq!(
            views[1].project.as_deref(),
            Some("projects/atlas/project.md")
        );
        assert!(vault.join("projects/atlas/views/delivery.yml").is_file());
        // Escaping folders are rejected.
        assert!(save_view(&vault, "evil", "name: E\n", Some("../outside")).is_err());
        let _ = std::fs::remove_dir_all(&vault);
    }

    // Containment: rel paths, folders, slugs, and view ids reach Tauri IPC
    // unchanged (Task 7), so escapes must be rejected here.
    #[test]
    fn writes_reject_paths_that_escape_the_vault() {
        let vault = vault_with_note("wfm-escape");
        // A real file one level above the vault root: without containment,
        // "../<name>" reaches and modifies it.
        let victim = vault
            .parent()
            .unwrap()
            .join(format!("cerebro-victim-{}.md", std::process::id()));
        const VICTIM: &str = "---\nsafe: true\n---\nUntouched.\n";
        std::fs::write(&victim, VICTIM).unwrap();
        let victim_rel = format!("../{}", victim.file_name().unwrap().to_str().unwrap());
        let hacked = patch(&[("hacked", serde_json::json!(true))]);

        assert!(update_frontmatter(&vault, &victim_rel, &hacked).is_err());
        assert!(save_note(&vault, &victim_rel, "hacked\n").is_err());
        assert!(set_note_title(&vault, &victim_rel, "Hacked").is_err());
        assert!(read_note(&vault, &victim_rel).is_err());
        // Absolute paths must be rejected too: Path::join replaces the base.
        let abs = victim.to_str().unwrap();
        assert!(update_frontmatter(&vault, abs, &hacked).is_err());
        assert!(read_note(&vault, abs).is_err());
        // Traversal buried mid-path is still traversal.
        assert!(read_note(&vault, "items/../../x.md").is_err());

        assert_eq!(std::fs::read_to_string(&victim).unwrap(), VICTIM);
        let _ = std::fs::remove_file(&victim);
        let _ = std::fs::remove_dir_all(&vault);
    }

    // A component-only check (Task 7's `../` rejection) cannot see that a
    // perfectly normal-looking name resolves somewhere else on disk. This is
    // the M1 gap: a symlink planted inside the vault made every containment
    // check upstream of the filesystem call vacuously true.
    #[test]
    fn writes_reject_paths_through_a_symlink_that_escapes_the_vault() {
        let vault = vault_with_note("wfm-symlink-escape");
        let victim = vault
            .parent()
            .unwrap()
            .join(format!("cerebro-symlink-victim-{}.md", std::process::id()));
        const VICTIM: &str = "---\nsafe: true\n---\nUntouched.\n";
        std::fs::write(&victim, VICTIM).unwrap();

        // A symlink INSIDE the vault whose own name has no `..` and isn't
        // absolute, so it sails through the component check — but it
        // resolves outside the vault root.
        let link_rel = "link.md";
        std::os::unix::fs::symlink(&victim, vault.join(link_rel)).unwrap();

        let hacked = patch(&[("hacked", serde_json::json!(true))]);
        assert!(update_frontmatter(&vault, link_rel, &hacked).is_err());
        assert!(save_note(&vault, link_rel, "hacked\n").is_err());
        assert!(set_note_title(&vault, link_rel, "Hacked").is_err());
        assert!(read_note(&vault, link_rel).is_err());

        // Same attack one directory down: the escaping symlink is an
        // intermediate component, not the leaf, and the leaf itself does
        // not exist yet.
        let escape_dir_rel = "escape";
        std::os::unix::fs::symlink(vault.parent().unwrap(), vault.join(escape_dir_rel)).unwrap();
        let nested_rel = format!("{escape_dir_rel}/new-file.md");
        assert!(save_note(&vault, &nested_rel, "hacked\n").is_err());
        assert!(read_note(&vault, &nested_rel).is_err());

        assert_eq!(std::fs::read_to_string(&victim).unwrap(), VICTIM);
        let _ = std::fs::remove_file(&victim);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn create_note_rejects_escaping_folder_and_non_component_slug() {
        let vault = testutil::temp_vault("wfm-create-escape");
        let fm = patch(&[]);
        assert!(create_note(&vault, "../escaped", "note", &fm, "x\n").is_err());
        assert!(create_note(&vault, "/tmp", "note", &fm, "x\n").is_err());
        assert!(create_note(&vault, "items", "../sneaky", &fm, "x\n").is_err());
        assert!(create_note(&vault, "items", "a/../b", &fm, "x\n").is_err());
        assert!(create_note(&vault, "items", "a/b", &fm, "x\n").is_err());
        assert!(create_note(&vault, "items", "", &fm, "x\n").is_err());
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn save_view_rejects_non_component_ids() {
        let vault = testutil::temp_vault("wfm-view-escape");
        assert!(save_view(&vault, "../../evil-view", "name: Evil\n", None).is_err());
        assert!(save_view(&vault, "nested/id", "name: Evil\n", None).is_err());
        assert!(save_view(&vault, "", "name: Evil\n", None).is_err());
        let _ = std::fs::remove_dir_all(&vault);
    }

    // --- Note targets (PLATFORM-API-1) -----------------------------------

    /// Every regular file under `vault`, dot-folders included, with its bytes:
    /// what "a refusal changed nothing" means. Symlinks are not followed, so
    /// a write carried through one shows up at the file it reached.
    fn snapshot(vault: &Path) -> std::collections::BTreeMap<std::path::PathBuf, Vec<u8>> {
        walkdir::WalkDir::new(vault)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|e| e.file_type().is_file())
            .map(|e| (e.path().to_path_buf(), std::fs::read(e.path()).unwrap()))
            .collect()
    }

    /// The cases src/lib/mockIpc.test.ts replays through the mock's doors.
    const NOTE_TARGETS: &str = include_str!("../../fixtures/note-targets.json");

    // The parity half: every note door here and its mock twin answer every
    // shared case alike — the agent's `.git/config` and ledger segment, the
    // upper-case spellings APFS folds onto them, the files an append or a
    // patch would corrupt — and a refusal leaves every byte where it was.
    #[test]
    fn note_targets_replay_the_shared_cases() {
        let file: serde_json::Value =
            serde_json::from_str(NOTE_TARGETS).expect("note-targets.json parses");
        let seed = file["seed"].as_str().expect("a seed");
        for case in file["cases"].as_array().expect("cases") {
            let vault = testutil::temp_vault("wfm-note-targets");
            let door = case["door"].as_str().expect("a door");
            let path = case["path"].as_str().unwrap_or_default();
            let edits = matches!(door, "save_note" | "update_frontmatter" | "set_note_title");
            if edits && case["seed"] != serde_json::json!(false) {
                testutil::write(&vault, path, seed);
            }
            let before = snapshot(&vault);
            let outcome = match door {
                "save_note" => save_note(&vault, path, "\n# Landed\n").map(|()| path.to_string()),
                "update_frontmatter" => update_frontmatter(
                    &vault,
                    path,
                    &patch(&[("status", serde_json::json!("done"))]),
                )
                .map(|()| path.to_string()),
                "set_note_title" => {
                    set_note_title(&vault, path, "Landed").map(|()| path.to_string())
                }
                "create_note" => create_note(
                    &vault,
                    case["folder"].as_str().expect("a folder"),
                    case["slug"].as_str().expect("a slug"),
                    &patch(&[]),
                    "# Landed\n",
                ),
                "write_text_file" => write_text_file(&vault, path, "flowchart TD\n"),
                other => panic!("no door called {other}"),
            };
            match (case["refused"].as_str(), case["lands"].as_str()) {
                (Some(fragment), None) => {
                    let err = outcome.expect_err(&format!("{case} must refuse"));
                    assert!(err.contains(fragment), "{case}: {err}");
                    assert_eq!(
                        snapshot(&vault),
                        before,
                        "{case}: the refusal changed bytes"
                    );
                }
                (None, Some(expected)) => {
                    let landed = outcome.unwrap_or_else(|e| panic!("{case} must land: {e}"));
                    assert_eq!(landed, expected, "{case}");
                    assert_ne!(snapshot(&vault), before, "{case}: nothing was written");
                }
                _ => panic!("{case} must name exactly one of `refused` and `lands`"),
            }
            let _ = std::fs::remove_dir_all(&vault);
        }
    }

    // Containment waves a symlink through when it points INSIDE the vault,
    // and `.git/` is inside the vault. So the note writers judge where a path
    // LANDS: an innocent name cannot carry a write into `.git/`.
    #[cfg(unix)]
    #[test]
    fn a_symlink_cannot_carry_a_note_write_into_git() {
        const GIT_CONFIG: &str = "[core]\n\trepositoryformatversion = 0\n";
        let vault = testutil::temp_vault("wfm-symlink-git");
        testutil::write(&vault, ".git/config", GIT_CONFIG);
        // Note-shaped, so only the landing can tell where it is.
        testutil::write(&vault, ".git/notes.md", NOTE);
        testutil::write(&vault, "records/real.md", NOTE);
        std::os::unix::fs::symlink(vault.join(".git"), vault.join("docs")).unwrap();
        std::os::unix::fs::symlink(vault.join(".git/config"), vault.join("records/config.md"))
            .unwrap();
        // Containment alone passes both: each resolves inside the vault.
        assert!(safe_join(&vault, "docs/notes.md").is_ok());
        assert!(safe_join(&vault, "records/config.md").is_ok());

        let before = snapshot(&vault);
        let hacked = patch(&[("hacked", serde_json::json!(true))]);
        let err = save_note(&vault, "docs/notes.md", "hacked\n").unwrap_err();
        assert!(err.contains("resolves to .git/notes.md"), "{err}");
        assert!(update_frontmatter(&vault, "docs/notes.md", &hacked).is_err());
        assert!(set_note_title(&vault, "docs/notes.md", "Hacked").is_err());
        assert!(appended_body(&vault, "docs/notes.md", "hacked").is_err());
        // A folder that does not exist yet still lands under the link.
        let err = create_note(&vault, "docs/hooks", "pre-commit", &hacked, "x\n").unwrap_err();
        assert!(
            err.contains("resolves to .git/hooks/pre-commit.md"),
            "{err}"
        );
        assert!(create_note(&vault, "docs", "x", &hacked, "x\n").is_err());
        assert!(write_text_file(&vault, "docs/x.mmd", "graph TD\n").is_err());
        // A leaf link whose own name is a note.
        let err = update_frontmatter(&vault, "records/config.md", &hacked).unwrap_err();
        assert!(err.contains("resolves to .git/config"), "{err}");
        assert!(save_note(&vault, "records/config.md", "hacked\n").is_err());
        assert!(appended_body(&vault, "records/config.md", "hacked").is_err());

        // Every byte where it was, nothing new under .git, the link a link.
        assert_eq!(snapshot(&vault), before);
        assert!(std::fs::symlink_metadata(vault.join("records/config.md"))
            .unwrap()
            .file_type()
            .is_symlink());
        // And an ordinary note beside them still lands.
        save_note(&vault, "records/real.md", "\n# Real\n").unwrap();
        let _ = std::fs::remove_dir_all(&vault);
    }

    // The disk the app ships for folds case — Unicode case, not just ASCII —
    // and `realpath` answers with the stored name, so a folded spelling is
    // judged by where it LANDS: `view` + U+017F LONG S is `views`, and
    // U+212A KELVIN SIGN + `nowledge` is the bundle, under a spelling
    // `knowledge::canonical_path` (ASCII folding) does not recognise — which
    // would walk straight past every bundle guard keyed off that name.
    #[test]
    fn a_folded_spelling_cannot_reach_a_skipped_folder_or_the_bundle() {
        let vault = testutil::temp_vault("wfm-folding");
        testutil::write(&vault, "views/x.yml", "name: X\n");
        testutil::write(&vault, "knowledge/metrics/churn.md", NOTE);
        if !vault.join("VIEWS").exists() {
            // A case-sensitive volume (CI's ext4): these spellings name new,
            // unrelated folders there, so there is nothing to reach.
            let _ = std::fs::remove_dir_all(&vault);
            return;
        }
        let kelvin = "\u{212a}nowledge/metrics/churn.md";
        assert!(crate::knowledge::canonical_path(kelvin).is_none());

        let before = snapshot(&vault);
        let err = create_note(&vault, "view\u{17f}", "x", &patch(&[]), "# X\n").unwrap_err();
        assert!(err.contains("resolves to views/x.md"), "{err}");
        // Plain ASCII case too: the scanner skips exactly `views/`, and this
        // `Views/` IS that folder here, so it lands there and refuses.
        let err = create_note(&vault, "Views", "x", &patch(&[]), "# X\n").unwrap_err();
        assert!(err.contains("resolves to views/x.md"), "{err}");
        let stamp = patch(&[("verified", serde_json::json!({ "by": "human:josef" }))]);
        let err = update_frontmatter(&vault, kelvin, &stamp).unwrap_err();
        assert!(err.contains("inside knowledge/"), "{err}");
        assert!(save_note(&vault, kelvin, "\n# Rewritten\n").is_err());
        assert!(set_note_title(&vault, kelvin, "Rewritten").is_err());
        let smuggled = create_note(
            &vault,
            "\u{212a}nowledge/metrics",
            "smuggled",
            &patch(&[]),
            "# S\n",
        );
        assert!(smuggled.is_err());
        assert_eq!(snapshot(&vault), before);
        let _ = std::fs::remove_dir_all(&vault);
    }

    // The views/attachments rule decides only what is VISIBLE — the dot rule
    // and the extension rule are the boundary — so it must say exactly what
    // the scanner says: a note the scanner lists and the writers refuse is a
    // page whose every keystroke fails to save. `Attachments/` (an Obsidian
    // habit), `Views/`, `notes/Views/` and `views./` are folders the scanner
    // lists; `views/` and `attachments/`, at any depth, are folders it skips.
    // Dotfile notes are the one deliberate exception: listed, and read-only.
    #[test]
    fn the_note_writers_take_exactly_the_notes_the_scanner_lists() {
        let listed = |vault: &Path| -> Vec<String> {
            super::super::scan::scan_vault(vault)
                .unwrap()
                .into_iter()
                .map(|entry| entry.path)
                .collect()
        };
        let cases: &[(&[&str], &str)] = &[
            (&[], "records/ok.md"),
            (&[], "Attachments/b.md"),
            (&[], "Views/a.md"),
            (&[], "notes/Views/e.md"),
            (&[], "views./d.md"),
            (&[], "views/x.md"),
            (&[], "attachments/y.md"),
            (&[], "notes/views/z.md"),
            // Beside an existing `views/`, a folding disk files `Views/` inside
            // it, where the scanner never looks; a case-sensitive one makes a
            // folder of its own, which the scanner lists. Both agree either way.
            (&["views/x.yml"], "Views/plan.md"),
            (&["attachments/pic.png"], "ATTACHMENTS/notes.md"),
        ];
        for (beside, rel) in cases {
            // The editing doors, on a note that is already there.
            let vault = testutil::temp_vault("wfm-scanner-agrees");
            for file in beside.iter() {
                testutil::write(&vault, file, "x\n");
            }
            testutil::write(&vault, rel, NOTE);
            let visible = !listed(&vault).is_empty();
            let done = patch(&[("status", serde_json::json!("done"))]);
            let saved = save_note(&vault, rel, "\n# Saved\n").is_ok();
            assert_eq!(saved, visible, "{rel} beside {beside:?}: saved {saved}");
            assert_eq!(
                update_frontmatter(&vault, rel, &done).is_ok(),
                visible,
                "{rel}"
            );
            assert_eq!(
                set_note_title(&vault, rel, "Titled").is_ok(),
                visible,
                "{rel}"
            );
            let _ = std::fs::remove_dir_all(&vault);

            // And create: what it writes, the scanner lists; what it refuses,
            // written by hand instead, the scanner would never have shown.
            let vault = testutil::temp_vault("wfm-scanner-agrees-create");
            for file in beside.iter() {
                testutil::write(&vault, file, "x\n");
            }
            let (folder, leaf) = rel.rsplit_once('/').expect("a folder");
            let slug = leaf.trim_end_matches(".md");
            match create_note(&vault, folder, slug, &patch(&[]), "# Created\n") {
                Ok(created) => assert_eq!(listed(&vault).len(), 1, "{created}"),
                Err(_) => {
                    testutil::write(&vault, rel, NOTE);
                    assert_eq!(
                        listed(&vault),
                        Vec::<String>::new(),
                        "{rel} beside {beside:?}"
                    );
                }
            }
            let _ = std::fs::remove_dir_all(&vault);
        }

        // The exception, decided rather than overlooked (note-targets.json).
        let vault = testutil::temp_vault("wfm-scanner-dotfile");
        testutil::write(&vault, "records/.draft.md", NOTE);
        assert_eq!(listed(&vault), ["records/.draft.md"]);
        let err = save_note(&vault, "records/.draft.md", "\n# Saved\n").unwrap_err();
        assert!(err.contains("dotfiles hold no notes"), "{err}");
        let _ = std::fs::remove_dir_all(&vault);
    }

    // The plant: a folder made under a spelling a folding disk hears as
    // `knowledge`, BEFORE the bundle exists, is the bundle from then on — the
    // bundle's own writes land in it — under a name no bundle guard reads. So
    // the plant refuses at every note door, by NAME; and a bundle already
    // stored that way (planted before this check, or made by hand) is still
    // the bundle by IDENTITY, reached under that name or through a symlink.
    #[cfg(unix)]
    #[test]
    fn the_bundle_cannot_be_planted_under_another_spelling() {
        let vault = testutil::temp_vault("wfm-plant");
        let kelvin = "\u{212a}nowledge";
        let planted = create_note(
            &vault,
            &format!("{kelvin}/metrics"),
            "churn",
            &patch(&[]),
            "# Churn\n",
        );
        let err = planted.unwrap_err();
        assert!(err.contains("inside knowledge/ by another name"), "{err}");
        // HFS+ ignores U+200C in a name the way APFS folds the Kelvin sign.
        assert!(create_note(&vault, "know\u{200c}ledge", "x", &patch(&[]), "# X\n").is_err());
        assert!(write_text_file(&vault, &format!("{kelvin}/flow.mmd"), "graph TD\n").is_err());
        assert_eq!(
            std::fs::read_dir(&vault).unwrap().count(),
            0,
            "nothing was made"
        );

        // Planted anyway, with a concept in it — spelled as stored, so a
        // case-sensitive disk builds the same tree; on a folding one, this is
        // where `write_concept("knowledge/metrics/churn.md")` lands.
        testutil::write(&vault, &format!("{kelvin}/metrics/churn.md"), NOTE);
        std::os::unix::fs::symlink(vault.join(kelvin), vault.join("docs")).unwrap();
        if vault.join("knowledge").exists() {
            assert_eq!(bundle_root(&vault).as_deref(), Some(Path::new(kelvin)));
        }
        let before = snapshot(&vault);
        let stamp = patch(&[("verified", serde_json::json!({ "by": "human:josef" }))]);
        for rel in [
            format!("{kelvin}/metrics/churn.md"),
            "docs/metrics/churn.md".to_string(),
        ] {
            let err = update_frontmatter(&vault, &rel, &stamp).unwrap_err();
            assert!(
                err.contains("inside knowledge/ by another name"),
                "{rel}: {err}"
            );
            assert!(save_note(&vault, &rel, "\n# Rewritten\n").is_err(), "{rel}");
            assert!(set_note_title(&vault, &rel, "Rewritten").is_err(), "{rel}");
            assert!(appended_body(&vault, &rel, "More.").is_err(), "{rel}");
        }
        let smuggled = create_note(&vault, "docs/metrics", "smuggled", &patch(&[]), "# S\n");
        assert!(smuggled.is_err());
        assert_eq!(snapshot(&vault), before);
        let _ = std::fs::remove_dir_all(&vault);
    }

    // Identity on its own: where `knowledge` is a link to another folder, that
    // folder IS the bundle, under a name no fold could guess — so its notes
    // take no plain write, and a projection may land there.
    #[cfg(unix)]
    #[test]
    fn the_folder_knowledge_resolves_to_is_the_bundle() {
        let vault = testutil::temp_vault("wfm-bundle-identity");
        testutil::write(&vault, "kb/metrics/churn.md", NOTE);
        std::os::unix::fs::symlink(vault.join("kb"), vault.join("knowledge")).unwrap();
        assert_eq!(bundle_root(&vault).as_deref(), Some(Path::new("kb")));
        let before = snapshot(&vault);
        let stamp = patch(&[("verified", serde_json::json!({ "by": "human:josef" }))]);
        let err = update_frontmatter(&vault, "kb/metrics/churn.md", &stamp).unwrap_err();
        assert!(err.contains("inside knowledge/ by another name"), "{err}");
        assert!(save_note(&vault, "kb/metrics/churn.md", "\n# Rewritten\n").is_err());
        assert!(create_note(&vault, "kb", "smuggled", &patch(&[]), "# S\n").is_err());
        assert_eq!(snapshot(&vault), before);
        assert!(bundle_join(&vault, "knowledge/metrics/churn.md").is_ok());
        let _ = std::fs::remove_dir_all(&vault);
    }

    // The projection writer's door (ledger::manifest): a projection lands
    // inside the bundle as the filesystem resolves it, or nowhere. The
    // concept doors check only that a path is SPELLED `knowledge/…`, so a
    // symlink inside the bundle carried write_concept wherever it pointed.
    #[cfg(unix)]
    #[test]
    fn bundle_join_keeps_a_projection_inside_the_bundle() {
        let vault = testutil::temp_vault("wfm-bundle-join");
        let outside = testutil::temp_vault("wfm-bundle-join-outside");
        // No bundle yet: a projection may create it, and nothing else.
        assert!(bundle_join(&vault, "knowledge/metrics/churn.md").is_ok());
        let err = bundle_join(&vault, "records/x.md").unwrap_err();
        assert!(err.contains("outside knowledge/"), "{err}");

        testutil::write(&vault, "knowledge/metrics/churn.md", NOTE);
        testutil::write(&vault, "records/x.md", NOTE);
        testutil::write(&vault, ".git/config", "[core]\n");
        std::fs::create_dir_all(vault.join(".git/hooks")).unwrap();
        let link = |target: &Path, name: &str| {
            std::os::unix::fs::symlink(target, vault.join("knowledge").join(name)).unwrap()
        };
        link(&vault.join(".git/hooks"), "sys");
        link(&outside, "out");
        link(&vault.join("records"), "records");
        link(&vault.join("knowledge/metrics"), "current");

        assert!(bundle_join(&vault, "knowledge/metrics/churn.md").is_ok());
        assert!(bundle_join(&vault, "knowledge/metrics/new.md").is_ok());
        // A link that stays inside the bundle is just another way in.
        assert!(bundle_join(&vault, "knowledge/current/churn.md").is_ok());
        let err = bundle_join(&vault, "knowledge/sys/pre-commit.md").unwrap_err();
        assert!(
            err.contains("resolves to .git/hooks/pre-commit.md, outside knowledge/"),
            "{err}"
        );
        let err = bundle_join(&vault, "knowledge/out/escaped.md").unwrap_err();
        assert!(err.contains("escapes the vault"), "{err}");
        let err = bundle_join(&vault, "knowledge/records/x.md").unwrap_err();
        assert!(err.contains("resolves to records/x.md"), "{err}");
        // A dot-folder inside the bundle is still the bundle: a person files
        // concepts there by hand, and the agent doors keep agents out of it
        // (`concept_refusal`).
        assert!(bundle_join(&vault, "knowledge/.archive/x.md").is_ok());
        let err = bundle_join(&vault, "knowledge/metrics/churn.txt").unwrap_err();
        assert!(err.contains("a projection is a .md file"), "{err}");
        let err = bundle_join(&vault, "knowledge/../.git/x.md").unwrap_err();
        assert!(err.contains("escapes the vault"), "{err}");
        let _ = std::fs::remove_dir_all(&vault);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn appended_body_appends_to_markdown_notes_only() {
        let vault = vault_with_note("wfm-appended-body");
        testutil::write(&vault, "diagrams/flow.mmd", "flowchart TD\n  A --> B\n");
        assert_eq!(
            appended_body(&vault, "items/atl-1.md", "  More.  ").unwrap(),
            "\n# Ship the scanner\n\nBody stays.\n\nMore.\n"
        );
        // A .mmd is a note elsewhere — just not one markdown appends to.
        let err = appended_body(&vault, "diagrams/flow.mmd", "More.").unwrap_err();
        assert!(err.contains("raw diagram source"), "{err}");
        let err = appended_body(&vault, ".git/config", "More.").unwrap_err();
        assert!(err.starts_with("not a note: .git/config"), "{err}");
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn create_folder_and_rename_note_move_notes_and_folders_within_the_vault() {
        let vault = vault_with_note("wfm-rename");
        create_folder(&vault, "projects/atlas/items").unwrap();
        assert!(vault.join("projects/atlas/items").is_dir());
        rename_note(&vault, "items/atl-1.md", "projects/atlas/items/atl-1.md").unwrap();
        assert!(!vault.join("items/atl-1.md").exists());
        assert_eq!(read(&vault, "projects/atlas/items/atl-1.md"), NOTE);
        // Refuses to clobber an existing target.
        testutil::write(&vault, "items/atl-2.md", NOTE);
        assert!(rename_note(&vault, "items/atl-2.md", "projects/atlas/items/atl-1.md").is_err());
        // Whole folders move too.
        rename_note(&vault, "items", "archive").unwrap();
        assert_eq!(read(&vault, "archive/atl-2.md"), NOTE);
        let _ = std::fs::remove_dir_all(&vault);
    }

    // delete_note's happy path routes through the OS trash (trash::delete) —
    // exercised manually in the tauri-dev shakeout rather than polluting the
    // developer's Trash on every test run. Guards are covered here.
    #[test]
    fn v2_ops_reject_escapes_and_missing_paths() {
        let vault = vault_with_note("wfm-v2-escape");
        assert!(create_folder(&vault, "../evil").is_err());
        assert!(create_folder(&vault, "/tmp/evil").is_err());
        assert!(rename_note(&vault, "items/atl-1.md", "../stolen.md").is_err());
        assert!(rename_note(&vault, "../victim.md", "items/x.md").is_err());
        assert!(rename_note(&vault, "items/nope.md", "items/still-nope.md").is_err());
        assert!(delete_note(&vault, "../victim.md").is_err());
        assert!(delete_note(&vault, "items/nope.md").is_err());
        // The escape attempts must not have touched the real note.
        assert_eq!(read(&vault, "items/atl-1.md"), NOTE);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn update_survives_trailing_whitespace_closing_fence() {
        let vault = testutil::temp_vault("wfm-fence-ws");
        testutil::write(
            &vault,
            "items/ws.md",
            "---\ntype: Work item\nstatus: todo\n--- \nBody stays.\n",
        );
        update_frontmatter(
            &vault,
            "items/ws.md",
            &patch(&[("status", serde_json::json!("done"))]),
        )
        .unwrap();
        assert_eq!(
            read(&vault, "items/ws.md"),
            "---\ntype: Work item\nstatus: done\n---\nBody stays.\n"
        );
        let _ = std::fs::remove_dir_all(&vault);
    }

    // --- Attachments (M16.13c) ---------------------------------------------

    /// A file outside the vault, standing in for whatever the OS picker
    /// returns — the point of `import_attachment` is that the source is not
    /// vault-relative and not vault-contained.
    fn source_file(label: &str, name: &str, body: &str) -> std::path::PathBuf {
        let dir = testutil::temp_vault(label);
        let path = dir.join(name);
        std::fs::write(&path, body).unwrap();
        path
    }

    #[test]
    fn import_copies_into_attachments_and_returns_a_relative_path() {
        let vault = testutil::temp_vault("wfm-attach");
        let src = source_file("wfm-attach-src", "report.pdf", "%PDF-1.4");
        let rel = import_attachment(&vault, src.to_str().unwrap()).unwrap();

        assert_eq!(rel, "attachments/report.pdf");
        assert_eq!(read(&vault, &rel), "%PDF-1.4");
        // The original is COPIED, never moved — the user's Downloads folder is
        // not ours to empty.
        assert!(src.exists());
        let _ = std::fs::remove_dir_all(&vault);
        let _ = std::fs::remove_dir_all(src.parent().unwrap());
    }

    // `report.pdf-2` is a file the OS can no longer open, which is what
    // reusing `unique_rel_path`'s `.md`-shaped dedupe would have produced.
    #[test]
    fn a_second_file_of_the_same_name_dedupes_the_stem_not_the_extension() {
        let vault = testutil::temp_vault("wfm-attach-dupe");
        let a = source_file("wfm-attach-dupe-a", "report.pdf", "first");
        let b = source_file("wfm-attach-dupe-b", "report.pdf", "second");
        assert_eq!(
            import_attachment(&vault, a.to_str().unwrap()).unwrap(),
            "attachments/report.pdf"
        );
        assert_eq!(
            import_attachment(&vault, b.to_str().unwrap()).unwrap(),
            "attachments/report-2.pdf"
        );
        // Neither clobbered the other.
        assert_eq!(read(&vault, "attachments/report.pdf"), "first");
        assert_eq!(read(&vault, "attachments/report-2.pdf"), "second");
        let _ = std::fs::remove_dir_all(&vault);
        let _ = std::fs::remove_dir_all(a.parent().unwrap());
        let _ = std::fs::remove_dir_all(b.parent().unwrap());
    }

    #[test]
    fn a_dotfile_name_keeps_its_leading_dot() {
        let vault = testutil::temp_vault("wfm-attach-dot");
        let a = source_file("wfm-attach-dot-a", ".gitignore", "node_modules");
        let b = source_file("wfm-attach-dot-b", ".gitignore", "target");
        assert_eq!(
            import_attachment(&vault, a.to_str().unwrap()).unwrap(),
            "attachments/.gitignore"
        );
        // Not "attachments/-2.gitignore": a leading dot is the whole name.
        assert_eq!(
            import_attachment(&vault, b.to_str().unwrap()).unwrap(),
            "attachments/.gitignore-2"
        );
        let _ = std::fs::remove_dir_all(&vault);
        let _ = std::fs::remove_dir_all(a.parent().unwrap());
        let _ = std::fs::remove_dir_all(b.parent().unwrap());
    }

    #[test]
    fn import_refuses_relative_sources_directories_and_missing_files() {
        let vault = testutil::temp_vault("wfm-attach-guard");
        // Relative: `Path::join` on a relative source would resolve against
        // the process CWD, which is not the vault and not the picker's folder.
        assert!(import_attachment(&vault, "../../etc/passwd").is_err());
        assert!(import_attachment(&vault, "").is_err());
        assert!(import_attachment(&vault, vault.to_str().unwrap()).is_err());
        assert!(import_attachment(&vault, "/nonexistent/nope.png").is_err());
        assert!(!vault.join(ATTACHMENTS_DIR).exists());
        let _ = std::fs::remove_dir_all(&vault);
    }

    // The folder is fixed by this function, not chosen by the caller: a files
    // field stores whatever string it is handed, and `attachments/` is the one
    // directory the scanner and the watcher already agree to ignore.
    #[test]
    fn an_imported_markdown_file_lands_where_the_scanner_will_not_adopt_it() {
        let vault = testutil::temp_vault("wfm-attach-md");
        let src = source_file("wfm-attach-md-src", "notes.md", "# Not a record");
        let rel = import_attachment(&vault, src.to_str().unwrap()).unwrap();
        assert!(rel.starts_with("attachments/"));
        assert!(crate::vault::scan::scan_vault(&vault).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&vault);
        let _ = std::fs::remove_dir_all(src.parent().unwrap());
    }

    // --- Atomic writes (M21.1) ---------------------------------------------

    /// Every atomic-write temp anywhere under the vault, dot-dirs included —
    /// the assertion net must be wider than the janitor's walk.
    fn temp_files(vault: &Path) -> Vec<std::path::PathBuf> {
        walkdir::WalkDir::new(vault)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|e| e.file_type().is_file())
            .filter(|e| e.file_name().to_string_lossy().contains(TEMP_MARKER))
            .map(|e| e.into_path())
            .collect()
    }

    fn backdate(path: &Path, secs: u64) {
        let then = std::time::SystemTime::now() - std::time::Duration::from_secs(secs);
        let file = std::fs::File::options().write(true).open(path).unwrap();
        file.set_times(
            std::fs::FileTimes::new()
                .set_accessed(then)
                .set_modified(then),
        )
        .unwrap();
    }

    fn assert_aborted(status: std::process::ExitStatus) {
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            // SIGABRT — the crash point fired. A plain test failure (panic)
            // exits with a code instead, and must not pass as a crash.
            assert_eq!(status.signal(), Some(6), "expected SIGABRT, got {status:?}");
        }
        #[cfg(not(unix))]
        assert!(
            !status.success(),
            "expected an aborted child, got {status:?}"
        );
    }

    #[test]
    fn writes_leave_no_temp_behind_on_success() {
        let vault = vault_with_note("wfm-atomic-clean");
        save_note(
            &vault,
            "items/atl-1.md",
            "\n# Ship the scanner\n\nNew body.\n",
        )
        .unwrap();
        update_frontmatter(
            &vault,
            "items/atl-1.md",
            &patch(&[("status", serde_json::json!("done"))]),
        )
        .unwrap();
        create_note(&vault, "items", "fresh", &patch(&[]), "# Fresh\n").unwrap();
        assert!(temp_files(&vault).is_empty());
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[cfg(unix)]
    #[test]
    fn writes_preserve_tightened_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let vault = vault_with_note("wfm-atomic-perms");
        let path = vault.join("items/atl-1.md");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        save_note(
            &vault,
            "items/atl-1.md",
            "\n# Ship the scanner\n\nPrivate.\n",
        )
        .unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn clean_orphan_temps_reaps_stale_and_spares_fresh() {
        let vault = testutil::temp_vault("wfm-orphans");
        testutil::write(&vault, "items/keep.md", "# Keep\n");
        // A crashed write from two minutes ago, nested one level down…
        let stale = vault.join(format!("items/.a.md{TEMP_MARKER}00000000deadbeef"));
        // …and a vault-root temp young enough to be a write in flight.
        let fresh = vault.join(format!(".b.yml{TEMP_MARKER}00000000cafebabe"));
        std::fs::write(&stale, "half a note").unwrap();
        std::fs::write(&fresh, "half a view").unwrap();
        backdate(&stale, 120);
        clean_orphan_temps(&vault);
        assert!(!stale.exists(), "stale orphan must be reaped");
        assert!(
            fresh.exists(),
            "a fresh temp may belong to an in-flight write"
        );
        assert!(vault.join("items/keep.md").exists());
        let _ = std::fs::remove_dir_all(&vault);
    }

    /// Child body for the crash tests below: rewrite the fixture note through
    /// the atomic funnel. Ignored in normal runs — `run_crash_scenario`
    /// spawns it in a child process with `CEREBRO_CRASH_POINT` armed.
    #[test]
    #[ignore = "crash-scenario child body, spawned by the crash tests"]
    fn crash_scenario_overwrite_note() {
        let Ok(vault) = std::env::var("CEREBRO_CRASH_VAULT") else {
            return;
        };
        write_file(
            &Path::new(&vault).join("items/atl-1.md"),
            "# Rewritten by the crash scenario\n",
        )
        .unwrap();
    }

    #[test]
    fn crash_at_temp_written_leaves_destination_untouched() {
        let vault = vault_with_note("wfm-crash-temp");
        let status = testutil::run_crash_scenario(
            "vault::write::tests::crash_scenario_overwrite_note",
            "temp-written",
            &vault,
        );
        assert_aborted(status);
        // Old bytes intact; the half-finished write is only an orphan temp.
        assert_eq!(read(&vault, "items/atl-1.md"), NOTE);
        let orphans = temp_files(&vault);
        assert_eq!(orphans.len(), 1, "{orphans:?}");
        // The acceptance-matrix row ends "orphan reaped later": age it past
        // the guard and let the janitor prove that.
        backdate(&orphans[0], 120);
        clean_orphan_temps(&vault);
        assert!(temp_files(&vault).is_empty());
        let _ = std::fs::remove_dir_all(&vault);
    }

    // M21.6: the funnel registers WHAT it wrote, so the watcher recognizes
    // the echo by content — and only the echo.
    #[test]
    fn the_write_funnel_registers_its_content_hash_with_the_watcher() {
        let vault = vault_with_note("wfm-hashed-own-write");
        save_note(&vault, "items/atl-1.md", "\n# Ship the scanner\n\nMine.\n").unwrap();
        let path = vault.join("items/atl-1.md");
        assert!(crate::vault::watcher::is_suppressed(&path));
        // A foreign edit right afterwards is not ours, window or no window.
        std::fs::write(&path, "someone else's bytes").unwrap();
        assert!(!crate::vault::watcher::is_suppressed(&path));
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn crash_after_rename_leaves_new_bytes_and_no_orphan() {
        let vault = vault_with_note("wfm-crash-rename");
        let status = testutil::run_crash_scenario(
            "vault::write::tests::crash_scenario_overwrite_note",
            "renamed-pre-dirsync",
            &vault,
        );
        assert_aborted(status);
        assert_eq!(
            read(&vault, "items/atl-1.md"),
            "# Rewritten by the crash scenario\n"
        );
        assert!(temp_files(&vault).is_empty());
        let _ = std::fs::remove_dir_all(&vault);
    }
}
