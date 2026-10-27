use super::*;
use crate::actions::ids::{AccountId, ConnectionId};
use crate::connections::{
    accounts::{ConnectionService, ValidatedCredential},
    AttendedPerson, ConnectionHealth, GhSelection,
};
use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
    rc::Rc,
};

const SENTINEL: &[u8] = b"SENTINEL_NATIVE_KEYCHAIN_NEVER_EXPORT";

// This substitutes only SecItem I/O. Query creation, scope, result validation,
// error reduction and lifecycle transactions are production code under test.
#[derive(Default)]
struct MemoryApi {
    items: RefCell<BTreeMap<(String, String), CFType>>,
    calls: RefCell<Vec<(&'static str, Query)>>,
    error: Cell<i32>,
    delete_error: Cell<i32>,
    read_override: RefCell<Option<CFType>>,
    during_add: RefCell<Option<Box<dyn FnOnce()>>>,
}
fn attribute(query: &Query, key: CFStringRef) -> CFType {
    // SAFETY: tests pass linked Security framework constants only.
    let key = unsafe { CFString::wrap_under_get_rule(key) };
    query.find(&key).expect("required query attribute").clone()
}
fn text_attribute(query: &Query, key: CFStringRef) -> String {
    attribute(query, key)
        .downcast::<CFString>()
        .expect("string attribute")
        .to_string()
}
fn item_key(query: &Query) -> (String, String) {
    // SAFETY: these immutable framework symbols exist on the supported OS.
    unsafe {
        (
            text_attribute(query, kSecAttrService),
            text_attribute(query, kSecAttrAccount),
        )
    }
}
impl KeychainApi for Rc<MemoryApi> {
    fn add(&self, query: &Query) -> Result<(), i32> {
        self.calls.borrow_mut().push(("add", query.clone()));
        if self.error.get() != 0 {
            return Err(self.error.get());
        }
        if let Some(callback) = self.during_add.borrow_mut().take() {
            callback();
        }
        let key = item_key(query);
        if self.items.borrow().contains_key(&key) {
            return Err(-25299);
        }
        // SAFETY: linked immutable framework symbol.
        self.items
            .borrow_mut()
            .insert(key, attribute(query, unsafe { kSecValueData }));
        Ok(())
    }
    fn copy(&self, query: &Query) -> Result<CFType, i32> {
        self.calls.borrow_mut().push(("copy", query.clone()));
        if self.error.get() != 0 {
            return Err(self.error.get());
        }
        if let Some(value) = self.read_override.borrow().as_ref() {
            return Ok(value.clone());
        }
        self.items
            .borrow()
            .get(&item_key(query))
            .cloned()
            .ok_or(-25300)
    }
    fn delete(&self, query: &Query) -> Result<(), i32> {
        self.calls.borrow_mut().push(("delete", query.clone()));
        let error = if self.error.get() != 0 {
            self.error.get()
        } else {
            self.delete_error.get()
        };
        if error != 0 {
            return Err(error);
        }
        self.items
            .borrow_mut()
            .remove(&item_key(query))
            .map(|_| ())
            .ok_or(-25300)
    }
}
fn reference() -> SecretRef {
    SecretRef {
        id: "0123456789abcdef0123456789abcdef".into(),
        account_id: AccountId("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into()),
        issuer: "https://github.com".into(),
        subject: "123".into(),
        secret_revision: 1,
    }
}
fn secret() -> SecretValue {
    SecretValue::from_bytes(SENTINEL.to_vec()).unwrap()
}
fn fake_store(api: &Rc<MemoryApi>) -> MacOsSecretStore<Rc<MemoryApi>> {
    MacOsSecretStore { api: api.clone() }
}

#[test]
fn keychain_roundtrip_is_exact_scoped_noninteractive_and_device_local() {
    let api = Rc::new(MemoryApi::default());
    let store = fake_store(&api);
    let reference = reference();
    store.put(&reference, &secret()).unwrap();
    assert!(store.resolve(&reference).unwrap().expose() == SENTINEL);
    store.delete(&reference).unwrap();
    assert!(matches!(
        store.resolve(&reference),
        Err(ConnectionError::SignInRequired)
    ));
    store.delete(&reference).unwrap(); // idempotent cleanup, not a fabricated readable secret
    let calls = api.calls.borrow();
    assert_eq!(calls.len(), 5);
    for (operation, query) in calls.iter() {
        // SAFETY: all query constants are immutable symbols from Security.framework.
        unsafe {
            assert_eq!(
                text_attribute(query, kSecAttrService),
                "com.cerebro.app.connections.v1"
            );
            let account = text_attribute(query, kSecAttrAccount);
            assert_eq!(account.len(), 68);
            assert!(account.starts_with("ref-"));
            assert!(account[4..].bytes().all(|byte| byte.is_ascii_hexdigit()));
            assert!(
                attribute(query, kSecClass)
                    == CFString::wrap_under_get_rule(kSecClassGenericPassword).into_CFType()
            );
            assert!(
                attribute(query, kSecAttrSynchronizable) == CFBoolean::false_value().into_CFType()
            );
            assert!(
                attribute(query, kSecUseDataProtectionKeychain)
                    == CFBoolean::true_value().into_CFType()
            );
            assert!(
                attribute(query, kSecUseAuthenticationUI)
                    == CFString::wrap_under_get_rule(kSecUseAuthenticationUIFail).into_CFType()
            );
            if *operation == "add" {
                assert!(attribute(query, kSecAttrAccessControl)
                    .downcast::<SecAccessControl>()
                    .is_some());
            } else {
                let data_key = CFString::wrap_under_get_rule(kSecValueData);
                assert!(!query.contains_key(&data_key));
            }
            if *operation == "copy" {
                assert!(
                    attribute(query, kSecMatchLimit)
                        == CFString::wrap_under_get_rule(kSecMatchLimitOne).into_CFType()
                );
                assert!(attribute(query, kSecReturnData) == CFBoolean::true_value().into_CFType());
            }
        }
    }
}
#[test]
fn keychain_binding_changes_cannot_read_or_delete_the_installed_item() {
    let api = Rc::new(MemoryApi::default());
    let store = fake_store(&api);
    let original = reference();
    store.put(&original, &secret()).unwrap();
    for index in 0..5 {
        let mut changed = original.clone();
        match index {
            0 => changed.id = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".into(),
            1 => changed.account_id = AccountId("cccccccccccccccccccccccccccccccc".into()),
            2 => changed.issuer = "https://other.example".into(),
            3 => changed.subject = "456".into(),
            _ => changed.secret_revision = 2,
        }
        assert!(matches!(
            store.resolve(&changed),
            Err(ConnectionError::SignInRequired)
        ));
        store.delete(&changed).unwrap();
        assert!(store.resolve(&original).unwrap().expose() == SENTINEL);
    }
}
#[test]
fn keychain_duplicate_put_cannot_change_an_installed_secret_revision() {
    let api = Rc::new(MemoryApi::default());
    let store = fake_store(&api);
    let reference = reference();
    store.put(&reference, &secret()).unwrap();
    assert_eq!(
        store.put(
            &reference,
            &SecretValue::from_bytes(b"different".to_vec()).unwrap()
        ),
        Err(ConnectionError::Unavailable)
    );
    assert!(store.resolve(&reference).unwrap().expose() == SENTINEL);
}
#[test]
fn keychain_rejects_malformed_or_unbounded_references_before_os_access() {
    let api = Rc::new(MemoryApi::default());
    let store = fake_store(&api);
    for index in 0..7 {
        let mut reference = reference();
        match index {
            0 => reference.id.clear(),
            1 => reference.account_id.0 = "../foreign".into(),
            2 => reference.issuer.clear(),
            3 => reference.issuer = "a".repeat(513),
            4 => reference.subject = "bad\nsubject".into(),
            5 => reference.secret_revision = 0,
            _ => reference.secret_revision = 9_007_199_254_740_992,
        }
        assert_eq!(
            store.put(&reference, &secret()),
            Err(ConnectionError::InvalidSelection)
        );
        assert!(matches!(
            store.resolve(&reference),
            Err(ConnectionError::InvalidSelection)
        ));
        assert_eq!(
            store.delete(&reference),
            Err(ConnectionError::InvalidSelection)
        );
    }
    assert!(api.calls.borrow().is_empty());
}
#[test]
fn keychain_rejects_wrong_type_empty_and_oversize_native_results() {
    let api = Rc::new(MemoryApi::default());
    let store = fake_store(&api);
    for value in [
        CFString::new("invalid native result").into_CFType(),
        CFData::from_buffer(&[]).into_CFType(),
        CFData::from_buffer(&vec![b'x'; 16_385]).into_CFType(),
    ] {
        *api.read_override.borrow_mut() = Some(value);
        assert!(matches!(
            store.resolve(&reference()),
            Err(ConnectionError::Unavailable)
        ));
    }
    *api.read_override.borrow_mut() = Some(CFData::from_buffer(&vec![b'x'; 16_384]).into_CFType());
    assert_eq!(store.resolve(&reference()).unwrap().expose().len(), 16_384);
}
#[test]
fn keychain_os_failures_become_finite_redacted_errors_without_retry() {
    let api = Rc::new(MemoryApi::default());
    let store = fake_store(&api);
    for (code, expected) in [
        (-25300, ConnectionError::SignInRequired),
        (-128, ConnectionError::Cancelled),
        (-25293, ConnectionError::Unavailable),
        (-25308, ConnectionError::Unavailable),
        (-25291, ConnectionError::Unavailable),
        (-34018, ConnectionError::Unavailable),
        (-999999, ConnectionError::Unavailable),
    ] {
        api.error.set(code);
        let before = api.calls.borrow().len();
        let result = store.resolve(&reference());
        assert_eq!(result.err(), Some(expected));
        assert_eq!(api.calls.borrow().len(), before + 1);
        let output = serde_json::to_string(&expected).unwrap();
        assert!(!output.contains(&code.to_string()));
        assert!(!output.contains(std::str::from_utf8(SENTINEL).unwrap()));
    }
    api.error.set(-25300);
    assert_eq!(store.delete(&reference()), Ok(()));
    assert_eq!(
        store.put(&reference(), &secret()),
        Err(ConnectionError::Unavailable)
    );
}

struct Fixture {
    dir: std::path::PathBuf,
    conn: rusqlite::Connection,
}
impl Fixture {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "cerebro-keychain-fake-{}",
            crate::connections::opaque_id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let conn = crate::runtime::open(&dir).unwrap();
        Self { dir, conn }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}
fn person() -> AttendedPerson {
    AttendedPerson::at_native_door("human:owner").unwrap()
}
fn selected() -> GhSelection {
    GhSelection {
        connection_id: ConnectionId("keychain-test".into()),
        host: "github.com".into(),
        login: "alice".into(),
    }
}
fn credential() -> ValidatedCredential {
    ValidatedCredential {
        login: "alice".into(),
        issuer: "https://github.com".into(),
        subject: "123".into(),
        scope_digest: crate::connections::digest(b"repo"),
        secret: secret(),
    }
}
fn install(
    service: &mut ConnectionService<'_>,
    revision: u64,
) -> crate::connections::ConnectionStatus {
    let attempt = service
        .begin_gh_import(&person(), &selected(), revision)
        .unwrap();
    service
        .complete_import(&person(), &attempt, credential())
        .unwrap()
}
#[test]
fn lifecycle_replaces_keychain_item_and_retries_denied_cleanup_while_disabled() {
    let mut fixture = Fixture::new();
    let api = Rc::new(MemoryApi::default());
    let store = fake_store(&api);
    let mut service = ConnectionService {
        conn: &mut fixture.conn,
        store: &store,
    };
    let initial = service.connect(&person(), &selected()).unwrap();
    let first = install(&mut service, initial.revision);
    let second = install(&mut service, first.revision);
    assert_eq!(first.account, second.account);
    assert_eq!(second.secret_revision, 2);
    assert_eq!(api.items.borrow().len(), 1);
    let serialized = serde_json::to_string(&second).unwrap();
    assert!(!serialized.contains(std::str::from_utf8(SENTINEL).unwrap()));
    api.delete_error.set(-25308);
    let disabled = service
        .revoke(&person(), &selected().connection_id, second.revision)
        .unwrap();
    assert_eq!(disabled.health, ConnectionHealth::Disabled);
    assert!(disabled.cleanup_pending);
    api.delete_error.set(0);
    service
        .cleanup(&person(), &selected().connection_id)
        .unwrap();
    let disabled = service
        .status(&person(), &selected().connection_id)
        .unwrap();
    assert_eq!(disabled.health, ConnectionHealth::Disabled);
    assert!(!disabled.cleanup_pending);
    assert!(api.items.borrow().is_empty());
    for file in std::fs::read_dir(&fixture.dir).unwrap() {
        let path = file.unwrap().path();
        if path.is_file() {
            assert!(!std::fs::read(path)
                .unwrap()
                .windows(SENTINEL.len())
                .any(|bytes| bytes == SENTINEL));
        }
    }
}
#[test]
fn revoked_import_cleans_late_keychain_item_without_installing_a_binding() {
    let mut fixture = Fixture::new();
    let api = Rc::new(MemoryApi::default());
    let store = fake_store(&api);
    let attempt = {
        let mut service = ConnectionService {
            conn: &mut fixture.conn,
            store: &store,
        };
        let initial = service.connect(&person(), &selected()).unwrap();
        service
            .begin_gh_import(&person(), &selected(), initial.revision)
            .unwrap()
    };
    let mut other = crate::runtime::open(&fixture.dir).unwrap();
    let other_store = fake_store(&api);
    let expected = attempt.expected_revision;
    *api.during_add.borrow_mut() = Some(Box::new(move || {
        let mut service = ConnectionService {
            conn: &mut other,
            store: &other_store,
        };
        service
            .revoke(&person(), &selected().connection_id, expected)
            .unwrap();
    }));
    let mut service = ConnectionService {
        conn: &mut fixture.conn,
        store: &store,
    };
    assert!(service
        .complete_import(&person(), &attempt, credential())
        .is_err());
    let status = service
        .status(&person(), &selected().connection_id)
        .unwrap();
    assert_eq!(status.health, ConnectionHealth::Disabled);
    assert!(status.account.is_none());
    assert!(api.items.borrow().is_empty());
}
