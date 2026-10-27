//! macOS secret storage for the admitted original-owner native worker.
//! No enumeration, prompts, replacement-owner lookup or plaintext fallback.
//! Security.framework calls are synchronous: one-item/byte limits are not a
//! hard OS-call deadline. Signed/entitled packaged acceptance remains required.
use super::{
    secrets::{SecretRef, SecretStore, SecretValue, MAX_SECRET_BYTES},
    ConnectionError,
};
use core_foundation::{
    base::{CFType, TCFType},
    boolean::CFBoolean,
    data::CFData,
    dictionary::CFDictionary,
    string::{CFString, CFStringRef},
};
use security_framework::access_control::{ProtectionMode, SecAccessControl};
use security_framework_sys::{
    item::*,
    keychain_item::{SecItemAdd, SecItemCopyMatching, SecItemDelete},
};

type Query = CFDictionary<CFString, CFType>;
const SERVICE: &str = "com.cerebro.app.connections.v1";
// Public Apple symbols omitted by the pinned sys crate. Minimum macOS is 14.
// UI-fail is supported but deprecated by Apple in favor of LAContext. It keeps
// this adapter noninteractive without changing process-global Keychain state.
extern "C" {
    static kSecUseAuthenticationUIFail: CFStringRef;
    static kSecMatchLimitOne: CFStringRef;
}
/// This boundary substitutes SecItem I/O in tests, not the query or lifecycle.
trait KeychainApi {
    fn add(&self, query: &Query) -> Result<(), i32>;
    fn copy(&self, query: &Query) -> Result<CFType, i32>;
    fn delete(&self, query: &Query) -> Result<(), i32>;
}
struct MacOsSecretStore<A> {
    api: A,
}
struct NativeApi;

/// Construction does not consult Keychain or claim that an item is readable.
pub(super) fn native_store() -> Box<dyn SecretStore> {
    Box::new(MacOsSecretStore { api: NativeApi })
}
fn os_result(status: i32) -> Result<(), i32> {
    if status == 0 {
        Ok(())
    } else {
        Err(status)
    }
}
impl KeychainApi for NativeApi {
    fn add(&self, query: &Query) -> Result<(), i32> {
        // SAFETY: the owned CFDictionary retains correctly typed values for the
        // synchronous call. No return value is requested, so result may be null.
        os_result(unsafe { SecItemAdd(query.as_concrete_TypeRef(), std::ptr::null_mut()) })
    }
    fn copy(&self, query: &Query) -> Result<CFType, i32> {
        let mut raw = std::ptr::null();
        // SAFETY: query retains its typed values and raw is a valid output slot.
        // Copy grants ownership of any non-null object; CFType releases it even
        // on an error. The caller checks its dynamic type before reading bytes.
        let status = unsafe { SecItemCopyMatching(query.as_concrete_TypeRef(), &mut raw) };
        let value = if raw.is_null() {
            None
        } else {
            // SAFETY: non-null object returned under the Copy ownership rule.
            Some(unsafe { CFType::wrap_under_create_rule(raw) })
        };
        os_result(status)?;
        value.ok_or(-50) // errSecParam; never expose a raw error string or object.
    }
    fn delete(&self, query: &Query) -> Result<(), i32> {
        // SAFETY: the owned dictionary retains typed selectors through the call.
        os_result(unsafe { SecItemDelete(query.as_concrete_TypeRef()) })
    }
}
fn opaque(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}
fn bounded_metadata(value: &str, limit: usize) -> bool {
    !value.is_empty()
        && value.len() <= limit
        && value
            .bytes()
            .all(|byte| byte.is_ascii() && !byte.is_ascii_control())
}
fn item_account(reference: &SecretRef) -> Result<String, ConnectionError> {
    if !opaque(&reference.id)
        || !opaque(&reference.account_id.0)
        || !bounded_metadata(&reference.issuer, 512)
        || !bounded_metadata(&reference.subject, 128)
        || !(1..=9_007_199_254_740_991).contains(&reference.secret_revision)
    {
        return Err(ConnectionError::InvalidSelection);
    }
    // Persisted key format: explicit version + ordered tuple, independent of DTO
    // field names/order. Every binding component changes the exact OS selector.
    let binding = serde_json::to_vec(&(
        "cerebro.secret-ref.v1",
        &reference.id,
        &reference.account_id.0,
        &reference.issuer,
        &reference.subject,
        reference.secret_revision,
    ))
    .map_err(|_| ConnectionError::Unavailable)?;
    Ok(format!("ref-{}", super::digest(&binding)))
}
fn selectors(reference: &SecretRef) -> Result<Vec<(CFString, CFType)>, ConnectionError> {
    let account = item_account(reference)?;
    // SAFETY: these immutable Security.framework constants exist on macOS14.
    // Get-rule wrappers retain them; the dictionary owns all keys and values.
    Ok(unsafe {
        vec![
            (
                CFString::wrap_under_get_rule(kSecClass),
                CFString::wrap_under_get_rule(kSecClassGenericPassword).into_CFType(),
            ),
            (
                CFString::wrap_under_get_rule(kSecAttrService),
                CFString::new(SERVICE).into_CFType(),
            ),
            (
                CFString::wrap_under_get_rule(kSecAttrAccount),
                CFString::new(&account).into_CFType(),
            ),
            (
                CFString::wrap_under_get_rule(kSecAttrSynchronizable),
                CFBoolean::false_value().into_CFType(),
            ),
            (
                CFString::wrap_under_get_rule(kSecUseDataProtectionKeychain),
                CFBoolean::true_value().into_CFType(),
            ),
            (
                CFString::wrap_under_get_rule(kSecUseAuthenticationUI),
                CFString::wrap_under_get_rule(kSecUseAuthenticationUIFail).into_CFType(),
            ),
        ]
    })
}
fn access_error(status: i32) -> ConnectionError {
    match status {
        -128 => ConnectionError::Cancelled, // errSecUserCanceled
        // Locked, denied, unavailable, missing entitlement, malformed native
        // results and unknown statuses remain unavailable, never missing/ready.
        _ => ConnectionError::Unavailable,
    }
}
impl<A: KeychainApi> SecretStore for MacOsSecretStore<A> {
    fn put(&self, reference: &SecretRef, secret: &SecretValue) -> Result<(), ConnectionError> {
        let mut query = selectors(reference)?;
        let access = SecAccessControl::create_with_protection(
            Some(ProtectionMode::AccessibleWhenUnlockedThisDeviceOnly),
            0,
        )
        .map_err(|_| ConnectionError::Unavailable)?;
        // SAFETY: the framework constants have process lifetime; query retains
        // the access object and bounded secret copy until the native call ends.
        unsafe {
            query.push((
                CFString::wrap_under_get_rule(kSecAttrAccessControl),
                access.into_CFType(),
            ));
            query.push((
                CFString::wrap_under_get_rule(kSecValueData),
                CFData::from_buffer(secret.expose()).into_CFType(),
            ));
        }
        // Create only. Replacement uses a fresh reference through the lifecycle
        // owner; duplicate-key failure must not overwrite a secret revision.
        self.api
            .add(&Query::from_CFType_pairs(&query))
            .map_err(access_error)
    }
    fn resolve(&self, reference: &SecretRef) -> Result<SecretValue, ConnectionError> {
        let mut query = selectors(reference)?;
        // SAFETY: immutable constants; owned CF values are retained by query.
        unsafe {
            query.push((
                CFString::wrap_under_get_rule(kSecReturnData),
                CFBoolean::true_value().into_CFType(),
            ));
            query.push((
                CFString::wrap_under_get_rule(kSecMatchLimit),
                CFString::wrap_under_get_rule(kSecMatchLimitOne).into_CFType(),
            ));
        }
        let value = self
            .api
            .copy(&Query::from_CFType_pairs(&query))
            .map_err(|status| {
                if status == -25300 {
                    ConnectionError::SignInRequired
                } else {
                    access_error(status)
                }
            })?;
        let data = value
            .downcast_into::<CFData>()
            .ok_or(ConnectionError::Unavailable)?;
        // Check before copying into a Rust Vec. This does not claim to bound
        // Security.framework's own allocation or erase its internal copies.
        if data.is_empty() || data.len() > MAX_SECRET_BYTES as isize {
            return Err(ConnectionError::Unavailable);
        }
        SecretValue::from_bytes(data.bytes().to_vec())
    }
    fn delete(&self, reference: &SecretRef) -> Result<(), ConnectionError> {
        let query = Query::from_CFType_pairs(&selectors(reference)?);
        match self.api.delete(&query) {
            Ok(()) | Err(-25300) => Ok(()), // missing is idempotent cleanup only
            Err(status) => Err(access_error(status)),
        }
    }
}
#[cfg(test)]
#[path = "keychain_tests.rs"]
mod tests;
