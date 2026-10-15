//! Shared mail storage and admission policy. The evidence pack is checked in
//! tests; runtime reads only this artifact's scoped, default-closed flag.
use serde::Deserialize;
use serde_json::Value;
use std::{collections::BTreeSet, sync::OnceLock};

pub const JSON: &str = include_str!("../../../shared/policy/mail.v1.json");
pub const PATH: &str = "shared/policy/mail.v1.json";
pub const DIGEST_PATH: &str = "shared/policy/mail.v1.sha256";
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Gate {
    pub registry: String,
    pub connector: String,
    pub kinds: Vec<String>,
    pub open: bool,
    pub scope: Option<String>,
    pub pack: String,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PathCase {
    pub path: String,
    pub kept: bool,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostCase {
    pub url: String,
    pub mail: bool,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GateCase {
    pub open: bool,
    pub scope: Option<String>,
    pub kind: String,
    pub vault_id: String,
    pub store_uuid: String,
    pub opens: bool,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RefusalCase {
    pub at: Vec<String>,
    pub set: Value,
    pub error: String,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MailPolicy {
    pub format: u64,
    pub artifact_version: u64,
    pub rule_version: String,
    pub folder: String,
    pub kept_out_of_git: Vec<String>,
    pub gate: Gate,
    pub mail_hosts: Vec<String>,
    pub unattended_denied_tools: Vec<String>,
    pub host_cases: Vec<HostCase>,
    pub path_cases: Vec<PathCase>,
    pub gate_cases: Vec<GateCase>,
    pub refusals: Vec<RefusalCase>,
}
fn plain(path: &str) -> bool {
    !path.is_empty()
        && path.is_ascii()
        && path.split('/').all(|part| {
            !matches!(part, "" | "." | "..")
                && part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
        })
}
fn named(value: &str, extra: u8, digits: bool) -> bool {
    (1..=40).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b == extra || (digits && b.is_ascii_digit()))
}
fn scope(value: &str) -> bool {
    let parts: Vec<_> = value.split(':').collect();
    parts.len() == 3
        && parts[0] == "vault_store"
        && parts[1..].iter().all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
        })
}
impl MailPolicy {
    pub fn validate(&self) -> Result<(), String> {
        let refuse = |text: &str| Err(text.to_owned());
        if self.format != 1 {
            return refuse("mail.format must be 1");
        }
        if self.artifact_version == 0 || self.artifact_version > 9_007_199_254_740_991 {
            return refuse("mail.artifact_version must be a positive integer");
        }
        if self.rule_version.trim().is_empty() {
            return refuse("mail.rule_version must not be empty");
        }
        if !plain(&self.folder) || !self.folder.starts_with("sources/") {
            return refuse("mail.folder must be a plain ASCII relative path under sources/");
        }
        if !self.kept_out_of_git.contains(&format!("{}/", self.folder))
            || self.kept_out_of_git.iter().collect::<BTreeSet<_>>().len()
                != self.kept_out_of_git.len()
            || self
                .kept_out_of_git
                .iter()
                .any(|path| !path.strip_suffix('/').is_some_and(plain))
        {
            return refuse("mail.kept_out_of_git must contain unique plain folders with trailing slashes, including the mail folder");
        }
        if self.mail_hosts.is_empty()
            || self.mail_hosts.iter().collect::<BTreeSet<_>>().len() != self.mail_hosts.len()
            || self.mail_hosts.iter().any(|host| {
                !host.contains('.')
                    || host.split('.').any(|label| {
                        label.is_empty()
                            || label.starts_with('-')
                            || label.ends_with('-')
                            || !label
                                .bytes()
                                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                    })
            })
        {
            return refuse("mail.mail_hosts must contain unique lowercase ASCII dotted hosts");
        }
        if self.unattended_denied_tools.is_empty()
            || self
                .unattended_denied_tools
                .iter()
                .collect::<BTreeSet<_>>()
                .len()
                != self.unattended_denied_tools.len()
            || self.unattended_denied_tools.iter().any(|tool| {
                !(1..=64).contains(&tool.len())
                    || !tool
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
            })
        {
            return refuse("mail.unattended_denied_tools must contain unique tool-part names");
        }
        if self.gate.registry != "R14" {
            return refuse("mail.gate.registry must be R14");
        }
        if !named(&self.gate.connector, b'-', true) {
            return refuse("mail.gate.connector must be a lowercase connector id");
        }
        if self.gate.kinds.is_empty()
            || self.gate.kinds.iter().collect::<BTreeSet<_>>().len() != self.gate.kinds.len()
            || self.gate.kinds.iter().any(|kind| !named(kind, b'_', false))
        {
            return refuse("mail.gate.kinds must be unique lowercase kind names");
        }
        if self.gate.open && !self.gate.scope.as_deref().is_some_and(scope) {
            return refuse("an open mail gate must name one vault_store scope");
        }
        if !self.gate.open && self.gate.scope.is_some() {
            return refuse("a closed mail gate must have no scope");
        }
        if !plain(&self.gate.pack)
            || !self
                .gate
                .pack
                .starts_with("docs/superpowers/evidence/triggers/R14/")
            || !self.gate.pack.ends_with(".md")
        {
            return refuse("mail.gate.pack must name a markdown pack under docs/superpowers/evidence/triggers/R14/");
        }
        Ok(())
    }
    pub fn is_kept_out_of_git(&self, path: &str) -> bool {
        let mut path = path;
        loop {
            if let Some(rest) = path.strip_prefix("./") {
                path = rest;
            } else if let Some(rest) = path.strip_prefix('/') {
                path = rest;
            } else {
                break;
            }
        }
        let path = path.to_ascii_lowercase();
        self.kept_out_of_git.iter().any(|entry| {
            let prefix = entry.trim_end_matches('/').to_ascii_lowercase();
            path == prefix || path.starts_with(&format!("{prefix}/"))
        })
    }
    pub fn gate_opens(&self, kind: &str, vault_id: &str, store_uuid: &str) -> bool {
        self.gate.open
            && self.gate.kinds.iter().any(|listed| listed == kind)
            && self.gate.scope.as_deref() == Some(&format!("vault_store:{vault_id}:{store_uuid}"))
    }
}
pub fn parse(json: &str) -> Result<MailPolicy, String> {
    let mut value: Value = serde_json::from_str(json).map_err(|_| "mail: invalid shape")?;
    // Optional serde fields otherwise accept an absent key, unlike the shared
    // strict loader. A closed gate must explicitly declare its null scope.
    if value
        .get("gate")
        .and_then(|gate| gate.get("scope"))
        .is_none()
        || value
            .get("gate_cases")
            .and_then(Value::as_array)
            .is_some_and(|cases| cases.iter().any(|case| case.get("scope").is_none()))
    {
        return Err("mail: invalid shape".into());
    }
    for (key, words) in [
        ("format", "mail.format must be 1"),
        (
            "artifact_version",
            "mail.artifact_version must be a positive integer",
        ),
    ] {
        if let Some(number) = value.get(key).and_then(Value::as_f64) {
            if !number.is_finite()
                || number.fract() != 0.0
                || !(1.0..=9_007_199_254_740_991.0).contains(&number)
                || (key == "format" && number != 1.0)
            {
                return Err(words.into());
            }
            value[key] = (number as u64).into();
        }
    }
    let table: MailPolicy = serde_json::from_value(value).map_err(|_| "mail: invalid shape")?;
    table.validate()?;
    Ok(table)
}
pub fn table() -> &'static MailPolicy {
    static TABLE: OnceLock<MailPolicy> = OnceLock::new();
    TABLE.get_or_init(|| parse(JSON).expect("the compiled mail policy is valid"))
}
pub fn is_kept_out_of_git(path: &str) -> bool {
    table().is_kept_out_of_git(path)
}
pub fn gate_opens(kind: &str, vault_id: &str, store_uuid: &str) -> bool {
    table().gate_opens(kind, vault_id, store_uuid)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::trigger::{evidence::parse_pack, registry};
    use sha2::{Digest, Sha256};
    use std::{fs, path::PathBuf};
    fn root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf()
    }
    #[test]
    fn the_loaded_bytes_match_the_committed_digest() {
        assert_eq!(fs::read_to_string(root().join(PATH)).unwrap(), JSON);
        assert_eq!(
            format!("{:x}", Sha256::digest(JSON.as_bytes())),
            fs::read_to_string(root().join(DIGEST_PATH)).unwrap().trim()
        );
    }
    #[test]
    fn replays_the_shared_mail_cases() {
        let table = table();
        for case in &table.path_cases {
            assert_eq!(
                table.is_kept_out_of_git(&case.path),
                case.kept,
                "{}",
                case.path
            );
        }
        for case in &table.gate_cases {
            let mut candidate = table.clone();
            candidate.gate.open = case.open;
            candidate.gate.scope = case.scope.clone();
            candidate.validate().unwrap();
            assert_eq!(
                candidate.gate_opens(&case.kind, &case.vault_id, &case.store_uuid),
                case.opens
            );
        }
        for case in &table.refusals {
            let mut value: Value = serde_json::from_str(JSON).unwrap();
            let mut target = &mut value;
            for part in &case.at {
                target = target.get_mut(part).unwrap();
            }
            *target = case.set.clone();
            assert_eq!(
                parse(&value.to_string()).unwrap_err(),
                case.error,
                "{:?}",
                case.at
            );
        }
    }
    #[test]
    fn the_loader_requires_every_field_and_refuses_unknown_ones() {
        for at in ["gate", "gate_cases"] {
            let mut value: Value = serde_json::from_str(JSON).unwrap();
            let target = if at == "gate" {
                &mut value[at]
            } else {
                &mut value[at][0]
            };
            target.as_object_mut().unwrap().remove("scope");
            assert_eq!(
                parse(&value.to_string()).unwrap_err(),
                "mail: invalid shape"
            );
        }
        let mut value: Value = serde_json::from_str(JSON).unwrap();
        value["unknown"] = true.into();
        assert_eq!(
            parse(&value.to_string()).unwrap_err(),
            "mail: invalid shape"
        );
    }
    fn accepted(table: &MailPolicy, pack: &str, registry: &registry::Registry) -> bool {
        let pack = parse_pack(pack).unwrap();
        !table.gate.open
            || (registry
                .resolve("R14", &format!("connector:{}", table.gate.connector))
                .is_some()
                && pack.frontmatter.get("decided_at").is_some_and(|date| {
                    date.len() == 10
                        && date.as_bytes()[4] == b'-'
                        && date.as_bytes()[7] == b'-'
                        && date
                            .bytes()
                            .enumerate()
                            .all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit())
                        && chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").is_ok()
                })
                && pack
                    .frontmatter
                    .get("evaluation_result")
                    .is_some_and(|value| value == "fired")
                && table.gate.scope == pack.frontmatter.get("scope").cloned())
    }
    #[test]
    fn the_gmail_pack_parses_and_names_its_gate() {
        let table = table();
        let bytes = fs::read_to_string(root().join(&table.gate.pack)).unwrap();
        let pack = parse_pack(&bytes).unwrap();
        assert_eq!(
            pack.frontmatter["gate"],
            format!("{}:connector:{}", table.gate.registry, table.gate.connector)
        );
        assert_eq!(
            pack.frontmatter["kinds"]
                .split(',')
                .map(str::trim)
                .collect::<Vec<_>>(),
            table.gate.kinds
        );
        assert!(accepted(table, &bytes, &registry::load().unwrap()));
    }
    #[test]
    fn the_gate_opens_only_after_the_pack_is_accepted() {
        let mut table = table().clone();
        let bytes = fs::read_to_string(root().join(&table.gate.pack)).unwrap();
        table.gate.open = true;
        table.gate.scope = Some("vault_store:one:two".into());
        assert!(!accepted(&table, &bytes, &registry::load().unwrap()));
        let mut raw: Value = serde_json::from_str(include_str!(
            "../../../shared/policy/trigger-registry.v1.json"
        ))
        .unwrap();
        raw["entries"][13]["subcapability_pattern"]["registered_connectors"] =
            serde_json::json!(["gmail"]);
        let registry = registry::parse_str(&raw.to_string()).unwrap();
        let accepted_pack = bytes
            .replace("vault_store:<set at acceptance>", "vault_store:one:two")
            .replace(
                "decided_at: pending",
                "decided_at: 2026-10-15\nevaluation_result: fired",
            );
        assert!(accepted(&table, &accepted_pack, &registry));
        assert!(!accepted(
            &table,
            &accepted_pack.replace("vault_store:one:two", "vault_store:else:two"),
            &registry
        ));
        assert!(!accepted(
            &table,
            &accepted_pack.replace("fired", "not_fired"),
            &registry
        ));
        assert!(!accepted(
            &table,
            &accepted_pack.replace("decided_at: 2026-10-15", "decided_at: pending"),
            &registry
        ));
    }
    #[test]
    #[ignore = "deliberate mail artifact edit: writes the committed digest"]
    fn write_mail_digest() {
        fs::write(
            root().join(DIGEST_PATH),
            format!("{:x}\n", Sha256::digest(JSON.as_bytes())),
        )
        .unwrap();
    }
}
