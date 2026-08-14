//! `source.registered` (M22.1, D11): the portable trusted identity and
//! capability record for one logical source.
//!
//! Only the trusted core registration API may append this kind — it
//! server-stamps `actor: system:source-registry` and no agent-facing op
//! exposes it. Authority is PROVENANCE derived from these records, never a
//! caller-selected label.

use serde::{Deserialize, Serialize};

use super::{
    canonical_json, is_id128, is_sha256, schema_body, sha256_first128, ACTOR_SOURCE_REGISTRY,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthorityCapability {
    ContentOnly,
    HumanAssertion,
    DirectSystemArtifact,
}

/// The closed registration union. Every variant carries the derived
/// `source_key`, its identity binding, its capability, and an independence
/// domain that is non-null EXACTLY for direct system artifacts.
///
/// `legacy_reference` is migration-only: always content-only, never an
/// authority or positive-independence basis — it preserves an imported
/// locator without pretending Cerebro observed the artifact.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SourceRegistration {
    HumanActor {
        source_key: String,
        actor_id: String,
        authority_capability: AuthorityCapability,
        independence_domain_id: Option<String>,
    },
    Connector {
        source_key: String,
        connector_instance_id: String,
        logical_scope_id: String,
        authority_capability: AuthorityCapability,
        independence_domain_id: Option<String>,
    },
    Builtin {
        source_key: String,
        service_id: String,
        authority_capability: AuthorityCapability,
        independence_domain_id: Option<String>,
    },
    CerebroRuntime {
        source_key: String,
        service_id: String,
        authority_capability: AuthorityCapability,
        independence_domain_id: Option<String>,
    },
    LegacyReference {
        source_key: String,
        resource: String,
        authority_capability: AuthorityCapability,
        independence_domain_id: Option<String>,
    },
}

impl SourceRegistration {
    pub fn kind_str(&self) -> &'static str {
        match self {
            SourceRegistration::HumanActor { .. } => "human_actor",
            SourceRegistration::Connector { .. } => "connector",
            SourceRegistration::Builtin { .. } => "builtin",
            SourceRegistration::CerebroRuntime { .. } => "cerebro_runtime",
            SourceRegistration::LegacyReference { .. } => "legacy_reference",
        }
    }

    pub fn source_key(&self) -> &str {
        match self {
            SourceRegistration::HumanActor { source_key, .. }
            | SourceRegistration::Connector { source_key, .. }
            | SourceRegistration::Builtin { source_key, .. }
            | SourceRegistration::CerebroRuntime { source_key, .. }
            | SourceRegistration::LegacyReference { source_key, .. } => source_key,
        }
    }

    pub fn capability(&self) -> AuthorityCapability {
        match self {
            SourceRegistration::HumanActor {
                authority_capability,
                ..
            }
            | SourceRegistration::Connector {
                authority_capability,
                ..
            }
            | SourceRegistration::Builtin {
                authority_capability,
                ..
            }
            | SourceRegistration::CerebroRuntime {
                authority_capability,
                ..
            }
            | SourceRegistration::LegacyReference {
                authority_capability,
                ..
            } => *authority_capability,
        }
    }

    pub fn independence_domain_id(&self) -> Option<&str> {
        match self {
            SourceRegistration::HumanActor {
                independence_domain_id,
                ..
            }
            | SourceRegistration::Connector {
                independence_domain_id,
                ..
            }
            | SourceRegistration::Builtin {
                independence_domain_id,
                ..
            }
            | SourceRegistration::CerebroRuntime {
                independence_domain_id,
                ..
            }
            | SourceRegistration::LegacyReference {
                independence_domain_id,
                ..
            } => independence_domain_id.as_deref(),
        }
    }

    /// The canonical identity object: `kind` plus ONLY the identity fields.
    /// Hashing it makes composite ids collision-safe without reserving a
    /// delimiter inside actor/connector/scope/service ids.
    fn identity_object(&self) -> serde_json::Value {
        match self {
            SourceRegistration::HumanActor { actor_id, .. } => serde_json::json!({
                "kind": "human_actor", "actor_id": actor_id
            }),
            SourceRegistration::Connector {
                connector_instance_id,
                logical_scope_id,
                ..
            } => serde_json::json!({
                "kind": "connector",
                "connector_instance_id": connector_instance_id,
                "logical_scope_id": logical_scope_id
            }),
            SourceRegistration::Builtin { service_id, .. } => serde_json::json!({
                "kind": "builtin", "service_id": service_id
            }),
            SourceRegistration::CerebroRuntime { service_id, .. } => serde_json::json!({
                "kind": "cerebro_runtime", "service_id": service_id
            }),
            SourceRegistration::LegacyReference { resource, .. } => serde_json::json!({
                "kind": "legacy_reference", "resource": resource
            }),
        }
    }

    /// `<kind>:<sha256(canonical_json(identity_object))>`.
    pub fn derived_source_key(&self) -> Result<String, String> {
        let identity = canonical_json(&self.identity_object())?;
        Ok(format!(
            "{}:{}",
            self.kind_str(),
            crate::ledger::sha256_hex(identity.as_bytes())
        ))
    }

    /// Every rule checkable from the registration record alone.
    pub fn validate(&self) -> Result<(), String> {
        let capability = self.capability();
        match self {
            SourceRegistration::HumanActor { actor_id, .. } => {
                if actor_id.is_empty() {
                    return Err("human_actor registration needs a non-empty actor_id".into());
                }
                if capability != AuthorityCapability::HumanAssertion {
                    return Err("human_actor capability is exactly human_assertion".into());
                }
            }
            SourceRegistration::Connector {
                connector_instance_id,
                logical_scope_id,
                ..
            } => {
                if connector_instance_id.is_empty() || logical_scope_id.is_empty() {
                    return Err("connector registration needs instance and scope ids".into());
                }
                if capability == AuthorityCapability::HumanAssertion {
                    return Err("a connector can never carry human_assertion capability".into());
                }
            }
            SourceRegistration::Builtin { service_id, .. } => {
                if service_id.is_empty() {
                    return Err("builtin registration needs a non-empty service_id".into());
                }
                if capability == AuthorityCapability::HumanAssertion {
                    return Err("a builtin can never carry human_assertion capability".into());
                }
            }
            SourceRegistration::CerebroRuntime { service_id, .. } => {
                if service_id.is_empty() {
                    return Err("cerebro_runtime registration needs a non-empty service_id".into());
                }
                if capability != AuthorityCapability::ContentOnly {
                    return Err("cerebro_runtime capability is exactly content_only".into());
                }
            }
            SourceRegistration::LegacyReference { resource, .. } => {
                if resource.is_empty() || resource != resource.trim() {
                    return Err(
                        "legacy_reference resource must be trimmed and non-empty — there is no \
                         id/title fallback and no guessed source identity"
                            .into(),
                    );
                }
                if capability != AuthorityCapability::ContentOnly {
                    return Err("legacy_reference capability is exactly content_only".into());
                }
            }
        }
        // Independence domain: non-null exactly for direct system artifacts.
        match (capability, self.independence_domain_id()) {
            (AuthorityCapability::DirectSystemArtifact, Some(domain)) if !domain.is_empty() => {}
            (AuthorityCapability::DirectSystemArtifact, _) => {
                return Err(
                    "a direct-system registration requires a non-empty independence_domain_id"
                        .into(),
                )
            }
            (_, None) => {}
            (_, Some(_)) => {
                return Err(
                    "independence_domain_id is non-null exactly for direct artifacts".into(),
                )
            }
        }
        let derived = self.derived_source_key()?;
        if self.source_key() != derived {
            return Err(format!(
                "source_key {:?} does not match its identity derivation",
                self.source_key()
            ));
        }
        Ok(())
    }
}

/// The identity-derivation half of `derive_source_id`, exposed for callers
/// that hold a key without a registration struct (the migrator's dedupe).
pub fn derive_source_key(registration: &SourceRegistration) -> Result<String, String> {
    registration.derived_source_key()
}

/// First 128 bits of `SHA-256("cerebro-source-v1\0" + store_uuid + "\0" +
/// source_key)` — the stable, opaque, per-store source id. It is the M25
/// `(store_uuid, source_id)` health/coverage key, never a record id.
pub fn derive_source_id(store_uuid: &str, source_key: &str) -> String {
    let mut bytes =
        Vec::with_capacity("cerebro-source-v1".len() + 2 + store_uuid.len() + source_key.len());
    bytes.extend_from_slice(b"cerebro-source-v1\0");
    bytes.extend_from_slice(store_uuid.as_bytes());
    bytes.push(0);
    bytes.extend_from_slice(source_key.as_bytes());
    sha256_first128(&bytes)
}

schema_body! {
    /// The portable trusted source record. Re-registering a source id or key
    /// with different canonical bytes is refused (reduce-time).
    pub struct SourceRegistered {
        pub source_id: String,
        pub registration: SourceRegistration,
    }
}

impl SourceRegistered {
    pub fn validate(&self, store_uuid: &str) -> Result<(), String> {
        self.validate_common()?;
        if self.actor.id != ACTOR_SOURCE_REGISTRY {
            return Err(format!(
                "source.registered is appended only by the core registration API \
                 (actor {ACTOR_SOURCE_REGISTRY}), got {:?}",
                self.actor.id
            ));
        }
        if !is_id128(&self.source_id) {
            return Err(format!(
                "source_id {:?} is not stable-form 128-bit lowercase hex",
                self.source_id
            ));
        }
        self.registration.validate()?;
        let derived = derive_source_id(store_uuid, self.registration.source_key());
        if self.source_id != derived {
            return Err(format!(
                "source_id {} does not match the store-scoped derivation {derived}",
                self.source_id
            ));
        }
        // The key's digest half must be well-formed hex (belt to the
        // derivation's braces — derived keys always are).
        let digest = self
            .registration
            .source_key()
            .split_once(':')
            .map(|(_, d)| d)
            .unwrap_or("");
        if !is_sha256(digest) {
            return Err("source_key digest half is not SHA-256 hex".into());
        }
        Ok(())
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::super::tests::common;
    use super::*;

    pub(crate) const STORE: &str = "feedfacefeedfacefeedfacefeedface";

    pub(crate) fn registration(kind: &str) -> SourceRegistration {
        let mut reg = match kind {
            "human_actor" => SourceRegistration::HumanActor {
                source_key: String::new(),
                actor_id: "human:josef".into(),
                authority_capability: AuthorityCapability::HumanAssertion,
                independence_domain_id: None,
            },
            "connector" => SourceRegistration::Connector {
                source_key: String::new(),
                connector_instance_id: "conn-1".into(),
                logical_scope_id: "scope-a".into(),
                authority_capability: AuthorityCapability::DirectSystemArtifact,
                independence_domain_id: Some("domain-github".into()),
            },
            "builtin" => SourceRegistration::Builtin {
                source_key: String::new(),
                service_id: "svc.filesystem".into(),
                authority_capability: AuthorityCapability::ContentOnly,
                independence_domain_id: None,
            },
            "cerebro_runtime" => SourceRegistration::CerebroRuntime {
                source_key: String::new(),
                service_id: "distiller".into(),
                authority_capability: AuthorityCapability::ContentOnly,
                independence_domain_id: None,
            },
            "legacy_reference" => SourceRegistration::LegacyReference {
                source_key: String::new(),
                resource: "https://example.com/spec".into(),
                authority_capability: AuthorityCapability::ContentOnly,
                independence_domain_id: None,
            },
            other => panic!("unknown fixture kind {other}"),
        };
        let key = reg.derived_source_key().unwrap();
        match &mut reg {
            SourceRegistration::HumanActor { source_key, .. }
            | SourceRegistration::Connector { source_key, .. }
            | SourceRegistration::Builtin { source_key, .. }
            | SourceRegistration::CerebroRuntime { source_key, .. }
            | SourceRegistration::LegacyReference { source_key, .. } => *source_key = key,
        }
        reg
    }

    pub(crate) fn registered(kind: &str) -> SourceRegistered {
        let registration = registration(kind);
        let source_id = derive_source_id(STORE, registration.source_key());
        let common = common(ACTOR_SOURCE_REGISTRY);
        SourceRegistered {
            schema: common.0,
            batch_id: None,
            idempotency_key: None,
            actor: common.1,
            occurred_at: None,
            valid_from: None,
            valid_to: None,
            source_id,
            registration,
        }
    }

    #[test]
    fn every_registration_variant_validates_and_round_trips() {
        for kind in [
            "human_actor",
            "connector",
            "builtin",
            "cerebro_runtime",
            "legacy_reference",
        ] {
            let event = registered(kind);
            event.validate(STORE).unwrap();
            let line = serde_json::to_string(&event).unwrap();
            let back: SourceRegistered = serde_json::from_str(&line).unwrap();
            assert_eq!(back, event);
            assert_eq!(serde_json::to_string(&back).unwrap(), line);
        }
    }

    #[test]
    fn the_key_derivation_is_domain_separated_and_pinned() {
        // Pinned bytes: identity object is {"kind":...,"actor_id":...} in
        // declaration order; key is kind-prefixed; id is store-scoped.
        let reg = registration("human_actor");
        let identity = r#"{"kind":"human_actor","actor_id":"human:josef"}"#;
        let want_key = format!(
            "human_actor:{}",
            crate::ledger::sha256_hex(identity.as_bytes())
        );
        assert_eq!(reg.source_key(), want_key);
        let id = derive_source_id(STORE, reg.source_key());
        assert_eq!(id.len(), 32);
        assert_ne!(
            id,
            derive_source_id("0000000000000000000000000000aaaa", reg.source_key()),
            "the same key in a different store is a different source id"
        );
    }

    #[test]
    fn capability_and_domain_rules_are_closed() {
        // Human actor with the wrong capability.
        let mut reg = registration("human_actor");
        if let SourceRegistration::HumanActor {
            authority_capability,
            ..
        } = &mut reg
        {
            *authority_capability = AuthorityCapability::ContentOnly;
        }
        assert!(reg.validate().is_err());

        // Direct artifact without a domain.
        let mut reg = registration("connector");
        if let SourceRegistration::Connector {
            independence_domain_id,
            ..
        } = &mut reg
        {
            *independence_domain_id = None;
        }
        assert!(reg.validate().is_err());

        // Content-only with a domain.
        let mut reg = registration("builtin");
        if let SourceRegistration::Builtin {
            independence_domain_id,
            ..
        } = &mut reg
        {
            *independence_domain_id = Some("sneaky".into());
        }
        assert!(reg.validate().is_err());

        // Runtime claiming direct-artifact capability.
        let mut reg = registration("cerebro_runtime");
        if let SourceRegistration::CerebroRuntime {
            authority_capability,
            ..
        } = &mut reg
        {
            *authority_capability = AuthorityCapability::DirectSystemArtifact;
        }
        assert!(reg.validate().is_err());

        // Legacy reference can never upgrade itself.
        let mut reg = registration("legacy_reference");
        if let SourceRegistration::LegacyReference {
            authority_capability,
            ..
        } = &mut reg
        {
            *authority_capability = AuthorityCapability::DirectSystemArtifact;
        }
        assert!(reg.validate().is_err());
    }

    #[test]
    fn untrimmed_or_empty_legacy_resources_are_refused() {
        for bad in ["", " padded ", "trailing "] {
            let mut reg = registration("legacy_reference");
            if let SourceRegistration::LegacyReference {
                resource,
                source_key,
                ..
            } = &mut reg
            {
                *resource = bad.into();
                *source_key = String::new();
            }
            let key = reg.derived_source_key().unwrap();
            if let SourceRegistration::LegacyReference { source_key, .. } = &mut reg {
                *source_key = key;
            }
            assert!(reg.validate().is_err(), "resource {bad:?} must be refused");
        }
    }

    #[test]
    fn a_forged_key_actor_or_source_id_is_refused() {
        let mut event = registered("builtin");
        event.source_id = "00000000000000000000000000000000".into();
        assert!(event.validate(STORE).is_err(), "wrong source id");

        let mut event = registered("builtin");
        event.actor.id = "agent:sneaky".into();
        assert!(event.validate(STORE).is_err(), "only the registry appends");

        let mut event = registered("builtin");
        if let SourceRegistration::Builtin { source_key, .. } = &mut event.registration {
            *source_key = format!("builtin:{}", "0".repeat(64));
        }
        assert!(event.validate(STORE).is_err(), "forged key");

        // The same registration under a different store id fails the pin.
        let event = registered("builtin");
        assert!(event.validate("0000000000000000000000000000aaaa").is_err());
    }
}
