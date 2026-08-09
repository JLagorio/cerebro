//! `TypedValue` — the recursive tagged value union (M22.1), and the RFC 6901
//! field-path check patch/assertion values share.
//!
//! The tagging exists so `null`, a MISSING field, and the string `"null"`
//! can never collapse into one another in a patch or assertion value.

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

/// The exact tagged recursive union from the design. Numbers keep their
/// original JSON spelling (`serde_json::Number`), so `1` and `1.0` are
/// different canonical bytes and the round-trip gate can see the difference.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TypedValue {
    Missing,
    Null { value: () },
    Boolean { value: bool },
    Number { value: serde_json::Number },
    String { value: String },
    Array { value: Vec<TypedValue> },
    Object { value: IndexMap<String, TypedValue> },
}

impl TypedValue {
    /// Structural validity: every number finite, recursively. (JSON cannot
    /// spell NaN/Inf, but a constructed value could carry one — refuse it
    /// before it reaches canonical bytes.)
    pub fn validate(&self) -> Result<(), String> {
        match self {
            TypedValue::Number { value } => {
                if let Some(f) = value.as_f64() {
                    if !f.is_finite() {
                        return Err(format!("non-finite number {value} in TypedValue"));
                    }
                }
                Ok(())
            }
            TypedValue::Array { value } => value.iter().try_for_each(TypedValue::validate),
            TypedValue::Object { value } => value.values().try_for_each(TypedValue::validate),
            _ => Ok(()),
        }
    }

    /// Convenience for validators that need "a canonical object with exactly
    /// these string fields" (relation_change / alias_add pairing).
    pub fn as_object(&self) -> Option<&IndexMap<String, TypedValue>> {
        match self {
            TypedValue::Object { value } => Some(value),
            _ => None,
        }
    }

    pub fn string(value: &str) -> TypedValue {
        TypedValue::String {
            value: value.to_string(),
        }
    }
}

/// A belief-state field path: RFC 6901 JSON Pointer over canonical belief
/// state — exactly `/body` (the markdown body) or `/fields/...` (a
/// frontmatter field). Anything else has no referent in a Belief.
pub fn validate_field_path(path: &str) -> Result<(), String> {
    // RFC 6901 escape validity: '~' only as '~0' or '~1'.
    let bytes = path.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'~' {
            match bytes.get(i + 1) {
                Some(b'0') | Some(b'1') => i += 2,
                _ => return Err(format!("field_path {path:?} has a bare '~' — not RFC 6901")),
            }
        } else {
            i += 1;
        }
    }
    if path == "/body" || path.starts_with("/fields/") {
        Ok(())
    } else {
        Err(format!(
            "field_path {path:?} must be /body or /fields/... over canonical belief state"
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_variant_round_trips_to_its_pinned_canonical_bytes() {
        let cases: Vec<(TypedValue, &str)> = vec![
            (TypedValue::Missing, r#"{"type":"missing"}"#),
            (
                TypedValue::Null { value: () },
                r#"{"type":"null","value":null}"#,
            ),
            (
                TypedValue::Boolean { value: true },
                r#"{"type":"boolean","value":true}"#,
            ),
            (
                TypedValue::Number {
                    value: serde_json::Number::from(42),
                },
                r#"{"type":"number","value":42}"#,
            ),
            (
                TypedValue::String {
                    value: "null".into(),
                },
                r#"{"type":"string","value":"null"}"#,
            ),
            (
                TypedValue::Array {
                    value: vec![TypedValue::Missing, TypedValue::Boolean { value: false }],
                },
                r#"{"type":"array","value":[{"type":"missing"},{"type":"boolean","value":false}]}"#,
            ),
            (
                TypedValue::Object {
                    value: [
                        ("z".to_string(), TypedValue::string("last")),
                        ("a".to_string(), TypedValue::Null { value: () }),
                    ]
                    .into_iter()
                    .collect(),
                },
                r#"{"type":"object","value":{"z":{"type":"string","value":"last"},"a":{"type":"null","value":null}}}"#,
            ),
        ];
        for (value, want) in cases {
            let line = serde_json::to_string(&value).unwrap();
            assert_eq!(line, want);
            let back: TypedValue = serde_json::from_str(&line).unwrap();
            assert_eq!(back, value);
            assert_eq!(serde_json::to_string(&back).unwrap(), line);
            value.validate().unwrap();
        }
    }

    #[test]
    fn null_missing_and_the_string_null_cannot_collapse() {
        let null = serde_json::to_string(&TypedValue::Null { value: () }).unwrap();
        let missing = serde_json::to_string(&TypedValue::Missing).unwrap();
        let string_null = serde_json::to_string(&TypedValue::string("null")).unwrap();
        assert_ne!(null, missing);
        assert_ne!(null, string_null);
        assert_ne!(missing, string_null);
    }

    #[test]
    fn a_tag_value_mismatch_is_refused() {
        for bad in [
            r#"{"type":"boolean","value":"true"}"#,
            r#"{"type":"number","value":"7"}"#,
            r#"{"type":"null","value":0}"#,
            r#"{"type":"unknown","value":1}"#,
        ] {
            assert!(
                serde_json::from_str::<TypedValue>(bad).is_err(),
                "{bad} must not parse"
            );
        }
    }

    #[test]
    fn integer_and_float_spellings_stay_distinct() {
        let int: TypedValue = serde_json::from_str(r#"{"type":"number","value":1}"#).unwrap();
        let float: TypedValue = serde_json::from_str(r#"{"type":"number","value":1.0}"#).unwrap();
        assert_eq!(
            serde_json::to_string(&int).unwrap(),
            r#"{"type":"number","value":1}"#
        );
        assert_eq!(
            serde_json::to_string(&float).unwrap(),
            r#"{"type":"number","value":1.0}"#
        );
    }

    #[test]
    fn field_paths_are_body_or_fields_pointers_only() {
        validate_field_path("/body").unwrap();
        validate_field_path("/fields/status").unwrap();
        validate_field_path("/fields/a~0b~1c").unwrap();
        for bad in [
            "",
            "/",
            "/fields",
            "/other/x",
            "fields/x",
            "/fields/a~2",
            "/fields/a~",
        ] {
            assert!(validate_field_path(bad).is_err(), "{bad:?} must be refused");
        }
    }
}
