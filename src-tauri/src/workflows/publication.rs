//! Descriptor-backed publication facts only; the native owner supplies authority.
#[cfg(unix)]
use super::files::{self, DefinitionStore};
use std::path::{Path, PathBuf};
pub(crate) use super::files::{
    FileError as Error, PublicationRef as Reference, PublicationState as State,
    UnpublicationRef as Unpublished,
};
#[cfg(unix)]
pub(crate) struct Directory { inner: DefinitionStore, root: PathBuf }
#[cfg(unix)]
pub(crate) struct Edit<'a> { inner: files::PublicationEdit<'a>, root: &'a Path }
#[cfg(unix)]
impl Directory {
    pub(crate) fn open_existing(root: &Path, workflow: &str) -> Result<Self, Error> {
        DefinitionStore::open_existing(root, workflow).map(|inner| Self { inner, root: root.into() })
    }
    pub(crate) fn edit(&self) -> Result<Edit<'_>, Error> {
        self.inner.begin_publication_edit().map(|inner| Edit { inner, root: &self.root })
    }
}
#[cfg(unix)]
impl Edit<'_> {
    pub(crate) fn root(&self) -> &Path { self.root }
    pub(crate) fn read(&self) -> Result<State, Error> { self.inner.read() }
    pub(crate) fn unpublish(&self, original: &Reference, key: &str) -> Result<Unpublished, Error> {
        self.inner.unpublish(original, key)
    }
    pub(crate) fn publish(&self, workflow: &str, etag: &str, revision: Option<u64>) -> Result<Reference, Error> {
        self.inner.publish(&files::DraftRef { workflow_id: workflow.into(), etag: etag.into() }, revision)
    }
}
#[cfg(not(unix))]
pub(crate) struct Directory;
#[cfg(not(unix))]
pub(crate) struct Edit<'a> { root: &'a Path }
#[cfg(not(unix))]
impl Directory {
    pub(crate) fn open_existing(_: &Path, _: &str) -> Result<Self, Error> { Err(Error::UnsupportedPlatform) }
    pub(crate) fn edit(&self) -> Result<Edit<'_>, Error> { Err(Error::UnsupportedPlatform) }
}
#[cfg(not(unix))]
impl Edit<'_> {
    pub(crate) fn root(&self) -> &Path { self.root }
    pub(crate) fn read(&self) -> Result<State, Error> { Err(Error::UnsupportedPlatform) }
    pub(crate) fn unpublish(&self, _: &Reference, _: &str) -> Result<Unpublished, Error> { Err(Error::UnsupportedPlatform) }
    pub(crate) fn publish(&self, _: &str, _: &str, _: Option<u64>) -> Result<Reference, Error> { Err(Error::UnsupportedPlatform) }
}
