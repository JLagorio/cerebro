//! Shared read/schema inspection types only; wire data never constructs authority.
#[cfg(test)]
use schemars::{schema::Schema, JsonSchema};
use serde::{Deserialize, Serialize};

macro_rules! id {
    ($($name:ident),+ $(,)?) => {$(
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
        #[serde(transparent)]
        pub(crate) struct $name(pub(crate) String);
    )+};
}
id!(ActionId, DefinitionDigest, SnapshotDigest, CatalogCursor);

macro_rules! wire_enum {
    ($name:ident { $($variant:ident),+ $(,)? }) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
        #[serde(rename_all="snake_case")]
        pub(crate) enum $name { $($variant),+ }
    };
}
wire_enum!(EffectClass {
    Read,
    LocalWrite,
    ExternalDraft,
    ExternalMutation,
    ExternalSend,
    ExternalPublish,
    ExternalDelete
});
wire_enum!(RetryContract {
    Never,
    Idempotent,
    ReconcileFirst
});
wire_enum!(RetryDisposition {
    Never,
    Refresh,
    Reconcile
});
wire_enum!(ActionErrorCode {
    InvalidInput,
    UnsupportedSchema,
    LimitExceeded,
    DefinitionMismatch,
    NotFound,
    RequestKeyConflict,
    RevisionConflict,
    Denied,
    Unavailable
});
wire_enum!(ActionReadErrorCode {
    NotFound,
    Denied,
    Unavailable
});

// A required nullable property: absent is a malformed DTO, null is recorded absence.
pub(crate) fn required_nullable<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> Result<Option<T>, D::Error> {
    Option::<T>::deserialize(d)
}
#[cfg(test)]
pub(crate) struct RequiredNullable<T>(std::marker::PhantomData<T>);
#[cfg(test)]
impl<T: JsonSchema> JsonSchema for RequiredNullable<T> {
    fn schema_name() -> String {
        format!("RequiredNullable{}", T::schema_name())
    }
    fn is_referenceable() -> bool {
        false
    }
    fn json_schema(generator: &mut schemars::gen::SchemaGenerator) -> Schema {
        <Option<T>>::json_schema(generator)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ActionSubjectView {
    pub(crate) vault_id: String,
    pub(crate) run_id: String,
    pub(crate) actor_id: String,
    #[serde(deserialize_with = "required_nullable")]
    #[cfg_attr(test, schemars(with = "RequiredNullable<String>"))]
    pub(crate) child_job_id: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    #[cfg_attr(test, schemars(with = "RequiredNullable<String>"))]
    pub(crate) client_id: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ActionDefinition {
    pub(crate) action_id: ActionId,
    pub(crate) definition_digest: DefinitionDigest,
    pub(crate) input_schema_digest: String,
    pub(crate) output_schema_digest: String,
    pub(crate) input_schema: String,
    pub(crate) output_schema: String,
    pub(crate) adapter_revision: String,
    pub(crate) effect_class: EffectClass,
    pub(crate) required_capabilities: Vec<String>,
    pub(crate) retry: RetryContract,
    pub(crate) cancel: bool,
    pub(crate) reconcile: bool,
}
pub(crate) type ActionDefinitionView = ActionDefinition;
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DefinitionMaterial {
    pub(crate) action_id: ActionId,
    pub(crate) input_schema: String,
    pub(crate) output_schema: String,
    pub(crate) adapter_revision: String,
    pub(crate) effect_class: EffectClass,
    pub(crate) required_capabilities: Vec<String>,
    pub(crate) retry: RetryContract,
    pub(crate) cancel: bool,
    pub(crate) reconcile: bool,
    pub(crate) secret_input_fields: Vec<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum CatalogStatus {
    Callable {},
    Unsupported { reason: String },
    Unavailable { reason: String },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ActionDescriptor {
    pub(crate) action_id: ActionId,
    pub(crate) definition_digest: DefinitionDigest,
    pub(crate) status: CatalogStatus,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ActionCatalogPage {
    pub(crate) descriptors: Vec<ActionDescriptor>,
    pub(crate) snapshot_digest: SnapshotDigest,
    #[serde(deserialize_with = "required_nullable")]
    #[cfg_attr(test, schemars(with = "RequiredNullable<CatalogCursor>"))]
    pub(crate) next_cursor: Option<CatalogCursor>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ActionError {
    pub(crate) code: ActionErrorCode,
    pub(crate) retry_disposition: RetryDisposition,
    pub(crate) message: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ActionReadError {
    pub(crate) code: ActionReadErrorCode,
    pub(crate) retry_disposition: RetryDisposition,
    pub(crate) message: String,
}
pub(crate) fn error(code: ActionErrorCode, message: &str) -> ActionError {
    ActionError {
        code,
        retry_disposition: RetryDisposition::Never,
        message: message.into(),
    }
}
