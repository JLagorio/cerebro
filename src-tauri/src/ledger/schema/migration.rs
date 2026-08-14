//! Migration epoch brackets and the deterministic migrated-id derivation
//! (M22.1; the migrator itself is M22.6 and is armed only at M23.0).

use super::{is_id128, is_sha256, schema_body, sha256_first128, ACTOR_MIGRATOR};

/// The one migration vocabulary version this build writes.
pub const MIGRATION_SCHEMA: u64 = 1;

/// `migrate_id(class, identity)` — first 128 bits of
/// `SHA-256("cerebro-migrate-id-v1\0" + store_uuid + "\0" + class + "\0" +
/// identity)`. Every stable id inside a migrated canonical body comes from
/// here (belief: normalized knowledge-relative path; entity: same path under
/// class `entity`). Never generate a fresh body id on retry.
pub fn migrate_id(store_uuid: &str, class: &str, identity: &str) -> String {
    let mut bytes = Vec::with_capacity(
        "cerebro-migrate-id-v1".len() + 3 + store_uuid.len() + class.len() + identity.len(),
    );
    bytes.extend_from_slice(b"cerebro-migrate-id-v1\0");
    bytes.extend_from_slice(store_uuid.as_bytes());
    bytes.push(0);
    bytes.extend_from_slice(class.as_bytes());
    bytes.push(0);
    bytes.extend_from_slice(identity.as_bytes());
    sha256_first128(&bytes)
}

schema_body! {
    /// Epoch opener: pins the store, the migration vocabulary, the corpus
    /// digest, and the planned output count. A changed source digest before
    /// completion is a reconciliation error, never a second epoch.
    pub struct MigrationStarted {
        pub store_uuid: String,
        pub migration_schema: u64,
        pub source_digest: String,
        pub planned_output_count: u64,
    }
}

schema_body! {
    /// Epoch closer: same identity plus the achieved output count and the
    /// digest over the UTF-8-byte-sorted deterministic output keys. Must
    /// agree with the started body and the committed keyed-output scan.
    pub struct MigrationCompleted {
        pub store_uuid: String,
        pub migration_schema: u64,
        pub source_digest: String,
        pub output_count: u64,
        pub output_keys_digest: String,
    }
}

fn validate_bracket(
    actor: &str,
    store_uuid: &str,
    migration_schema: u64,
    source_digest: &str,
) -> Result<(), String> {
    if actor != ACTOR_MIGRATOR {
        return Err(format!(
            "migration brackets are written only by {ACTOR_MIGRATOR}, got {actor:?}"
        ));
    }
    if !is_id128(store_uuid) {
        return Err("store_uuid must be the 128-bit hex store id".into());
    }
    if migration_schema != MIGRATION_SCHEMA {
        return Err(format!("unsupported migration schema {migration_schema}"));
    }
    if !is_sha256(source_digest) {
        return Err("source_digest is not SHA-256 hex".into());
    }
    Ok(())
}

impl MigrationStarted {
    pub fn validate(&self) -> Result<(), String> {
        self.validate_common()?;
        validate_bracket(
            &self.actor.id,
            &self.store_uuid,
            self.migration_schema,
            &self.source_digest,
        )
    }
}

impl MigrationCompleted {
    pub fn validate(&self) -> Result<(), String> {
        self.validate_common()?;
        validate_bracket(
            &self.actor.id,
            &self.store_uuid,
            self.migration_schema,
            &self.source_digest,
        )?;
        if !is_sha256(&self.output_keys_digest) {
            return Err("output_keys_digest is not SHA-256 hex".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::common;
    use super::*;

    const STORE: &str = "feedfacefeedfacefeedfacefeedface";

    #[test]
    fn migrate_ids_are_domain_and_class_separated() {
        let belief = migrate_id(STORE, "belief", "concepts/ownership.md");
        let entity = migrate_id(STORE, "entity", "concepts/ownership.md");
        assert_eq!(belief.len(), 32);
        assert_ne!(belief, entity, "same path, different class, different id");
        assert_ne!(
            belief,
            migrate_id(
                "0000000000000000000000000000aaaa",
                "belief",
                "concepts/ownership.md"
            ),
            "same path in a different store is a different id"
        );
        // Deterministic across calls — the restart-idempotency foundation.
        assert_eq!(belief, migrate_id(STORE, "belief", "concepts/ownership.md"));
    }

    #[test]
    fn brackets_pin_actor_schema_and_digest_shapes() {
        let (schema, actor) = common(ACTOR_MIGRATOR);
        let digest = crate::ledger::sha256_hex(b"corpus");
        let mut started = MigrationStarted {
            schema,
            batch_id: None,
            idempotency_key: Some("migrate-v1:feedface:started".into()),
            actor,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            store_uuid: STORE.into(),
            migration_schema: MIGRATION_SCHEMA,
            source_digest: digest.clone(),
            planned_output_count: 12,
        };
        started.validate().unwrap();

        started.actor.id = "agent:sneaky".into();
        assert!(started.validate().is_err());
        started.actor.id = ACTOR_MIGRATOR.into();
        started.migration_schema = 2;
        assert!(started.validate().is_err());

        let (schema, actor) = common(ACTOR_MIGRATOR);
        let completed = MigrationCompleted {
            schema,
            batch_id: None,
            idempotency_key: Some("migrate-v1:feedface:completed".into()),
            actor,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            store_uuid: STORE.into(),
            migration_schema: MIGRATION_SCHEMA,
            source_digest: digest,
            output_count: 12,
            output_keys_digest: crate::ledger::sha256_hex(b"keys"),
        };
        completed.validate().unwrap();
    }
}
