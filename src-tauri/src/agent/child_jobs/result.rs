//! Transient structural result validation only. No job/delivery acceptance,
//! authority, factual verification, current source read or body persistence.
use super::{
    limits,
    types::{ChildJobSpec, EvidenceRef, SpecRefusal},
};
use serde::{
    de::{value::MapAccessDeserializer, MapAccess, Visitor},
    Deserialize, Deserializer,
};
use std::{
    collections::{btree_map::Entry, BTreeMap, BTreeSet},
    fmt,
    marker::PhantomData,
};

// The one decoder implemented here, also required in the shared allowlist.
const SCHEMA_ID: &str = "read_evidence_summary.v1";

// Private immutable data-only snapshot. No Serialize/Debug and no authority mint.
pub(crate) struct FrozenResultContract {
    schema_id: String,
    budget_bytes: usize,
    evidence: BTreeMap<String, String>,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ContractError {
    InvalidSpec(SpecRefusal),
    UnsupportedSchema,
    AmbiguousEvidence,
}
impl FrozenResultContract {
    pub(crate) fn from_spec(
        original: &ChildJobSpec,
        captured_at: u64,
    ) -> Result<Self, ContractError> {
        original
            .validate(captured_at)
            .map_err(ContractError::InvalidSpec)?;
        if original.result_schema_id != SCHEMA_ID {
            return Err(ContractError::UnsupportedSchema);
        }
        let budget_bytes = usize::try_from(original.budget.result_bytes)
            .map_err(|_| ContractError::InvalidSpec(SpecRefusal::InvalidBudget))?;
        let mut evidence = BTreeMap::new();
        for reference in &original.input_evidence_refs {
            match evidence.entry(reference.path.clone()) {
                Entry::Vacant(entry) => {
                    entry.insert(reference.sha256.clone());
                }
                Entry::Occupied(entry) if entry.get() != &reference.sha256 => {
                    return Err(ContractError::AmbiguousEvidence);
                }
                Entry::Occupied(_) => {}
            }
        }
        Ok(Self {
            schema_id: original.result_schema_id.clone(),
            budget_bytes,
            evidence,
        })
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum UsageAvailability {
    Unknown,
}
// Intentionally no Debug/Serialize on any content-bearing carrier.
pub(crate) struct ValidatedSummary {
    pub summary: String,
    pub evidence: Vec<EvidenceRef>,
    pub usage_availability: UsageAvailability,
}
pub(crate) enum ResultValidation {
    Valid(ValidatedSummary),
    Partial(ValidatedSummary),
    Invalid { reason: ResultInvalidReason },
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ResultInvalidReason {
    PolicyUnavailable,
    TooLarge,
    Malformed,
    SchemaMismatch,
    InvalidSummary,
    InvalidReference,
    ChangedReference,
    DuplicateReference,
    TooManyReferences,
}
// Restrict only these two local JSON boundaries to objects. Forward the
// original map directly so the existing derives still reject duplicate known
// keys and unknown fields; do not collapse entries through serde_json::Value.
struct Object<T>(T);
impl<'de, T: Deserialize<'de>> Deserialize<'de> for Object<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ObjectVisitor<T>(PhantomData<T>);
        impl<'de, T: Deserialize<'de>> Visitor<'de> for ObjectVisitor<T> {
            type Value = Object<T>;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("an object")
            }

            fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<Self::Value, A::Error> {
                T::deserialize(MapAccessDeserializer::new(map)).map(Object)
            }
        }
        deserializer.deserialize_map(ObjectVisitor::<T>(PhantomData))
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Carrier {
    schema_id: String,
    completeness: Completeness,
    summary: String,
    evidence: Vec<Object<EvidenceRef>>,
}
#[derive(Deserialize)]
#[serde(try_from = "String")]
enum Completeness {
    Complete,
    Partial,
}
impl TryFrom<String> for Completeness {
    type Error = &'static str;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        match value.as_str() {
            "complete" => Ok(Self::Complete),
            "partial" => Ok(Self::Partial),
            _ => Err("invalid completeness"),
        }
    }
}
fn invalid(reason: ResultInvalidReason) -> ResultValidation {
    ResultValidation::Invalid { reason }
}
pub(crate) fn validate_transient(
    contract: &FrozenResultContract,
    encoded: &[u8],
) -> ResultValidation {
    // This is the original requested cap, bounded again by the shared approved
    // maximum, before serde can allocate any model-supplied text or vector.
    if let Err(error) = limits::check_result_length(contract.budget_bytes, encoded.len()) {
        return invalid(if error == limits::LimitRefusal::PolicyUnavailable {
            ResultInvalidReason::PolicyUnavailable
        } else {
            ResultInvalidReason::TooLarge
        });
    }
    let parsed = match serde_json::from_slice::<Object<Carrier>>(encoded) {
        Ok(Object(parsed)) => parsed,
        Err(_) => return invalid(ResultInvalidReason::Malformed),
    };
    if parsed.schema_id != contract.schema_id {
        return invalid(ResultInvalidReason::SchemaMismatch);
    }
    if parsed.summary.trim().is_empty() {
        return invalid(ResultInvalidReason::InvalidSummary);
    }
    let bounds = match limits::load() {
        Ok(bounds) => bounds,
        Err(_) => return invalid(ResultInvalidReason::PolicyUnavailable),
    };
    if parsed.evidence.len() > bounds.max_evidence_refs {
        return invalid(ResultInvalidReason::TooManyReferences);
    }
    {
        let mut seen = BTreeSet::new();
        for Object(reference) in &parsed.evidence {
            // Exact membership inherits the original validated lexical path and
            // digest shape. No second path/hash policy or source read is needed.
            let Some(expected) = contract.evidence.get(&reference.path) else {
                return invalid(ResultInvalidReason::InvalidReference);
            };
            if expected != &reference.sha256 {
                return invalid(ResultInvalidReason::ChangedReference);
            }
            if !seen.insert(reference.path.as_str()) {
                return invalid(ResultInvalidReason::DuplicateReference);
            }
        }
    }
    let summary = ValidatedSummary {
        summary: parsed.summary,
        evidence: parsed
            .evidence
            .into_iter()
            .map(|Object(reference)| reference)
            .collect(),
        usage_availability: UsageAvailability::Unknown,
    };
    // Completeness is a self-report. Valid/Partial means structural acceptance,
    // never factual correctness, delivery settlement, deadline or job success.
    match parsed.completeness {
        Completeness::Complete => ResultValidation::Valid(summary),
        Completeness::Partial => ResultValidation::Partial(summary),
    }
}
