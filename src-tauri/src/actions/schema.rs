//! Bounded JSON parser and deliberately closed schema subset. No f64 input path.
use super::read_types::*;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::{collections::BTreeMap, sync::OnceLock};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HistoryInspectionLimits {
    pub max_effects: usize,
    pub max_stored_payload_bytes: usize,
    pub max_stored_payload_bytes_total: usize,
    pub max_output_bytes: usize,
    pub max_effect_details_bytes: usize,
    pub max_depth: usize,
    pub max_nodes: usize,
    pub max_object_keys: usize,
    pub max_array_items: usize,
    pub max_string_bytes: usize,
    pub max_attempts: usize,
    pub max_retry_decisions: usize,
    pub max_preview_fields: usize,
    pub max_redacted_fields: usize,
    pub max_preview_summary_bytes: usize,
    pub max_preview_label_bytes: usize,
    pub max_preview_value_bytes: usize,
    pub max_target_reference_bytes: usize,
    pub max_attempt_summary_bytes: usize,
    pub max_timestamp_bytes: usize,
    pub max_id_bytes: usize,
    pub max_account_label_bytes: usize,
    pub max_metadata_bytes: usize,
    pub output_metadata_reserve_bytes: usize,
    pub max_issues: usize,
}
pub(crate) fn history_limits() -> &'static HistoryInspectionLimits {
    &policy().history_inspection
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Limits {
    pub input_bytes: usize,
    pub schema_bytes: usize,
    pub definition_bytes: usize,
    pub depth: usize,
    pub nodes: usize,
    pub keys: usize,
    pub array_items: usize,
    pub string_bytes: usize,
    pub number_bytes: usize,
    pub exponent: i32,
    pub catalog_definitions: usize,
}
pub(crate) type AdmissionRules =
    super::native_rules::AdmissionRules<super::native_rules::AdmissionLimits>;
pub(super) use super::native_rules::POLICY;
pub(crate) fn admission_rules() -> &'static AdmissionRules {
    &policy().admission
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Policy {
    version: u32,
    admission: AdmissionRules,
    history_inspection: HistoryInspectionLimits,
    registration: String,
    effect_classes: Vec<EffectClass>,
    classification: String,
    provider_annotations: String,
    reserved_tools: Vec<String>,
    reserved_errors: Vec<String>,
    runtime_destiny: String,
    limits: Limits,
    schema_keywords: Vec<String>,
    schema_types: Vec<String>,
}
fn policy() -> &'static Policy {
    static POLICY_VALUE: OnceLock<Policy> = OnceLock::new();
    POLICY_VALUE.get_or_init(|| {
        let p: Policy = serde_json::from_str(POLICY).expect("action policy");
        assert_eq!(p.version, 1);
        assert_eq!(p.registration, "retained_native_origins_only");
        assert_eq!(p.classification, "trusted_local_definition_only");
        assert_eq!(p.provider_annotations, "never_authority");
        assert_eq!(p.effect_classes.len(), 7);
        assert_eq!(p.reserved_tools.len(), 5);
        assert_eq!(p.reserved_errors.len(), 9);
        assert_eq!(p.runtime_destiny, "operational_at_registration");
        super::native_rules::validate(&p.admission);
        p
    })
}
pub(crate) fn limits() -> &'static Limits {
    &policy().limits
}
pub(super) fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn invalid(message: &str) -> ActionError {
    error(ActionErrorCode::InvalidInput, message)
}
fn limit() -> ActionError {
    error(
        ActionErrorCode::LimitExceeded,
        "Action JSON exceeds its bounded limits.",
    )
}
fn unsupported() -> ActionError {
    error(
        ActionErrorCode::UnsupportedSchema,
        "This action schema is unsupported and cannot be called.",
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Node {
    Null,
    Bool(bool),
    String(String),
    Number(String),
    Array(Vec<Node>),
    Object(BTreeMap<String, Node>),
}
impl Node {
    fn object(&self) -> Option<&BTreeMap<String, Node>> {
        if let Self::Object(v) = self {
            Some(v)
        } else {
            None
        }
    }
    fn string(&self) -> Option<&str> {
        if let Self::String(v) = self {
            Some(v)
        } else {
            None
        }
    }
    fn array(&self) -> Option<&[Node]> {
        if let Self::Array(v) = self {
            Some(v)
        } else {
            None
        }
    }
    fn number(&self) -> Option<&str> {
        if let Self::Number(v) = self {
            Some(v)
        } else {
            None
        }
    }
    pub(crate) fn canonical(&self) -> String {
        match self {
            Self::Null => "null".into(),
            Self::Bool(v) => v.to_string(),
            Self::String(v) => serde_json::to_string(v).expect("string"),
            Self::Number(v) => v.clone(),
            Self::Array(v) => format!(
                "[{}]",
                v.iter().map(Self::canonical).collect::<Vec<_>>().join(",")
            ),
            Self::Object(v) => format!(
                "{{{}}}",
                v.iter()
                    .map(|(k, v)| format!(
                        "{}:{}",
                        serde_json::to_string(k).expect("key"),
                        v.canonical()
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            ),
        }
    }
}
#[derive(Debug, Clone)]
pub(super) struct ValidatedInput {
    #[cfg(test)]
    pub canonical: String,
    pub digest: String,
    pub value: Node,
}

struct Parser<'a> {
    text: &'a str,
    pos: usize,
    nodes: usize,
    depth_limit: usize,
}
impl<'a> Parser<'a> {
    fn ws(&mut self) {
        while matches!(
            self.text.as_bytes().get(self.pos),
            Some(b' ' | b'\n' | b'\r' | b'\t')
        ) {
            self.pos += 1;
        }
    }
    fn byte(&self) -> Option<u8> {
        self.text.as_bytes().get(self.pos).copied()
    }
    fn take(&mut self, b: u8) -> bool {
        self.ws();
        if self.byte() == Some(b) {
            self.pos += 1;
            true
        } else {
            false
        }
    }
    fn string(&mut self) -> Result<String, ActionError> {
        self.ws();
        let start = self.pos;
        if self.byte() != Some(b'"') {
            return Err(invalid("Expected a JSON string."));
        }
        self.pos += 1;
        let mut escaped = false;
        while let Some(b) = self.byte() {
            // Bound encoded bytes before allocating decoded Unicode/key material.
            if self.pos - start - 1 > limits().string_bytes {
                return Err(limit());
            }
            self.pos += 1;
            if escaped {
                escaped = false;
            } else if b == b'\\' {
                escaped = true;
            } else if b == b'"' {
                return serde_json::from_str(&self.text[start..self.pos])
                    .map_err(|_| invalid("Invalid JSON string."));
            }
        }
        Err(invalid("Unterminated JSON string."))
    }
    fn node(&mut self, depth: usize) -> Result<Node, ActionError> {
        if depth > self.depth_limit || self.nodes >= limits().nodes {
            return Err(limit());
        }
        self.nodes += 1;
        self.ws();
        Ok(match self.byte() {
            Some(b'"') => Node::String(self.string()?),
            Some(b'{') => {
                self.pos += 1;
                let mut values = BTreeMap::new();
                if self.take(b'}') {
                    return Ok(Node::Object(values));
                }
                loop {
                    if values.len() >= limits().keys {
                        return Err(limit());
                    }
                    let key = self.string()?;
                    if values.contains_key(&key) {
                        return Err(invalid("Duplicate object key."));
                    }
                    if !self.take(b':') {
                        return Err(invalid("Expected object colon."));
                    }
                    values.insert(key, self.node(depth + 1)?);
                    if self.take(b'}') {
                        break;
                    }
                    if !self.take(b',') {
                        return Err(invalid("Expected object delimiter."));
                    }
                }
                Node::Object(values)
            }
            Some(b'[') => {
                self.pos += 1;
                let mut values = Vec::new();
                if self.take(b']') {
                    return Ok(Node::Array(values));
                }
                loop {
                    if values.len() >= limits().array_items {
                        return Err(limit());
                    }
                    values.push(self.node(depth + 1)?);
                    if self.take(b']') {
                        break;
                    }
                    if !self.take(b',') {
                        return Err(invalid("Expected array delimiter."));
                    }
                }
                Node::Array(values)
            }
            Some(b'n') if self.text[self.pos..].starts_with("null") => {
                self.pos += 4;
                Node::Null
            }
            Some(b't') if self.text[self.pos..].starts_with("true") => {
                self.pos += 4;
                Node::Bool(true)
            }
            Some(b'f') if self.text[self.pos..].starts_with("false") => {
                self.pos += 5;
                Node::Bool(false)
            }
            Some(b'-' | b'0'..=b'9') => {
                let start = self.pos;
                while matches!(
                    self.byte(),
                    Some(b'0'..=b'9' | b'-' | b'+' | b'.' | b'e' | b'E')
                ) {
                    if self.pos - start >= limits().number_bytes {
                        return Err(limit());
                    }
                    self.pos += 1;
                }
                Node::Number(normalize_number(&self.text[start..self.pos])?)
            }
            _ => return Err(invalid("Invalid finite JSON value.")),
        })
    }
}
fn normalize_number(text: &str) -> Result<String, ActionError> {
    static NUMBER: OnceLock<regex::Regex> = OnceLock::new();
    if !NUMBER
        .get_or_init(|| {
            regex::Regex::new(r"^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$").unwrap()
        })
        .is_match(text)
    {
        return Err(invalid("Invalid finite decimal number."));
    }
    let negative = text.starts_with('-');
    let unsigned = text.trim_start_matches('-');
    let (mantissa, exponent) = unsigned.split_once(['e', 'E']).unwrap_or((unsigned, "0"));
    let mut exponent: i32 = exponent.parse().map_err(|_| limit())?;
    if exponent.unsigned_abs() > limits().exponent as u32 {
        return Err(limit());
    }
    let fraction = mantissa.split_once('.').map_or(0, |(_, f)| f.len());
    exponent -= fraction as i32;
    let digits = mantissa.replace('.', "");
    let digits = digits.trim_start_matches('0');
    if digits.is_empty() {
        return Ok("0".into());
    }
    let significant = digits.trim_end_matches('0');
    exponent += (digits.len() - significant.len()) as i32;
    if exponent.unsigned_abs() > limits().exponent as u32 {
        return Err(limit());
    }
    Ok(format!(
        "{}{}{}",
        if negative { "-" } else { "" },
        significant,
        if exponent == 0 {
            String::new()
        } else {
            format!("e{exponent}")
        }
    ))
}
pub(super) fn parse_bounded(text: &str, bytes: usize) -> Result<Node, ActionError> {
    parse_bounded_with_depth(text, bytes, limits().depth)
}
fn parse_bounded_with_depth(
    text: &str,
    bytes: usize,
    depth_limit: usize,
) -> Result<Node, ActionError> {
    if text.len() > bytes {
        return Err(limit());
    }
    let mut parser = Parser {
        text,
        pos: 0,
        nodes: 0,
        depth_limit,
    };
    let node = parser.node(0)?;
    parser.ws();
    if parser.pos != text.len() {
        return Err(invalid("Trailing JSON content."));
    }
    Ok(node)
}
pub(super) fn canonicalize(text: &str, schema: bool) -> Result<ValidatedInput, ActionError> {
    let value = parse_bounded(
        text,
        if schema {
            limits().schema_bytes
        } else {
            limits().input_bytes
        },
    )?;
    let canonical = value.canonical();
    let digest = digest(canonical.as_bytes());
    Ok(ValidatedInput {
        #[cfg(test)]
        canonical,
        digest,
        value,
    })
}
// Normalized exact decimal comparison; at most numberBytes significant digits.
fn decimal_parts(text: &str) -> (bool, &str, i32) {
    let negative = text.starts_with('-');
    let unsigned = text.trim_start_matches('-');
    let (digits, exponent) = unsigned.split_once('e').unwrap_or((unsigned, "0"));
    (
        negative,
        digits,
        exponent.parse().expect("normalized exponent"),
    )
}
fn compare_number(a: &str, b: &str) -> Ordering {
    if a == b {
        return Ordering::Equal;
    }
    let (an, ad, ae) = decimal_parts(a);
    let (bn, bd, be) = decimal_parts(b);
    if an != bn {
        return if an {
            Ordering::Less
        } else {
            Ordering::Greater
        };
    }
    let magnitude = if ad == "0" {
        Ordering::Less
    } else if bd == "0" {
        Ordering::Greater
    } else {
        (ad.len() as i32 + ae)
            .cmp(&(bd.len() as i32 + be))
            .then_with(|| {
                let len = ad.len().max(bd.len());
                ad.bytes()
                    .chain(std::iter::repeat(b'0'))
                    .take(len)
                    .cmp(bd.bytes().chain(std::iter::repeat(b'0')).take(len))
            })
    };
    if an {
        magnitude.reverse()
    } else {
        magnitude
    }
}
fn count(node: &Node) -> Option<usize> {
    let text = node.number()?;
    let (negative, digits, exp) = decimal_parts(text);
    if negative || exp < 0 {
        return None;
    }
    digits
        .parse::<usize>()
        .ok()?
        .checked_mul(10usize.checked_pow(exp as u32)?)
}

#[derive(Debug)]
pub(super) struct CompiledSchema {
    root: Node,
}
pub(super) fn compile_schema(text: &str) -> Result<CompiledSchema, ActionError> {
    let schema = canonicalize(text, true)
        .map_err(|e| {
            if e.code == ActionErrorCode::LimitExceeded {
                e
            } else {
                unsupported()
            }
        })?
        .value;
    check_schema(&schema)?;
    Ok(CompiledSchema { root: schema })
}
fn check_schema(schema: &Node) -> Result<(), ActionError> {
    let s = schema.object().ok_or_else(unsupported)?;
    if s.keys().any(|k| !policy().schema_keywords.contains(k)) {
        return Err(unsupported());
    }
    if let Some(dialect) = s.get("$schema") {
        if dialect.string() != Some("https://json-schema.org/draft/2020-12/schema") {
            return Err(unsupported());
        }
    }
    let kind = s
        .get("type")
        .and_then(Node::string)
        .ok_or_else(unsupported)?;
    if !policy().schema_types.iter().any(|t| t == kind) {
        return Err(unsupported());
    }
    for key in ["description", "title"] {
        if s.get(key).is_some_and(|v| v.string().is_none()) {
            return Err(unsupported());
        }
    }
    for key in ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"] {
        if let Some(v) = s.get(key) {
            if !matches!(kind, "number" | "integer") || v.number().is_none() {
                return Err(unsupported());
            }
        }
    }
    for key in ["minLength", "maxLength", "minItems", "maxItems"] {
        if let Some(v) = s.get(key) {
            if count(v).is_none()
                || (key.ends_with("Length") && kind != "string")
                || (key.ends_with("Items") && kind != "array")
            {
                return Err(unsupported());
            }
        }
    }
    if let Some(props) = s.get("properties") {
        if kind != "object" {
            return Err(unsupported());
        }
        for child in props.object().ok_or_else(unsupported)?.values() {
            check_schema(child)?;
        }
    }
    if let Some(required) = s.get("required") {
        if kind != "object" {
            return Err(unsupported());
        }
        let fields = required.array().ok_or_else(unsupported)?;
        let mut seen = std::collections::BTreeSet::new();
        for field in fields {
            if !seen.insert(field.string().ok_or_else(unsupported)?) {
                return Err(unsupported());
            }
        }
    }
    if let Some(additional) = s.get("additionalProperties") {
        if kind != "object" || !matches!(additional, Node::Bool(_)) {
            return Err(unsupported());
        }
    }
    if let Some(items) = s.get("items") {
        if kind != "array" {
            return Err(unsupported());
        }
        check_schema(items)?;
    }
    if let Some(values) = s.get("enum") {
        if values.array().is_none_or(|v| v.is_empty()) {
            return Err(unsupported());
        }
    }
    Ok(())
}
fn matches_schema(schema: &Node, input: &Node) -> bool {
    let s = schema.object().expect("compiled schema");
    let kind = s["type"].string().expect("type");
    let matches = match kind {
        "null" => matches!(input, Node::Null),
        "boolean" => matches!(input, Node::Bool(_)),
        "string" => matches!(input, Node::String(_)),
        "object" => matches!(input, Node::Object(_)),
        "array" => matches!(input, Node::Array(_)),
        "number" => matches!(input, Node::Number(_)),
        "integer" => input.number().is_some_and(|v| decimal_parts(v).2 >= 0),
        _ => false,
    };
    if !matches
        || s.get("const").is_some_and(|v| v != input)
        || s.get("enum")
            .is_some_and(|v| !v.array().expect("enum").contains(input))
    {
        return false;
    }
    if let Node::Number(value) = input {
        for (key, order, equal) in [
            ("minimum", Ordering::Less, true),
            ("maximum", Ordering::Greater, true),
            ("exclusiveMinimum", Ordering::Less, false),
            ("exclusiveMaximum", Ordering::Greater, false),
        ] {
            if let Some(bound) = s.get(key) {
                let cmp = compare_number(value, bound.number().expect("bound"));
                if cmp == order || (!equal && cmp == Ordering::Equal) {
                    return false;
                }
            }
        }
    }
    if let Node::String(value) = input {
        let len = value.chars().count();
        if s.get("minLength").is_some_and(|n| len < count(n).unwrap())
            || s.get("maxLength").is_some_and(|n| len > count(n).unwrap())
        {
            return false;
        }
    }
    if let Node::Array(values) = input {
        if s.get("minItems")
            .is_some_and(|n| values.len() < count(n).unwrap())
            || s.get("maxItems")
                .is_some_and(|n| values.len() > count(n).unwrap())
        {
            return false;
        }
        if let Some(items) = s.get("items") {
            if values.iter().any(|v| !matches_schema(items, v)) {
                return false;
            }
        }
    }
    if let Node::Object(values) = input {
        if s.get("required").is_some_and(|v| {
            v.array()
                .unwrap()
                .iter()
                .any(|k| !values.contains_key(k.string().unwrap()))
        }) {
            return false;
        }
        let props = s.get("properties").and_then(Node::object);
        for (key, value) in values {
            if let Some(child) = props.and_then(|p| p.get(key)) {
                if !matches_schema(child, value) {
                    return false;
                }
            } else if s.get("additionalProperties") == Some(&Node::Bool(false)) {
                return false;
            }
        }
    }
    true
}
pub(super) fn validate(
    schema: &CompiledSchema,
    input: &str,
) -> Result<ValidatedInput, ActionError> {
    let validated = canonicalize(input, false)?;
    if !matches_schema(&schema.root, &validated.value) {
        return Err(invalid("Input does not match the action schema."));
    }
    Ok(validated)
}
pub(super) fn validate_input(
    definition: &ActionDefinition,
    input: &str,
) -> Result<ValidatedInput, ActionError> {
    validate(&compile_schema(&definition.input_schema)?, input)
}
pub(super) fn validate_output(
    definition: &ActionDefinition,
    output: &str,
) -> Result<ValidatedInput, ActionError> {
    validate(&compile_schema(&definition.output_schema)?, output)
}

/// Reuse the action boundary's duplicate-key refusal, exact decimals and allocation
/// limits for workflow definitions; do not introduce a second schema evaluator.
pub(crate) fn workflow_canonical_json(
    text: &str,
    bytes: usize,
    depth: usize,
) -> Result<String, ActionError> {
    Ok(parse_bounded_with_depth(text, bytes, depth)?.canonical())
}
pub(crate) fn workflow_schema_digest(text: &str) -> Result<String, ActionError> {
    let schema = compile_schema(text)?;
    Ok(digest(schema.root.canonical().as_bytes()))
}
pub(crate) fn workflow_validate_input(schema: &str, input: &str) -> Result<(), ActionError> {
    validate(&compile_schema(schema)?, input).map(|_| ())
}
pub(crate) fn workflow_parse_value(
    text: &str,
    bytes: usize,
    depth: usize,
) -> Result<Node, ActionError> {
    parse_bounded_with_depth(text, bytes, depth)
}
pub(crate) fn workflow_schema(text: &str) -> Result<Node, ActionError> {
    compile_schema(text).map(|schema| schema.root)
}
pub(crate) fn workflow_matches(schema: &Node, value: &Node) -> bool {
    matches_schema(schema, value)
}
/// Declaration hints for the workflow interpreter and its static validator.
/// The caller passes a schema produced by workflow_schema, not arbitrary JSON.
pub(crate) fn workflow_property<'a>(
    schema: Option<&'a Node>,
    key: &str,
) -> Option<(&'a Node, bool)> {
    let schema = schema?.object()?;
    let property = schema.get("properties")?.object()?.get(key)?;
    let required = schema
        .get("required")
        .and_then(Node::array)
        .is_some_and(|fields| fields.iter().any(|field| field.string() == Some(key)));
    Some((property, required))
}
pub(crate) fn workflow_items(schema: Option<&Node>) -> Option<&Node> {
    schema?.object()?.get("items")
}
/// Both arguments came from the exact-decimal parser, never arbitrary text.
pub(crate) fn workflow_compare_numbers(left: &Node, right: &Node) -> Option<Ordering> {
    Some(compare_number(left.number()?, right.number()?))
}
