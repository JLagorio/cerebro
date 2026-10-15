//! Contained reads addressed by a root id, never a renderer-supplied vault.
use super::kinds;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::File,
    io::Read,
    path::{Path, PathBuf},
    sync::OnceLock,
};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Limits {
    pub body_bytes: u64,
    pub range_bytes: u64,
    pub rel_bytes: usize,
    pub root_bytes: usize,
    pub link_hops: usize,
    pub revision_bytes: usize,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rules {
    pub format: u8,
    pub scheme: String,
    pub host: String,
    pub vault_root: String,
    pub revision_key: String,
    pub limits: Limits,
    pub refusals: BTreeMap<String, String>,
    pub cases: Vec<serde_json::Value>,
    pub files: Vec<serde_json::Value>,
}

pub fn rules() -> &'static Rules {
    static RULES: OnceLock<Rules> = OnceLock::new();
    RULES.get_or_init(|| {
        let rules: Rules =
            serde_json::from_str(include_str!("../../../shared/files/bytes.v1.json"))
                .expect("shipped byte rules");
        assert_eq!(rules.format, 1);
        assert_eq!(rules.scheme, "cerebro-file");
        assert_eq!(rules.host, "localhost");
        assert_eq!(rules.vault_root, "0");
        assert_eq!(rules.revision_key, "v");
        assert!(
            rules.limits.body_bytes > 0
                && rules.limits.range_bytes > 0
                && rules.limits.range_bytes <= rules.limits.body_bytes
        );
        assert!(
            rules.limits.rel_bytes > 0
                && rules.limits.root_bytes > 0
                && rules.limits.link_hops > 0
                && rules.limits.revision_bytes > 0
        );
        assert_eq!(
            rules
                .refusals
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            [
                "bad_address",
                "folder",
                "no_such_root",
                "not_found",
                "outside",
                "too_large",
                "wrong_door"
            ]
        );
        assert!(!rules.cases.is_empty() && !rules.files.is_empty());
        rules
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Refusal {
    pub code: String,
    pub message: String,
}
pub fn refusal(code: &str) -> Refusal {
    Refusal {
        code: code.into(),
        message: rules().refusals[code].clone(),
    }
}

pub fn rel_refusal(root_id: &str, rel: &str) -> Option<Refusal> {
    let caps = &rules().limits;
    let valid_root = !root_id.is_empty()
        && root_id.len() <= caps.root_bytes
        && root_id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_');
    let drive_prefix =
        rel.as_bytes().get(1) == Some(&b':') && rel.as_bytes()[0].is_ascii_alphabetic();
    let valid_rel = !rel.is_empty()
        && rel.len() <= caps.rel_bytes
        && !rel.contains('\\')
        && !rel.chars().any(char::is_control)
        && !rel
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == "..")
        && !drive_prefix;
    (!valid_root || !valid_rel).then(|| refusal("bad_address"))
}

pub fn root_dir(config: &Path, id: &str) -> Result<PathBuf, Refusal> {
    if id == rules().vault_root {
        crate::app_config::load(config)
            .last_vault
            .filter(|path| !path.is_empty())
            .map(PathBuf::from)
            .ok_or_else(|| refusal("no_such_root"))
    } else {
        crate::roots::find(config, id)
            .map(|root| PathBuf::from(root.path))
            .ok_or_else(|| refusal("no_such_root"))
    }
}

pub fn locate_in(root: &Path, root_id: &str, rel: &str) -> Result<PathBuf, Refusal> {
    if let Some(error) = rel_refusal(root_id, rel) {
        return Err(error);
    }
    let path = crate::roots::tree::locate_within(root, rel).map_err(|error| match error {
        crate::roots::tree::LocateRefusal::Outside => refusal("outside"),
        crate::roots::tree::LocateRefusal::Missing => refusal("not_found"),
        crate::roots::tree::LocateRefusal::RootUnavailable(_) => refusal("no_such_root"),
    })?;
    let meta = std::fs::metadata(&path).map_err(|_| refusal("not_found"))?;
    if meta.is_dir() {
        return Err(refusal("folder"));
    }
    if !meta.is_file() {
        return Err(refusal("not_found"));
    }
    Ok(path)
}

/// The opened descriptor, pinned while the path was contained. Readers never
/// reopen `path`: it is retained only to classify the extension.
#[derive(Debug)]
pub struct OpenedFile {
    /// The canonical root used for this exact open, before a vault switch.
    pub root: PathBuf,
    pub path: PathBuf,
    pub file: File,
}

/// Open the already-resolved relative components beneath an anchored root.
/// O_NOFOLLOW applies to every component, including the final file: swapping
/// either a directory or a file for an outside symlink cannot redirect a read.
#[cfg(unix)]
fn open_resolved(root: &Path, path: PathBuf) -> Result<OpenedFile, Refusal> {
    use std::{
        ffi::CString,
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::{ffi::OsStrExt, fs::OpenOptionsExt},
        },
    };
    let mut directory = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(root)
        .map_err(|_| refusal("no_such_root"))?;
    let components = path
        .strip_prefix(root)
        .map_err(|_| refusal("outside"))?
        .components()
        .collect::<Vec<_>>();
    if components.is_empty() {
        return Err(refusal("folder"));
    }
    for (index, component) in components.iter().enumerate() {
        let std::path::Component::Normal(name) = component else {
            return Err(refusal("outside"));
        };
        let name = CString::new(name.as_bytes()).map_err(|_| refusal("bad_address"))?;
        let last = index + 1 == components.len();
        let flags = libc::O_RDONLY
            | libc::O_NOFOLLOW
            | libc::O_CLOEXEC
            | if last {
                libc::O_NONBLOCK
            } else {
                libc::O_DIRECTORY
            };
        // SAFETY: directory is an owned open descriptor; name is a NUL-terminated
        // single component and flags ask only for a read. openat borrows both.
        let fd = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            let code = std::io::Error::last_os_error().raw_os_error();
            return Err(refusal(
                if matches!(code, Some(libc::ELOOP) | Some(libc::ENOTDIR)) {
                    "outside"
                } else {
                    "not_found"
                },
            ));
        }
        // SAFETY: a successful openat returned a fresh descriptor, now owned
        // exactly once by File and closed on every success or error path.
        let file = unsafe { File::from_raw_fd(fd) };
        if last {
            let meta = file.metadata().map_err(|_| refusal("not_found"))?;
            if !meta.is_file() {
                return Err(refusal(if meta.is_dir() { "folder" } else { "not_found" }));
            }
            return Ok(OpenedFile {
                root: root.to_path_buf(),
                path,
                file,
            });
        }
        directory = file;
    }
    Err(refusal("not_found"))
}

#[cfg(not(unix))]
fn open_resolved(_root: &Path, _path: PathBuf) -> Result<OpenedFile, Refusal> {
    // Cerebro ships on macOS. An additional platform needs its own anchored
    // descriptor walk before this door can safely serve it.
    Err(refusal("wrong_door"))
}

pub fn open_in(root: &Path, root_id: &str, rel: &str) -> Result<OpenedFile, Refusal> {
    let root = std::fs::canonicalize(root).map_err(|_| refusal("no_such_root"))?;
    let path = locate_in(&root, root_id, rel)?;
    open_resolved(&root, path)
}

pub fn locate(config: &Path, root_id: &str, rel: &str) -> Result<OpenedFile, Refusal> {
    if let Some(error) = rel_refusal(root_id, rel) {
        return Err(error);
    }
    open_in(&root_dir(config, root_id)?, root_id, rel)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    pub size: u64,
    pub mime: String,
    pub kind: String,
    pub door: String,
    pub sniff: String,
    pub open: String,
}

pub fn probe_opened(opened: OpenedFile) -> Result<Probe, Refusal> {
    let OpenedFile { path, mut file, .. } = opened;
    let meta = file.metadata().map_err(|_| refusal("not_found"))?;
    let mut head = Vec::with_capacity(8192);
    file.by_ref()
        .take(8192)
        .read_to_end(&mut head)
        .map_err(|_| refusal("not_found"))?;
    let row = kinds::lookup(&path.to_string_lossy());
    Ok(Probe {
        size: meta.len(),
        mime: row.mime.clone(),
        kind: row.kind.as_str().into(),
        door: row.bytes.as_str().into(),
        sniff: crate::roots::read::sniff(&head).into(),
        open: kinds::open_policy_for(&path.to_string_lossy(), &meta, Some(&head))
            .as_str()
            .into(),
    })
}

pub fn probe(config: &Path, root_id: &str, rel: &str) -> Result<Probe, Refusal> {
    probe_opened(locate(config, root_id, rel)?)
}

pub fn read_for_ipc(config: &Path, root_id: &str, rel: &str) -> Result<Vec<u8>, Refusal> {
    let OpenedFile { path, file, .. } = locate(config, root_id, rel)?;
    if kinds::lookup(&path.to_string_lossy()).bytes != kinds::Door::Ipc {
        return Err(refusal("wrong_door"));
    }
    let cap = rules().limits.body_bytes;
    if file.metadata().map_err(|_| refusal("not_found"))?.len() > cap {
        return Err(refusal("too_large"));
    }
    let mut body = Vec::new();
    file.take(cap + 1)
        .read_to_end(&mut body)
        .map_err(|_| refusal("not_found"))?;
    if body.len() as u64 > cap {
        return Err(refusal("too_large"));
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::testutil;

    fn configured(label: &str) -> PathBuf {
        let dir = testutil::temp_vault(label);
        crate::app_config::save(
            &dir,
            &crate::app_config::AppConfig {
                last_vault: Some(dir.to_string_lossy().into_owned()),
                ..Default::default()
            },
        )
        .unwrap();
        dir
    }

    #[test]
    fn replays_the_shared_bytes_cases() {
        for case in &rules().cases {
            let refused = rel_refusal(
                case["root"].as_str().unwrap(),
                case["rel"].as_str().unwrap(),
            );
            assert_eq!(
                refused.as_ref().map(|r| r.code.as_str()),
                case["refusal"].as_str(),
                "{case}"
            );
            if let Some(url) = case["url"].as_str() {
                assert_eq!(
                    super::super::scheme::address(&url.parse().unwrap()).unwrap(),
                    (
                        case["root"].as_str().unwrap().into(),
                        case["rel"].as_str().unwrap().into()
                    )
                );
            }
        }
        let dir = configured("bytes-cases");
        for case in &rules().files {
            let rel = case["rel"].as_str().unwrap();
            let data = case["bytes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|b| b.as_u64().unwrap() as u8)
                .collect::<Vec<_>>();
            std::fs::write(dir.join(rel), &data).unwrap();
            #[cfg(unix)]
            if case["executable"] == true {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(dir.join(rel), std::fs::Permissions::from_mode(0o755))
                    .unwrap();
            }
            let out = probe(&dir, "0", rel).unwrap();
            assert_eq!(out.door, case["door"].as_str().unwrap(), "{rel}");
            assert_eq!(out.open, case["open"].as_str().unwrap(), "{rel}");
            if out.door == "ipc" {
                assert_eq!(read_for_ipc(&dir, "0", rel).unwrap(), data);
            } else {
                assert_eq!(read_for_ipc(&dir, "0", rel).unwrap_err().code, "wrong_door");
            }
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn root_zero_is_the_last_vault() {
        let dir = configured("bytes-root");
        assert_eq!(root_dir(&dir, "0").unwrap(), dir);
        let second = testutil::temp_vault("bytes-root-next");
        crate::app_config::save(
            &dir,
            &crate::app_config::AppConfig {
                last_vault: Some(second.to_string_lossy().into_owned()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(root_dir(&dir, "0").unwrap(), second);
        let _ = std::fs::remove_dir_all(dir);
        let _ = std::fs::remove_dir_all(second);
    }

    #[test]
    fn an_unset_vault_is_no_such_root() {
        let dir = testutil::temp_vault("bytes-no-root");
        assert_eq!(root_dir(&dir, "0").unwrap_err().code, "no_such_root");
        assert_eq!(root_dir(&dir, "unknown").unwrap_err().code, "no_such_root");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_mounted_root_resolves_by_id() {
        let dir = testutil::temp_vault("bytes-mounted-config");
        let root = testutil::temp_vault("bytes-mounted-root");
        let mounted = crate::roots::mount(&dir, &root.to_string_lossy()).unwrap();
        assert_eq!(
            root_dir(&dir, &mounted.id).unwrap(),
            std::fs::canonicalize(&root).unwrap()
        );
        let _ = std::fs::remove_dir_all(dir);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn probe_answers_a_file_over_the_text_cap() {
        let dir = configured("bytes-probe-large");
        File::create(dir.join("large.png"))
            .unwrap()
            .set_len(5 * 1024 * 1024)
            .unwrap();
        assert_eq!(
            probe(&dir, "0", "large.png").unwrap(),
            Probe {
                size: 5 * 1024 * 1024,
                mime: "image/png".into(),
                kind: "image".into(),
                door: "scheme".into(),
                sniff: "binary".into(),
                open: "allow".into()
            }
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn read_for_ipc_refuses_over_the_cap() {
        let dir = configured("bytes-ipc-cap");
        File::create(dir.join("large.pdf"))
            .unwrap()
            .set_len(rules().limits.body_bytes + 1)
            .unwrap();
        assert_eq!(
            read_for_ipc(&dir, "0", "large.pdf").unwrap_err().code,
            "too_large"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_folder_is_refused_folder() {
        let dir = configured("bytes-folder");
        std::fs::create_dir(dir.join("folder.png")).unwrap();
        assert_eq!(probe(&dir, "0", "folder.png").unwrap_err().code, "folder");
        assert_eq!(
            probe(&dir, "0", "missing.png").unwrap_err().code,
            "not_found"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn outside_symlinks_are_refused_and_contained_links_resolve() {
        let dir = configured("bytes-links");
        let outside = testutil::temp_vault("bytes-links-outside");
        testutil::write(&outside, "secret.png", "secret");
        std::os::unix::fs::symlink(outside.join("secret.png"), dir.join("out.png")).unwrap();
        assert_eq!(probe(&dir, "0", "out.png").unwrap_err().code, "outside");
        testutil::write(&dir, "inside.png", "inside");
        std::os::unix::fs::symlink("inside.png", dir.join("link.png")).unwrap();
        assert_eq!(probe(&dir, "0", "link.png").unwrap().size, 6);
        let _ = std::fs::remove_dir_all(dir);
        let _ = std::fs::remove_dir_all(outside);
    }

    #[cfg(unix)]
    #[test]
    fn a_swap_after_resolution_never_opens_outside_bytes() {
        let root = configured("bytes-swap");
        let root = std::fs::canonicalize(root).unwrap();
        let outside = testutil::temp_vault("bytes-swap-outside");
        testutil::write(&outside, "secret.png", "outside secret");
        testutil::write(&root, "a.png", "inside");
        let resolved = locate_in(&root, "0", "a.png").unwrap();
        std::fs::remove_file(root.join("a.png")).unwrap();
        std::os::unix::fs::symlink(outside.join("secret.png"), root.join("a.png")).unwrap();
        assert_eq!(open_resolved(&root, resolved).unwrap_err().code, "outside");
        testutil::write(&root, "nested/secret.png", "inside");
        let resolved = locate_in(&root, "0", "nested/secret.png").unwrap();
        std::fs::rename(root.join("nested"), root.join("moved")).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("nested")).unwrap();
        assert_eq!(open_resolved(&root, resolved).unwrap_err().code, "outside");
        // Once opened, a later replacement cannot alter the handle's bytes.
        let mut opened = open_in(&root, "0", "moved/secret.png").unwrap();
        std::fs::remove_file(root.join("moved/secret.png")).unwrap();
        std::os::unix::fs::symlink(outside.join("secret.png"), root.join("moved/secret.png"))
            .unwrap();
        let mut content = String::new();
        opened.file.read_to_string(&mut content).unwrap();
        assert_eq!(content, "inside");
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(outside);
    }
}
