//! Shared import identity and byte-exact stamps (M69.3). Files are the index;
//! the batch writer remains the journal and the only human mutation door.
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, MutexGuard, OnceLock};
pub mod capture;
pub mod notion;
pub mod plan;
mod stamps;
pub use stamps::stamp_bytes_refusal;
const RAW: &str = include_str!("../../../shared/import/sources.v1.json");
static TABLE: OnceLock<Table> = OnceLock::new();
static IMPORT_LOCK: Mutex<()> = Mutex::new(());
/// Always held before path locks, including by the future agent import door.
pub fn lock() -> MutexGuard<'static, ()> {
    IMPORT_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}
pub struct Table {
    pub value: Value,
}
fn failure(path: &str, why: &str) -> String {
    format!("Invalid sources artifact: {path}: {why}")
}
fn object<'a>(
    value: &'a Value,
    path: &str,
    keys: &[&str],
) -> Result<&'a Map<String, Value>, String> {
    let row = value
        .as_object()
        .ok_or_else(|| failure(path, "must be an object"))?;
    for key in keys {
        if !row.contains_key(*key) {
            return Err(failure(&format!("{path}.{key}"), "is required"));
        }
    }
    for key in row.keys() {
        if !keys.contains(&key.as_str()) {
            return Err(failure(&format!("{path}.{key}"), "is not a field"));
        }
    }
    Ok(row)
}
fn text<'a>(value: &'a Value, path: &str) -> Result<&'a str, String> {
    value
        .as_str()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| failure(path, "must be non-empty text"))
}
fn positive(value: &Value, path: &str) -> Result<u64, String> {
    value
        .as_f64()
        .filter(|v| v.is_finite() && *v > 0.0 && *v <= 9_007_199_254_740_991.0 && v.fract() == 0.0)
        .map(|v| v as u64)
        .ok_or_else(|| failure(path, "must be a positive integer"))
}
fn list<'a>(value: &'a Value, path: &str) -> Result<Vec<&'a str>, String> {
    let items = value
        .as_array()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| failure(path, "must be a non-empty list"))?;
    let result = items
        .iter()
        .enumerate()
        .map(|(i, item)| text(item, &format!("{path}[{i}]")))
        .collect::<Result<Vec<_>, _>>()?;
    if result.iter().collect::<HashSet<_>>().len() != result.len() {
        return Err(failure(path, "must not repeat a value"));
    }
    Ok(result)
}
fn step_keys(op: &str) -> Option<&'static [&'static str]> {
    Some(match op {
        "trim"
        | "drop_query_and_fragment"
        | "trim_trailing_slashes"
        | "last_segment"
        | "ascii_lower"
        | "require_uuid" => &[],
        "remove" => &["chars"],
        "take_last" => &["count"],
        "require_hex" => &["length"],
        "require_printable" => &["max"],
        "sha256_hex" => &["domain"],
        _ => return None,
    })
}
impl Table {
    pub fn parse(raw: &str) -> Result<Self, String> {
        let value: Value =
            serde_json::from_str(raw).map_err(|_| failure("sources", "JSON cannot be read"))?;
        Self::validate(&value)?;
        Ok(Self { value })
    }
    pub fn validate(value: &Value) -> Result<(), String> {
        let row = object(
            value,
            "sources",
            &[
                "format",
                "artifact_version",
                "rule_version",
                "about",
                "agent_guard",
                "cache",
                "import",
                "systems",
                "stamp",
                "import_hash",
                "url_pattern",
                "refused",
                "outcomes",
                "kept_reasons",
                "messages",
                "cases",
            ],
        )?;
        if row["format"] != 1 {
            return Err(failure("sources.format", "must be 1"));
        }
        positive(&row["artifact_version"], "sources.artifact_version")?;
        for key in ["rule_version", "about"] {
            text(&row[key], &format!("sources.{key}"))?;
        }
        list(&row["agent_guard"], "sources.agent_guard")?;
        for (name, extra) in [("cache", "kinds"), ("import", "methods")] {
            let path = format!("sources.{name}");
            let family = object(&row[name], &path, &["stamped_by", "keys", extra])?;
            text(&family["stamped_by"], &format!("{path}.stamped_by"))?;
            for key in ["keys", extra] {
                list(&family[key], &format!("{path}.{key}"))?;
            }
        }
        let systems = row["systems"]
            .as_array()
            .filter(|v| !v.is_empty())
            .ok_or_else(|| failure("sources.systems", "must be a non-empty list"))?;
        let mut previous = "";
        for (i, value) in systems.iter().enumerate() {
            let path = format!("sources.systems[{i}]");
            let system = object(value, &path, &["id", "label", "record", "id_steps"])?;
            let id = text(&system["id"], &format!("{path}.id"))?;
            if !id.starts_with(|c: char| c.is_ascii_lowercase())
                || !id
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
                || previous >= id
            {
                return Err(failure(
                    &format!("{path}.id"),
                    "must be a unique sorted lowercase id",
                ));
            }
            previous = id;
            text(&system["label"], &format!("{path}.label"))?;
            text(&system["record"], &format!("{path}.record"))?;
            let steps = system["id_steps"]
                .as_array()
                .filter(|v| !v.is_empty())
                .ok_or_else(|| failure(&format!("{path}.id_steps"), "must be a non-empty list"))?;
            for (j, step) in steps.iter().enumerate() {
                let at = format!("{path}.id_steps[{j}]");
                let keys = step["op"]
                    .as_str()
                    .and_then(step_keys)
                    .ok_or_else(|| failure(&format!("{at}.op"), "is not a canonicalizer step"))?;
                let all = [vec!["op"], keys.to_vec()].concat();
                let step = object(step, &at, &all)?;
                for key in keys {
                    if ["count", "length", "max"].contains(key) {
                        positive(&step[*key], &format!("{at}.{key}"))?;
                    } else {
                        text(&step[*key], &format!("{at}.{key}"))?;
                    }
                }
            }
        }
        let stamp = object(
            &row["stamp"],
            "sources.stamp",
            &["order", "value", "volatile", "optional"],
        )?;
        if stamp["value"] != "json_string" {
            return Err(failure("sources.stamp.value", "must be json_string"));
        }
        let order = list(&stamp["order"], "sources.stamp.order")?;
        if stamp["order"] != row["import"]["keys"] {
            return Err(failure(
                "sources.stamp.order",
                "must list the import keys in order",
            ));
        }
        for key in ["volatile", "optional"] {
            for name in list(&stamp[key], &format!("sources.stamp.{key}"))? {
                if !order.contains(&name) {
                    return Err(failure(
                        &format!("sources.stamp.{key}"),
                        "must name import keys",
                    ));
                }
            }
        }
        regex::Regex::new(text(&row["url_pattern"], "sources.url_pattern")?)
            .map_err(|_| failure("sources.url_pattern", "must be a regular expression"))?;
        let domain = object(&row["import_hash"], "sources.import_hash", &["domain"])?;
        text(&domain["domain"], "sources.import_hash.domain")?;
        let refused = object(&row["refused"], "sources.refused", &["types", "roots"])?;
        list(&refused["types"], "sources.refused.types")?;
        list(&refused["roots"], "sources.refused.roots")?;
        for (key, keys) in [
            (
                "outcomes",
                &["created", "replaced", "unchanged", "kept", "duplicate"][..],
            ),
            (
                "kept_reasons",
                &["changed_since_import", "stamp_unreadable"],
            ),
            (
                "messages",
                &[
                    "unknown_system",
                    "bad_record_id",
                    "bad_url",
                    "bad_shape",
                    "stamped_key",
                    "refused_type",
                    "bad_path",
                    "path_twice",
                    "stamp_refusal",
                ],
            ),
        ] {
            let path = format!("sources.{key}");
            let words = object(&row[key], &path, keys)?;
            for name in keys {
                text(&words[*name], &format!("{path}.{name}"))?;
            }
        }
        let cases = object(
            &row["cases"],
            "sources.cases",
            &[
                "record_ids",
                "import_hashes",
                "stamps",
                "urls",
                "stamp_guard",
            ],
        )?;
        for (key, rows) in cases {
            if rows.as_array().is_none_or(|v| v.is_empty()) {
                return Err(failure(
                    &format!("sources.cases.{key}"),
                    "must be a non-empty list",
                ));
            }
        }
        Ok(())
    }
}
pub fn table() -> &'static Table {
    TABLE.get_or_init(|| Table::parse(RAW).expect("compiled import sources artifact must validate"))
}
fn strings(value: &Value) -> Vec<&str> {
    value
        .as_array()
        .expect("validated list")
        .iter()
        .map(|v| v.as_str().expect("validated string"))
        .collect()
}
pub fn cache_kinds() -> Vec<&'static str> {
    strings(&table().value["cache"]["kinds"])
}
pub fn import_keys() -> Vec<&'static str> {
    strings(&table().value["import"]["keys"])
}
pub fn words(key: &str, values: &[(&str, &str)]) -> String {
    let mut message = table().value["messages"][key]
        .as_str()
        .expect("known message")
        .to_string();
    for (name, value) in values {
        message = message.replace(&format!("{{{name}}}"), value);
    }
    message
}
fn system(id: &str) -> Result<&'static Value, String> {
    let systems = table().value["systems"]
        .as_array()
        .expect("validated systems");
    systems.iter().find(|row| row["id"] == id).ok_or_else(|| {
        words(
            "unknown_system",
            &[
                ("system", id),
                (
                    "systems",
                    &systems
                        .iter()
                        .map(|row| row["id"].as_str().unwrap())
                        .collect::<Vec<_>>()
                        .join(", "),
                ),
            ],
        )
    })
}
fn ascii_trim(value: &str) -> &str {
    value.trim_matches(['\t', '\n', '\u{c}', '\r', ' '])
}
pub fn hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
pub fn canonical_record_id(id: &str, input: &str) -> Result<String, String> {
    let row = system(id)?;
    let mut value = input.to_string();
    let bad = || {
        words(
            "bad_record_id",
            &[
                ("input", input),
                ("label", row["label"].as_str().unwrap()),
                ("record", row["record"].as_str().unwrap()),
            ],
        )
    };
    for step in row["id_steps"].as_array().unwrap() {
        match step["op"].as_str().unwrap() {
            "trim" => value = ascii_trim(&value).to_string(),
            "ascii_lower" => value.make_ascii_lowercase(),
            "drop_query_and_fragment" => {
                value.truncate(value.find(['?', '#']).unwrap_or(value.len()))
            }
            "trim_trailing_slashes" => value = value.trim_end_matches('/').to_string(),
            "last_segment" => value = value.rsplit('/').next().unwrap_or("").to_string(),
            "remove" => value.retain(|c| !step["chars"].as_str().unwrap().contains(c)),
            "take_last" => {
                value = value
                    .chars()
                    .skip(
                        value
                            .chars()
                            .count()
                            .saturating_sub(step["count"].as_f64().unwrap() as usize),
                    )
                    .collect()
            }
            "require_hex" => {
                if value.len() != step["length"].as_f64().unwrap() as usize
                    || !value
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                {
                    return Err(bad());
                }
            }
            "require_uuid" => {
                if value.len() != 36
                    || !value.bytes().enumerate().all(|(i, b)| {
                        if [8, 13, 18, 23].contains(&i) {
                            b == b'-'
                        } else {
                            b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
                        }
                    })
                {
                    return Err(bad());
                }
            }
            "require_printable" => {
                if value.is_empty()
                    || value.chars().count() > step["max"].as_f64().unwrap() as usize
                    || value.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
                {
                    return Err(bad());
                }
            }
            "sha256_hex" => value = hash(&format!("{}\0{value}", step["domain"].as_str().unwrap())),
            _ => unreachable!("validated step"),
        }
    }
    Ok(value)
}
pub fn stored_record_id(id: &str, value: &str) -> Option<String> {
    let row = system(id).ok()?;
    if row["id_steps"].as_array()?.last()?["op"] == "sha256_hex" {
        return (value.len() == 64
            && value
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
        .then(|| value.to_string());
    }
    canonical_record_id(id, value).ok()
}
pub fn path_refusal(path: &str) -> Option<String> {
    let lower = path.to_ascii_lowercase();
    (path.contains('\\')
        || path.starts_with('/')
        || !lower.ends_with(".md")
        || path
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == ".." || crate::vault::scan::is_hidden(p))
        || strings(&table().value["refused"]["roots"])
            .iter()
            .any(|root| {
                crate::knowledge::disk_folded(path)
                    .starts_with(&crate::knowledge::disk_folded(root))
            }))
    .then(|| words("bad_path", &[("path", path)]))
}
fn source_shape(content: &str) -> Result<(usize, serde_yaml::Mapping), String> {
    let bad = || words("bad_shape", &[]);
    if !content.starts_with("---\n") || content.contains('\r') {
        return Err(bad());
    }
    let end = content[3..]
        .find("\n---\n")
        .map(|i| i + 3)
        .ok_or_else(bad)?;
    let yaml: serde_yaml::Value =
        serde_yaml::from_str(if end == 3 { "" } else { &content[4..end] }).map_err(|_| bad())?;
    let fields = match yaml {
        serde_yaml::Value::Null => serde_yaml::Mapping::new(),
        serde_yaml::Value::Mapping(fields) => fields,
        _ => return Err(bad()),
    };
    Ok((end, fields))
}
pub struct Stamp<'a> {
    pub system: &'a str,
    pub record_id: &'a str,
    pub url: Option<&'a str>,
    pub method: Option<&'a str>,
    pub now: &'a str,
    pub actor: &'a str,
}
pub struct Composed {
    pub content: String,
    pub hash: String,
}
/// `record_id` is already canonical. The planner canonicalizes input once.
pub fn valid_url(url: &str) -> bool {
    static PATTERN: OnceLock<regex::Regex> = OnceLock::new();
    let pattern = PATTERN.get_or_init(|| {
        regex::Regex::new(table().value["url_pattern"].as_str().unwrap())
            .expect("validated URL pattern")
    });
    pattern.find(url).is_some_and(|found| found.as_str() == url)
}
pub fn compose(content: &str, stamp: &Stamp<'_>) -> Result<Composed, String> {
    system(stamp.system)?;
    if let Some(url) = stamp.url {
        if !valid_url(url) {
            return Err(words("bad_url", &[("input", url)]));
        }
    }
    let (end, fields) = source_shape(content)?;
    let mut keys = strings(&table().value["cache"]["keys"]);
    for key in import_keys() {
        if !keys.contains(&key) {
            keys.push(key);
        }
    }
    let present: Vec<_> = keys
        .into_iter()
        .filter(|key| fields.contains_key(serde_yaml::Value::String((*key).to_string())))
        .collect();
    if !present.is_empty() {
        return Err(words("stamped_key", &[("keys", &present.join(", "))]));
    }
    if let Some(kind) = fields.get("type").and_then(serde_yaml::Value::as_str) {
        if strings(&table().value["refused"]["types"])
            .iter()
            .any(|name| name.eq_ignore_ascii_case(ascii_trim(kind)))
        {
            return Err(words("refused_type", &[("type", kind)]));
        }
    }
    if stamp
        .method
        .is_some_and(|method| !strings(&table().value["import"]["methods"]).contains(&method))
    {
        return Err(words("bad_shape", &[]));
    }
    let mut values: HashMap<&str, &str> = [
        ("source_system", stamp.system),
        ("source_record_id", stamp.record_id),
        ("imported_at", stamp.now),
        ("imported_by", stamp.actor),
        ("import_hash", ""),
    ]
    .into_iter()
    .collect();
    if let Some(url) = stamp.url {
        values.insert("source_url", url);
    }
    if let Some(method) = stamp.method {
        values.insert("import_method", method);
    }
    let write = |values: &HashMap<&str, &str>, blank: bool| {
        let volatile = strings(&table().value["stamp"]["volatile"]);
        let lines = strings(&table().value["stamp"]["order"])
            .into_iter()
            .filter_map(|key| {
                values.get(key).map(|value| {
                    format!(
                        "{key}: {}",
                        serde_json::to_string(if blank && volatile.contains(&key) {
                            ""
                        } else {
                            *value
                        })
                        .unwrap()
                    )
                })
            })
            .collect::<Vec<_>>()
            .join("\n");
        format!("{}\n{lines}{}", &content[..end], &content[end..])
    };
    let digest = hash(&format!(
        "{}\0{}",
        table().value["import_hash"]["domain"].as_str().unwrap(),
        write(&values, true)
    ));
    values.insert("import_hash", &digest);
    let content = write(&values, false);
    source_shape(&content)?;
    Ok(Composed {
        content,
        hash: digest,
    })
}
pub struct StoredHash {
    pub stored: String,
    pub current: String,
}
pub fn stored_import_hash(content: &str) -> Option<StoredHash> {
    let (end, fields) = source_shape(content).ok()?;
    let stored = fields.get("import_hash")?.as_str()?;
    if stored.len() != 64
        || !stored
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return None;
    }
    let mut lines: Vec<_> = content[..end].split('\n').map(str::to_string).collect();
    for key in strings(&table().value["stamp"]["volatile"]) {
        let matches: Vec<_> = lines
            .iter()
            .enumerate()
            .filter(|(_, line)| line.starts_with(&format!("{key}: ")))
            .map(|(i, _)| i)
            .collect();
        let value = fields.get(key)?.as_str()?;
        if matches.len() != 1
            || lines[matches[0]] != format!("{key}: {}", serde_json::to_string(value).ok()?)
        {
            return None;
        }
        lines[matches[0]] = format!("{key}: \"\"");
    }
    Some(StoredHash {
        stored: stored.to_string(),
        current: hash(&format!(
            "{}\0{}{}",
            table().value["import_hash"]["domain"].as_str().unwrap(),
            lines.join("\n"),
            &content[end..]
        )),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replays_the_shared_source_cases() {
        for row in table().value["cases"]["urls"].as_array().unwrap() {
            assert_eq!(
                valid_url(row["input"].as_str().unwrap()),
                row["accepted"].as_bool().unwrap(),
                "{row}"
            );
        }
        for row in table().value["cases"]["record_ids"].as_array().unwrap() {
            let got = canonical_record_id(
                row["system"].as_str().unwrap(),
                row["input"].as_str().unwrap(),
            );
            if row["expected"].is_null() {
                assert!(got.is_err(), "{row}");
            } else {
                assert_eq!(got.unwrap(), row["expected"].as_str().unwrap(), "{row}");
            }
        }
        for row in table().value["cases"]["import_hashes"].as_array().unwrap() {
            let got = compose(
                row["content"].as_str().unwrap(),
                &Stamp {
                    system: row["system"].as_str().unwrap(),
                    record_id: row["record_id"].as_str().unwrap(),
                    url: row["url"].as_str(),
                    method: row["method"].as_str(),
                    now: row["now"].as_str().unwrap(),
                    actor: row["actor"].as_str().unwrap(),
                },
            )
            .unwrap();
            assert_eq!(got.hash, row["hash"].as_str().unwrap());
            assert_eq!(got.content, row["composed"].as_str().unwrap());
            let stored = stored_import_hash(&got.content).unwrap();
            assert_eq!(stored.stored, got.hash);
            assert_eq!(stored.current, got.hash);
        }
        for row in table().value["cases"]["stamps"].as_array().unwrap() {
            assert_eq!(
                stored_import_hash(row["content"].as_str().unwrap()).map(|v| v.stored),
                row["expected"].as_str().map(str::to_string)
            );
        }
    }
    #[test]
    fn an_import_hash_does_not_depend_on_when_or_who_imported() {
        let content = "---\n---\n# Page\n";
        let make = |now, actor| {
            compose(
                content,
                &Stamp {
                    system: "notion",
                    record_id: "0123456789abcdef0123456789abcdef",
                    url: None,
                    method: None,
                    now,
                    actor,
                },
            )
            .unwrap()
        };
        assert_eq!(
            make("now", "human:me").hash,
            make("later", "human:later").hash
        );
    }
    #[test]
    fn a_stored_calendar_digest_is_not_hashed_again() {
        let id = canonical_record_id("ics", "event-1 -").unwrap();
        assert_eq!(stored_record_id("ics", &id), Some(id));
        assert_eq!(stored_record_id("ics", "event-1 -"), None);
    }
    #[test]
    fn sources_validation_is_closed() {
        let mut value = table().value.clone();
        value["extra"] = true.into();
        assert_eq!(
            Table::validate(&value).unwrap_err(),
            "Invalid sources artifact: sources.extra: is not a field"
        );
        let mut value = table().value.clone();
        value["format"] = 2.into();
        assert_eq!(
            Table::validate(&value).unwrap_err(),
            "Invalid sources artifact: sources.format: must be 1"
        );
        let mut value = table().value.clone();
        value["systems"][0]["id_steps"][0]["op"] = "invent".into();
        assert!(Table::validate(&value)
            .unwrap_err()
            .ends_with("is not a canonicalizer step"));
        let mut value = table().value.clone();
        value["systems"][0]["id_steps"][1]["max"] = 0.into();
        assert!(Table::validate(&value)
            .unwrap_err()
            .ends_with("must be a positive integer"));
    }
    #[test]
    fn the_compiled_sources_match_the_digest() {
        assert_eq!(
            hash(RAW),
            include_str!("../../../shared/import/sources.v1.sha256").trim()
        );
    }
    #[test]
    #[ignore = "deliberate artifact edit only"]
    fn write_sources_digest() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../shared/import/sources.v1.sha256");
        std::fs::write(path, format!("{}\n", hash(RAW))).unwrap();
    }
}
