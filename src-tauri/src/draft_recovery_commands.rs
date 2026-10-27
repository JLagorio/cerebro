//! Explicit recovery of a retained draft. No draft bytes are persisted here.
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use tauri::Manager;

#[derive(serde::Deserialize)]
struct ExportRules {
    version: u64,
    max_bytes: usize,
    lease_seconds: u64,
    max_pending: usize,
    formats: Vec<String>,
    bundle_formats: Vec<String>,
}
fn rules() -> &'static ExportRules {
    static RULES: OnceLock<ExportRules> = OnceLock::new();
    RULES.get_or_init(|| {
        serde_json::from_str(include_str!("../../shared/policy/draft-export.v1.json"))
            .expect("checked draft export rules")
    })
}
fn invalid(reason: &str) -> String {
    format!("recovery_invalid_path: {reason}")
}
fn unavailable(reason: &str) -> String {
    format!("recovery_unavailable: {reason}")
}
fn hash_valid(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn active_origin(config: &Path, vault: &Path) -> Result<(PathBuf, PathBuf), String> {
    let vault = vault
        .canonicalize()
        .map_err(|_| unavailable("vault is unavailable"))?;
    if !vault.is_dir() || std::fs::read_dir(&vault).is_err() {
        return Err(unavailable("vault is unavailable"));
    }
    let active = crate::files::bytes::root_dir(config, "0")
        .map_err(|_| unavailable("active vault is unavailable"))?
        .canonicalize()
        .map_err(|_| unavailable("active vault is unavailable"))?;
    if vault != active {
        return Err(unavailable("the active vault changed"));
    }
    let config = config
        .canonicalize()
        .map_err(|_| unavailable("configuration is unavailable"))?;
    Ok((vault, config))
}
#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum DraftTargetProbe {
    Present,
    Missing,
    Unavailable { code: String },
}
fn probe_in(vault: &Path, path: &str) -> DraftTargetProbe {
    let unavailable = || DraftTargetProbe::Unavailable {
        code: "recovery_unavailable".into(),
    };
    if !vault.is_dir() || std::fs::read_dir(vault).is_err() {
        return unavailable();
    }
    let target = match crate::vault::write::draft_recovery_target(vault, path) {
        Ok(target) => target,
        Err(_) => {
            return DraftTargetProbe::Unavailable {
                code: "recovery_invalid_path".into(),
            }
        }
    };
    match std::fs::symlink_metadata(&target) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return DraftTargetProbe::Missing
        }
        Err(_) => return unavailable(),
        Ok(meta) if meta.is_symlink() && target.canonicalize().is_err() => return unavailable(),
        Ok(meta) if !meta.is_file() && !meta.is_symlink() => return unavailable(),
        Ok(_) => {}
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        // A concurrently planted FIFO must not turn a presence check into
        // an unbounded read wait. No bytes are read from this descriptor.
        options.custom_flags(libc::O_NONBLOCK | libc::O_CLOEXEC);
    }
    match options.open(target).and_then(|file| file.metadata()) {
        Ok(meta) if meta.is_file() => DraftTargetProbe::Present,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => DraftTargetProbe::Missing,
        _ => unavailable(),
    }
}
fn validate_create(
    vault: &Path,
    original: &str,
    destination: &str,
    content: &str,
) -> Result<(), String> {
    crate::vault::write::validate_draft_recovery_create(vault, original, destination, content)
        .map_err(|reason| invalid(&reason))
}
fn validate_export(format: &str, content: &str, hash: &str) -> Result<(), String> {
    if !rules().formats.iter().any(|value| value == format)
        || content.len() > rules().max_bytes
        || !hash_valid(hash)
        || format!("{:x}", Sha256::digest(content.as_bytes())) != hash
    {
        return Err(invalid(
            "export content changed, is unsupported or is too large",
        ));
    }
    if format == "json" {
        let bundle: serde_json::Value =
            serde_json::from_str(content).map_err(|_| invalid("invalid recovery data"))?;
        if bundle["version"].as_u64() != Some(rules().version)
            || !bundle["format"]
                .as_str()
                .is_some_and(|format| rules().bundle_formats.iter().any(|value| value == format))
        {
            return Err(invalid("invalid recovery data version"));
        }
    }
    Ok(())
}
fn validate_choice(
    vault: &Path,
    path: &str,
    name: &str,
    format: &str,
    hash: &str,
) -> Result<(), String> {
    crate::vault::write::draft_recovery_target(vault, path).map_err(|reason| invalid(&reason))?;
    if !rules().formats.iter().any(|value| value == format) || !hash_valid(hash) {
        return Err(invalid("invalid export format or digest"));
    }
    if format != "json"
        && (Path::new(path).extension().and_then(|ext| ext.to_str()) != Some(format)
            || crate::knowledge::guard_human_write(path).is_err())
    {
        return Err(invalid("this source requires a recovery bundle"));
    }
    if name.is_empty()
        || name.starts_with('.')
        || name.contains(['/', '\\', '\0'])
        || Path::new(name).extension().and_then(|ext| ext.to_str()) != Some(format)
    {
        return Err(invalid("invalid export filename"));
    }
    Ok(())
}
struct PendingExport<T> {
    vault: PathBuf,
    config: PathBuf,
    format: String,
    hash: String,
    expires: Instant,
    destination: T,
}
struct TokenBook<T> {
    pending: HashMap<String, PendingExport<T>>,
}
impl<T> Default for TokenBook<T> {
    fn default() -> Self {
        Self {
            pending: HashMap::new(),
        }
    }
}
impl<T> TokenBook<T> {
    fn insert(&mut self, pending: PendingExport<T>, now: Instant) -> Result<String, String> {
        self.pending.retain(|_, value| value.expires > now);
        if self.pending.len() >= rules().max_pending {
            return Err(unavailable("too many pending exports"));
        }
        let token = crate::ledger::new_run_id();
        self.pending.insert(token.clone(), pending);
        Ok(token)
    }
    fn take(
        &mut self,
        token: &str,
        vault: &Path,
        config: &Path,
        now: Instant,
    ) -> Result<PendingExport<T>, String> {
        let pending = self
            .pending
            .remove(token)
            .ok_or_else(|| invalid("export choice expired"))?;
        if pending.vault != vault || pending.config != config || pending.expires <= now {
            return Err(invalid("export choice changed or expired"));
        }
        Ok(pending)
    }
    fn cancel(&mut self, token: &str) {
        self.pending.remove(token);
    }
}
#[derive(Default)]
pub(crate) struct DraftExportState {
    book: Mutex<TokenBook<crate::shell::file_actions::DraftCopyDestination>>,
    epoch: std::sync::atomic::AtomicU64,
}
impl DraftExportState {
    pub(crate) fn clear(&self) {
        self.epoch.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if let Ok(mut book) = self.book.lock() {
            book.pending.clear();
        }
    }
}
#[derive(serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum DraftExportChoice {
    Chosen { token: String },
    Cancelled,
}
#[derive(serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum DraftExportResult {
    Exported { destination: String },
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecoveredPage {
    path: String,
    content_hash: String,
    batch: crate::vault::batch::BatchApplied,
}
#[tauri::command(async)]
pub(crate) fn probe_draft_target(
    app: tauri::AppHandle,
    vault: String,
    path: String,
) -> DraftTargetProbe {
    let result = crate::config_dir(&app)
        .and_then(|config| active_origin(&config, Path::new(&vault)))
        .map(|(vault, _)| probe_in(&vault, &path))
        .unwrap_or_else(|_| DraftTargetProbe::Unavailable {
            code: "recovery_unavailable".into(),
        });
    if let DraftTargetProbe::Unavailable { code } = &result {
        crate::recovery_commands::record_refusal("probe_draft_target", code.clone());
    }
    result
}
#[tauri::command(async)]
pub(crate) fn choose_draft_export(
    app: tauri::AppHandle,
    vault: String,
    path: String,
    default_name: String,
    format: String,
    content_hash: String,
) -> Result<DraftExportChoice, String> {
    (|| {
        let config =
            crate::config_dir(&app).map_err(|_| unavailable("configuration is unavailable"))?;
        let (vault, config) = active_origin(&config, Path::new(&vault))?;
        validate_choice(&vault, &path, &default_name, &format, &content_hash)?;
        let state = app.state::<DraftExportState>();
        let epoch = state.epoch.load(std::sync::atomic::Ordering::SeqCst);
        let Some(destination) = crate::shell::file_actions::choose_draft_copy(&app, &default_name)
            .map_err(|_| unavailable("export picker unavailable"))?
        else {
            return Ok(DraftExportChoice::Cancelled);
        };
        // A choice from another active vault cannot acquire a capability.
        active_origin(&config, &vault)?;
        if destination.extension() != Some(format.as_str()) {
            return Err(invalid("chosen filename does not match export type"));
        }
        let now = Instant::now();
        let mut book = state
            .book
            .lock()
            .map_err(|_| unavailable("export state unavailable"))?;
        if state.epoch.load(std::sync::atomic::Ordering::SeqCst) != epoch {
            return Err(invalid("the recovery window closed"));
        }
        let token = book.insert(
            PendingExport {
                vault,
                config,
                format,
                hash: content_hash,
                expires: now + Duration::from_secs(rules().lease_seconds),
                destination,
            },
            now,
        )?;
        Ok(DraftExportChoice::Chosen { token })
    })()
    .map_err(|message| crate::recovery_commands::record_refusal("choose_draft_export", message))
}
#[tauri::command(async)]
pub(crate) fn commit_draft_export(
    app: tauri::AppHandle,
    vault: String,
    token: String,
    content: String,
) -> Result<DraftExportResult, String> {
    (|| {
        // Consume even when the app/vault is now unavailable or foreign.
        let pending = app
            .state::<DraftExportState>()
            .book
            .lock()
            .map_err(|_| unavailable("export state unavailable"))?
            .pending
            .remove(&token)
            .ok_or_else(|| invalid("export choice expired"))?;
        let config =
            crate::config_dir(&app).map_err(|_| unavailable("configuration is unavailable"))?;
        let (vault, config) = active_origin(&config, Path::new(&vault))?;
        let mut selected = TokenBook::default();
        selected.pending.insert(token.clone(), pending);
        let pending = selected.take(&token, &vault, &config, Instant::now())?;
        validate_export(&pending.format, &content, &pending.hash)?;
        let destination = crate::shell::file_actions::publish_draft_copy(
            &config,
            &vault,
            pending.destination,
            content.as_bytes(),
        )
        .map_err(|_| unavailable("export could not be saved; choose a destination again"))?;
        Ok(DraftExportResult::Exported { destination })
    })()
    .map_err(|message| crate::recovery_commands::record_refusal("commit_draft_export", message))
}
#[tauri::command]
pub(crate) fn cancel_draft_export(app: tauri::AppHandle, token: String) {
    if let Ok(mut book) = app.state::<DraftExportState>().book.lock() {
        book.cancel(&token);
    }
}
fn create_in(
    vault: &Path,
    original: &str,
    destination: &str,
    content: &str,
) -> Result<RecoveredPage, String> {
    validate_create(vault, original, destination, content)?;
    let batch = crate::apply_batch(
        vault.to_string_lossy().into_owned(),
        vec![serde_json::json!({ "op": "create", "path": destination, "content": content })],
    )
    .map_err(|message| invalid(&message))?;
    let created = batch
        .files
        .first()
        .ok_or_else(|| unavailable("create acknowledgement missing"))?;
    let path = created.path.clone();
    let content_hash = created
        .after_hash
        .clone()
        .ok_or_else(|| unavailable("create acknowledgement missing"))?;
    Ok(RecoveredPage {
        path,
        content_hash,
        batch,
    })
}
#[tauri::command(async)]
pub(crate) fn create_recovered_page(
    app: tauri::AppHandle,
    vault: String,
    original_path: String,
    destination_path: String,
    content: String,
) -> Result<RecoveredPage, String> {
    (|| {
        let config =
            crate::config_dir(&app).map_err(|_| unavailable("configuration is unavailable"))?;
        let (vault, _) = active_origin(&config, Path::new(&vault))?;
        create_in(&vault, &original_path, &destination_path, &content)
    })()
    .map_err(|message| crate::recovery_commands::record_refusal("create_recovered_page", message))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::testutil::{temp_vault, write};

    #[test]
    fn probe_distinguishes_absence_from_present_and_invalid_targets() {
        let vault = temp_vault("draft-probe");
        write(&vault, "page.md", "body");
        write(&vault, "diagram.mmd", "graph TD");
        write(&vault, "board.canvas", "{}");
        write(&vault, "knowledge/concepts/concept.md", "governed");
        for path in [
            "page.md",
            "diagram.mmd",
            "board.canvas",
            "knowledge/concepts/concept.md",
        ] {
            assert_eq!(probe_in(&vault, path), DraftTargetProbe::Present, "{path}");
        }
        assert_eq!(probe_in(&vault, "gone.md"), DraftTargetProbe::Missing);
        std::fs::create_dir(vault.join("directory.md")).unwrap();
        for path in [
            "directory.md",
            ".git/gone.md",
            "../gone.md",
            "gone.txt",
            "views/gone.md",
        ] {
            assert!(
                matches!(probe_in(&vault, path), DraftTargetProbe::Unavailable { .. }),
                "{path}"
            );
        }
        assert!(matches!(
            probe_in(&vault.join("gone"), "gone.md"),
            DraftTargetProbe::Unavailable { .. }
        ));
        std::fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn create_validation_preserves_body_bytes_and_refuses_original_aliases_and_metadata() {
        let vault = temp_vault("draft-create-check");
        for content in [
            "",
            " \t\r\n",
            "\u{feff}body\r\n",
            "---\nnot closed",
            "# body\r\n  text\r\n",
        ] {
            assert!(
                validate_create(&vault, "gone.md", "recovered.md", content).is_ok(),
                "{content:?}"
            );
        }
        for (original, destination, content) in [
            ("gone.md", "gone.md", "body"),
            ("gone.md", "./gone.md", "body"),
            ("gone.md", "GONE.md", "body"),
            ("gone.mmd", "new.md", "body"),
            ("knowledge/a.md", "new.md", "body"),
            ("gone.md", "knowledge/new.md", "body"),
            ("gone.md", "new.mmd", "body"),
            ("gone.md", ".git/new.md", "body"),
            ("gone.md", "new.md", "---\ntitle: promoted\n---\nbody"),
            ("gone.md", "new.md", "\u{feff}---\r\n---\r\nbody"),
        ] {
            assert!(
                validate_create(&vault, original, destination, content).is_err(),
                "{original} -> {destination}"
            );
        }
        std::fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn export_validation_binds_digest_and_plain_bundle_version_without_normalizing() {
        use sha2::{Digest, Sha256};
        let content =
            "{\"format\":\"cerebro-retained-draft\",\"version\":1,\"text\":\"  \\r\\n☀\"}";
        let hash = format!("{:x}", Sha256::digest(content.as_bytes()));
        assert!(validate_export("json", content, &hash).is_ok());
        assert!(validate_export("json", content, &"0".repeat(64)).is_err());
        for content in [
            "{}",
            "{\"format\":\"cerebro-retained-draft\",\"version\":2}",
            "not json",
        ] {
            let hash = format!("{:x}", Sha256::digest(content.as_bytes()));
            assert!(validate_export("json", content, &hash).is_err());
        }
        let source = "\u{feff}graph TD\r\n A-->B  \r\n";
        let hash = format!("{:x}", Sha256::digest(source.as_bytes()));
        assert!(validate_export("mmd", source, &hash).is_ok());
        assert!(validate_export("svg", source, &hash).is_err());
    }
    #[test]
    fn token_book_consumes_foreign_expired_and_cancelled_choices_without_replay() {
        use std::time::{Duration, Instant};
        let now = Instant::now();
        let pending = || PendingExport {
            vault: "/vault".into(),
            config: "/config".into(),
            format: "json".into(),
            hash: "a".repeat(64),
            expires: now + Duration::from_secs(60),
            destination: "selected.json",
        };
        let mut book = TokenBook::default();
        let token = book.insert(pending(), now).unwrap();
        assert_eq!(
            book.take(&token, Path::new("/vault"), Path::new("/config"), now)
                .unwrap()
                .destination,
            "selected.json"
        );
        assert!(book
            .take(&token, Path::new("/vault"), Path::new("/config"), now)
            .is_err());
        for failure in ["vault", "config", "expiry", "cancel"] {
            let token = book.insert(pending(), now).unwrap();
            if failure == "cancel" {
                book.cancel(&token);
            }
            assert!(
                book.take(
                    &token,
                    Path::new(if failure == "vault" {
                        "/other"
                    } else {
                        "/vault"
                    }),
                    Path::new(if failure == "config" {
                        "/other"
                    } else {
                        "/config"
                    }),
                    if failure == "expiry" {
                        now + Duration::from_secs(61)
                    } else {
                        now
                    },
                )
                .is_err(),
                "{failure}"
            );
            assert!(
                book.take(&token, Path::new("/vault"), Path::new("/config"), now)
                    .is_err(),
                "{failure} replay"
            );
        }
        // The bound is shared/policy/draft-export.v1.json's max_pending.
        for _ in 0..64 {
            book.insert(pending(), now).unwrap();
        }
        assert!(book.insert(pending(), now).is_err());
        assert!(book
            .insert(pending(), now + Duration::from_secs(61))
            .is_ok());
    }

    #[test]
    fn replays_the_shared_draft_recovery_cases() {
        use sha2::{Digest, Sha256};
        let cases: serde_json::Value =
            serde_json::from_str(include_str!("../fixtures/draft-recovery-cases.json")).unwrap();
        let vault = temp_vault("draft-shared");
        for case in cases["create"].as_array().unwrap() {
            assert_eq!(
                validate_create(
                    &vault,
                    case["original"].as_str().unwrap(),
                    case["destination"].as_str().unwrap(),
                    case["content"].as_str().unwrap()
                )
                .is_ok(),
                case["allowed"].as_bool().unwrap(),
                "{case}"
            );
        }
        for case in cases["exports"].as_array().unwrap() {
            let content = case["content"].as_str().unwrap();
            let hash = format!("{:x}", Sha256::digest(content.as_bytes()));
            assert_eq!(
                validate_export(case["format"].as_str().unwrap(), content, &hash).is_ok(),
                case["allowed"].as_bool().unwrap(),
                "{case}"
            );
        }
        std::fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn exact_create_returns_human_batch_acknowledgement_and_does_not_restore_original() {
        use sha2::{Digest, Sha256};
        let _lock = crate::runtime::sink::test_lock();
        let config = temp_vault("draft-create-sink");
        crate::runtime::sink::arm(&config).unwrap();
        let vault = temp_vault("draft-create-exact");
        let body = "\u{feff}# Exact\r\n  body \r\n";
        let created = create_in(&vault, "gone.md", "recovered.md", body).unwrap();
        assert_eq!(
            std::fs::read(vault.join("recovered.md")).unwrap(),
            body.as_bytes()
        );
        assert!(!vault.join("gone.md").exists());
        assert_eq!(
            created.content_hash,
            format!("{:x}", Sha256::digest(body.as_bytes()))
        );
        assert_eq!(created.batch.files.len(), 1);
        assert_eq!(created.batch.files[0].before_hash, None);
        assert_eq!(
            created.batch.files[0].after_hash.as_deref(),
            Some(created.content_hash.as_str())
        );
        assert!(create_in(&vault, "gone.md", "recovered.md", "overwrite").is_err());
        assert_eq!(
            std::fs::read(vault.join("recovered.md")).unwrap(),
            body.as_bytes()
        );
        crate::runtime::sink::disarm();
        std::fs::remove_dir_all(vault).unwrap();
        std::fs::remove_dir_all(config).unwrap();
    }
    #[test]
    fn source_identity_and_active_vault_are_checked_independently_of_presence() {
        let vault = temp_vault("draft-active");
        let other = temp_vault("draft-other");
        let config = temp_vault("draft-active-config");
        crate::app_config::save(
            &config,
            &crate::app_config::AppConfig {
                last_vault: Some(vault.to_string_lossy().into_owned()),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(active_origin(&config, &vault).is_ok());
        assert!(active_origin(&config, &other).is_err());
        assert!(validate_choice(&vault, "gone.md", "draft.json", "json", &"a".repeat(64)).is_ok());
        for (path, name, format, hash) in [
            ("gone.md", "../draft.json", "json", "a".repeat(64)),
            ("gone.md", "draft.json", "json", "invalid".into()),
            ("knowledge/a.md", "draft.md", "md", "a".repeat(64)),
            ("gone.md", "draft.mmd", "mmd", "a".repeat(64)),
            ("gone.md", "draft.md", "json", "a".repeat(64)),
        ] {
            assert!(validate_choice(&vault, path, name, format, &hash).is_err());
        }
        for directory in [vault, other, config] {
            std::fs::remove_dir_all(directory).unwrap();
        }
    }
    #[cfg(unix)]
    #[test]
    fn probe_refuses_alias_backdoors_and_broken_links() {
        use std::os::unix::fs::symlink;
        let vault = temp_vault("draft-probe-alias");
        let outside = temp_vault("draft-probe-outside");
        write(&vault, "knowledge/a.md", "governed");
        symlink(vault.join("knowledge"), vault.join("alias")).unwrap();
        symlink(&outside, vault.join("escape")).unwrap();
        symlink(vault.join("absent.md"), vault.join("broken.md")).unwrap();
        for path in ["alias/a.md", "escape/gone.md", "broken.md"] {
            assert!(
                matches!(probe_in(&vault, path), DraftTargetProbe::Unavailable { .. }),
                "{path}"
            );
        }
        std::fs::remove_dir_all(vault).unwrap();
        std::fs::remove_dir_all(outside).unwrap();
    }
}
