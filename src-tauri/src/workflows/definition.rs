use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum DefinitionError {
    InvalidJson,
    UnsupportedFormat,
    LimitExceeded,
    InvalidIdentity,
    InvalidGraph,
    InvalidMapping,
    UnsupportedSchema,
    SchemaDigestMismatch,
    DefinitionMismatch,
    InvalidInput,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Definition {
    pub format_version: u32,
    pub workflow_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub definition_hash: Option<String>,
    pub entry_step_id: String,
    #[serde(serialize_with = "serialize_raw")]
    pub input_schema: Box<RawValue>,
    pub input_schema_digest: String,
    pub steps: Vec<Step>,
    pub trigger: Trigger,
    pub declared_action_digests: Vec<String>,
    pub authored_by: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum Trigger {
    Manual,
    Schedule {
        #[serde(rename = "intervalSeconds")]
        interval_seconds: u32,
        #[serde(rename = "catchUp")]
        catch_up: CatchUp,
    },
    Event {
        event: String,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum CatchUp {
    SkipMissed,
    CoalesceLatest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Step {
    pub step_id: String,
    pub label: String,
    pub operation: Operation,
}
#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(super) enum Operation {
    Read {
        query: Mapping,
        #[serde(serialize_with = "serialize_raw")]
        output_schema: Box<RawValue>,
        next_step_id: String,
    },
    Transform {
        mapping: Mapping,
        #[serde(serialize_with = "serialize_raw")]
        output_schema: Box<RawValue>,
        next_step_id: String,
    },
    Condition {
        predicate: Predicate,
        if_true: String,
        if_false: String,
    },
    Action {
        action_id: String,
        definition_digest: String,
        connection_id: String,
        account_id: String,
        input: Mapping,
        next_step_id: String,
    },
    Wait {
        until: WaitUntil,
        next_step_id: String,
    },
    Result {
        output: Mapping,
    },
}
#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(super) enum WaitUntil {
    Timer {
        at: String,
    },
    ExternalInput {
        #[serde(serialize_with = "serialize_raw")]
        schema: Box<RawValue>,
        expires_at: String,
    },
}
#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(super) enum Mapping {
    Literal {
        #[serde(serialize_with = "serialize_raw")]
        value: Box<RawValue>,
    },
    Input {
        path: Vec<String>,
    },
    Output {
        step_id: String,
        path: Vec<String>,
    },
    Object {
        fields: BTreeMap<String, Mapping>,
    },
    Array {
        items: Vec<Mapping>,
    },
}
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum Predicate {
    Equals { left: Mapping, right: Mapping },
    Less { left: Mapping, right: Mapping },
    Greater { left: Mapping, right: Mapping },
    Exists { value: Mapping },
    All { items: Vec<Predicate> },
    Any { items: Vec<Predicate> },
    Not { value: Box<Predicate> },
}

#[derive(Debug)]
pub(super) struct ValidatedDefinition {
    pub definition: Definition,
    pub definition_hash: String,
    pub canonical: String,
}

use crate::actions::schema as json_schema;
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, VecDeque};
use std::sync::OnceLock;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Limits {
    format_version: u32,
    pub steps: usize,
    definition_bytes: usize,
    pub expression_nodes: usize,
    pub expression_depth: usize,
    pub json_depth: usize,
    identity_bytes: usize,
    label_bytes: usize,
    pub path_segments: usize,
    pub path_segment_bytes: usize,
    minimum_interval_seconds: u32,
    maximum_interval_seconds: u32,
    pub step_output_bytes: usize,
    pub run_output_bytes: usize,
}
pub(super) fn limits() -> &'static Limits {
    static LIMITS: OnceLock<Limits> = OnceLock::new();
    LIMITS.get_or_init(|| {
        serde_json::from_str(include_str!("../../../shared/workflows/format.v1.json"))
            .expect("workflow format limits")
    })
}
/// The schedule planner reuses the definition format's actual interval bounds.
pub(super) fn schedule_interval_supported(seconds: u32) -> bool {
    (limits().minimum_interval_seconds..=limits().maximum_interval_seconds).contains(&seconds)
}
fn hash(bytes: &str) -> String {
    format!("{:x}", Sha256::digest(bytes.as_bytes()))
}
fn json_error(error: crate::actions::read_types::ActionError) -> DefinitionError {
    if error.code == crate::actions::read_types::ActionErrorCode::LimitExceeded {
        DefinitionError::LimitExceeded
    } else {
        DefinitionError::InvalidJson
    }
}
pub(super) fn valid_identity(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= limits().identity_bytes
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
}
fn digest_string(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn schema(raw: &RawValue) -> Result<String, DefinitionError> {
    json_schema::workflow_schema_digest(raw.get()).map_err(|_| DefinitionError::UnsupportedSchema)
}
fn bounded_label(value: &str) -> bool {
    !value.trim().is_empty()
        && value.len() <= limits().label_bytes
        && !value.chars().any(char::is_control)
}
fn utc(value: &str) -> bool {
    value.ends_with('Z') && chrono::DateTime::parse_from_rfc3339(value).is_ok()
}
impl Operation {
    fn successors(&self) -> Vec<&str> {
        match self {
            Self::Read { next_step_id, .. }
            | Self::Transform { next_step_id, .. }
            | Self::Action { next_step_id, .. }
            | Self::Wait { next_step_id, .. } => vec![next_step_id],
            Self::Condition {
                if_true, if_false, ..
            } => {
                if if_true == if_false {
                    vec![if_true]
                } else {
                    vec![if_true, if_false]
                }
            }
            Self::Result { .. } => vec![],
        }
    }
    fn produces_output(&self) -> bool {
        matches!(
            self,
            Self::Read { .. }
                | Self::Transform { .. }
                | Self::Action { .. }
                | Self::Wait {
                    until: WaitUntil::ExternalInput { .. },
                    ..
                }
        )
    }
}

struct Expressions<'a> {
    definition: &'a Definition,
    index: &'a BTreeMap<String, usize>,
    consumer: usize,
    dominators: &'a BTreeSet<usize>,
    ancestors: &'a BTreeSet<usize>,
    nodes: usize,
}
impl Expressions<'_> {
    fn visit(&mut self, depth: usize) -> Result<(), DefinitionError> {
        self.nodes += 1;
        if depth > limits().expression_depth || self.nodes > limits().expression_nodes {
            Err(DefinitionError::LimitExceeded)
        } else {
            Ok(())
        }
    }
    fn path(&self, path: &[String]) -> Result<(), DefinitionError> {
        if path.len() > limits().path_segments
            || path.iter().any(|s| s.len() > limits().path_segment_bytes)
        {
            Err(DefinitionError::LimitExceeded)
        } else {
            Ok(())
        }
    }
    fn mapping(
        &mut self,
        mapping: &Mapping,
        depth: usize,
        allow_missing: bool,
    ) -> Result<(), DefinitionError> {
        self.mapping_in(mapping, depth, allow_missing, None)
    }
    fn mapping_in(
        &mut self,
        mapping: &Mapping,
        depth: usize,
        allow_missing: bool,
        schema: Option<&json_schema::Node>,
    ) -> Result<(), DefinitionError> {
        self.visit(depth)?;
        match mapping {
            Mapping::Literal { .. } => Ok(()),
            Mapping::Input { path } => self.path(path),
            Mapping::Output { step_id, path } => {
                self.path(path)?;
                let producer = *self
                    .index
                    .get(step_id)
                    .ok_or(DefinitionError::InvalidMapping)?;
                if producer >= self.consumer
                    || !self.definition.steps[producer].operation.produces_output()
                    || !self.ancestors.contains(&producer)
                    || (!allow_missing && !self.dominators.contains(&producer))
                {
                    return Err(DefinitionError::InvalidMapping);
                }
                Ok(())
            }
            Mapping::Object { fields } => {
                for (key, child) in fields {
                    if key.len() > limits().path_segment_bytes {
                        return Err(DefinitionError::LimitExceeded);
                    }
                    let declared = json_schema::workflow_property(schema, key);
                    self.mapping_in(
                        child,
                        depth + 1,
                        allow_missing || declared.is_some_and(|(_, required)| !required),
                        declared.map(|(schema, _)| schema),
                    )?;
                }
                Ok(())
            }
            Mapping::Array { items } => {
                for child in items {
                    self.mapping_in(
                        child,
                        depth + 1,
                        allow_missing,
                        json_schema::workflow_items(schema),
                    )?;
                }
                Ok(())
            }
        }
    }
    fn predicate(&mut self, predicate: &Predicate, depth: usize) -> Result<(), DefinitionError> {
        self.visit(depth)?;
        match predicate {
            Predicate::Equals { left, right }
            | Predicate::Less { left, right }
            | Predicate::Greater { left, right } => {
                self.mapping(left, depth + 1, false)?;
                self.mapping(right, depth + 1, false)
            }
            Predicate::Exists { value } => self.mapping(value, depth + 1, true),
            Predicate::All { items } | Predicate::Any { items } => {
                if items.is_empty() {
                    return Err(DefinitionError::InvalidMapping);
                }
                for child in items {
                    self.predicate(child, depth + 1)?;
                }
                Ok(())
            }
            Predicate::Not { value } => self.predicate(value, depth + 1),
        }
    }
}

pub(super) fn validate(text: &str) -> Result<ValidatedDefinition, DefinitionError> {
    if text.len() > limits().definition_bytes {
        return Err(DefinitionError::LimitExceeded);
    }
    // The shared exact-decimal parser also rejects duplicate keys and bounds JSON
    // allocation before serde constructs recursive expressions or raw schema values.
    canonical_json(text)?;
    #[derive(Deserialize)]
    struct Header {
        #[serde(rename = "formatVersion")]
        format_version: u32,
    }
    let header: Header = serde_json::from_str(text).map_err(|_| DefinitionError::InvalidJson)?;
    if header.format_version != limits().format_version {
        return Err(DefinitionError::UnsupportedFormat);
    }
    let mut definition: Definition =
        serde_json::from_str(text).map_err(|_| DefinitionError::InvalidJson)?;
    if !valid_identity(&definition.workflow_id) || !bounded_label(&definition.authored_by) {
        return Err(DefinitionError::InvalidIdentity);
    }
    if definition.steps.is_empty() || definition.steps.len() > limits().steps {
        return Err(DefinitionError::LimitExceeded);
    }
    if schema(&definition.input_schema)? != definition.input_schema_digest {
        return Err(DefinitionError::SchemaDigestMismatch);
    }
    let actions: BTreeSet<_> = definition.declared_action_digests.iter().collect();
    if actions.len() != definition.declared_action_digests.len()
        || actions.len() > limits().steps
        || actions.iter().any(|s| !digest_string(s))
    {
        return Err(DefinitionError::InvalidIdentity);
    }
    match &definition.trigger {
        Trigger::Manual => (),
        Trigger::Schedule {
            interval_seconds, ..
        } => {
            if !schedule_interval_supported(*interval_seconds) {
                return Err(DefinitionError::InvalidInput);
            }
        }
        Trigger::Event { event } => {
            if !bounded_label(event) {
                return Err(DefinitionError::InvalidIdentity);
            }
        }
    }
    let mut index = BTreeMap::new();
    for (i, step) in definition.steps.iter().enumerate() {
        if !valid_identity(&step.step_id) || !bounded_label(&step.label) {
            return Err(DefinitionError::InvalidIdentity);
        }
        if index.insert(step.step_id.clone(), i).is_some() {
            return Err(DefinitionError::InvalidGraph);
        }
    }
    let entry = *index
        .get(&definition.entry_step_id)
        .ok_or(DefinitionError::InvalidGraph)?;
    let mut predecessors = vec![BTreeSet::new(); definition.steps.len()];
    let mut successors = vec![Vec::new(); definition.steps.len()];
    for (i, step) in definition.steps.iter().enumerate() {
        for next in step.operation.successors() {
            let next = *index.get(next).ok_or(DefinitionError::InvalidGraph)?;
            predecessors[next].insert(i);
            successors[i].push(next);
        }
    }
    if !predecessors[entry].is_empty() {
        return Err(DefinitionError::InvalidGraph);
    }
    let mut remaining: Vec<_> = predecessors.iter().map(BTreeSet::len).collect();
    let mut ready = VecDeque::from([entry]);
    let mut order = Vec::new();
    while let Some(i) = ready.pop_front() {
        order.push(i);
        for &next in &successors[i] {
            remaining[next] -= 1;
            if remaining[next] == 0 {
                ready.push_back(next);
            }
        }
    }
    if order.len() != definition.steps.len() {
        return Err(DefinitionError::InvalidGraph);
    }
    let mut dominators: Vec<BTreeSet<usize>> = vec![BTreeSet::new(); definition.steps.len()];
    let mut ancestors: Vec<BTreeSet<usize>> = vec![BTreeSet::new(); definition.steps.len()];
    for i in order {
        let mut intersection: Option<BTreeSet<usize>> = None;
        for &previous in &predecessors[i] {
            let mut preceding = ancestors[previous].clone();
            preceding.insert(previous);
            ancestors[i].extend(preceding);
            let mut previous_set = dominators[previous].clone();
            previous_set.insert(previous);
            intersection = Some(match intersection {
                None => previous_set,
                Some(set) => set.intersection(&previous_set).copied().collect(),
            });
        }
        dominators[i] = intersection.unwrap_or_default();
        let mut expressions = Expressions {
            definition: &definition,
            index: &index,
            consumer: i,
            dominators: &dominators[i],
            ancestors: &ancestors[i],
            nodes: 0,
        };
        match &definition.steps[i].operation {
            Operation::Read {
                query,
                output_schema,
                ..
            } => {
                schema(output_schema)?;
                expressions.mapping(query, 1, false)?;
            }
            Operation::Transform {
                mapping,
                output_schema,
                ..
            } => {
                let output = json_schema::workflow_schema(output_schema.get())
                    .map_err(|_| DefinitionError::UnsupportedSchema)?;
                expressions.mapping_in(mapping, 1, false, Some(&output))?;
            }
            Operation::Condition { predicate, .. } => expressions.predicate(predicate, 1)?,
            Operation::Action {
                action_id,
                definition_digest,
                connection_id,
                account_id,
                input,
                ..
            } => {
                if !actions.contains(definition_digest)
                    || [action_id, connection_id, account_id]
                        .iter()
                        .any(|s| !bounded_label(s))
                {
                    return Err(DefinitionError::InvalidIdentity);
                }
                expressions.mapping(input, 1, false)?;
            }
            Operation::Wait { until, .. } => match until {
                WaitUntil::Timer { at } => {
                    if !utc(at) {
                        return Err(DefinitionError::InvalidInput);
                    }
                }
                WaitUntil::ExternalInput {
                    schema: output_schema,
                    expires_at,
                } => {
                    schema(output_schema)?;
                    if !utc(expires_at) {
                        return Err(DefinitionError::InvalidInput);
                    }
                }
            },
            Operation::Result { output } => expressions.mapping(output, 1, false)?,
        }
    }
    let expected = definition.definition_hash.take();
    let encoded = serde_json::to_string(&definition).map_err(|_| DefinitionError::InvalidJson)?;
    let canonical = canonical_json(&encoded)?;
    let definition_hash = hash(&canonical);
    if expected
        .as_ref()
        .is_some_and(|expected| expected != &definition_hash)
    {
        return Err(DefinitionError::DefinitionMismatch);
    }
    definition.definition_hash = Some(definition_hash.clone());
    let encoded = serde_json::to_string(&definition).map_err(|_| DefinitionError::InvalidJson)?;
    if encoded.len() > limits().definition_bytes {
        return Err(DefinitionError::LimitExceeded);
    }
    // Hash canonical values; store typed envelope integers as JSON integers so
    // serde can read a sealed schedule such as intervalSeconds=100.
    let canonical = encoded;
    Ok(ValidatedDefinition {
        definition,
        definition_hash,
        canonical,
    })
}

pub(super) fn validate_input(
    definition: &ValidatedDefinition,
    input: &str,
) -> Result<(), DefinitionError> {
    json_schema::workflow_validate_input(definition.definition.input_schema.get(), input)
        .map_err(|_| DefinitionError::InvalidInput)
}

#[path = "definition_decode.rs"]
mod decode;

pub(super) fn definition_byte_limit() -> usize {
    limits().definition_bytes
}
pub(super) fn canonical_json(text: &str) -> Result<String, DefinitionError> {
    json_schema::workflow_canonical_json(text, limits().definition_bytes, limits().json_depth)
        .map_err(json_error)
}

fn serialize_raw<S: serde::Serializer>(raw: &RawValue, serializer: S) -> Result<S::Ok, S::Error> {
    use serde::ser::Error;
    let text = canonical_json(raw.get())
        .map_err(|_| S::Error::custom("Invalid bounded workflow JSON."))?;
    RawValue::from_string(text)
        .map_err(S::Error::custom)?
        .serialize(serializer)
}

/// The editor codec writes the same format version as the authoritative validator.
pub(super) fn format_version() -> u32 {
    limits().format_version
}
