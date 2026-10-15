//! A deterministic import plan over one vault read, before any mutation.
use super::{
    canonical_record_id, compose, hash, path_refusal, stored_import_hash, stored_record_id, words,
    Stamp,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub system: String,
    pub record_id: String,
    pub url: Option<String>,
    pub path: String,
    pub content: String,
}
#[derive(Debug, Clone)]
pub struct ImportFile {
    pub path: String,
    pub content: String,
}
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub index: usize,
    pub system: String,
    pub record_id: String,
    pub outcome: &'static str,
    pub path: String,
    pub also_at: Vec<String>,
    pub reason: Option<&'static str>,
    pub first: Option<usize>,
}
pub struct Plan {
    pub writes: Vec<(usize, Value)>,
    pub imports: Vec<ImportResult>,
}
pub fn copy_index(files: &[ImportFile]) -> HashMap<(String, String), Vec<&ImportFile>> {
    let mut result: HashMap<_, Vec<_>> = HashMap::new();
    let mut sorted: Vec<_> = files.iter().collect();
    sorted.sort_by(|a, b| a.path.cmp(&b.path));
    for file in sorted {
        if path_refusal(&file.path).is_some() {
            continue;
        }
        // Identity survives formatting edits. The strict stamp reader below
        // then keeps a CRLF or requoted copy instead of making a second page.
        let (yaml, _) = crate::vault::parse::split_frontmatter(&file.content);
        let Some(fields) = yaml
            .and_then(|yaml| serde_yaml::from_str::<serde_yaml::Value>(yaml).ok())
            .and_then(|value| value.as_mapping().cloned())
        else {
            continue;
        };
        let Some(system) = fields
            .get("source_system")
            .and_then(serde_yaml::Value::as_str)
        else {
            continue;
        };
        let Some(raw) = fields
            .get("source_record_id")
            .and_then(serde_yaml::Value::as_str)
        else {
            continue;
        };
        let Some(id) = stored_record_id(system, raw) else {
            continue;
        };
        result
            .entry((system.to_string(), id))
            .or_default()
            .push(file);
    }
    result
}
pub fn plan(
    requests: &[(usize, Request)],
    files: &[ImportFile],
    occupied: &[String],
    other_paths: &[String],
    now: &str,
    actor: &str,
) -> Result<Plan, String> {
    plan_with_method(requests, files, occupied, other_paths, now, actor, None)
}
/// The import door alone marks an explicitly composed fallback. Human batch
/// requests cannot supply this writer-owned key.
pub(crate) fn plan_with_method(
    requests: &[(usize, Request)],
    files: &[ImportFile],
    occupied: &[String],
    other_paths: &[String],
    now: &str,
    actor: &str,
    method: Option<&str>,
) -> Result<Plan, String> {
    let copies = copy_index(files);
    let mut held: HashSet<_> = occupied
        .iter()
        .map(|path| path.to_ascii_lowercase())
        .chain(files.iter().map(|f| f.path.to_ascii_lowercase()))
        .collect();
    let other: HashSet<_> = other_paths
        .iter()
        .map(|path| path.to_ascii_lowercase())
        .collect();
    let mut seen: HashMap<(String, String), ImportResult> = HashMap::new();
    let mut writes = Vec::new();
    let mut imports = Vec::new();
    for (index, op) in requests {
        let record_id = canonical_record_id(&op.system, &op.record_id)?;
        if let Some(why) = path_refusal(&op.path) {
            return Err(why);
        }
        let composed = compose(
            &op.content,
            &Stamp {
                system: &op.system,
                record_id: &record_id,
                url: op.url.as_deref(),
                method,
                now,
                actor,
            },
        )?;
        let key = (op.system.clone(), record_id.clone());
        if let Some(first) = seen.get(&key) {
            let mut duplicate = first.clone();
            duplicate.index = *index;
            duplicate.outcome = "duplicate";
            duplicate.first = Some(first.index);
            duplicate.reason = None;
            imports.push(duplicate);
            continue;
        }
        let found = copies.get(&key).map(Vec::as_slice).unwrap_or(&[]);
        let mut path = found
            .first()
            .map(|file| file.path.clone())
            .unwrap_or_else(|| op.path.clone());
        let mut reason = None;
        let outcome;
        if let Some(old) = found.first() {
            if other.contains(&path.to_ascii_lowercase()) {
                return Err(words("path_twice", &[("path", &path)]));
            }
            match stored_import_hash(&old.content) {
                None => {
                    outcome = "kept";
                    reason = Some("stamp_unreadable");
                }
                Some(digest) if digest.current != digest.stored => {
                    outcome = "kept";
                    reason = Some("changed_since_import");
                }
                Some(digest) if digest.stored == composed.hash => outcome = "unchanged",
                Some(_) => {
                    outcome = "replaced";
                    writes.push((*index, json!({ "op": "replace_file", "path": path, "content": composed.content, "expectHash": hash(&old.content) })));
                }
            }
        } else {
            if other.contains(&path.to_ascii_lowercase()) {
                return Err(words("path_twice", &[("path", &path)]));
            }
            let dot = op.path.rfind('.').expect("validated markdown path");
            let (stem, ext) = op.path.split_at(dot);
            let mut suffix = 2;
            while held.contains(&path.to_ascii_lowercase()) {
                path = format!("{stem}-{suffix}{ext}");
                suffix += 1;
            }
            if other.contains(&path.to_ascii_lowercase()) {
                return Err(words("path_twice", &[("path", &path)]));
            }
            outcome = "created";
            held.insert(path.to_ascii_lowercase());
            writes.push((
                *index,
                json!({ "op": "create", "path": path, "content": composed.content }),
            ));
        }
        let result = ImportResult {
            index: *index,
            system: op.system.clone(),
            record_id,
            outcome,
            path,
            also_at: found.iter().skip(1).map(|file| file.path.clone()).collect(),
            reason,
            first: None,
        };
        imports.push(result.clone());
        seen.insert(key, result);
    }
    Ok(Plan { writes, imports })
}

/// One disk walk records every visible occupied name, including directories
/// and symlinks, without following links. Failed reads refuse rather than
/// making an existing identity disappear from the importer's view.
pub fn read_vault(vault: &std::path::Path) -> Result<(Vec<ImportFile>, Vec<String>), String> {
    if !vault.is_dir() {
        return Err(format!("not a directory: {}", vault.display()));
    }
    let mut files = Vec::new();
    let mut occupied = Vec::new();
    let walk = walkdir::WalkDir::new(vault)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            entry.depth() == 0
                || if entry.file_type().is_dir() {
                    !crate::vault::scan::is_skipped_dir(&entry.file_name().to_string_lossy())
                } else {
                    !crate::vault::scan::is_hidden(&entry.file_name().to_string_lossy())
                }
        });
    for item in walk {
        let item =
            item.map_err(|error| format!("Couldn't read the import's existing copies: {error}"))?;
        if item.depth() == 0 {
            continue;
        }
        let path = item
            .path()
            .strip_prefix(vault)
            .map_err(|e| e.to_string())?
            .to_str()
            .ok_or_else(|| "An existing import path is not UTF-8.".to_string())?
            .replace('\\', "/");
        occupied.push(path.clone());
        if item.file_type().is_file() && path_refusal(&path).is_none() && path.ends_with(".md") {
            let source = crate::vault::write::read_note_source(vault, &path)?;
            files.push(ImportFile {
                path,
                content: source.content,
            });
        }
    }
    Ok((files, occupied))
}
