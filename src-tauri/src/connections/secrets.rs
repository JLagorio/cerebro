//! Rust-adapter-only secret boundary; no Debug, Serialize, Display or error payload.
use super::ConnectionError;
#[cfg(all(test, not(target_os = "macos")))]
use crate::actions::ids::AccountId;

#[cfg(any(test, feature = "native-keychain-smoke", target_os = "macos"))]
pub(super) const MAX_SECRET_BYTES: usize = 16_384;

pub(crate) struct SecretValue(Vec<u8>);
#[cfg(any(test, feature = "native-keychain-smoke", target_os = "macos"))]
impl SecretValue {
    pub(crate) fn from_bytes(bytes: Vec<u8>) -> Result<Self, ConnectionError> {
        if bytes.is_empty() || bytes.len() > MAX_SECRET_BYTES {
            return Err(ConnectionError::Unavailable);
        }
        Ok(Self(bytes))
    }
    pub(crate) fn expose(&self) -> &[u8] {
        &self.0
    }
}
impl Drop for SecretValue {
    fn drop(&mut self) {
        self.0.fill(0);
    }
}
pub(crate) use super::metadata::SecretRef;
pub(crate) trait SecretStore {
    fn put(&self, reference: &SecretRef, secret: &SecretValue) -> Result<(), ConnectionError>;
    #[cfg(any(test, feature = "native-keychain-smoke", target_os = "macos"))]
    #[cfg_attr(
        not(any(test, feature = "native-keychain-smoke")),
        expect(
            dead_code,
            reason = "secret resolution belongs to provider dispatch; initial import creates/deletes exact references"
        )
    )]
    fn resolve(&self, reference: &SecretRef) -> Result<SecretValue, ConnectionError>;
    fn delete(&self, reference: &SecretRef) -> Result<(), ConnectionError>;
}
/// Explicit fallback for platforms without an accepted native adapter.
#[cfg(any(test, all(feature = "native-keychain-smoke", not(target_os = "macos"))))]
pub(crate) struct UnsupportedSecretStore;
#[cfg(any(test, all(feature = "native-keychain-smoke", not(target_os = "macos"))))]
impl SecretStore for UnsupportedSecretStore {
    fn put(&self, _: &SecretRef, _: &SecretValue) -> Result<(), ConnectionError> {
        Err(ConnectionError::Unsupported)
    }
    fn resolve(&self, _: &SecretRef) -> Result<SecretValue, ConnectionError> {
        Err(ConnectionError::Unsupported)
    }
    fn delete(&self, _: &SecretRef) -> Result<(), ConnectionError> {
        Err(ConnectionError::Unsupported)
    }
}

/// Construct only at the trusted native lifecycle owner; construction does no I/O.
/// The fixed credential-worker fixture cannot construct this OS-backed store.
#[cfg(any(test, feature = "native-keychain-smoke", target_os = "macos"))]
pub(crate) fn platform_secret_store() -> Box<dyn SecretStore> {
    #[cfg(target_os = "macos")]
    {
        super::keychain::native_store()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Box::new(UnsupportedSecretStore)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_store_factory_can_be_constructed_without_credentials() {
        // Constructor smoke only: the real macOS adapter is never invoked here.
        let store = platform_secret_store();
        #[cfg(not(target_os = "macos"))]
        {
            let reference = SecretRef {
                id: "0123456789abcdef0123456789abcdef".into(),
                account_id: AccountId("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into()),
                issuer: "https://github.com".into(),
                subject: "123".into(),
                secret_revision: 1,
            };
            let secret = SecretValue::from_bytes(b"fake".to_vec()).unwrap();
            assert_eq!(
                store.put(&reference, &secret),
                Err(ConnectionError::Unsupported)
            );
            assert_eq!(
                store.resolve(&reference).err(),
                Some(ConnectionError::Unsupported)
            );
            assert_eq!(store.delete(&reference), Err(ConnectionError::Unsupported));
        }
        drop(store);
    }
}
