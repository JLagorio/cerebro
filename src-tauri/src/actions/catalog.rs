//! Immutable definition material. This is not a scoped callable service catalog.
use super::{read_types::*, schema::*};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Default)]
pub(super) struct ActionCatalog {
    entries: BTreeMap<(ActionId, DefinitionDigest), Envelope>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Envelope {
    material: DefinitionMaterial,
    definition: ActionDefinition,
}
// Count the exact escaped envelope before allocating its serialized buffer.
// Material alone is insufficient: the envelope repeats schemas and capabilities.
#[derive(Default)]
struct EnvelopeSize(usize);
impl std::io::Write for EnvelopeSize {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0 = self
            .0
            .checked_add(bytes.len())
            .filter(|size| *size <= limits().definition_bytes)
            .ok_or_else(|| std::io::Error::other("definition envelope exceeds its byte limit"))?;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn checked_envelope_bytes(entry: &Envelope) -> Result<String, ActionError> {
    serde_json::to_writer(EnvelopeSize::default(), entry).map_err(|_| {
        error(
            ActionErrorCode::LimitExceeded,
            "Definition envelope exceeds its limits.",
        )
    })?;
    let bytes = serde_json::to_string(entry).expect("bounded definition envelope");
    // Admission and export use the same structural/string limits as import.
    parse_bounded(&bytes, limits().definition_bytes)?;
    Ok(bytes)
}

fn material_definition(m: &DefinitionMaterial) -> Result<ActionDefinition, ActionError> {
    let l = limits();
    if !m.secret_input_fields.is_empty() {
        return Err(error(
            ActionErrorCode::UnsupportedSchema,
            "Actions requiring embedded secrets are unsupported.",
        ));
    }
    if !valid_action_id(&m.action_id.0) || m.adapter_revision.is_empty() {
        return Err(error(
            ActionErrorCode::InvalidInput,
            "Definition requires a namespaced action and adapter revision.",
        ));
    }
    if m.action_id.0.len() > l.string_bytes
        || m.adapter_revision.len() > l.string_bytes
        || m.required_capabilities.len() > l.array_items
        || m.required_capabilities
            .iter()
            .any(|v| v.is_empty() || v.len() > l.string_bytes)
    {
        return Err(error(
            ActionErrorCode::LimitExceeded,
            "Definition material exceeds its limits.",
        ));
    }
    let input = canonicalize(&m.input_schema, true)?;
    let output = canonicalize(&m.output_schema, true)?;
    compile_schema(&m.input_schema)?;
    compile_schema(&m.output_schema)?;
    // Size-check strings and cumulative material before serialization allocates.
    let total = m.action_id.0.len()
        + m.adapter_revision.len()
        + m.input_schema.len()
        + m.output_schema.len()
        + m.required_capabilities
            .iter()
            .map(String::len)
            .sum::<usize>();
    if total > l.definition_bytes / 6 {
        return Err(error(
            ActionErrorCode::LimitExceeded,
            "Definition material exceeds its limits.",
        ));
    }
    let encoded = serde_json::to_string(m).expect("definition material");
    let parsed = parse_bounded(&encoded, l.definition_bytes)?;
    // Material's schemas remain exact strings: even whitespace edits make a new
    // definition digest, while canonical schema digests describe semantic bytes.
    let canonical = parsed.canonical();
    Ok(ActionDefinition {
        action_id: m.action_id.clone(),
        definition_digest: DefinitionDigest(digest(canonical.as_bytes())),
        input_schema_digest: input.digest,
        output_schema_digest: output.digest,
        input_schema: m.input_schema.clone(),
        output_schema: m.output_schema.clone(),
        adapter_revision: m.adapter_revision.clone(),
        effect_class: m.effect_class,
        required_capabilities: m.required_capabilities.clone(),
        retry: m.retry,
        cancel: m.cancel,
        reconcile: m.reconcile,
    })
}
impl ActionCatalog {
    /// Immutable compiled metadata only; never scoped callable authority.
    pub(super) fn definitions(&self)->Vec<ActionDefinition>{self.entries.values().map(|entry|entry.definition.clone()).collect()}

    pub(super) fn insert(
        &mut self,
        material: DefinitionMaterial,
        provider_annotations: &str,
    ) -> Result<ActionDefinition, ActionError> {
        // Discovery annotations are untrusted, bounded, ignored and never stored.
        // Only the local material supplies classification and required grants.
        if provider_annotations.len() > limits().input_bytes {
            return Err(error(
                ActionErrorCode::LimitExceeded,
                "Provider annotation exceeds its limits.",
            ));
        }
        let definition = material_definition(&material)?;
        let key = (
            definition.action_id.clone(),
            definition.definition_digest.clone(),
        );
        if let Some(previous) = self.entries.get(&key) {
            if previous.material != material {
                return Err(error(
                    ActionErrorCode::DefinitionMismatch,
                    "Immutable definition material conflicts.",
                ));
            }
            return Ok(previous.definition.clone());
        }
        if self.entries.len() >= limits().catalog_definitions {
            return Err(error(
                ActionErrorCode::LimitExceeded,
                "Catalog definition limit reached.",
            ));
        }
        let entry = Envelope {
            material,
            definition: definition.clone(),
        };
        checked_envelope_bytes(&entry)?;
        self.entries.insert(key, entry);
        Ok(definition)
    }
    pub(super) fn resolve(
        &self,
        action_id: &ActionId,
        definition_digest: &DefinitionDigest,
    ) -> Result<ActionDefinition, ActionError> {
        self.entries
            .get(&(action_id.clone(), definition_digest.clone()))
            .map(|e| e.definition.clone())
            .ok_or_else(|| {
                error(
                    ActionErrorCode::NotFound,
                    "Action definition was not found.",
                )
            })
    }
    #[cfg(test)]
    pub(super) fn export(
        &self,
        action_id: &ActionId,
        definition_digest: &DefinitionDigest,
    ) -> Result<String, ActionError> {
        let entry = self
            .entries
            .get(&(action_id.clone(), definition_digest.clone()))
            .ok_or_else(|| {
                error(
                    ActionErrorCode::NotFound,
                    "Action definition was not found.",
                )
            })?;
        checked_envelope_bytes(entry)
    }
    #[cfg(test)]
    pub(super) fn import(&mut self, bytes: &str) -> Result<ActionDefinition, ActionError> {
        parse_bounded(bytes, limits().definition_bytes)?;
        let envelope: Envelope = serde_json::from_str(bytes).map_err(|_| {
            error(
                ActionErrorCode::DefinitionMismatch,
                "Invalid definition envelope.",
            )
        })?;
        let expected = material_definition(&envelope.material)?;
        if expected != envelope.definition {
            return Err(error(
                ActionErrorCode::DefinitionMismatch,
                "Definition envelope failed digest verification.",
            ));
        }
        self.insert(envelope.material, "{}")
    }
}

// Grammar comes from the shared literal contract. The formerly permissive
// test-gated colon predicate was never a promise to accept malformed IDs.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NamespaceRule {
    minimum_segments: usize,
    first_characters: String,
    remaining_characters: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NamespaceContract {
    version: u32,
    legacy_colon: NamespaceRule,
    dotted: NamespaceRule,
    cases: Vec<NamespaceCase>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NamespaceCase {
    id: String,
    accepted: bool,
}
fn valid_action_id(value: &str) -> bool {
    static CONTRACT: std::sync::OnceLock<Option<NamespaceContract>> = std::sync::OnceLock::new();
    let Some(contract) = CONTRACT.get_or_init(|| {
        let rules: NamespaceContract = serde_json::from_str(include_str!(
            "../../../shared/actions/action-id-cases.v1.json"
        ))
        .ok()?;
        if rules.version != 1
            || rules.cases.is_empty()
            || rules
                .cases
                .iter()
                .any(|case| namespace_matches(&rules, &case.id) != case.accepted)
        {
            return None;
        }
        Some(rules)
    }) else {
        return false;
    };
    namespace_matches(contract, value)
}
fn namespace_matches(contract: &NamespaceContract, value: &str) -> bool {
    let (separator, rule) = if value.contains(':') {
        (':', &contract.legacy_colon)
    } else {
        ('.', &contract.dotted)
    };
    let mut count = 0;
    if rule.minimum_segments < 2 || !value.is_ascii() {
        return false;
    }
    for part in value.split(separator) {
        count += 1;
        let mut chars = part.chars();
        if !chars
            .next()
            .is_some_and(|c| rule.first_characters.contains(c))
            || !chars.all(|c| rule.remaining_characters.contains(c))
        {
            return false;
        }
    }
    count >= rule.minimum_segments
}
