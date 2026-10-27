//! File-backed workflow definitions only. No activation or execution authority.
use super::definition::{self, DefinitionError, ValidatedDefinition};
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum FileError {
    InvalidPath,
    Unavailable,
    Busy,
    Conflict,
    InvalidJson,
    LimitExceeded,
    InvalidDefinition(DefinitionError),
    InvalidVersion,
    CommitUncertain,
    UnsupportedPlatform,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct DraftRef {
    pub workflow_id: String,
    pub etag: String,
}
#[derive(Debug)]
pub(super) struct Draft {
    pub reference: DraftRef,
    pub json: String,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PublicationRef {
    pub workflow_id: String,
    pub definition_hash: String,
    pub revision: u64,
}

#[derive(Debug)]
pub(super) struct CatalogPage {pub ids:Vec<String>,pub next_cursor:Option<String>,pub truncated:bool}
#[derive(Debug)]
pub(super) struct ExistingDocument {pub draft:Option<Draft>,pub publication_revision:u64,pub publication:Option<PublicationRef>,pub versions:Vec<String>,pub versions_truncated:bool}

use serde::{Deserialize, Serialize};
fn safe_id(id: &str) -> bool { definition::valid_identity(id) }
fn digest(text: &str) -> String { crate::ledger::sha256_hex(text.as_bytes()) }
fn hash_name(hash: &str) -> Result<String, FileError> {
    if hash.len() != 64 || !hash.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)) { return Err(FileError::InvalidPath); }
    Ok(format!("{hash}.json"))
}
fn bounded_json(text: &str) -> Result<(), FileError> {
    definition::canonical_json(text).map(|_| ())
        .map_err(|error| if error == DefinitionError::LimitExceeded { FileError::LimitExceeded } else { FileError::InvalidJson })
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Pointer {
    format_version: u32,
    workflow_id: String,
    definition_hash: String,
    revision: u64,
}
impl Pointer {
    fn reference(&self) -> PublicationRef {
        PublicationRef { workflow_id: self.workflow_id.clone(), definition_hash: self.definition_hash.clone(), revision: self.revision }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case", rename_all_fields = "camelCase", deny_unknown_fields)]
enum PointerV2 {
    Published {
        format_version: u32,
        workflow_id: String,
        definition_hash: String,
        revision: u64,
    },
    Unpublished {
        format_version: u32,
        workflow_id: String,
        revision: u64,
        transition_id: String,
        previous_definition_hash: String,
    },
}
fn transition_id(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn publication_revision(value: u64) -> Result<u64, FileError> {
    if value == 0 { return Err(FileError::InvalidVersion); }
    crate::actions::SafeCounter::new(value).map(|counter| counter.get())
        .map_err(|_| FileError::InvalidVersion)
}

// Preserve the actual format1 reader as the compatibility boundary. Dispatch
// for future formats must choose a different parser, never relax this one.
fn decode_v1_pointer(bytes: &str) -> Result<Pointer, FileError> {
    bounded_json(bytes)?;
    #[derive(Deserialize)]
    struct Header {
        #[serde(rename = "formatVersion")]
        format_version: u32,
    }
    let header: Header = serde_json::from_str(bytes).map_err(|_| FileError::InvalidVersion)?;
    if header.format_version != 1 {
        return Err(FileError::InvalidDefinition(DefinitionError::UnsupportedFormat));
    }
    serde_json::from_str(bytes).map_err(|_| FileError::InvalidVersion)
}

#[cfg(unix)]
mod owned {
    use super::*;
    use std::{ffi::{CStr, CString}, fs::{self, File}, io::{Read, Write}, os::{fd::{AsRawFd, FromRawFd}, unix::fs::{MetadataExt, OpenOptionsExt}}, path::PathBuf, sync::Arc};

    #[derive(Clone, Copy, PartialEq, Eq)]
    struct Identity { dev: u64, ino: u64 }
    impl Identity { fn of(meta: &fs::Metadata) -> Self { Self { dev: meta.dev(), ino: meta.ino() } } }
    fn name(value: &str) -> Result<CString, FileError> {
        if value.is_empty() || value.contains(['/', '\\']) || matches!(value, "." | "..") { return Err(FileError::InvalidPath); }
        CString::new(value).map_err(|_| FileError::InvalidPath)
    }
    fn open_at(parent: &File, name: &CStr, flags: i32) -> Result<File, FileError> {
        let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK, 0o600 as libc::c_uint) };
        if fd < 0 { return Err(FileError::Unavailable); }
        Ok(unsafe { File::from_raw_fd(fd) })
    }
    // One atomic namespace operation: a process interruption cannot leave a
    // second hard link that violates the immutable reader's nlink=1 rule.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn rename_exclusive(parent: &File, from: &CStr, to: &CStr) -> Result<bool, FileError> {
        #[cfg(target_os = "macos")]
        let result = unsafe { libc::renameatx_np(parent.as_raw_fd(), from.as_ptr(), parent.as_raw_fd(), to.as_ptr(), libc::RENAME_EXCL) };
        #[cfg(target_os = "linux")]
        let result = unsafe { libc::renameat2(parent.as_raw_fd(), from.as_ptr(), parent.as_raw_fd(), to.as_ptr(), libc::RENAME_NOREPLACE) };
        if result == 0 { return Ok(true); }
        if std::io::Error::last_os_error().raw_os_error() == Some(libc::EEXIST) {
            Ok(false)
        } else {
            Err(FileError::Unavailable)
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    fn rename_exclusive(_parent: &File, _from: &CStr, _to: &CStr) -> Result<bool, FileError> {
        Err(FileError::UnsupportedPlatform)
    }
    fn stat_at(parent: &File, name: &CStr) -> Result<Option<libc::stat>, FileError> {
        let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
        if unsafe { libc::fstatat(parent.as_raw_fd(), name.as_ptr(), stat.as_mut_ptr(), libc::AT_SYMLINK_NOFOLLOW) } != 0 {
            return if std::io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT) { Ok(None) } else { Err(FileError::Unavailable) };
        }
        Ok(Some(unsafe { stat.assume_init() }))
    }
    fn stat_identity(stat: &libc::stat) -> Identity { Identity { dev: stat.st_dev as u64, ino: stat.st_ino as u64 } }
    fn ordinary(meta: &fs::Metadata) -> Result<(), FileError> {
        if !meta.is_file() || meta.nlink() != 1 || meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o022 != 0 { return Err(FileError::InvalidPath); }
        Ok(())
    }
    pub(super) struct Directory {
        file: File,
        identity: Identity,
        path: PathBuf,
        parent: Option<(Arc<Directory>, CString)>,
    }
    impl Directory {
        fn root(path: &Path) -> Result<Arc<Self>, FileError> {
            if !path.is_absolute() { return Err(FileError::InvalidPath); }
            let path = fs::canonicalize(path).map_err(|_| FileError::Unavailable)?;
            let before = fs::symlink_metadata(&path).map_err(|_| FileError::Unavailable)?;
            if !before.is_dir() || before.file_type().is_symlink() { return Err(FileError::InvalidPath); }
            let file = fs::OpenOptions::new().read(true).custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC).open(&path).map_err(|_| FileError::Unavailable)?;
            let identity = Identity::of(&file.metadata().map_err(|_| FileError::Unavailable)?);
            if identity != Identity::of(&before) { return Err(FileError::Unavailable); }
            let directory = Arc::new(Self { file, identity, path, parent: None });
            directory.validate()?;
            Ok(directory)
        }
        fn child(parent: Arc<Self>, leaf: &str) -> Result<Arc<Self>, FileError> { Self::child_with_mode(parent,leaf,true) }
        fn existing_child(parent: Arc<Self>, leaf: &str) -> Result<Arc<Self>, FileError> { Self::child_with_mode(parent,leaf,false) }
        fn child_with_mode(parent: Arc<Self>, leaf: &str, create:bool) -> Result<Arc<Self>, FileError> {
            parent.validate()?;
            let child_name = name(leaf)?;
            if create {
            let made = unsafe { libc::mkdirat(parent.file.as_raw_fd(), child_name.as_ptr(), 0o700) };
            if made != 0 && std::io::Error::last_os_error().raw_os_error() != Some(libc::EEXIST) { return Err(FileError::Unavailable); }
            if made == 0 { parent.sync()?; }
            }
            let stat = stat_at(&parent.file, &child_name)?.ok_or(FileError::Unavailable)?;
            if stat.st_mode & libc::S_IFMT != libc::S_IFDIR { return Err(FileError::InvalidPath); }
            let file = open_at(&parent.file, &child_name, libc::O_RDONLY | libc::O_DIRECTORY)?;
            let metadata = file.metadata().map_err(|_| FileError::Unavailable)?;
            if !metadata.is_dir() || metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o022 != 0 || Identity::of(&metadata) != stat_identity(&stat) { return Err(FileError::InvalidPath); }
            let child = Arc::new(Self { file, identity: Identity::of(&metadata), path: parent.path.join(leaf), parent: Some((parent, child_name)) });
            child.validate()?;
            Ok(child)
        }
        fn validate(&self) -> Result<(), FileError> {
            let held = self.file.metadata().map_err(|_| FileError::Unavailable)?;
            if !held.is_dir() || Identity::of(&held) != self.identity { return Err(FileError::Unavailable); }
            let current = if let Some((parent, name)) = &self.parent {
                parent.validate()?;
                let stat = stat_at(&parent.file, name)?.ok_or(FileError::Unavailable)?;
                if stat.st_mode & libc::S_IFMT != libc::S_IFDIR { return Err(FileError::InvalidPath); }
                stat_identity(&stat)
            } else {
                let stat = fs::symlink_metadata(&self.path).map_err(|_| FileError::Unavailable)?;
                if !stat.is_dir() || stat.file_type().is_symlink() { return Err(FileError::InvalidPath); }
                Identity::of(&stat)
            };
            if current != self.identity { return Err(FileError::Unavailable); }
            Ok(())
        }

        // A fresh descriptor/open description avoids sharing readdir position
        // with retained parent FDs. No path-based directory reopening occurs.
        #[cfg(any(target_os="macos",target_os="linux"))]
        fn entries(&self,limit:usize)->Result<(Vec<String>,bool),FileError>{
            if limit==0{return Err(FileError::Unavailable);}
            self.validate()?;
            let before=self.file.metadata().map_err(|_|FileError::Unavailable)?;
            let directory=open_at(&self.file,c".",libc::O_RDONLY|libc::O_DIRECTORY)?;
            if Identity::of(&directory.metadata().map_err(|_|FileError::Unavailable)?)!=self.identity{return Err(FileError::Unavailable);}
            let stream=unsafe{libc::fdopendir(directory.as_raw_fd())};
            if stream.is_null(){return Err(FileError::Unavailable);}
            std::mem::forget(directory); // fdopendir now owns this fresh FD.
            struct Stream(*mut libc::DIR);
            impl Drop for Stream{fn drop(&mut self){unsafe{libc::closedir(self.0);}}}
            let stream=Stream(stream);let mut names=Vec::new();let mut complete=false;
            while names.len()<limit{
                #[cfg(target_os="macos")]
                unsafe{*libc::__error()=0;}
                #[cfg(target_os="linux")]
                unsafe{*libc::__errno_location()=0;}
                let entry=unsafe{libc::readdir(stream.0)};
                if entry.is_null(){
                    if std::io::Error::last_os_error().raw_os_error()!=Some(0){return Err(FileError::Unavailable);}
                    complete=true;break;
                }
                let name=unsafe{CStr::from_ptr((*entry).d_name.as_ptr())}.to_str().map_err(|_|FileError::InvalidPath)?;
                if matches!(name,"."|".."){continue;}
                names.push(name.to_owned());
            }
            self.validate()?;
            let after=self.file.metadata().map_err(|_|FileError::Unavailable)?;
            if before.modified().ok()!=after.modified().ok()||before.ctime()!=after.ctime()||before.ctime_nsec()!=after.ctime_nsec(){return Err(FileError::Unavailable);}
            // Reaching the work cap is conservatively incomplete, even when
            // exactly limit names exist. Never spend an unbounded scan to prove EOF.
            Ok((names,!complete))
        }
        #[cfg(not(any(target_os="macos",target_os="linux")))]
        fn entries(&self,_limit:usize)->Result<(Vec<String>,bool),FileError>{Err(FileError::UnsupportedPlatform)}
        fn optional_child(parent:Arc<Self>,leaf:&str)->Result<Option<Arc<Self>>,FileError>{
            parent.validate()?;let entry=name(leaf)?;
            if stat_at(&parent.file,&entry)?.is_none(){parent.validate()?;return Ok(None);}
            Self::existing_child(parent,leaf).map(Some)
        }
        fn ordinary_entry(&self,leaf:&str)->Result<(),FileError>{
            self.validate()?;let entry=name(leaf)?;
            let before=stat_at(&self.file,&entry)?.ok_or(FileError::Unavailable)?;
            if before.st_mode&libc::S_IFMT!=libc::S_IFREG||before.st_nlink!=1{return Err(FileError::InvalidPath);}
            let file=open_at(&self.file,&entry,libc::O_RDONLY)?;let held=file.metadata().map_err(|_|FileError::Unavailable)?;ordinary(&held)?;
            let named=stat_at(&self.file,&entry)?.ok_or(FileError::Unavailable)?;
            if Identity::of(&held)!=stat_identity(&before)||Identity::of(&held)!=stat_identity(&named){return Err(FileError::Unavailable);}
            self.validate()
        }

        fn sync(&self) -> Result<(), FileError> { self.file.sync_all().map_err(|_| FileError::Unavailable) }
        fn read(&self, leaf: &str) -> Result<Option<String>, FileError> {
            self.validate()?;
            let name = name(leaf)?;
            let Some(before) = stat_at(&self.file, &name)? else { return Ok(None); };
            if before.st_mode & libc::S_IFMT != libc::S_IFREG || before.st_nlink != 1 { return Err(FileError::InvalidPath); }
            let mut file = open_at(&self.file, &name, libc::O_RDONLY)?;
            let held = file.metadata().map_err(|_| FileError::Unavailable)?;
            ordinary(&held)?;
            if Identity::of(&held) != stat_identity(&before) { return Err(FileError::Unavailable); }
            if held.len() > definition::definition_byte_limit() as u64 { return Err(FileError::LimitExceeded); }
            let mut bytes = Vec::new();
            Read::by_ref(&mut file).take(definition::definition_byte_limit() as u64 + 1).read_to_end(&mut bytes).map_err(|_| FileError::Unavailable)?;
            if bytes.len() > definition::definition_byte_limit() { return Err(FileError::LimitExceeded); }
            let after = file.metadata().map_err(|_| FileError::Unavailable)?;
            let named = stat_at(&self.file, &name)?.ok_or(FileError::Unavailable)?;
            if Identity::of(&held) != stat_identity(&named) || held.len() != after.len() || held.modified().ok() != after.modified().ok() || held.ctime() != after.ctime() || held.ctime_nsec() != after.ctime_nsec() || bytes.len() as u64 != after.len() { return Err(FileError::Unavailable); }
            ordinary(&after)?;
            self.validate()?;
            String::from_utf8(bytes).map(Some).map_err(|_| FileError::InvalidJson)
        }
    }
    struct Lock { file: File, parent: Arc<Directory>, identity: Identity }
    impl Lock {
        fn acquire(parent: Arc<Directory>) -> Result<Self, FileError> {
            parent.validate()?;
            let file = open_at(&parent.file, c".lock", libc::O_RDWR | libc::O_CREAT)?;
            ordinary(&file.metadata().map_err(|_| FileError::Unavailable)?)?;
            file.try_lock().map_err(|_| FileError::Busy)?;
            let identity = Identity::of(&file.metadata().map_err(|_| FileError::Unavailable)?);
            let lock = Self { file, parent, identity };
            lock.validate()?;
            Ok(lock)
        }
        fn validate(&self) -> Result<(), FileError> {
            self.parent.validate()?;
            let held = self.file.metadata().map_err(|_| FileError::Unavailable)?;
            ordinary(&held)?;
            let current = stat_at(&self.parent.file, c".lock")?.ok_or(FileError::Unavailable)?;
            if current.st_mode & libc::S_IFMT != libc::S_IFREG || current.st_nlink != 1 || stat_identity(&current) != self.identity || Identity::of(&held) != self.identity { return Err(FileError::Unavailable); }
            Ok(())
        }
    }
    struct Temporary { directory: Arc<Directory>, name: CString, file: File, identity: Identity, moved: bool }
    impl Temporary {
        fn write(directory: Arc<Directory>, text: &str) -> Result<Self, FileError> {
            directory.validate()?;
            let name = name(&format!(".pending-{:032x}.json", rand::random::<u128>()))?;
            let file = open_at(&directory.file, &name, libc::O_RDWR | libc::O_CREAT | libc::O_EXCL)?;
            let identity = Identity::of(&file.metadata().map_err(|_| FileError::Unavailable)?);
            let mut pending = Self { directory, name, file, identity, moved: false };
            pending.file.write_all(text.as_bytes()).and_then(|_| pending.file.sync_all()).map_err(|_| FileError::Unavailable)?;
            pending.validate()?;
            Ok(pending)
        }
        fn validate(&self) -> Result<(), FileError> {
            self.directory.validate()?;
            ordinary(&self.file.metadata().map_err(|_| FileError::Unavailable)?)?;
            let current = stat_at(&self.directory.file, &self.name)?.ok_or(FileError::Unavailable)?;
            if current.st_mode & libc::S_IFMT != libc::S_IFREG || stat_identity(&current) != self.identity { return Err(FileError::Unavailable); }
            Ok(())
        }
        fn replace(mut self, target: &str) -> Result<(), FileError> {
            self.validate()?;
            let target = name(target)?;
            if unsafe { libc::renameat(self.directory.file.as_raw_fd(), self.name.as_ptr(), self.directory.file.as_raw_fd(), target.as_ptr()) } != 0 { return Err(FileError::Unavailable); }
            self.moved = true;
            Ok(())
        }
        fn install_version(mut self, target: &str) -> Result<bool, FileError> {
            self.validate()?;
            let target = name(target)?;
            if !rename_exclusive(&self.directory.file, &self.name, &target)? {
                // A prior interrupted installation may have created the valid
                // version before syncing this directory. Seal it before any
                // retry can publish a pointer in the separate parent directory.
                self.directory.sync()?;
                return Ok(false);
            }
            self.moved = true;
            // Model process loss immediately after the atomic namespace
            // operation, before directory sync or pointer publication.
            #[cfg(test)]
            fail(FailPoint::AfterVersionEntryInstall)?;
            self.directory.sync()?;
            Ok(true)
        }
    }
    impl Drop for Temporary {
        fn drop(&mut self) {
            if self.moved || self.directory.validate().is_err() { return; }
            if stat_at(&self.directory.file, &self.name).ok().flatten().is_some_and(|stat| stat_identity(&stat) == self.identity) {
                let _ = unsafe { libc::unlinkat(self.directory.file.as_raw_fd(), self.name.as_ptr(), 0) };
            }
        }
    }
    pub(super) struct Store {
        id: String,
        directory: Arc<Directory>,
        versions: Arc<Directory>,
    }
    /// The file lock stays owned across the caller's SQL/file/SQL phases.
    /// It is file exclusion only, never a native opening or execution proof.
    pub(super) struct PublicationEdit<'a> {
        store: &'a Store,
        lock: Lock,
    }
    impl PublicationEdit<'_> {
        pub(super) fn read(&self) -> Result<PublicationState, FileError> {
            self.lock.validate()?;
            let state = self.store.publication_state()?;
            self.lock.validate()?;
            Ok(state)
        }
        pub(super) fn publish(&self, draft: &DraftRef, expected: Option<u64>) -> Result<PublicationRef, FileError> {
            self.store.publish_locked(&self.lock, draft, expected)
        }
        pub(super) fn unpublish(&self, expected: &PublicationRef, key: &str) -> Result<UnpublicationRef, FileError> {
            if !transition_id(key) { return Err(FileError::InvalidPath); }
            if expected.workflow_id != self.store.id { return Err(FileError::Conflict); }
            let current = self.read()?;
            if let Some(recorded) = current.unpublished.as_ref() {
                if recorded.previous != *expected || recorded.transition_id != key { return Err(FileError::Conflict); }
                // An interruption may leave the correct namespace entry before
                // its directory sync. Exact replay seals that same entry only.
                self.store.directory.sync().and_then(|_| self.lock.validate())
                    .and_then(|_| if self.store.publication_state()? == current { Ok(()) } else { Err(FileError::Conflict) })
                    .map_err(|_| FileError::CommitUncertain)?;
                return Ok(recorded.clone());
            }
            if current.publication.as_ref() != Some(expected) { return Err(FileError::Conflict); }
            let revision = crate::actions::SafeCounter::new(current.revision)
                .and_then(crate::actions::SafeCounter::next).map_err(|_| FileError::LimitExceeded)?.get();
            let result = UnpublicationRef { previous: expected.clone(), revision, transition_id: key.into() };
            let pointer = PointerV2::Unpublished {
                format_version: 2, workflow_id: self.store.id.clone(), revision,
                transition_id: key.into(), previous_definition_hash: expected.definition_hash.clone(),
            };
            let bytes = serde_json::to_string(&pointer).map_err(|_| FileError::InvalidJson)?;
            let before = self.store.directory.read("published.json")?;
            let pending = Temporary::write(self.store.directory.clone(), &bytes)?;
            fail(FailPoint::BeforePointerRename)?;
            pointer_hook();
            self.lock.validate()?;
            if self.store.publication_state()? != current || self.store.directory.read("published.json")? != before {
                return Err(FileError::Conflict);
            }
            pending.replace("published.json")?;
            fail(FailPoint::AfterPointerRename).and_then(|_| self.store.directory.sync())
                .and_then(|_| self.lock.validate())
                .and_then(|_| {
                    if self.store.directory.read("published.json")?.as_deref() != Some(bytes.as_str())
                        || self.store.publication_state()?.unpublished.as_ref() != Some(&result) {
                        return Err(FileError::Conflict);
                    }
                    Ok(())
                }).map_err(|_| FileError::CommitUncertain)?;
            Ok(result)
        }
    }
    impl Store {
        pub(super) fn list_existing(vault:&Path,after:Option<&str>)->Result<CatalogPage,FileError>{
            if after.is_some_and(|value|!safe_id(value)){return Err(FileError::InvalidPath);}
            let empty=||CatalogPage{ids:vec![],next_cursor:None,truncated:false};
            let root=Directory::root(vault)?;
            let Some(control)=Directory::optional_child(root,".cerebro")?else{return Ok(empty());};
            let Some(workflows)=Directory::optional_child(control,"workflows")?else{return Ok(empty());};
            let limits=crate::runtime::workflows::catalog_policy();
            let(names,truncated)=workflows.entries(limits.scan_entries)?;
            let mut ids=Vec::new();
            for id in names{if safe_id(&id){Directory::existing_child(workflows.clone(),&id)?;if after.is_none_or(|cursor|id.as_str()>cursor){ids.push(id);}}}
            ids.sort();ids.dedup();
            let more=ids.len()>limits.page_size;ids.truncate(limits.page_size);
            let next_cursor=if more{ids.last().cloned()}else{None};
            workflows.validate()?;Ok(CatalogPage{ids,next_cursor,truncated})
        }
        pub(super) fn inspect_existing(vault:&Path,id:&str)->Result<ExistingDocument,FileError>{
            if !safe_id(id){return Err(FileError::InvalidPath);}
            let root=Directory::root(vault)?;
            let control=Directory::existing_child(root,".cerebro")?;
            let workflows=Directory::existing_child(control,"workflows")?;
            let directory=Directory::existing_child(workflows,id)?;
            let versions=Directory::existing_child(directory.clone(),"versions")?;
            let store=Self{id:id.into(),directory,versions};
            let draft=store.draft()?;let state=store.publication_state()?;
            let publication_revision=state.revision;let publication=state.publication;
            let limits=crate::runtime::workflows::catalog_policy();
            let(names,scan_truncated)=store.versions.entries(limits.scan_entries)?;
            let mut versions=names.into_iter().filter_map(|name|{let hash=name.strip_suffix(".json")?;if hash_name(hash).ok().as_deref()==Some(name.as_str()){Some(hash.to_owned())}else{None}}).collect::<Vec<_>>();
            versions.sort();versions.dedup();
            let versions_truncated=scan_truncated||versions.len()>limits.versions_per_workflow;
            versions.truncate(limits.versions_per_workflow);
            for hash in &versions{store.versions.ordinary_entry(&hash_name(hash)?)?;}
            // Enumeration yields bounded candidate references. Selecting one or
            // reading the publication still runs the exact canonical hash reader.
            store.directory.validate()?;store.versions.validate()?;
            Ok(ExistingDocument{draft,publication_revision,publication,versions,versions_truncated})
        }

        pub(super) fn read_existing_version(vault:&Path,id:&str,hash:&str)->Result<ValidatedDefinition,FileError>{
            if !safe_id(id){return Err(FileError::InvalidPath);}
            let root=Directory::root(vault)?;
            let control=Directory::existing_child(root,".cerebro")?;
            let workflows=Directory::existing_child(control,"workflows")?;
            let directory=Directory::existing_child(workflows,id)?;
            let versions=Directory::existing_child(directory.clone(),"versions")?;
            // Hash-addressed versions install atomically and are immutable. The
            // existing bounded reader validates every original directory/file
            // descriptor and its named identity; no writable lock is needed.
            Self{id:id.into(),directory,versions}.version(hash)
        }
        pub(super) fn open(vault: &Path, id: &str) -> Result<Self, FileError> {
            if !safe_id(id) { return Err(FileError::InvalidPath); }
            let root = Directory::root(vault)?;
            let control = Directory::child(root, ".cerebro")?;
            let workflows = Directory::child(control, "workflows")?;
            let directory = Directory::child(workflows, id)?;
            let _lock = Lock::acquire(directory.clone())?;
            let versions = Directory::child(directory.clone(), "versions")?;
            Ok(Self { id: id.into(), directory, versions })
        }
        pub(super) fn open_existing(vault: &Path, id: &str) -> Result<Self, FileError> {
            if !safe_id(id) { return Err(FileError::InvalidPath); }
            let root = Directory::root(vault)?;
            let control = Directory::existing_child(root, ".cerebro")?;
            let workflows = Directory::existing_child(control, "workflows")?;
            let directory = Directory::existing_child(workflows, id)?;
            let versions = Directory::existing_child(directory.clone(), "versions")?;
            Ok(Self { id: id.into(), directory, versions })
        }
        fn draft(&self) -> Result<Option<Draft>, FileError> {
            self.directory.read("draft.json")?.map(|json| {
                bounded_json(&json)?;
                Ok(Draft { reference: DraftRef { workflow_id: self.id.clone(), etag: digest(&json) }, json })
            }).transpose()
        }
        pub(super) fn read_draft(&self) -> Result<Option<Draft>, FileError> {
            let lock = Lock::acquire(self.directory.clone())?;
            let draft = self.draft()?;
            lock.validate()?;
            Ok(draft)
        }
        fn check_draft(&self, expected: Option<&str>) -> Result<(), FileError> {
            if self.draft()?.as_ref().map(|draft| draft.reference.etag.as_str()) != expected { return Err(FileError::Conflict); }
            Ok(())
        }
        pub(super) fn save_draft(&self, json: &str, expected: Option<&str>) -> Result<DraftRef, FileError> {
            bounded_json(json)?;
            let lock = Lock::acquire(self.directory.clone())?;
            self.check_draft(expected)?;
            let pending = Temporary::write(self.directory.clone(), json)?;
            fail(FailPoint::BeforeDraftRename)?;
            lock.validate()?;
            self.check_draft(expected)?;
            pending.replace("draft.json")?;
            // From rename onward there is no safe promise that old bytes remain.
            fail(FailPoint::AfterDraftRename).and_then(|_| self.directory.sync()).and_then(|_| lock.validate())
                .and_then(|_| self.check_draft(Some(&digest(json)))).map_err(|_| FileError::CommitUncertain)?;
            Ok(DraftRef { workflow_id: self.id.clone(), etag: digest(json) })
        }
        fn version(&self, hash: &str) -> Result<ValidatedDefinition, FileError> {
            let leaf = hash_name(hash)?;
            let bytes = self.versions.read(&leaf)?.ok_or(FileError::InvalidVersion)?;
            let version = definition::validate(&bytes).map_err(|error| {
                if error == DefinitionError::UnsupportedFormat { FileError::InvalidDefinition(error) } else { FileError::InvalidVersion }
            })?;
            if version.definition_hash != hash || version.definition.workflow_id != self.id || version.canonical != bytes { return Err(FileError::InvalidVersion); }
            Ok(version)
        }
        pub(super) fn read_version(&self, hash: &str) -> Result<ValidatedDefinition, FileError> {
            let lock = Lock::acquire(self.directory.clone())?;
            let version = self.version(hash)?;
            lock.validate()?;
            Ok(version)
        }
        fn publication_state(&self) -> Result<PublicationState, FileError> {
            let Some(bytes) = self.directory.read("published.json")? else {
                return Ok(PublicationState { revision: 0, publication: None, unpublished: None });
            };
            bounded_json(&bytes)?;
            #[derive(Deserialize)]
            struct Header { #[serde(rename = "formatVersion")] format_version: u32 }
            let header: Header = serde_json::from_str(&bytes).map_err(|_| FileError::InvalidVersion)?;
            let state = match header.format_version {
                1 => {
                    let pointer = decode_v1_pointer(&bytes)?;
                    if pointer.workflow_id != self.id { return Err(FileError::InvalidVersion); }
                    publication_revision(pointer.revision)?;
                    self.version(&pointer.definition_hash)?;
                    PublicationState { revision: pointer.revision, publication: Some(pointer.reference()), unpublished: None }
                }
                2 => {
                    let pointer: PointerV2 = serde_json::from_str(&bytes).map_err(|_| FileError::InvalidVersion)?;
                    match pointer {
                        PointerV2::Published { workflow_id, definition_hash, revision, .. } => {
                            if workflow_id != self.id { return Err(FileError::InvalidVersion); }
                            publication_revision(revision)?;
                            self.version(&definition_hash)?;
                            PublicationState { revision, publication: Some(PublicationRef { workflow_id, definition_hash, revision }), unpublished: None }
                        }
                        PointerV2::Unpublished { workflow_id, revision, transition_id: key, previous_definition_hash, .. } => {
                            if workflow_id != self.id || revision < 2 || !transition_id(&key) { return Err(FileError::InvalidVersion); }
                            publication_revision(revision)?;
                            self.version(&previous_definition_hash)?;
                            PublicationState { revision, publication: None, unpublished: Some(UnpublicationRef {
                                previous: PublicationRef { workflow_id, definition_hash: previous_definition_hash, revision: revision - 1 },
                                revision, transition_id: key,
                            }) }
                        }
                    }
                }
                _ => return Err(FileError::InvalidDefinition(DefinitionError::UnsupportedFormat)),
            };
            self.directory.validate()?;
            Ok(state)
        }
        pub(super) fn begin_publication_edit(&self) -> Result<PublicationEdit<'_>, FileError> {
            let lock = Lock::acquire(self.directory.clone())?;
            Ok(PublicationEdit { store: self, lock })
        }
        pub(super) fn read_publication_state(&self) -> Result<PublicationState, FileError> {
            self.begin_publication_edit()?.read()
        }
        pub(super) fn read_existing_publication_state(vault: &Path, id: &str) -> Result<PublicationState, FileError> {
            if !safe_id(id) { return Err(FileError::InvalidPath); }
            let root = Directory::root(vault)?;
            let control = Directory::existing_child(root, ".cerebro")?;
            let workflows = Directory::existing_child(control, "workflows")?;
            let directory = Directory::existing_child(workflows, id)?;
            let versions = Directory::existing_child(directory.clone(), "versions")?;
            Self { id: id.into(), directory, versions }.publication_state()
        }
        pub(super) fn read_publication(&self) -> Result<Option<PublicationRef>, FileError> {
            let lock = Lock::acquire(self.directory.clone())?;
            let publication = self.publication_state()?.publication;
            lock.validate()?;
            Ok(publication)
        }
        fn check_publication(&self, expected: Option<u64>) -> Result<(), FileError> {
            let revision = self.publication_state()?.revision;
            if (revision != 0).then_some(revision) != expected { return Err(FileError::Conflict); }
            Ok(())
        }
        pub(super) fn publish(&self, draft: &DraftRef, expected: Option<u64>) -> Result<PublicationRef, FileError> {
            self.begin_publication_edit()?.publish(draft, expected)
        }
        fn publish_locked(&self, lock: &Lock, draft: &DraftRef, expected: Option<u64>) -> Result<PublicationRef, FileError> {
            if draft.workflow_id != self.id { return Err(FileError::Conflict); }
            lock.validate()?;
            self.check_publication(expected)?;
            let prior_pointer = self.directory.read("published.json")?;
            let current = self.draft()?.ok_or(FileError::Conflict)?;
            if current.reference != *draft { return Err(FileError::Conflict); }
            let validated = definition::validate(&current.json).map_err(FileError::InvalidDefinition)?;
            if validated.definition.workflow_id != self.id { return Err(FileError::InvalidDefinition(DefinitionError::InvalidIdentity)); }
            let leaf = hash_name(&validated.definition_hash)?;
            let revision = crate::actions::SafeCounter::new(expected.unwrap_or(0))
                .and_then(crate::actions::SafeCounter::next).map_err(|_| FileError::LimitExceeded)?.get();
            let published = PublicationRef { workflow_id: self.id.clone(), definition_hash: validated.definition_hash.clone(), revision };
            let pointer = PointerV2::Published { format_version: 2, workflow_id: published.workflow_id.clone(), definition_hash: published.definition_hash.clone(), revision };
            let pointer_bytes = serde_json::to_string(&pointer).map_err(|_| FileError::InvalidJson)?;
            let version = Temporary::write(self.versions.clone(), &validated.canonical)?;
            fail(FailPoint::BeforeVersionInstall)?;
            lock.validate()?;
            version.install_version(&leaf)?;
            if self.version(&validated.definition_hash)?.canonical != validated.canonical { return Err(FileError::InvalidVersion); }
            let pending = Temporary::write(self.directory.clone(), &pointer_bytes)?;
            fail(FailPoint::BeforePointerRename)?;
            pointer_hook();
            lock.validate()?;
            self.check_draft(Some(&draft.etag))?;
            self.check_publication(expected)?;
            if self.directory.read("published.json")? != prior_pointer { return Err(FileError::Conflict); }
            if self.version(&validated.definition_hash)?.canonical != validated.canonical { return Err(FileError::InvalidVersion); }
            pending.replace("published.json")?;
            fail(FailPoint::AfterPointerRename).and_then(|_| self.directory.sync()).and_then(|_| lock.validate())
                .and_then(|_| {
                    if self.directory.read("published.json")?.as_deref() != Some(pointer_bytes.as_str()) { return Err(FileError::Conflict); }
                    self.version(&published.definition_hash).map(|_| ())
                }).map_err(|_| FileError::CommitUncertain)?;
            Ok(published)
        }
    }
}

#[cfg(unix)]
pub(super) struct DefinitionStore { store: owned::Store }
#[cfg(unix)]
impl DefinitionStore {
    pub(super) fn list_existing(vault:&Path,after:Option<&str>)->Result<CatalogPage,FileError>{owned::Store::list_existing(vault,after)}
    pub(super) fn inspect_existing(vault:&Path,id:&str)->Result<ExistingDocument,FileError>{owned::Store::inspect_existing(vault,id)}

    pub(super) fn open(vault: &Path, id: &str) -> Result<Self, FileError> { owned::Store::open(vault, id).map(|store| Self { store }) }
    pub(super) fn open_existing(vault: &Path, id: &str) -> Result<Self, FileError> { owned::Store::open_existing(vault, id).map(|store| Self { store }) }
    pub(super) fn read_existing_version(vault:&Path,id:&str,hash:&str)->Result<ValidatedDefinition,FileError>{owned::Store::read_existing_version(vault,id,hash)}

    pub(super) fn save_draft(&self, json: &str, expected_etag: Option<&str>) -> Result<DraftRef, FileError> { self.store.save_draft(json, expected_etag) }
    pub(super) fn read_draft(&self) -> Result<Option<Draft>, FileError> { self.store.read_draft() }
    pub(super) fn publish(&self, draft: &DraftRef, expected_revision: Option<u64>) -> Result<PublicationRef, FileError> { self.store.publish(draft, expected_revision) }
    pub(super) fn read_publication(&self) -> Result<Option<PublicationRef>, FileError> { self.store.read_publication() }
    pub(super) fn read_version(&self, hash: &str) -> Result<ValidatedDefinition, FileError> { self.store.read_version(hash) }
}
#[cfg(not(unix))]
pub(super) struct DefinitionStore;
#[cfg(not(unix))]
impl DefinitionStore {
    pub(super) fn list_existing(vault:&Path,after:Option<&str>)->Result<CatalogPage,FileError>{let _=(vault,after);Err(FileError::UnsupportedPlatform)}
    pub(super) fn inspect_existing(vault:&Path,id:&str)->Result<ExistingDocument,FileError>{let _=(vault,id);Err(FileError::UnsupportedPlatform)}

    pub(super) fn open(_vault: &Path, _id: &str) -> Result<Self, FileError> { Err(FileError::UnsupportedPlatform) }
    pub(super) fn read_existing_version(_vault:&Path,_id:&str,_hash:&str)->Result<ValidatedDefinition,FileError>{Err(FileError::UnsupportedPlatform)}
}


/// File metadata only. A publication edit is not native execution authority.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PublicationState {
    pub revision: u64,
    pub publication: Option<PublicationRef>,
    pub unpublished: Option<UnpublicationRef>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct UnpublicationRef {
    pub previous: PublicationRef,
    pub revision: u64,
    pub transition_id: String,
}
#[cfg(unix)]
pub(super) struct PublicationEdit<'a> {
    edit: owned::PublicationEdit<'a>,
}
#[cfg(unix)]
impl PublicationEdit<'_> {
    pub(super) fn read(&self) -> Result<PublicationState, FileError> {
        self.edit.read()
    }
    pub(super) fn unpublish(
        &self,
        expected: &PublicationRef,
        transition_id: &str,
    ) -> Result<UnpublicationRef, FileError> {
        self.edit.unpublish(expected, transition_id)
    }
    pub(super) fn publish(
        &self,
        draft: &DraftRef,
        expected_revision: Option<u64>,
    ) -> Result<PublicationRef, FileError> {
        self.edit.publish(draft, expected_revision)
    }
}
#[cfg(unix)]
impl DefinitionStore {
    pub(super) fn begin_publication_edit(&self) -> Result<PublicationEdit<'_>, FileError> {
        self.store.begin_publication_edit().map(|edit| PublicationEdit { edit })
    }
    pub(super) fn read_publication_state(&self) -> Result<PublicationState, FileError> {
        self.store.read_publication_state()
    }
    pub(super) fn read_existing_publication_state(
        vault: &Path,
        id: &str,
    ) -> Result<PublicationState, FileError> {
        owned::Store::read_existing_publication_state(vault, id)
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum FailPoint {
    BeforeVersionInstall,
    #[cfg(test)]
    AfterVersionEntryInstall,
    BeforePointerRename,
    AfterPointerRename,
    BeforeDraftRename,
    AfterDraftRename,
}
#[cfg(test)]
thread_local! {
    static FAILURE: std::cell::Cell<Option<FailPoint>> = const { std::cell::Cell::new(None) };
    static POINTER_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
}
fn fail(point: FailPoint) -> Result<(), FileError> {
    #[cfg(test)]
    if FAILURE.with(|slot| slot.get() == Some(point)) { return Err(FileError::Unavailable); }
    #[cfg(not(test))]
    let _ = point;
    Ok(())
}
fn pointer_hook() {
    #[cfg(test)]
    if let Some(hook) = POINTER_HOOK.with(|slot| slot.borrow_mut().take()) { hook(); }
}
#[cfg(test)]
fn with_failure<T>(point: FailPoint, run: impl FnOnce() -> T) -> T {
    struct Reset(Option<FailPoint>);
    impl Drop for Reset { fn drop(&mut self) { FAILURE.with(|slot| slot.set(self.0)); } }
    let _reset = Reset(FAILURE.with(|slot| slot.replace(Some(point))));
    run()
}
#[cfg(test)]
fn with_pointer_hook<T>(hook: impl FnOnce() + 'static, run: impl FnOnce() -> T) -> T {
    struct Reset(Option<Box<dyn FnOnce()>>);
    impl Drop for Reset { fn drop(&mut self) { POINTER_HOOK.with(|slot| *slot.borrow_mut() = self.0.take()); } }
    let _reset = Reset(POINTER_HOOK.with(|slot| slot.replace(Some(Box::new(hook)))));
    run()
}
#[cfg(all(test, unix))]
#[path = "files_tests.rs"]
mod tests;
