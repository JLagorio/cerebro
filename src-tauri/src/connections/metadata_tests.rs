//! Same-module SQL/decoder probes. No SecretStore/Keychain/provider invocation.
//! These are metadata-kernel tests, never native window/owner proof.
use super::*;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::path::PathBuf;

const OWNER: &str = "human:metadata-owner";
const ID: &str = "metadata-connection";
const SECRET_ID: &str = "ffffffffffffffffffffffffffffffff";
const MAX_SAFE: u64 = 9_007_199_254_740_991;

struct Fixture {
    data: PathBuf,
    conn: Connection,
}
impl Fixture {
    fn new() -> Self {
        let data = crate::vault::testutil::temp_vault("m96-metadata-sql");
        let conn = crate::runtime::open(&data).unwrap();
        Self { data, conn }
    }
    fn insert(&self) {
        self.conn.execute("INSERT INTO managed_connections(connection_id,person,status,active_attempt,secret_ref) VALUES(?1,?2,?3,?4,?5)",
            params![ID,OWNER,serde_json::to_string(&status()).unwrap(),"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",serde_json::to_string(&reference()).unwrap()]).unwrap();
    }
    fn read(&self, id: &str, owner: &str) -> rusqlite::Result<Option<MetadataRecord>> {
        self.conn
            .query_row(STATUS_SQL, params![id, owner], MetadataRecord::read)
            .optional()
    }
    fn finish(self) {
        drop(self.conn);
        std::fs::remove_dir_all(self.data).unwrap();
    }
}
fn status() -> ConnectionStatus {
    ConnectionStatus {
        connection_id: ConnectionId(ID.into()),
        revision: 1,
        login: "metadata-fixture".into(),
        health: ConnectionHealth::Ready,
        account: Some(AccountBinding {
            account_id: AccountId("fixture-account".into()),
            subject: "123".into(),
            issuer: "https://github.com".into(),
            account_revision: 1,
            scope_digest: "a".repeat(64),
        }),
        secret_revision: 1,
        revocation_generation: 0,
        observed_at: "2026-10-24T00:00:00.000Z".into(),
        cleanup_pending: true,
        remote_revocation: RemoteRevocation::NotAttempted,
    }
}
fn reference() -> SecretRef {
    SecretRef {
        id: SECRET_ID.into(),
        account_id: AccountId("fixture-account".into()),
        issuer: "https://github.com".into(),
        subject: "123".into(),
        secret_revision: 1,
    }
}
fn encoded(value: &impl serde::Serialize) -> String {
    serde_json::to_string(value).unwrap()
}
fn change_status(path: &str, value: Value) -> String {
    let mut changed = serde_json::to_value(status()).unwrap();
    *changed.pointer_mut(path).unwrap() = value;
    encoded(&changed)
}

#[test]
fn metadata_actual_status_sql_is_owner_scoped_and_uses_one_record_decoder() {
    let f = Fixture::new();
    f.insert();
    let before = f.conn.total_changes();
    let own = f.read(ID, OWNER).unwrap();
    let other = f.read(ID, "human:other").unwrap();
    let absent = f.read("unknown-connection", OWNER).unwrap();
    let changed = f.conn.total_changes() != before;
    let actual = own.map(|r| (r.status, r.observation_revision, r.active, r.reference));
    f.finish();
    let (mut expected, reference) = (status(), reference());
    expected.cleanup_pending = false;
    assert_eq!(
        actual,
        Some((
            expected,
            0,
            Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into()),
            Some(reference)
        ))
    );
    assert!(
        other.is_none() && absent.is_none(),
        "STATUS_SQL disclosed a row outside its exact owner/id selection"
    );
    assert!(!changed, "metadata SELECT mutated storage");
}

#[test]
fn metadata_cleanup_overlay_uses_actual_queue_not_stale_status_json() {
    let f = Fixture::new();
    f.insert();
    let original: String = f
        .conn
        .query_row(
            "SELECT status FROM managed_connections WHERE connection_id=?1",
            [ID],
            |r| r.get(0),
        )
        .unwrap();
    let absent = f.read(ID, OWNER).unwrap().unwrap().status.cleanup_pending;
    f.conn.execute("INSERT INTO managed_secret_cleanup(secret_id,connection_id,reference,disposition) VALUES(?1,?2,?3,'reserved')",
        params![SECRET_ID,ID,encoded(&reference())]).unwrap();
    let reserved = f.read(ID, OWNER).unwrap().unwrap().status.cleanup_pending;
    f.conn
        .execute(
            "UPDATE managed_secret_cleanup SET disposition='delete' WHERE secret_id=?1",
            [SECRET_ID],
        )
        .unwrap();
    let deleting = f.read(ID, OWNER).unwrap().unwrap().status.cleanup_pending;
    f.conn
        .execute(
            "DELETE FROM managed_secret_cleanup WHERE secret_id=?1",
            [SECRET_ID],
        )
        .unwrap();
    let removed = f.read(ID, OWNER).unwrap().unwrap().status.cleanup_pending;
    let after: String = f
        .conn
        .query_row(
            "SELECT status FROM managed_connections WHERE connection_id=?1",
            [ID],
            |r| r.get(0),
        )
        .unwrap();
    f.finish();
    assert!(
        !absent && reserved && deleting && !removed,
        "cleanup overlay followed stale JSON or ignored a reserved cleanup row"
    );
    assert_eq!(
        original, after,
        "read overlay rewrote stored observation bytes"
    );
}

#[test]
fn metadata_status_and_reference_positive_counters_match_existing_schema() {
    // V32 requires status.revision/accountRevision and reference.secretRevision
    // positive; secretRevision/revocationGeneration on status may still be zero.
    let bad_revision = decode_status(&change_status("/revision", json!(0)), false);
    let bad_account = decode_status(&change_status("/account/accountRevision", json!(0)), false);
    let mut bad_reference = reference();
    bad_reference.secret_revision = 0;
    let bad_reference = decode_reference(Some(&encoded(&bad_reference)));
    let mut valid = status();
    valid.secret_revision = 0;
    valid.revocation_generation = 0;
    let zero_nonpositive_axes = decode_status(&encoded(&valid), false);
    assert_eq!(bad_revision, Err(ConnectionError::Unavailable));
    assert_eq!(bad_account, Err(ConnectionError::Unavailable));
    assert_eq!(bad_reference, Err(ConnectionError::Unavailable));
    assert!(
        zero_nonpositive_axes.is_ok(),
        "valid zero-valued non-positive-required counters were rejected"
    );
}

#[test]
fn metadata_counter_bounds_reject_overflow_and_preserve_maximum() {
    for path in [
        "/revision",
        "/secretRevision",
        "/revocationGeneration",
        "/account/accountRevision",
    ] {
        let maximum = decode_status(&change_status(path, json!(MAX_SAFE)), false);
        let overflow = decode_status(&change_status(path, json!(MAX_SAFE + 1)), false);
        assert!(maximum.is_ok(), "maximum exact counter was rejected");
        assert_eq!(overflow, Err(ConnectionError::Unavailable));
    }
    let mut r = reference();
    r.secret_revision = MAX_SAFE;
    assert!(decode_reference(Some(&encoded(&r))).is_ok());
    r.secret_revision = MAX_SAFE + 1;
    assert_eq!(
        decode_reference(Some(&encoded(&r))),
        Err(ConnectionError::Unavailable)
    );
}

#[test]
fn metadata_raw_encoded_bounds_are_applied_to_valid_json_before_decode() {
    let cap = crate::actions::schema::admission_rules().limits.grant_bytes;
    for is_reference in [false, true] {
        // An ignored extension makes valid JSON at/above the raw cap without
        // changing any known field. Without the byte guard both would decode.
        let mut value = if is_reference {
            serde_json::to_value(reference()).unwrap()
        } else {
            serde_json::to_value(status()).unwrap()
        };
        value["bounded-test-extension"] = json!("");
        let base = encoded(&value).len();
        assert!(base < cap);
        value["bounded-test-extension"] = json!("x".repeat(cap - base));
        let at = encoded(&value);
        assert_eq!(at.len(), cap);
        value["bounded-test-extension"] = json!("x".repeat(cap - base + 1));
        let over = encoded(&value);
        assert_eq!(over.len(), cap + 1);
        if is_reference {
            assert!(decode_reference(Some(&at)).is_ok());
            assert_eq!(
                decode_reference(Some(&over)),
                Err(ConnectionError::Unavailable)
            );
        } else {
            assert!(decode_status(&at, false).is_ok());
            assert_eq!(
                decode_status(&over, false),
                Err(ConnectionError::Unavailable)
            );
        }
    }
}

#[test]
fn metadata_identity_limits_count_utf8_bytes_in_every_status_and_reference_field() {
    let cap = crate::actions::schema::admission_rules()
        .limits
        .identity_bytes;
    let too_many_bytes = "é".repeat(cap / 2 + 1);
    for path in [
        "/connectionId",
        "/login",
        "/account/accountId",
        "/account/subject",
        "/account/issuer",
        "/account/scopeDigest",
    ] {
        assert_eq!(
            decode_status(&change_status(path, json!(too_many_bytes)), false),
            Err(ConnectionError::Unavailable)
        );
    }
    for field in ["id", "accountId", "issuer", "subject"] {
        let mut value = serde_json::to_value(reference()).unwrap();
        value[field] = json!(too_many_bytes);
        assert_eq!(
            decode_reference(Some(&encoded(&value))),
            Err(ConnectionError::Unavailable)
        );
        value[field] = json!("");
        assert_eq!(
            decode_reference(Some(&encoded(&value))),
            Err(ConnectionError::Unavailable)
        );
    }
    let observed_cap = crate::actions::schema::admission_rules()
        .limits
        .process_session_bytes;
    assert_eq!(
        decode_status(
            &change_status("/observedAt", json!("x".repeat(observed_cap + 1))),
            false
        ),
        Err(ConnectionError::Unavailable)
    );
}

#[test]
fn metadata_actual_row_reader_refuses_wrong_types_invalid_utf8_and_oversized_raw_fields() {
    let f = Fixture::new();
    f.insert();
    // Corruption injection affects only this disposable fixture; actual schema
    // would reject these writes. Every read still uses production STATUS_SQL.
    f.conn
        .pragma_update(None, "ignore_check_constraints", true)
        .unwrap();
    let original = encoded(&status());
    let secret = encoded(&reference());
    let cap = crate::actions::schema::admission_rules().limits.grant_bytes;
    let identity = crate::actions::schema::admission_rules()
        .limits
        .identity_bytes;
    let mut refused = Vec::new();
    for sql in [
        "UPDATE managed_connections SET status=x'80'",
        "UPDATE managed_connections SET status=CAST(x'80' AS TEXT)",
        "UPDATE managed_connections SET status=7",
    ] {
        f.conn.execute(sql, []).unwrap();
        refused.push(f.read(ID, OWNER).is_err());
    }
    f.conn
        .execute("UPDATE managed_connections SET status=?1", [&original])
        .unwrap();
    for (column, text) in [
        ("status", " ".repeat(cap + 1)),
        ("secret_ref", " ".repeat(cap + 1)),
        ("active_attempt", "a".repeat(identity + 1)),
    ] {
        f.conn
            .execute(
                &format!("UPDATE managed_connections SET {column}=?1"),
                [&text],
            )
            .unwrap();
        refused.push(f.read(ID, OWNER).is_err());
        f.conn
            .execute(
                "UPDATE managed_connections SET status=?1,secret_ref=?2,active_attempt=NULL",
                params![original, secret],
            )
            .unwrap();
    }
    for value in [-1_i64, 9_007_199_254_740_992] {
        f.conn
            .execute(
                "UPDATE managed_connections SET observation_revision=?1",
                [value],
            )
            .unwrap();
        refused.push(f.read(ID, OWNER).is_err());
    }
    f.finish();
    assert!(
        refused.into_iter().all(|v| v),
        "raw malformed/unbounded metadata survived the actual row decoder"
    );
}

#[test]
fn metadata_malformed_json_unknown_enums_and_missing_fields_are_unavailable() {
    for raw in ["", "null", "[]", "{}", "{", r#"{"health":"future"}"#] {
        assert_eq!(decode_status(raw, false), Err(ConnectionError::Unavailable));
        assert_eq!(
            decode_reference(Some(raw)),
            Err(ConnectionError::Unavailable)
        );
    }
    assert_eq!(decode_reference(None), Ok(None));
    for path in ["/health", "/remoteRevocation"] {
        assert_eq!(
            decode_status(&change_status(path, json!("future_unknown")), false),
            Err(ConnectionError::Unavailable)
        );
    }
}

#[test]
fn metadata_existing_connection_status_consumer_uses_decoder_without_secret_store_access() {
    use crate::connections::{
        accounts::ConnectionService,
        secrets::{SecretStore, SecretValue},
        AttendedPerson,
    };
    struct NeverAccess(std::cell::Cell<usize>);
    impl SecretStore for NeverAccess {
        fn put(&self, _: &SecretRef, _: &SecretValue) -> Result<(), ConnectionError> {
            self.0.set(self.0.get() + 1);
            Err(ConnectionError::Unavailable)
        }
        fn resolve(&self, _: &SecretRef) -> Result<SecretValue, ConnectionError> {
            self.0.set(self.0.get() + 1);
            Err(ConnectionError::Unavailable)
        }
        fn delete(&self, _: &SecretRef) -> Result<(), ConnectionError> {
            self.0.set(self.0.get() + 1);
            Err(ConnectionError::Unavailable)
        }
    }
    let mut f = Fixture::new();
    f.insert();
    let store = NeverAccess(std::cell::Cell::new(0));
    // Existing test-only person constructor supplies no production owner proof.
    let person = AttendedPerson::at_native_door(OWNER).unwrap();
    let result = {
        let service = ConnectionService {
            conn: &mut f.conn,
            store: &store,
        };
        service.status(&person, &ConnectionId(ID.into()))
    };
    let calls = store.0.get();
    f.finish();
    let mut expected = status();
    expected.cleanup_pending = false;
    assert_eq!(result, Ok(expected));
    assert_eq!(
        calls, 0,
        "metadata status unexpectedly touched the secret seam"
    );
}
