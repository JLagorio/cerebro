//! Shared fake credential/provider seams. Test-only; no native authority factory.
use super::secrets::{SecretRef, SecretStore, SecretValue};
use super::{digest, gh_credentials, ConnectionError};
use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
};

pub(crate) const SENTINEL: &str = "SENTINEL_NATIVE_TOKEN_NEVER_EXPORT";
#[derive(Default)]
pub(crate) struct FakeStore {
    pub(crate) items: RefCell<BTreeMap<String, (SecretRef, Vec<u8>)>>,
    pub(crate) fail_delete: Cell<bool>,
}
impl SecretStore for FakeStore {
    fn put(&self, r: &SecretRef, s: &SecretValue) -> Result<(), ConnectionError> {
        self.items
            .borrow_mut()
            .insert(r.id.clone(), (r.clone(), s.expose().to_vec()));
        Ok(())
    }
    fn resolve(&self, r: &SecretRef) -> Result<SecretValue, ConnectionError> {
        let items = self.items.borrow();
        let (stored, bytes) = items.get(&r.id).ok_or(ConnectionError::SignInRequired)?;
        if stored != r {
            return Err(ConnectionError::IdentityMismatch);
        }
        SecretValue::from_bytes(bytes.clone())
    }
    fn delete(&self, r: &SecretRef) -> Result<(), ConnectionError> {
        if self.fail_delete.get() {
            return Err(ConnectionError::Unavailable);
        }
        self.items.borrow_mut().remove(&r.id);
        Ok(())
    }
}
pub(crate) struct FakeGh {
    /// Whether the explicitly selected capture returns a token; no metadata probe.
    pub(crate) exists: bool,
    pub(crate) calls: Cell<usize>,
}
impl gh_credentials::GhProcess for FakeGh {
    fn capture_token(
        &self,
        command: &gh_credentials::GhTokenCommand,
    ) -> Result<SecretValue, ConnectionError> {
        self.calls.set(self.calls.get() + 1);
        assert_eq!(command.program, "gh");
        assert_eq!(
            command.args,
            [
                "auth",
                "token",
                "--hostname",
                "github.com",
                "--user",
                "alice",
                "--no-refresh",
            ]
        );
        assert!(command.clear_environment);
        assert!(command.timeout_ms > 0 && command.timeout_ms <= 30_000);
        assert!(command.output_limit <= 16_384);
        for forbidden in [
            "GH_TOKEN",
            "GITHUB_TOKEN",
            "GH_ENTERPRISE_TOKEN",
            "GITHUB_ENTERPRISE_TOKEN",
            "GH_HOST",
            "GH_DEBUG",
            "DEBUG",
        ] {
            assert!(!command.environment.iter().any(|(key, _)| *key == forbidden));
        }
        assert!(command.environment.contains(&("GH_PROMPT_DISABLED", "1")));
        if !self.exists {
            return Err(ConnectionError::NotFound);
        }
        SecretValue::from_bytes(SENTINEL.as_bytes().to_vec())
    }
}
pub(crate) struct FakeIdentity {
    pub(crate) login: &'static str,
}
impl gh_credentials::IdentityReader for FakeIdentity {
    fn authenticated_identity(
        &self,
        _: &SecretValue,
    ) -> Result<gh_credentials::ProviderIdentity, ConnectionError> {
        Ok(gh_credentials::ProviderIdentity {
            login: self.login.into(),
            subject: "123".into(),
            issuer: "https://github.com".into(),
            scope_digest: digest(b"repo"),
        })
    }
}
pub(crate) struct BeforePut<'a> {
    pub(crate) inner: &'a FakeStore,
    pub(crate) before: RefCell<Option<Box<dyn FnOnce() + 'a>>>,
}
impl SecretStore for BeforePut<'_> {
    fn put(&self, r: &SecretRef, s: &SecretValue) -> Result<(), ConnectionError> {
        if let Some(before) = self.before.borrow_mut().take() {
            before();
        }
        self.inner.put(r, s)
    }
    fn resolve(&self, r: &SecretRef) -> Result<SecretValue, ConnectionError> {
        self.inner.resolve(r)
    }
    fn delete(&self, r: &SecretRef) -> Result<(), ConnectionError> {
        self.inner.delete(r)
    }
}
