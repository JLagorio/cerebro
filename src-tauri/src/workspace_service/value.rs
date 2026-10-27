//! Canonical bounded values for inactive staging; legacy patches remain test-only.
//! No writer, admission decision or receipt lives here.

use super::types::values::*;
use serde::{
    de::{MapAccess, Visitor},
    Deserialize, Deserializer,
};
#[cfg(test)]
use serde_json::Map;
use serde_json::{value::RawValue, Value};
use std::{collections::BTreeMap, sync::OnceLock};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DecimalRule {
    pattern: String,
    max_lexeme_bytes: usize,
    legacy_max_safe_integer: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Limits {
    max_source_bytes: usize,
    max_depth: usize,
    max_nodes: usize,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DateRule {
    grammar: String,
    date: String,
    instant: String,
    implicit_conversion: bool,
}
#[derive(Deserialize)]
struct Rules {
    version: u32,
    decimal: DecimalRule,
    limits: Limits,
    dates: DateRule,
}

fn rules() -> &'static Rules {
    static RULES: OnceLock<Rules> = OnceLock::new();
    RULES.get_or_init(|| {
        let rules: Rules =
            serde_json::from_str(include_str!("../../../shared/workspace/values.v1.json"))
                .expect("workspace value rules");
        assert_eq!(rules.version, 1);
        assert_eq!(rules.dates.grammar, crate::vault::dates::DATES_PATH);
        assert_eq!(rules.dates.date, "calendar_day_only");
        assert_eq!(rules.dates.instant, "zoned_instant_only");
        assert!(!rules.dates.implicit_conversion);
        rules
    })
}

fn invalid(message: &str) -> ValueError {
    ValueError {
        code: ValueErrorCode::SchemaInvalid,
        message: message.into(),
        retryable: false,
    }
}

fn unsupported(message: &str) -> ValueError {
    ValueError {
        code: ValueErrorCode::CapabilityUnavailable,
        message: message.into(),
        retryable: false,
    }
}

fn check_source(source: &str) -> Result<(), ValueError> {
    if source.len() > rules().limits.max_source_bytes {
        return Err(invalid("Workspace value exceeds its byte limit."));
    }
    // Bound nesting before asking even RawValue's syntax reader to traverse it.
    let (mut quoted, mut escaped, mut depth) = (false, false, 0_usize);
    for byte in source.bytes() {
        if quoted {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                quoted = false;
            }
        } else {
            match byte {
                b'"' => quoted = true,
                b'[' | b'{' => {
                    depth += 1;
                    if depth > rules().limits.max_depth {
                        return Err(invalid("Workspace value exceeds its nesting limit."));
                    }
                }
                b']' | b'}' => depth = depth.saturating_sub(1),
                _ => {}
            }
        }
    }
    Ok(())
}

fn decimal_valid(value: &str) -> bool {
    static DECIMAL: OnceLock<regex::Regex> = OnceLock::new();
    value.len() <= rules().decimal.max_lexeme_bytes
        && DECIMAL
            .get_or_init(|| {
                regex::Regex::new(&rules().decimal.pattern).expect("workspace decimal grammar")
            })
            .is_match(value)
}

struct RawObject(BTreeMap<String, Box<RawValue>>);
impl<'de> Deserialize<'de> for RawObject {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ObjectVisitor;
        impl<'de> Visitor<'de> for ObjectVisitor {
            type Value = RawObject;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("an object with unique keys")
            }
            fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<Self::Value, M::Error> {
                let mut values = BTreeMap::new();
                while let Some((key, value)) = map.next_entry::<String, Box<RawValue>>()? {
                    if values.insert(key, value).is_some() {
                        return Err(serde::de::Error::custom("duplicate object key"));
                    }
                }
                Ok(RawObject(values))
            }
        }
        deserializer.deserialize_map(ObjectVisitor)
    }
}

fn raw_node(raw: &RawValue, nodes: &mut usize) -> Result<PropertyValue, ValueError> {
    *nodes += 1;
    if *nodes > rules().limits.max_nodes {
        return Err(invalid("Workspace value exceeds its node limit."));
    }
    let text = raw.get();
    Ok(match text.as_bytes().first() {
        Some(b'n') => PropertyValue::Null {},
        Some(b't' | b'f') => PropertyValue::Boolean {
            value: text == "true",
        },
        Some(b'"') => PropertyValue::String {
            value: serde_json::from_str(text).map_err(|_| invalid("Invalid JSON string."))?,
        },
        Some(b'[') => {
            let values: Vec<Box<RawValue>> =
                serde_json::from_str(text).map_err(|_| invalid("Invalid JSON array."))?;
            PropertyValue::Array {
                value: values
                    .iter()
                    .map(|item| raw_node(item, nodes))
                    .collect::<Result<_, _>>()?,
            }
        }
        Some(b'{') => {
            let RawObject(values) = serde_json::from_str(text)
                .map_err(|_| invalid("Invalid JSON object or duplicate key."))?;
            PropertyValue::Object {
                value: values
                    .into_iter()
                    .map(|(key, item)| Ok((key, raw_node(&item, nodes)?)))
                    .collect::<Result<_, ValueError>>()?,
            }
        }
        _ if decimal_valid(text) => PropertyValue::Decimal { value: text.into() },
        _ => return Err(invalid("Invalid finite decimal lexeme.")),
    })
}

fn temporal_valid(value: &str, instant: bool) -> bool {
    crate::vault::dates::is_date_text(&Value::String(value.into()))
        && crate::vault::dates::parse_date_text(value, &chrono_tz::UTC).is_some_and(|endpoint| {
            if instant {
                endpoint.instant
            } else {
                !endpoint.instant && endpoint.time.is_none()
            }
        })
}

/// Raw JSON enters as RawValue, never serde_json::Number or serde_yaml::Value.
/// Numbers become exact finite lexical strings before any f64 conversion.
pub(crate) fn decode_json(source: &str, schema: ValueSchema) -> Result<PropertyValue, ValueError> {
    check_source(source)?;
    let raw: Box<RawValue> =
        serde_json::from_str(source).map_err(|_| invalid("Malformed JSON value."))?;
    let value = raw_node(&raw, &mut 0)?;
    match (schema, value) {
        (ValueSchema::Plain, value) | (_, value @ PropertyValue::Null {}) => Ok(value),
        (ValueSchema::Date, PropertyValue::String { value }) if temporal_valid(&value, false) => {
            Ok(PropertyValue::Date { value })
        }
        (ValueSchema::Instant, PropertyValue::String { value }) if temporal_valid(&value, true) => {
            Ok(PropertyValue::Instant { value })
        }
        _ => Err(invalid(
            "Value does not match its declared date or instant schema.",
        )),
    }
}

fn validate_value(
    value: &PropertyValue,
    depth: usize,
    nodes: &mut usize,
) -> Result<(), ValueError> {
    *nodes += 1;
    if depth > rules().limits.max_depth || *nodes > rules().limits.max_nodes {
        return Err(invalid("Workspace value exceeds its structural limits."));
    }
    match value {
        PropertyValue::Decimal { value } if !decimal_valid(value) => {
            return Err(invalid("Invalid finite decimal lexeme."))
        }
        PropertyValue::Date { value } if !temporal_valid(value, false) => {
            return Err(invalid("Invalid calendar date."))
        }
        PropertyValue::Instant { value } if !temporal_valid(value, true) => {
            return Err(invalid("Invalid zoned instant."))
        }
        PropertyValue::Array { value } => {
            for item in value {
                validate_value(item, depth + 1, nodes)?;
            }
        }
        PropertyValue::Object { value } => {
            for item in value.values() {
                validate_value(item, depth + 1, nodes)?;
            }
        }
        PropertyValue::Relation {
            spelling,
            resolution,
            ..
        } if spelling.is_empty()
            || matches!(resolution, RelationResolution::Resolved { target_id } if target_id.is_empty()) =>
        {
            return Err(invalid(
                "A relation retains spelling and an existing target ID when resolved.",
            ));
        }
        _ => {}
    }
    Ok(())
}

pub(crate) fn decode_tagged(source: &str) -> Result<PropertyValue, ValueError> {
    // This first pass enforces bounds, unique map keys and valid UTF-8 strings.
    // Valid tagged DTOs carry all numbers as strings; the typed second pass
    // rejects numeric fields instead of accepting already-rounded values.
    decode_json(source, ValueSchema::Plain)?;
    let value: PropertyValue =
        serde_json::from_str(source).map_err(|_| invalid("Invalid tagged workspace value."))?;
    validate_value(&value, 0, &mut 0)?;
    Ok(value)
}

// Exact comparison is a view of a bounded lexeme, never a rewrite of metadata.
// Magnitude exponents are bounded digit strings, not machine exponents or an
// instruction to allocate zeros. This also handles 256-byte exponent lexemes.
struct DecimalPower {
    negative: bool,
    digits: Vec<u8>,
}
impl DecimalPower {
    fn new(negative: bool, digits: &[u8]) -> Self {
        let first = digits
            .iter()
            .position(|digit| *digit != b'0')
            .unwrap_or(digits.len());
        let digits = if first == digits.len() {
            vec![b'0']
        } else {
            digits[first..].to_vec()
        };
        Self {
            negative: negative && digits != [b'0'],
            digits,
        }
    }
    fn magnitude(a: &[u8], b: &[u8]) -> std::cmp::Ordering {
        a.len().cmp(&b.len()).then_with(|| a.cmp(b))
    }
    fn sum(a: &[u8], b: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut carry = 0u8;
        for index in 0..a.len().max(b.len()) {
            let x = a
                .len()
                .checked_sub(index + 1)
                .map(|i| a[i] - b'0')
                .unwrap_or(0);
            let y = b
                .len()
                .checked_sub(index + 1)
                .map(|i| b[i] - b'0')
                .unwrap_or(0);
            let sum = x + y + carry;
            out.push(b'0' + sum % 10);
            carry = sum / 10;
        }
        if carry != 0 {
            out.push(b'0' + carry);
        }
        out.reverse();
        out
    }
    // a >= b; both are normalized nonnegative integer digit strings.
    fn difference(a: &[u8], b: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut borrow = 0i16;
        for index in 0..a.len() {
            let x = i16::from(a[a.len() - index - 1] - b'0');
            let y = b
                .len()
                .checked_sub(index + 1)
                .map(|i| i16::from(b[i] - b'0'))
                .unwrap_or(0);
            let value = x - y - borrow;
            borrow = i16::from(value < 0);
            out.push(
                b'0' + u8::try_from(if value < 0 { value + 10 } else { value })
                    .expect("decimal subtraction digit"),
            );
        }
        out.reverse();
        Self::new(false, &out).digits
    }
    fn offset(self, offset: i32) -> Self {
        if offset == 0 {
            return self;
        }
        let other = Self::new(offset < 0, offset.unsigned_abs().to_string().as_bytes());
        if self.negative == other.negative {
            return Self::new(self.negative, &Self::sum(&self.digits, &other.digits));
        }
        match Self::magnitude(&self.digits, &other.digits) {
            std::cmp::Ordering::Less => Self::new(
                other.negative,
                &Self::difference(&other.digits, &self.digits),
            ),
            _ => Self::new(
                self.negative,
                &Self::difference(&self.digits, &other.digits),
            ),
        }
    }
    fn compare(&self, other: &Self) -> std::cmp::Ordering {
        if self.negative != other.negative {
            return if self.negative {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Greater
            };
        }
        let order = Self::magnitude(&self.digits, &other.digits);
        if self.negative {
            order.reverse()
        } else {
            order
        }
    }
}
struct ComparableDecimal {
    negative: bool,
    digits: Vec<u8>,
    power: DecimalPower,
}
fn comparable_decimal(source: &str) -> Option<ComparableDecimal> {
    let negative = source.starts_with('-');
    let source = source.strip_prefix('-').unwrap_or(source);
    let (mantissa, exponent) = source.split_once(['e', 'E']).unwrap_or((source, "0"));
    let fraction = mantissa
        .split_once('.')
        .map(|(_, fraction)| fraction.len())
        .unwrap_or(0);
    let raw = mantissa
        .bytes()
        .filter(|digit| *digit != b'.')
        .collect::<Vec<_>>();
    let first = raw.iter().position(|digit| *digit != b'0')?;
    let significant = raw.len() - first;
    let mut digits = raw[first..].to_vec();
    while digits.last() == Some(&b'0') {
        digits.pop();
    }
    let power = DecimalPower::new(
        exponent.starts_with('-'),
        exponent.trim_start_matches(['-', '+']).as_bytes(),
    );
    let offset = i32::try_from(significant).expect("bounded decimal digits")
        - i32::try_from(fraction).expect("bounded decimal fraction");
    Some(ComparableDecimal {
        negative,
        digits,
        power: power.offset(offset),
    })
}
pub(crate) fn compare_decimals(left: &str, right: &str) -> Result<std::cmp::Ordering, ValueError> {
    use std::cmp::Ordering;
    if !decimal_valid(left) || !decimal_valid(right) {
        return Err(invalid("Invalid finite decimal comparison lexeme."));
    }
    let (a, b) = (comparable_decimal(left), comparable_decimal(right));
    let (a, b) = match (a, b) {
        (None, None) => return Ok(Ordering::Equal),
        (None, Some(b)) => {
            return Ok(if b.negative {
                Ordering::Greater
            } else {
                Ordering::Less
            })
        }
        (Some(a), None) => {
            return Ok(if a.negative {
                Ordering::Less
            } else {
                Ordering::Greater
            })
        }
        (Some(a), Some(b)) => (a, b),
    };
    if a.negative != b.negative {
        return Ok(if a.negative {
            Ordering::Less
        } else {
            Ordering::Greater
        });
    }
    let order = a.power.compare(&b.power).then_with(|| {
        let count = a.digits.len().max(b.digits.len());
        a.digits
            .iter()
            .copied()
            .chain(std::iter::repeat(b'0'))
            .take(count)
            .cmp(
                b.digits
                    .iter()
                    .copied()
                    .chain(std::iter::repeat(b'0'))
                    .take(count),
            )
    });
    Ok(if a.negative { order.reverse() } else { order })
}

pub(crate) fn legacy_value(value: &PropertyValue) -> Result<Value, ValueError> {
    Ok(match value {
        PropertyValue::Null {} => Value::Null,
        PropertyValue::String { value }
        | PropertyValue::Date { value }
        | PropertyValue::Instant { value } => Value::String(value.clone()),
        PropertyValue::Boolean { value } => Value::Bool(*value),
        PropertyValue::Array { value } => {
            Value::Array(value.iter().map(legacy_value).collect::<Result<_, _>>()?)
        }
        PropertyValue::Object { value } => Value::Object(
            value
                .iter()
                .map(|(key, value)| Ok((key.clone(), legacy_value(value)?)))
                .collect::<Result<_, ValueError>>()?,
        ),
        PropertyValue::Decimal { value } => {
            let number = value
                .parse::<i64>()
                .ok()
                .filter(|number| {
                    number.to_string() == *value
                        && number.unsigned_abs()
                            <= rules()
                                .decimal
                                .legacy_max_safe_integer
                                .parse::<u64>()
                                .expect("legacy safe integer limit")
                })
                .ok_or_else(|| {
                    unsupported(
                        "Legacy patches cannot retain this exact decimal spelling or precision.",
                    )
                })?;
            Value::from(number)
        }
        PropertyValue::Relation { .. } => {
            return Err(unsupported(
                "Legacy patches cannot retain typed relation resolution.",
            ))
        }
    })
}

/// Convert proposed values only. This is not an authorized write plan or proof
/// that existing YAML can be rewritten losslessly; no receipt or file is touched.
#[cfg(test)]
fn prepare_legacy_patch(changes: &[PropertyChange]) -> Result<Map<String, Value>, ValueError> {
    let (mut patch, mut nodes) = (Map::new(), 0);
    for change in changes {
        let key = match change {
            PropertyChange::Set { key, .. } | PropertyChange::Remove { key } => key,
        };
        if key.is_empty() || patch.contains_key(key) {
            return Err(invalid("Property changes require unique non-empty keys."));
        }
        let value = match change {
            PropertyChange::Remove { .. } => Value::Null,
            PropertyChange::Set {
                value: PropertyValue::Null {},
                ..
            } => {
                return Err(unsupported(
                    "Set(null) cannot be represented by the legacy removal marker.",
                ))
            }
            PropertyChange::Set { value, .. } => {
                validate_value(value, 0, &mut nodes)?;
                legacy_value(value)?
            }
        };
        patch.insert(key.clone(), value);
    }
    // Validate typed recursion before serialization; the wire byte/depth caps
    // still apply to the complete change batch, including keys and tags.
    let source =
        serde_json::to_string(changes).map_err(|_| invalid("Invalid property changes."))?;
    check_source(&source)?;
    Ok(patch)
}

pub(crate) fn max_source_bytes() -> usize {
    rules().limits.max_source_bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cases() -> serde_json::Value {
        serde_json::from_str(include_str!("../../../shared/workspace/values.v1.json")).unwrap()
    }

    #[test]
    fn raw_json_cases_preserve_lexemes_before_any_number_conversion() {
        for case in cases()["decodeCases"].as_array().unwrap() {
            let result = decode_json(
                case["source"].as_str().unwrap(),
                serde_json::from_value(case["schema"].clone()).unwrap(),
            );
            if let Some(expected) = case.get("expected") {
                assert_eq!(
                    serde_json::to_value(result.unwrap()).unwrap(),
                    *expected,
                    "{}",
                    case["name"]
                );
            } else {
                assert_eq!(
                    serde_json::to_value(result.unwrap_err()).unwrap()["code"],
                    case["error"],
                    "{}",
                    case["name"]
                );
            }
        }
    }

    #[test]
    fn tagged_cases_keep_unknown_values_and_refuse_invalid_declarations() {
        for case in cases()["taggedCases"].as_array().unwrap() {
            let original = case["value"].to_string();
            let result = decode_tagged(&original);
            if case["valid"] == true {
                assert_eq!(
                    serde_json::to_value(result.unwrap()).unwrap(),
                    case["value"],
                    "{}",
                    case["name"]
                );
            } else {
                assert!(result.is_err(), "{}", case["name"]);
            }
        }
    }

    #[test]
    fn legacy_conversion_never_confuses_set_null_with_remove_or_rounds_a_decimal() {
        for case in cases()["changeCases"].as_array().unwrap() {
            let changes: Vec<PropertyChange> =
                serde_json::from_value(case["changes"].clone()).unwrap();
            let before = changes.clone();
            let result = prepare_legacy_patch(&changes);
            if let Some(expected) = case.get("expected") {
                assert_eq!(
                    serde_json::to_value(result.unwrap()).unwrap(),
                    *expected,
                    "{}",
                    case["name"]
                );
            } else {
                assert_eq!(
                    serde_json::to_value(result.unwrap_err()).unwrap()["code"],
                    case["error"],
                    "{}",
                    case["name"]
                );
            }
            assert_eq!(
                changes, before,
                "a refused conversion must retain exact input"
            );
        }
    }

    #[test]
    fn legacy_writer_round_trips_supported_changes_and_only_remove_deletes() {
        let original = "---\npresent: null\nkeep: '007'\n---\n# Body\n";
        for case in cases()["changeCases"].as_array().unwrap() {
            let Some(expected) = case.get("expected") else {
                continue;
            };
            let changes =
                serde_json::from_value::<Vec<PropertyChange>>(case["changes"].clone()).unwrap();
            let patch = prepare_legacy_patch(&changes).unwrap();
            let after = crate::vault::write::patch_bytes("fixture.md", original, &patch).unwrap();
            let metadata = crate::vault::write::frontmatter_json("fixture.md", &after).unwrap();
            for (key, value) in expected.as_object().unwrap() {
                if value.is_null() {
                    assert!(!metadata.contains_key(key), "{}", case["name"]);
                } else {
                    assert_eq!(metadata.get(key), Some(value), "{}", case["name"]);
                }
            }
            assert_eq!(metadata["keep"], "007");
            assert!(after.ends_with("# Body\n"));
        }
    }

    #[test]
    fn decoding_is_bounded_before_recursive_or_numeric_materialization() {
        let rules = cases();
        let depth = rules["limits"]["maxDepth"].as_u64().unwrap() as usize;
        let nodes = rules["limits"]["maxNodes"].as_u64().unwrap() as usize;
        let bytes = rules["limits"]["maxSourceBytes"].as_u64().unwrap() as usize;
        for source in [
            format!("{}null{}", "[".repeat(depth + 1), "]".repeat(depth + 1)),
            format!("[{}]", vec!["null"; nodes + 1].join(",")),
            format!("\"{}\"", "x".repeat(bytes)),
            "1".repeat(rules["decimal"]["maxLexemeBytes"].as_u64().unwrap() as usize + 1),
        ] {
            assert!(decode_json(&source, ValueSchema::Plain).is_err());
        }
        let quoted = serde_json::to_string(&"[".repeat(depth + 1)).unwrap();
        assert!(matches!(
            decode_json(&quoted, ValueSchema::Plain).unwrap(),
            PropertyValue::String { .. }
        ));
    }

    #[test]
    fn tagged_objects_cannot_hide_duplicate_keys_or_out_of_contract_values() {
        assert!(decode_tagged(
            r#"{"kind":"object","value":{"x":{"kind":"null"},"x":{"kind":"boolean","value":true}}}"#
        )
        .is_err());
        assert!(decode_tagged(r#"{"kind":"decimal","value":"1e400"}"#).is_ok());
    }

    #[test]
    fn all_prototype_refusals_keep_operational_destiny() {
        let policy: Value =
            serde_json::from_str(include_str!("../../../shared/policy/policy.v3.json")).unwrap();
        for error in [invalid("invalid value"), unsupported("not representable")] {
            let code = serde_json::to_value(error.code).unwrap();
            assert_eq!(
                policy["rejection_destinies"][code.as_str().unwrap()],
                "operational"
            );
            assert!(!error.retryable);
        }
    }
}
