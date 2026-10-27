//! App-owned definitions only. No provider discovery, account grant or executor.
use super::{catalog::ActionCatalog, read_types::*, schema};
use serde::Deserialize;
use std::sync::OnceLock;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Definitions {
    version: u32,
    source: String,
    definitions: Vec<DefinitionMaterial>,
}
pub(super) fn compiled_catalog() -> Result<&'static ActionCatalog, ActionReadError> {
    static CATALOG: OnceLock<Result<ActionCatalog, ActionReadError>> = OnceLock::new();
    CATALOG.get_or_init(load).as_ref().map_err(Clone::clone)
}
fn load() -> Result<ActionCatalog, ActionReadError> {
    let unavailable = || ActionReadError {
        code: ActionReadErrorCode::Unavailable,
        retry_disposition: RetryDisposition::Never,
        message: "Local action definitions are unavailable.".into(),
    };
    let bytes = include_str!("../../../shared/actions/github-issues.v1.json");
    schema::parse_bounded(bytes, schema::limits().definition_bytes).map_err(|_| unavailable())?;
    let source: Definitions = serde_json::from_str(bytes).map_err(|_| unavailable())?;
    if source.version != 1
        || source.source != "compiled_local_definitions"
        || source.definitions.is_empty()
        || source.definitions.len() > schema::limits().catalog_definitions
    {
        return Err(unavailable());
    }
    let mut catalog = ActionCatalog::default();
    for definition in source.definitions {
        catalog
            .insert(definition, "{}")
            .map_err(|_| unavailable())?;
    }
    Ok(catalog)
}
