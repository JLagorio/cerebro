//! Counted, pure workflow expressions. This module has no effects or IO.
use super::definition::{limits, valid_identity, Mapping, Predicate};
use crate::actions::{read_types::ActionErrorCode, schema::{self, Node}};
use std::cmp::Ordering;
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum MappingError {
    InvalidJson,
    InvalidSchema,
    SchemaMismatch,
    MissingInput { path: Vec<String> },
    MissingStepOutput { step_id: String, path: Vec<String> },
    TypeMismatch,
    ExpressionLimit,
    OutputLimit,
    ContextLimit,
}

pub(super) struct Context {
    input: Node,
    // Only recorded outputs from this run's executed path belong here. The
    // runtime supplies that scope; an absent row never becomes a JSON null.
    outputs: BTreeMap<String, Node>,
}
fn parse(text: &str) -> Result<Node, MappingError> {
    schema::workflow_parse_value(text, limits().step_output_bytes, limits().json_depth)
        .map_err(|error| if error.code == ActionErrorCode::LimitExceeded {
            MappingError::ContextLimit
        } else { MappingError::InvalidJson })
}
impl Context {
    pub(super) fn new(input: &str, outputs: &BTreeMap<String, String>) -> Result<Self, MappingError> {
        if outputs.len() > limits().steps { return Err(MappingError::ContextLimit); }
        let input = parse(input)?;
        let mut total = 0usize;
        let outputs = outputs.iter().map(|(step, text)| {
            if !valid_identity(step) { return Err(MappingError::InvalidJson); }
            total = total.checked_add(text.len()).ok_or(MappingError::ContextLimit)?;
            if total > limits().run_output_bytes { return Err(MappingError::ContextLimit); }
            Ok((step.clone(), parse(text)?))
        }).collect::<Result<_, _>>()?;
        Ok(Self { input, outputs })
    }
}

fn missing(error: &MappingError) -> bool {
    matches!(error, MappingError::MissingInput { .. } | MappingError::MissingStepOutput { .. })
}
fn select<'a>(mut value: Option<&'a Node>, path: &[String]) -> Result<Option<&'a Node>, MappingError> {
    if path.len() > limits().path_segments || path.iter().any(|key| key.len() > limits().path_segment_bytes) {
        return Err(MappingError::ExpressionLimit);
    }
    for key in path {
        value = match value {
            Some(Node::Object(fields)) => fields.get(key),
            Some(Node::Array(items)) => key.parse::<usize>().ok()
                .filter(|index| index.to_string() == *key).and_then(|index| items.get(index)),
            _ => None,
        };
    }
    Ok(value)
}
fn append(out: &mut String, bytes: &str) -> Result<(), MappingError> {
    if bytes.len() > limits().step_output_bytes.saturating_sub(out.len()) {
        return Err(MappingError::OutputLimit);
    }
    out.push_str(bytes);
    Ok(())
}
struct Evaluator<'a> { context: &'a Context, nodes: usize }
impl Evaluator<'_> {
    fn visit(&mut self, depth: usize) -> Result<(), MappingError> {
        self.nodes += 1;
        if self.nodes > limits().expression_nodes || depth > limits().expression_depth {
            Err(MappingError::ExpressionLimit)
        } else { Ok(()) }
    }
    fn mapping(&mut self, mapping: &Mapping, depth: usize, schema: Option<&Node>) -> Result<String, MappingError> {
        self.visit(depth)?;
        let mut result = String::new();
        match mapping {
            Mapping::Literal { value } => append(&mut result, &parse(value.get())?.canonical())?,
            Mapping::Input { path } => {
                let value = select(Some(&self.context.input), path)?
                    .ok_or_else(|| MappingError::MissingInput { path: path.clone() })?;
                append(&mut result, &value.canonical())?;
            }
            Mapping::Output { step_id, path } => {
                let value = select(self.context.outputs.get(step_id), path)?
                    .ok_or_else(|| MappingError::MissingStepOutput { step_id: step_id.clone(), path: path.clone() })?;
                append(&mut result, &value.canonical())?;
            }
            Mapping::Array { items } => {
                append(&mut result, "[")?;
                let item_schema = schema::workflow_items(schema);
                for (i, item) in items.iter().enumerate() {
                    if i > 0 { append(&mut result, ",")?; }
                    append(&mut result, &self.mapping(item, depth + 1, item_schema)?)?;
                }
                append(&mut result, "]")?;
            }
            Mapping::Object { fields } => {
                append(&mut result, "{")?;
                let mut emitted = false;
                for (key, value) in fields {
                    if key.len() > limits().path_segment_bytes { return Err(MappingError::ExpressionLimit); }
                    let declared = schema::workflow_property(schema, key);
                    let value = match self.mapping(value, depth + 1, declared.map(|(schema, _)| schema)) {
                        Err(error) if missing(&error) && declared.is_some_and(|(_, required)| !required) => continue,
                        value => value?,
                    };
                    if emitted { append(&mut result, ",")?; }
                    append(&mut result, &serde_json::to_string(key).expect("JSON object key"))?;
                    append(&mut result, ":")?;
                    append(&mut result, &value)?;
                    emitted = true;
                }
                append(&mut result, "}")?;
            }
        }
        Ok(result)
    }
    fn predicate(&mut self, predicate: &Predicate, depth: usize) -> Result<bool, MappingError> {
        self.visit(depth)?;
        match predicate {
            Predicate::Exists { value } => match self.mapping(value, depth + 1, None) {
                Ok(_) => Ok(true), Err(error) if missing(&error) => Ok(false), Err(error) => Err(error),
            },
            Predicate::Equals { left, right } => Ok(self.mapping(left, depth + 1, None)? == self.mapping(right, depth + 1, None)?),
            Predicate::Less { left, right } | Predicate::Greater { left, right } => {
                let left = parse(&self.mapping(left, depth + 1, None)?)?;
                let right = parse(&self.mapping(right, depth + 1, None)?)?;
                let order = schema::workflow_compare_numbers(&left, &right).ok_or(MappingError::TypeMismatch)?;
                Ok(order == if matches!(predicate, Predicate::Less { .. }) { Ordering::Less } else { Ordering::Greater })
            }
            Predicate::All { items } => {
                if items.is_empty() { return Err(MappingError::TypeMismatch); }
                for item in items { if !self.predicate(item, depth + 1)? { return Ok(false); } }
                Ok(true)
            }
            Predicate::Any { items } => {
                if items.is_empty() { return Err(MappingError::TypeMismatch); }
                for item in items { if self.predicate(item, depth + 1)? { return Ok(true); } }
                Ok(false)
            }
            Predicate::Not { value } => self.predicate(value, depth + 1).map(|value| !value),
        }
    }
}
pub(super) fn evaluate(mapping: &Mapping, context: &Context, output_schema: Option<&str>) -> Result<String, MappingError> {
    let schema = output_schema.map(schema::workflow_schema).transpose().map_err(|_| MappingError::InvalidSchema)?;
    let result = Evaluator { context, nodes: 0 }.mapping(mapping, 1, schema.as_ref())?;
    let parsed = parse(&result)?;
    if schema.as_ref().is_some_and(|schema| !schema::workflow_matches(schema, &parsed)) {
        return Err(MappingError::SchemaMismatch);
    }
    Ok(result)
}
pub(super) fn predicate(predicate: &Predicate, context: &Context) -> Result<bool, MappingError> {
    Evaluator { context, nodes: 0 }.predicate(predicate, 1)
}

#[cfg(test)]
#[path = "mapping_tests.rs"]
mod tests;
