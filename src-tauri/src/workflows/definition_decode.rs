//! Dispatch tagged JSON before decoding its fields so RawValue never passes
//! through serde's lossy internally-tagged Content buffer. Validation bounds
//! the complete JSON first; schemas and literal decimals retain their bytes.
use super::*;

macro_rules! tagged {
    ($name:ident { $($tag:literal => $variant:ident { $($field:ident: $ty:ty),* $(,)? }),* $(,)? }) => {
        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                use serde::de::Error;
                let raw = Box::<RawValue>::deserialize(deserializer)?;
                #[derive(Deserialize)]
                struct Tag { kind: String }
                let tag: Tag = serde_json::from_str(raw.get()).map_err(D::Error::custom)?;
                match tag.kind.as_str() {
                    $($tag => {
                        #[derive(Deserialize)]
                        #[serde(rename_all = "camelCase", deny_unknown_fields)]
                        struct Fields { kind: String, $($field: $ty),* }
                        let fields: Fields = serde_json::from_str(raw.get()).map_err(D::Error::custom)?;
                        let _ = fields.kind;
                        Ok(Self::$variant { $($field: fields.$field),* })
                    }),*,
                    _ => Err(D::Error::custom("Unsupported workflow expression or step.")),
                }
            }
        }
    }
}
tagged!(Operation {
    "read" => Read { query: Mapping, output_schema: Box<RawValue>, next_step_id: String },
    "transform" => Transform { mapping: Mapping, output_schema: Box<RawValue>, next_step_id: String },
    "condition" => Condition { predicate: Predicate, if_true: String, if_false: String },
    "action" => Action { action_id: String, definition_digest: String, connection_id: String,
        account_id: String, input: Mapping, next_step_id: String },
    "wait" => Wait { until: WaitUntil, next_step_id: String },
    "result" => Result { output: Mapping },
});
tagged!(Mapping {
    "literal" => Literal { value: Box<RawValue> },
    "input" => Input { path: Vec<String> },
    "output" => Output { step_id: String, path: Vec<String> },
    "object" => Object { fields: BTreeMap<String, Mapping> },
    "array" => Array { items: Vec<Mapping> },
});
tagged!(Predicate {
    "equals" => Equals { left: Mapping, right: Mapping },
    "less" => Less { left: Mapping, right: Mapping },
    "greater" => Greater { left: Mapping, right: Mapping },
    "exists" => Exists { value: Mapping },
    "all" => All { items: Vec<Predicate> },
    "any" => Any { items: Vec<Predicate> },
    "not" => Not { value: Box<Predicate> },
});
tagged!(WaitUntil {
    "timer" => Timer { at: String },
    "external_input" => ExternalInput { schema: Box<RawValue>, expires_at: String },
});
