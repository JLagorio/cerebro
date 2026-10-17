//! Attachment placement behind write.rs's human receipt doors. The directory
//! lock covers reuse and name allocation; Unix writes address a pinned folder.
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Seek, Write},
    path::{Path, PathBuf},
};
use unicode_normalization::UnicodeNormalization;

pub(super) const FOLDER_REFUSAL: &str = "attachments/ is not the folder the scanner skips";
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct AttachmentImport {
    pub path: String,
    pub reused: bool,
}
pub(super) struct Placed {
    pub result: AttachmentImport,
    pub hash: String,
}
fn cap() -> u64 {
    crate::files::kinds::limits().attachment_bytes
}
fn basename(name: &str) -> &str {
    name.rsplit(['/', '\\']).next().unwrap_or("").trim_matches(|c| matches!(c, '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'))
}
pub(super) fn attachment_refusal(name: &str, size: u64) -> Option<String> {
    let name = basename(name);
    if name.is_empty() {
        return Some("a file needs a name".into());
    }
    if super::scan::is_hidden(name) {
        return Some(format!("{name} is hidden"));
    }
    (size > cap()).then(|| format!("{name} is over {} MB", cap() / 1_000_000))
}
pub(super) fn attachment_name(name: &str) -> String {
    let safe: String = basename(name)
        .chars()
        .map(|c| {
            if c.is_control() || "<>:|?*#%\"".contains(c) {
                '-'
            } else {
                c
            }
        })
        .collect();
    let safe = basename(&safe);
    let (stem, ext) = match safe.rfind('.') {
        Some(dot) if dot > 0 => (&safe[..dot], &safe[dot..]),
        _ => (safe, ""),
    };
    let mut end = stem.len().min(200);
    while !stem.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{ext}", if end == 0 { "file" } else { &stem[..end] })
}
fn fold(name: &str) -> String {
    name.nfc().flat_map(char::to_lowercase).collect()
}
fn parts(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    }
}
fn family(candidate: &str, name: &str) -> Option<u64> {
    let candidate = fold(candidate);
    let name = fold(name);
    if candidate == name {
        return Some(1);
    }
    let (stem, ext) = parts(&name);
    let middle = candidate
        .strip_prefix(stem)?
        .strip_prefix('-')?
        .strip_suffix(ext)?;
    let number = middle.parse::<u64>().ok()?;
    (number >= 2 && middle == number.to_string()).then_some(number)
}
fn hash(file: &mut File) -> Result<String, String> {
    file.rewind().map_err(|e| e.to_string())?;
    let mut digest = Sha256::new();
    let mut buf = [0; 64 * 1024];
    let mut bounded = file.take(cap() + 1);
    let mut total = 0_u64;
    loop {
        let n = bounded.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        total += n as u64;
        digest.update(&buf[..n]);
    }
    if total > cap() {
        return Err("The attachment changed while it was being read".into());
    }
    Ok(format!("{:x}", digest.finalize()))
}

struct Directory {
    path: PathBuf,
    file: File,
}
const STAGED_PREFIX: &str = ".attachment.cerebro-tmp-";
fn staged_name(name: &str) -> bool {
    name.strip_prefix(STAGED_PREFIX)
        .is_some_and(|suffix| suffix.len() == 16 && suffix.bytes().all(|b| b.is_ascii_hexdigit()))
}
impl Directory {
    fn open(vault: &Path) -> Result<Self, String> {
        let root = std::fs::canonicalize(vault).map_err(|e| e.to_string())?;
        for entry in std::fs::read_dir(&root).map_err(|e| e.to_string())? {
            let name = entry.map_err(|e| e.to_string())?.file_name();
            let name = name.to_string_lossy();
            if fold(&name) == "attachments" && name != "attachments" {
                return Err(FOLDER_REFUSAL.into());
            }
        }
        let path = root.join(super::write::ATTACHMENTS_DIR);
        match std::fs::create_dir(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e.to_string()),
        }
        let metadata = std::fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(FOLDER_REFUSAL.into());
        }
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC);
        }
        let file = options.open(&path).map_err(|_| FOLDER_REFUSAL.to_owned())?;
        Ok(Self { path, file })
    }
    fn entries(&self) -> Result<Vec<String>, String> {
        #[cfg(unix)]
        {
            use std::os::fd::{FromRawFd, IntoRawFd};
            let fd = self
                .file
                .try_clone()
                .map_err(|e| e.to_string())?
                .into_raw_fd();
            // SAFETY: fd is a fresh owned directory descriptor; fdopendir
            // takes ownership only on success.
            let raw = unsafe { libc::fdopendir(fd) };
            if raw.is_null() {
                let error = std::io::Error::last_os_error();
                // SAFETY: fdopendir failed, so fd still belongs to us.
                drop(unsafe { File::from_raw_fd(fd) });
                return Err(error.to_string());
            }
            struct Listing(*mut libc::DIR);
            impl Drop for Listing {
                fn drop(&mut self) {
                    // SAFETY: this DIR came from fdopendir and closes once.
                    unsafe {
                        libc::closedir(self.0);
                    }
                }
            }
            let listing = Listing(raw);
            let mut names = Vec::new();
            loop {
                // SAFETY: dirent contains only integers and byte arrays. Its
                // fixed name buffer covers NAME_MAX on our macOS/Linux targets.
                let mut entry: libc::dirent = unsafe { std::mem::zeroed() };
                let mut found = std::ptr::null_mut();
                // SAFETY: the DIR is exclusively borrowed here and both
                // output pointers live throughout the call.
                let error = unsafe { libc::readdir_r(listing.0, &mut entry, &mut found) };
                if error != 0 {
                    return Err(std::io::Error::from_raw_os_error(error).to_string());
                }
                if found.is_null() {
                    break;
                }
                // SAFETY: a successful readdir_r NUL-terminates d_name.
                let name =
                    unsafe { std::ffi::CStr::from_ptr(entry.d_name.as_ptr()) }.to_string_lossy();
                if name != "." && name != ".." {
                    names.push(name.into_owned());
                }
            }
            Ok(names)
        }
        #[cfg(not(unix))]
        std::fs::read_dir(&self.path)
            .map_err(|e| e.to_string())?
            .map(|entry| {
                entry
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .map_err(|e| e.to_string())
            })
            .collect()
    }
    fn open_file(&self, name: &str, create: bool) -> Result<File, std::io::Error> {
        #[cfg(unix)]
        {
            use std::os::fd::{AsRawFd, FromRawFd};
            let name = std::ffi::CString::new(name)?;
            let flags = libc::O_NOFOLLOW
                | libc::O_CLOEXEC
                | libc::O_NONBLOCK
                | if create {
                    libc::O_RDWR | libc::O_CREAT | libc::O_EXCL
                } else {
                    libc::O_RDONLY
                };
            // SAFETY: an owned directory, a single NUL-terminated name, and
            // create_new/no-follow prevent truncation or following a link.
            let fd = unsafe { libc::openat(self.file.as_raw_fd(), name.as_ptr(), flags, 0o600) };
            if fd < 0 {
                return Err(std::io::Error::last_os_error());
            }
            // SAFETY: openat returned one fresh descriptor, owned here once.
            Ok(unsafe { File::from_raw_fd(fd) })
        }
        #[cfg(not(unix))]
        {
            let path = self.path.join(name);
            if std::fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
                return Err(std::io::Error::other(FOLDER_REFUSAL));
            }
            OpenOptions::new()
                .read(true)
                .write(create)
                .create_new(create)
                .open(path)
        }
    }
    fn remove_staged(&self, name: &str) {
        // Even a future mistaken call cannot unlink an authored page or an
        // attachment: only one exact hidden staging component is eligible.
        if !staged_name(name) {
            return;
        }
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            if let Ok(name) = std::ffi::CString::new(name) {
                // SAFETY: this is only our unpredictable staging entry.
                unsafe {
                    libc::unlinkat(self.file.as_raw_fd(), name.as_ptr(), 0);
                }
            }
        }
        #[cfg(not(unix))]
        {
            let _ = std::fs::remove_file(self.path.join(name));
        }
    }
    fn install(&self, temp: &str, name: &str) -> Result<bool, String> {
        // A changed folder never redirects the pinned descriptor's writes.
        #[cfg(unix)]
        {
            use std::os::{fd::AsRawFd, unix::fs::MetadataExt};
            let current = std::fs::symlink_metadata(&self.path).map_err(|_| FOLDER_REFUSAL)?;
            let held = self.file.metadata().map_err(|e| e.to_string())?;
            if current.file_type().is_symlink()
                || current.dev() != held.dev()
                || current.ino() != held.ino()
            {
                return Err(FOLDER_REFUSAL.into());
            }
            let temp = std::ffi::CString::new(temp).map_err(|e| e.to_string())?;
            let name = std::ffi::CString::new(name).map_err(|e| e.to_string())?;
            // SAFETY: both names are single components in the held directory.
            // linkat installs atomically only if the destination is absent;
            // unlike rename it cannot overwrite an external concurrent create.
            let ok = unsafe {
                libc::linkat(
                    self.file.as_raw_fd(),
                    temp.as_ptr(),
                    self.file.as_raw_fd(),
                    name.as_ptr(),
                    0,
                )
            };
            if ok == 0 {
                let _ = self.file.sync_all();
                return Ok(true);
            }
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                return Ok(false);
            }
            Err(error.to_string())
        }
        #[cfg(not(unix))]
        {
            match std::fs::hard_link(self.path.join(temp), self.path.join(name)) {
                Ok(()) => Ok(true),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
                Err(e) => Err(e.to_string()),
            }
        }
    }
}
struct Staged<'a> {
    directory: &'a Directory,
    name: String,
    file: File,
}
impl<'a> Staged<'a> {
    fn create(directory: &'a Directory, name: String) -> Result<Self, String> {
        if !staged_name(&name) {
            return Err("Invalid attachment staging name".into());
        }
        // Arm cleanup only after exclusive creation succeeds. An existing
        // entry belongs to somebody else, even if its spelling collides.
        let file = directory
            .open_file(&name, true)
            .map_err(|e| e.to_string())?;
        Ok(Self {
            directory,
            name,
            file,
        })
    }
}
impl Drop for Staged<'_> {
    fn drop(&mut self) {
        self.directory.remove_staged(&self.name);
    }
}

fn place(
    vault: &Path,
    name: &str,
    stage: impl FnOnce(&mut File) -> Result<(), String>,
) -> Result<Placed, String> {
    let _lock = super::write::lock_paths(vault, &[super::write::ATTACHMENTS_DIR])
        .map_err(|_| "attachments/ is not the folder the scanner skips".to_string())?;
    let directory = Directory::open(vault)?;
    let mut temp = Staged::create(
        &directory,
        format!("{STAGED_PREFIX}{:016x}", rand::random::<u64>()),
    )?;
    let file = &mut temp.file;
    stage(file)?;
    let size = file.metadata().map_err(|e| e.to_string())?.len();
    if let Some(why) = attachment_refusal(name, size) {
        return Err(why);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = file
            .metadata()
            .map_err(|e| e.to_string())?
            .permissions()
            .mode()
            & 0o666;
        file.set_permissions(std::fs::Permissions::from_mode(mode))
            .map_err(|e| e.to_string())?;
    }
    file.sync_all().map_err(|e| e.to_string())?;
    let digest = hash(file)?;
    let name = attachment_name(name);
    let held_names = directory.entries()?;
    let mut candidates = held_names
        .iter()
        .filter_map(|path| family(path, &name).map(|order| (order, path.clone())))
        .collect::<Vec<_>>();
    candidates.sort();
    for (_, path) in candidates {
        let Ok(mut candidate) = directory.open_file(&path, false) else {
            continue;
        };
        let Ok(meta) = candidate.metadata() else {
            continue;
        };
        if meta.is_file() && meta.len() == size && hash(&mut candidate)? == digest {
            return Ok(Placed {
                result: AttachmentImport {
                    path: format!("attachments/{path}"),
                    reused: true,
                },
                hash: digest,
            });
        }
    }
    let (stem, ext) = parts(&name);
    for n in 1_u64.. {
        let target = if n == 1 {
            name.clone()
        } else {
            format!("{stem}-{n}{ext}")
        };
        if held_names.iter().any(|held| fold(held) == fold(&target)) {
            continue;
        }
        if directory.install(&temp.name, &target)? {
            return Ok(Placed {
                result: AttachmentImport {
                    path: format!("attachments/{target}"),
                    reused: false,
                },
                hash: digest,
            });
        }
    }
    unreachable!()
}

pub(super) fn import_file(vault: &Path, source: &str) -> Result<Placed, String> {
    let path = Path::new(source);
    if !path.is_absolute() {
        return Err(format!("attachment source must be absolute: {source}"));
    }
    let name = basename(source);
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK | libc::O_CLOEXEC);
    }
    let mut source = options
        .open(path)
        .map_err(|_| format!("{name} could not be read"))?;
    let meta = source
        .metadata()
        .map_err(|_| format!("{name} could not be read"))?;
    if meta.is_dir() {
        return Err(format!("{name} is a folder"));
    }
    if !meta.is_file() {
        return Err(format!("{name} is not a file"));
    }
    if let Some(why) = attachment_refusal(name, meta.len()) {
        return Err(why);
    }
    place(vault, name, |output| {
        std::io::copy(&mut (&mut source).take(cap() + 1), output).map_err(|e| e.to_string())?;
        #[cfg(target_os = "macos")]
        {
            use std::os::fd::AsRawFd;
            // SAFETY: both descriptors are owned throughout this call. Copy
            // xattrs (including quarantine), never data or permissions; data
            // was streamed under the cap and execute bits are never granted.
            if unsafe {
                libc::fcopyfile(
                    source.as_raw_fd(),
                    output.as_raw_fd(),
                    std::ptr::null_mut(),
                    libc::COPYFILE_XATTR,
                )
            } != 0
            {
                return Err(std::io::Error::last_os_error().to_string());
            }
        }
        Ok(())
    })
}
pub(super) fn import_bytes(vault: &Path, name: &str, encoded: &str) -> Result<Placed, String> {
    use base64::Engine as _;
    if let Some(why) = attachment_refusal(name, 0) {
        return Err(why);
    }
    if encoded.len() as u64 > cap().div_ceil(3) * 4 {
        return Err(format!(
            "{} is over {} MB",
            basename(name),
            cap() / 1_000_000
        ));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| format!("{} could not be read", basename(name)))?;
    if let Some(why) = attachment_refusal(name, bytes.len() as u64) {
        return Err(why);
    }
    place(vault, name, |output| {
        output.write_all(&bytes).map_err(|e| e.to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn failed_staging_creation_preserves_the_existing_entry() {
        let vault = super::super::testutil::temp_vault("attachment-staging-collision");
        let directory = Directory::open(&vault).unwrap();
        let name = format!("{STAGED_PREFIX}0123456789abcdef");
        std::fs::write(directory.path.join(&name), "existing bytes").unwrap();
        assert!(Staged::create(&directory, name.clone()).is_err());
        assert_eq!(
            std::fs::read_to_string(directory.path.join(name)).unwrap(),
            "existing bytes"
        );
        let _ = std::fs::remove_dir_all(vault);
    }
    #[test]
    fn staging_cleanup_can_remove_only_its_hidden_name() {
        let vault = super::super::testutil::temp_vault("attachment-staging-cleanup");
        let directory = Directory::open(&vault).unwrap();
        super::super::testutil::write(&vault, "page.md", "# Page");
        std::fs::write(directory.path.join("picture.png"), b"picture").unwrap();
        for name in [
            "../page.md",
            "picture.png",
            ".attachment.cerebro-tmp-page.md",
        ] {
            directory.remove_staged(name);
            assert!(Staged::create(&directory, name.to_owned()).is_err());
        }
        let name = format!("{STAGED_PREFIX}0123456789abcdef");
        let staged = Staged::create(&directory, name.clone()).unwrap();
        assert!(directory.path.join(&name).exists());
        drop(staged);
        assert!(!directory.path.join(name).exists());
        assert_eq!(
            std::fs::read_to_string(vault.join("page.md")).unwrap(),
            "# Page"
        );
        assert_eq!(
            std::fs::read(directory.path.join("picture.png")).unwrap(),
            b"picture"
        );
        let _ = std::fs::remove_dir_all(vault);
    }
}
