//! Non-executing previews. Managed commits require a verified native importer.
//! Rewritten object envelopes preserve order; untouched values retain their raw
//! JSON bytes, including numeric and string lexemes. No plaintext backup.
use super::{digest, opaque_id, secrets::SecretRef, ConnectionError};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{value::RawValue, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MigrationPreview {
    pub preview_id: String,
    pub source_digest: String,
    pub server_count: usize,
    pub plaintext_locations: Vec<PlaintextLocation>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlaintextLocation {
    pub server_index: usize,
    pub field: &'static str,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MigrationResult {
    pub migrated: bool,
    pub remaining_plaintext_locations: Vec<PlaintextLocation>,
}
/// No raw secret becomes output. The importer must validate provider identity before return.
/// A production adapter also needs durable cleanup for a failed ownership commit.
pub(crate) trait LegacyImporter {
    fn import_and_verify(&self, server: &Value) -> Result<SecretRef, ConnectionError>;
    fn discard(&self, reference: &SecretRef) -> Result<(), ConnectionError>;
}
pub(crate) struct MigrationService {
    previews: HashMap<String, String>,
}
/// Only the envelopes we rewrite are decoded as maps. Unknown values stay raw.
/// Reject duplicate keys here instead of silently dropping one during rewriting.
#[derive(Serialize)]
#[serde(transparent)]
struct RawObject(IndexMap<String, Box<RawValue>>);
impl<'de> Deserialize<'de> for RawObject {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ObjectVisitor;
        impl<'de> serde::de::Visitor<'de> for ObjectVisitor {
            type Value = RawObject;
            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("an object with unique keys")
            }
            fn visit_map<M: serde::de::MapAccess<'de>>(
                self,
                mut map: M,
            ) -> Result<RawObject, M::Error> {
                let mut values = IndexMap::new();
                while let Some((key, value)) = map.next_entry::<String, Box<RawValue>>()? {
                    if values.insert(key, value).is_some() {
                        return Err(serde::de::Error::custom("duplicate configuration key"));
                    }
                }
                Ok(RawObject(values))
            }
        }
        deserializer.deserialize_map(ObjectVisitor)
    }
}
struct ParsedConfig {
    // Inspection/importer compatibility only. Never serialize this lossy model.
    inspection: Value,
    root: RawObject,
    servers: RawObject,
}
fn raw_object(raw: &str) -> Result<RawObject, ConnectionError> {
    serde_json::from_str(raw).map_err(|_| ConnectionError::InvalidConfig)
}
fn parse(raw: &str) -> Result<ParsedConfig, ConnectionError> {
    if raw.len() > 1024 * 1024 {
        return Err(ConnectionError::InvalidConfig);
    }
    let inspection: Value =
        serde_json::from_str(raw).map_err(|_| ConnectionError::InvalidConfig)?;
    let servers = inspection
        .get("servers")
        .and_then(Value::as_object)
        .ok_or(ConnectionError::InvalidConfig)?;
    if servers.len() > 128 || servers.values().any(|server| !server.is_object()) {
        return Err(ConnectionError::InvalidConfig);
    }
    let root = raw_object(raw)?;
    let servers = raw_object(
        root.0
            .get("servers")
            .ok_or(ConnectionError::InvalidConfig)?
            .get(),
    )?;
    for server in servers.0.values() {
        raw_object(server.get())?;
    }
    Ok(ParsedConfig {
        inspection,
        root,
        servers,
    })
}
fn encode(
    config: &mut ParsedConfig,
    server_index: usize,
    reference: &SecretRef,
) -> Result<String, ConnectionError> {
    let server = config
        .servers
        .0
        .get_index(server_index)
        .ok_or(ConnectionError::InvalidSelection)?
        .1;
    let mut object = raw_object(server.get())?;
    object.0.shift_remove("env");
    object.0.shift_remove("headers");
    object.0.insert(
        "executionOwner".into(),
        serde_json::value::to_raw_value(&"cerebro").map_err(|_| ConnectionError::Unavailable)?,
    );
    object.0.insert(
        "secretRef".into(),
        serde_json::value::to_raw_value(reference).map_err(|_| ConnectionError::Unavailable)?,
    );
    *config.servers.0.get_index_mut(server_index).unwrap().1 =
        serde_json::value::to_raw_value(&object).map_err(|_| ConnectionError::Unavailable)?;
    config.root.0.insert(
        "servers".into(),
        serde_json::value::to_raw_value(&config.servers)
            .map_err(|_| ConnectionError::Unavailable)?,
    );
    serde_json::to_string_pretty(&config.root).map_err(|_| ConnectionError::InvalidConfig)
}
fn locations(value: &Value) -> Vec<PlaintextLocation> {
    let mut out = Vec::new();
    if let Some(servers) = value.get("servers").and_then(Value::as_object) {
        for (server_index, server) in servers.values().enumerate() {
            for field in ["env", "headers"] {
                if server
                    .get(field)
                    .is_some_and(|v| !v.is_null() && v.as_object().is_none_or(|o| !o.is_empty()))
                {
                    out.push(PlaintextLocation {
                        server_index,
                        field,
                    });
                }
            }
        }
    }
    out
}
fn checked_path(vault: &Path) -> Result<PathBuf, ConnectionError> {
    // Refuse links on the owned components, including the supplied vault itself.
    // System ancestors such as macOS /var may legitimately be symlinks.
    let path = vault.join(".cerebro/connectors.json");
    for ancestor in [vault, path.parent().unwrap(), path.as_path()] {
        match std::fs::symlink_metadata(ancestor) {
            Ok(meta) if meta.file_type().is_symlink() => return Err(ConnectionError::UnsafePath),
            Ok(_) => {}
            Err(_) => return Err(ConnectionError::Unavailable),
        }
    }
    Ok(path)
}
fn read_checked(vault: &Path) -> Result<(PathBuf, String), ConnectionError> {
    use std::io::Read;
    let path = checked_path(vault)?;
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options
        .open(&path)
        .map_err(|_| ConnectionError::UnsafePath)?;
    if !file
        .metadata()
        .map_err(|_| ConnectionError::Unavailable)?
        .is_file()
    {
        return Err(ConnectionError::UnsafePath);
    }
    let mut raw = String::new();
    file.take(1024 * 1024 + 1)
        .read_to_string(&mut raw)
        .map_err(|_| ConnectionError::Unavailable)?;
    if raw.len() > 1024 * 1024 {
        return Err(ConnectionError::InvalidConfig);
    }
    Ok((path, raw))
}
impl MigrationService {
    pub(crate) fn new() -> Self {
        Self {
            previews: HashMap::new(),
        }
    }
    pub(crate) fn plan_legacy_migration(
        &mut self,
        raw: &str,
    ) -> Result<MigrationPreview, ConnectionError> {
        let config = parse(raw)?;
        let value = &config.inspection;
        if self.previews.len() >= 32 {
            return Err(ConnectionError::Unavailable);
        }
        let preview = MigrationPreview {
            preview_id: opaque_id(),
            source_digest: digest(raw.as_bytes()),
            server_count: value["servers"].as_object().unwrap().len(),
            plaintext_locations: locations(value),
        };
        // Keep a digest only. Credentials are not retained in a preview cache.
        self.previews
            .insert(preview.preview_id.clone(), preview.source_digest.clone());
        Ok(preview)
    }
    pub(crate) fn cancel(&mut self, id: &str) {
        self.previews.remove(id);
    }
    /// Test-only until native routing excludes managed routes and a selected backend exists.
    pub(crate) fn commit_legacy_migration(
        &mut self,
        vault: &Path,
        id: &str,
        expected: &str,
        server_index: usize,
        importer: &dyn LegacyImporter,
    ) -> Result<MigrationResult, ConnectionError> {
        let planned = self.previews.remove(id).ok_or(ConnectionError::Cancelled)?;
        if planned != expected {
            return Err(ConnectionError::SourceChanged);
        }
        let (path, raw) = read_checked(vault)?;
        if digest(raw.as_bytes()) != expected {
            return Err(ConnectionError::SourceChanged);
        }
        let mut config = parse(&raw)?;
        let server = config.inspection["servers"]
            .as_object()
            .unwrap()
            .values()
            .nth(server_index)
            .ok_or(ConnectionError::InvalidSelection)?;
        if server.get("executionOwner").is_some_and(|v| v != "cli") {
            return Err(ConnectionError::InvalidSelection);
        }
        let reference = importer.import_and_verify(server)?;
        let commit = (|| {
            // The imported source is checked again after potentially slow native work.
            let (_, current) = read_checked(vault)?;
            if digest(current.as_bytes()) != expected {
                return Err(ConnectionError::SourceChanged);
            }
            let object = config.inspection["servers"]
                .as_object_mut()
                .unwrap()
                .values_mut()
                .nth(server_index)
                .unwrap()
                .as_object_mut()
                .unwrap();
            object.remove("env");
            object.remove("headers");
            let output = encode(&mut config, server_index, &reference)?;
            crate::connectors::write_owner_only(&path, &output)
                .map_err(|_| ConnectionError::Unavailable)?;
            Ok(MigrationResult {
                migrated: true,
                remaining_plaintext_locations: locations(&config.inspection),
            })
        })();
        if commit.is_err() {
            importer.discard(&reference)?;
        }
        commit
    }
}
