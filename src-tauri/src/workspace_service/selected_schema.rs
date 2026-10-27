//! The shipped selected-store schemas (BL-23, M99.6). Each text is frozen:
//! `shared/workspace/schema/` holds the exact bytes stores were built from,
//! and a committed SHA-256 beside each file pins them, so an edit to a shipped
//! file (one space, one comment) fails the build instead of every store.
//! A newer store is a new file with its own digest, never an edit.
//!
//! A store is compared object by object with the model SQLite itself builds
//! from the same text on a private in-memory database: every table and
//! automatic index, with its stored definition, and nothing else. No reader
//! splits or trims the text by hand, so a comment or a reformatted definition
//! can never drop an expected table or hide a changed one.
use super::{error, text, AuthorityError, AuthorityErrorKind};
use rusqlite::{types::ValueRef, Connection};
use std::{collections::BTreeMap, sync::OnceLock};

/// Store 2: Full width receipts only.
pub(crate) const V2: &str = include_str!("../../../shared/workspace/schema/selected_schema.sql");
/// Store 3: paired body receipts.
pub(crate) const V3: &str = include_str!("../../../shared/workspace/schema/selected_schema_v3.sql");
/// Store 4: durable metadata requests.
pub(crate) const V4: &str = include_str!("../../../shared/workspace/schema/selected_schema_v4.sql");

/// Every shipped text with its committed digest, oldest first.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "The digest anchor is read by the schema tests.")
)]
pub(crate) const SHIPPED: [(&str, &str, &str); 3] = [
    (
        V2,
        "shared/workspace/schema/selected_schema.sql",
        "shared/workspace/schema/selected_schema.sha256",
    ),
    (
        V3,
        "shared/workspace/schema/selected_schema_v3.sql",
        "shared/workspace/schema/selected_schema_v3.sha256",
    ),
    (
        V4,
        "shared/workspace/schema/selected_schema_v4.sql",
        "shared/workspace/schema/selected_schema_v4.sha256",
    ),
];

/// One object a schema creates, exactly as `sqlite_schema` stores it. An
/// automatic index has no SQL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SchemaObject {
    pub(crate) kind: String,
    pub(crate) name: String,
    pub(crate) table: String,
    pub(crate) sql: Option<String>,
}

/// SQLite's own reading of one schema text: the store version its
/// `PRAGMA user_version` sets and every object it creates, by type and name.
pub(crate) fn model_of(schema: &str) -> Result<(i64, Vec<SchemaObject>), String> {
    let conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
    conn.execute_batch(schema).map_err(|e| e.to_string())?;
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    let mut statement = conn
        .prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name")
        .map_err(|e| e.to_string())?;
    let objects = statement
        .query_map([], |row| {
            Ok(SchemaObject {
                kind: row.get(0)?,
                name: row.get(1)?,
                table: row.get(2)?,
                sql: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok((version, objects))
}

/// The shipped models by store version, built once from the frozen texts.
pub(crate) fn shipped() -> Result<&'static BTreeMap<i64, Vec<SchemaObject>>, AuthorityError> {
    static MODELS: OnceLock<Result<BTreeMap<i64, Vec<SchemaObject>>, String>> = OnceLock::new();
    MODELS
        .get_or_init(|| {
            let mut models = BTreeMap::new();
            for schema in [V2, V3, V4] {
                let (version, objects) = model_of(schema)?;
                if objects.is_empty() || models.insert(version, objects).is_some() {
                    return Err(format!("shipped schema {version} is empty or repeated"));
                }
            }
            Ok(models)
        })
        .as_ref()
        .map_err(|_| {
            error(
                AuthorityErrorKind::UnsupportedFormat,
                "The shipped selected schemas are unavailable.",
            )
        })
}

fn differs(message: String) -> AuthorityError {
    error(AuthorityErrorKind::InvalidMetadata, message)
}

/// Compare `conn`'s whole schema with shipped store `version`, object by
/// object: each table and automatic index the shipped text creates, with its
/// stored definition byte for byte, and no other object. The refusal names
/// what differs. Reads at most one row past the shipped object count.
pub(super) fn verify(conn: &Connection, version: i64) -> Result<(), AuthorityError> {
    let expected = shipped()?.get(&version).ok_or_else(|| {
        error(
            AuthorityErrorKind::UnsupportedFormat,
            "Canonical store schema version is unsupported.",
        )
    })?;
    let unreadable = || differs("Canonical schema is unreadable.".into());
    let mut statement = conn
        .prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name LIMIT ?1")
        .map_err(|_| unreadable())?;
    let mut rows = statement
        .query([i64::try_from(expected.len()).map_err(|_| unreadable())? + 1])
        .map_err(|_| unreadable())?;
    let mut seen = std::collections::BTreeSet::new();
    while let Some(row) = rows.next().map_err(|_| unreadable())? {
        let kind = text(row, 0, 32)?;
        let name = text(row, 1, 128)?;
        let table = text(row, 2, 128)?;
        let sql = match row.get_ref(3).map_err(|_| unreadable())? {
            ValueRef::Null => None,
            ValueRef::Text(_) => Some(text(row, 3, 8192)?),
            _ => return Err(unreadable()),
        };
        // Only a name the shipped schema defines is ever echoed back.
        let Some(want) = expected
            .iter()
            .find(|object| object.kind == kind && object.name == name)
        else {
            return Err(differs(format!(
                "Canonical metadata holds a schema object that shipped schema {version} does not define."
            )));
        };
        if want.table != table || want.sql != sql {
            return Err(differs(format!(
                "Canonical {} {} differs from shipped schema {version}.",
                want.kind, want.name
            )));
        }
        seen.insert((kind, name));
    }
    let missing = expected
        .iter()
        .filter(|object| !seen.contains(&(object.kind.clone(), object.name.clone())))
        .map(|object| format!("{} {}", object.kind, object.name))
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        return Err(differs(format!(
            "Canonical schema is incomplete: shipped schema {version} also defines {}.",
            missing.join(", ")
        )));
    }
    Ok(())
}

#[cfg(test)]
#[path = "selected_schema_tests.rs"]
mod tests;
