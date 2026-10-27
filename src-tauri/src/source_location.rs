//! Versioned source positions. The source read and its hash are one snapshot.
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Utf8Range {
    pub start: u32,
    pub end: u32,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceLocator {
    pub version: u8,
    pub vault_id: String,
    pub path: String,
    pub source_hash: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body_utf8_range: Option<Utf8Range>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub property_key: Option<String>,
    pub quote: String,
    pub prefix: String,
    pub suffix: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum ResolveSourceResult {
    Exact {
        locator: SourceLocator,
    },
    Relocated {
        locator: SourceLocator,
        #[serde(rename = "previousHash")]
        previous_hash: String,
    },
    Changed {
        path: String,
        reason: String,
    },
    Unavailable {
        reason: String,
    },
    Unsupported {
        reason: String,
    },
}
pub struct SourceScope<'a> {
    pub vault: &'a Path,
    pub vault_id: &'a str,
    pub admits: &'a dyn Fn(&str) -> bool,
}
pub type SourceReadError = String;
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rules {
    version: u8,
    pub quote_scalars: usize,
    pub context_scalars: usize,
    pub max_source_bytes: usize,
    pub max_body_bytes: usize,
    max_path_bytes: usize,
    max_vault_id_bytes: usize,
    kinds: Vec<String>,
    carriers: Vec<String>,
}
pub fn rules() -> &'static Rules {
    static RULES: std::sync::OnceLock<Rules> = std::sync::OnceLock::new();
    RULES.get_or_init(|| {
        let rules: Rules = serde_json::from_str(include_str!(
            "../../shared/knowledge/source-location.v1.json"
        ))
        .expect("source location rules");
        assert_eq!(rules.version, 1);
        assert_eq!(rules.kinds, ["body", "property"]);
        assert_eq!(rules.carriers, ["markdown", "unsupported"]);
        assert!(rules.quote_scalars > 0 && rules.context_scalars > 0);
        assert!(rules.max_source_bytes >= rules.max_body_bytes && rules.max_body_bytes > 0);
        rules
    })
}

/// Evidence of the exact corpus read. Unsupported carriers never yield a
/// Markdown range, even if their searchable projection is textual.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceSnapshot {
    pub raw_sha256: String,
    pub carrier: &'static str,
    pub body_start_utf8: usize,
    pub searched_body_bytes: usize,
    pub capped: bool,
}

fn unavailable() -> ResolveSourceResult {
    ResolveSourceResult::Unavailable {
        reason: "Source is unavailable.".into(),
    }
}
fn changed(locator: &SourceLocator) -> ResolveSourceResult {
    ResolveSourceResult::Changed {
        path: locator.path.clone(),
        reason: "The recorded passage no longer resolves uniquely.".into(),
    }
}
fn valid(locator: &SourceLocator) -> bool {
    let caps = rules();
    let shape = match locator.kind.as_str() {
        "body" => {
            locator.property_key.is_none()
                && locator
                    .body_utf8_range
                    .as_ref()
                    .is_some_and(|r| r.start < r.end && r.end as usize <= caps.max_body_bytes)
        }
        "property" => {
            locator.body_utf8_range.is_none()
                && locator
                    .property_key
                    .as_ref()
                    .is_some_and(|key| !key.is_empty())
        }
        _ => false,
    };
    shape
        && locator.source_hash.len() == 64
        && locator
            .source_hash
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        && !locator.quote.is_empty()
        && locator.quote.chars().count() <= caps.quote_scalars
        && locator.prefix.chars().count() <= caps.context_scalars
        && locator.suffix.chars().count() <= caps.context_scalars
}

/// Finds at most two matches. Advancing one scalar preserves overlapping
/// occurrences, which must remain ambiguous rather than picking the first.
fn candidates(text: &str, locator: &SourceLocator) -> Vec<usize> {
    let mut found = Vec::new();
    let mut from = 0;
    while let Some(offset) = text[from..].find(&locator.quote) {
        let start = from + offset;
        let end = start + locator.quote.len();
        if text[..start].ends_with(&locator.prefix) && text[end..].starts_with(&locator.suffix) {
            found.push(start);
            if found.len() == 2 {
                break;
            }
        }
        from = start
            + text[start..]
                .chars()
                .next()
                .expect("nonempty quote")
                .len_utf8();
    }
    found
}

fn resolve_body_window(locator: &SourceLocator, body: &str, hash: String) -> ResolveSourceResult {
    let mut cap = body.len().min(rules().max_body_bytes);
    while !body.is_char_boundary(cap) {
        cap -= 1;
    }
    let body = &body[..cap];
    let same = hash == locator.source_hash;
    let mut resolved = locator.clone();
    resolved.source_hash = hash;
    if same {
        let range = locator
            .body_utf8_range
            .as_ref()
            .expect("validated body range");
        if body.get(range.start as usize..range.end as usize) != Some(locator.quote.as_str()) {
            return changed(locator);
        }
    } else {
        let found = candidates(body, locator);
        if found.len() != 1 {
            return changed(locator);
        }
        resolved.body_utf8_range = Some(Utf8Range {
            start: found[0] as u32,
            end: (found[0] + locator.quote.len()) as u32,
        });
    }
    if same {
        ResolveSourceResult::Exact { locator: resolved }
    } else {
        ResolveSourceResult::Relocated {
            locator: resolved,
            previous_hash: locator.source_hash.clone(),
        }
    }
}

pub fn resolve_source(
    scope: &SourceScope<'_>,
    locator: &SourceLocator,
) -> Result<ResolveSourceResult, SourceReadError> {
    use std::io::Read;
    // No cached excerpt or read may precede current vault/read admission.
    if locator.vault_id != scope.vault_id || !(scope.admits)(&locator.path) {
        return Ok(unavailable());
    }
    if locator.path.len() > rules().max_path_bytes
        || locator.vault_id.len() > rules().max_vault_id_bytes
        || crate::files::bytes::rel_refusal("0", &locator.path).is_some()
    {
        return Ok(unavailable());
    }
    if locator.version != rules().version {
        return Ok(ResolveSourceResult::Unsupported {
            reason: "Unsupported source location version.".into(),
        });
    }
    if !valid(locator) {
        return Ok(changed(locator));
    }
    if !locator.path.ends_with(".md") {
        return Ok(ResolveSourceResult::Unsupported {
            reason: "This carrier has no Markdown source location.".into(),
        });
    }
    match crate::workspace_service::authority::resolve(scope.vault) {
        Ok(crate::workspace_service::authority::Authority::Selected) => {
            if crate::runtime::scope::derive_vault_id(scope.vault) != scope.vault_id {
                return Ok(unavailable());
            }
            if locator.kind == "property" {
                return Ok(ResolveSourceResult::Unsupported { reason: "Canonical metadata passage locations are unavailable; body YAML is not metadata.".into() });
            }
            let Ok(exact) =
                crate::workspace_service::selected::source_body(scope.vault, &locator.path)
            else {
                return Ok(unavailable());
            };
            let hash = crate::ledger::sha256_hex(exact.as_bytes());
            return Ok(resolve_body_window(locator, &exact, hash));
        }
        Ok(crate::workspace_service::authority::Authority::Legacy) => {}
        Err(_) => return Ok(unavailable()),
    }
    let Ok(opened) =
        crate::workspace_service::boundary::open_legacy_source(scope.vault, &locator.path)
    else {
        return Ok(unavailable());
    };
    // open_in pins an O_NOFOLLOW descriptor beneath an anchored root. Scope
    // follows its actual landing, including an in-vault symlink's target.
    let Ok(landing) = opened.path.strip_prefix(&opened.root) else {
        return Ok(unavailable());
    };
    if crate::runtime::scope::derive_vault_id(&opened.root) != scope.vault_id
        || !(scope.admits)(&landing.to_string_lossy())
    {
        return Ok(unavailable());
    }
    if !opened.path.to_string_lossy().ends_with(".md") {
        return Ok(ResolveSourceResult::Unsupported {
            reason: "This carrier has no Markdown source location.".into(),
        });
    }
    let max = rules().max_source_bytes;
    let Ok(meta) = opened.file.metadata() else {
        return Ok(unavailable());
    };
    if meta.len() > max as u64 {
        return Ok(ResolveSourceResult::Unavailable {
            reason: "Source exceeds the bounded read limit.".into(),
        });
    }
    let mut bytes = Vec::new();
    if opened
        .file
        .take(max as u64 + 1)
        .read_to_end(&mut bytes)
        .is_err()
    {
        return Ok(unavailable());
    }
    if bytes.len() > max {
        return Ok(ResolveSourceResult::Unavailable {
            reason: "Source exceeds the bounded read limit.".into(),
        });
    }
    let Ok(raw) = String::from_utf8(bytes) else {
        return Ok(unavailable());
    };
    let hash = crate::ledger::sha256_hex(raw.as_bytes());
    let same = hash == locator.source_hash;
    let mut resolved = locator.clone();
    resolved.source_hash = hash;
    if locator.kind == "body" {
        return Ok(resolve_body_window(
            locator,
            crate::vault::parse::split_frontmatter(&raw).1,
            resolved.source_hash,
        ));
    }
    {
        let entry =
            crate::vault::entry::build_entry(&locator.path, &raw, String::new(), String::new());
        if entry.parse_error.is_some() {
            return Ok(unavailable());
        }
        let fields = crate::search::searchable_fields(
            &entry.title,
            entry.entry_type.as_deref(),
            &entry.properties,
            &entry.relationships,
        );
        let fields: Vec<_> = fields
            .iter()
            .filter(|field| Some(&field.key) == locator.property_key.as_ref())
            .collect();
        if fields.len() != 1 {
            return Ok(changed(locator));
        }
        let matches = candidates(&fields[0].text, locator).len();
        // Equal hashes identify the row, not an array member. Only relocation
        // needs one unique occurrence of the recorded quote and context.
        if matches == 0 || (!same && matches != 1) {
            return Ok(changed(locator));
        }
    }
    Ok(if same {
        ResolveSourceResult::Exact { locator: resolved }
    } else {
        ResolveSourceResult::Relocated {
            locator: resolved,
            previous_hash: locator.source_hash.clone(),
        }
    })
}

/// Build from the raw selected window, before display normalization. The
/// optional range denotes body bytes or the flattened property's own bytes.
pub fn locate_window(
    vault_id: &str,
    path: &str,
    snapshot: &SourceSnapshot,
    text: &str,
    range: std::ops::Range<usize>,
    property_key: Option<&str>,
) -> Option<SourceLocator> {
    if snapshot.carrier != "markdown"
        || range.is_empty()
        || (property_key.is_none() && range.end > snapshot.searched_body_bytes)
    {
        return None;
    }
    let quote = text.get(range.clone())?;
    if quote.chars().count() > rules().quote_scalars {
        return None;
    }
    let prefix: String = text[..range.start]
        .chars()
        .rev()
        .take(rules().context_scalars)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    let suffix: String = text[range.end..]
        .chars()
        .take(rules().context_scalars)
        .collect();
    Some(SourceLocator {
        version: 1,
        vault_id: vault_id.into(),
        path: path.into(),
        source_hash: snapshot.raw_sha256.clone(),
        kind: if property_key.is_some() {
            "property"
        } else {
            "body"
        }
        .into(),
        body_utf8_range: property_key.is_none().then_some(Utf8Range {
            start: range.start.try_into().ok()?,
            end: range.end.try_into().ok()?,
        }),
        property_key: property_key.map(str::to_string),
        quote: quote.into(),
        prefix,
        suffix,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn source_location_shared_cases() {
        let cases: serde_json::Value = serde_json::from_str(include_str!(
            "../../shared/knowledge/source-location-cases.json"
        ))
        .unwrap();
        let mut mismatches = Vec::new();
        for case in cases["cases"].as_array().unwrap() {
            let vault = crate::vault::testutil::temp_vault("source-location");
            let mut locator: SourceLocator =
                serde_json::from_value(case["locator"].clone()).unwrap();
            crate::vault::testutil::write(&vault, &locator.path, case["current"].as_str().unwrap());
            let vault_id = crate::runtime::scope::derive_vault_id(&vault);
            locator.vault_id = vault_id.clone();
            let allowed = case["allowed"].as_bool().unwrap();
            let scope = SourceScope {
                vault: &vault,
                vault_id: if case["vaultId"] == "vault" {
                    &vault_id
                } else {
                    "other"
                },
                admits: &|_| allowed,
            };
            let result = resolve_source(&scope, &locator).unwrap();
            let result = serde_json::to_value(result).unwrap();
            if result["status"] != case["status"] {
                mismatches.push(format!(
                    "{}: expected {}, got {}",
                    case["name"], case["status"], result["status"]
                ));
            }
            if result.get("locator").is_some() {
                assert_eq!(
                    result["locator"]["sourceHash"],
                    crate::ledger::sha256_hex(case["current"].as_str().unwrap().as_bytes())
                );
            }
            if case["status"] == "relocated" {
                assert_eq!(result["previousHash"], locator.source_hash);
            }

            if let Some(range) = case.get("range") {
                assert_eq!(
                    result["locator"]["bodyUtf8Range"], *range,
                    "{}",
                    case["name"]
                );
            }
            let _ = std::fs::remove_dir_all(vault);
        }
        assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
    }
    fn body_locator(vault: &Path, raw: &str) -> SourceLocator {
        SourceLocator {
            version: 1,
            vault_id: crate::runtime::scope::derive_vault_id(vault),
            path: "note.md".into(),
            source_hash: crate::ledger::sha256_hex(raw.as_bytes()),
            kind: "body".into(),
            body_utf8_range: Some(Utf8Range {
                start: 0,
                end: raw.len() as u32,
            }),
            property_key: None,
            quote: raw.into(),
            prefix: String::new(),
            suffix: String::new(),
        }
    }

    #[test]
    fn source_location_refuses_denied_symlink_landing() {
        let vault = crate::vault::testutil::temp_vault("source-scope-link");
        crate::vault::testutil::write(&vault, "private.md", "secret");
        #[cfg(unix)]
        std::os::unix::fs::symlink(vault.join("private.md"), vault.join("note.md")).unwrap();
        let locator = body_locator(&vault, "secret");
        let scope = SourceScope {
            vault: &vault,
            vault_id: &locator.vault_id,
            admits: &|path| path == "note.md",
        };
        let result = resolve_source(&scope, &locator).unwrap();
        assert_eq!(
            serde_json::to_value(result).unwrap(),
            serde_json::json!({"status":"unavailable","reason":"Source is unavailable."})
        );
        let _ = std::fs::remove_dir_all(vault);
    }

    #[test]
    fn source_location_bounds_raw_read_and_body_relocation() {
        let vault = crate::vault::testutil::temp_vault("source-bounds");
        let locator = body_locator(&vault, "secret");
        let scope = SourceScope {
            vault: &vault,
            vault_id: &locator.vault_id,
            admits: &|_| true,
        };
        crate::vault::testutil::write(
            &vault,
            "note.md",
            &format!("{}secret", "x".repeat(rules().max_body_bytes)),
        );
        assert!(matches!(
            resolve_source(&scope, &locator).unwrap(),
            ResolveSourceResult::Changed { .. }
        ));
        let file = std::fs::File::create(vault.join("note.md")).unwrap();
        file.set_len(rules().max_source_bytes as u64 + 1).unwrap();
        assert!(matches!(
            resolve_source(&scope, &locator).unwrap(),
            ResolveSourceResult::Unavailable { .. }
        ));
        let _ = std::fs::remove_dir_all(vault);
    }

    #[test]
    fn source_location_contract_digest() {
        assert_eq!(
            crate::ledger::sha256_hex(include_bytes!(
                "../../shared/knowledge/source-location.v1.json"
            )),
            include_str!("../../shared/knowledge/source-location.v1.sha256").trim()
        );
        assert_eq!(
            rules().max_body_bytes,
            crate::vault::corpus::SEARCH_BODY_CAP
        );
    }
    #[test]
    #[ignore = "deliberate source location contract regeneration"]
    fn write_source_location_digest() {
        let digest = crate::ledger::sha256_hex(include_bytes!(
            "../../shared/knowledge/source-location.v1.json"
        ));
        std::fs::write(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../shared/knowledge/source-location.v1.sha256"),
            format!("{digest}\n"),
        )
        .unwrap();
    }
}
