//! `shared/policy/subagents.v1.json` — how far Claude Code's subagents may go
//! in a run (M91.1, M91.2a).
//!
//! The artifact names the Claude Code it was measured on and the environment
//! every run but Cerebro's own constructs is spawned with
//! (`agent::cli_command`): subagents run in the foreground, one level deep, two
//! at once and eight a session, and Claude Code's built-in agent types are
//! switched off (M91.2a). Since M91.2a it also names what only a seated run
//! adds (`seated_env`: the todo list, and never the shared task list), the
//! agent types Cerebro defines itself (`presets`: each one's sentence, the
//! reading toolsets it holds and the web tools it holds where its run does),
//! and the settings that harden every run's Claude Code (`settings`: no
//! bypass mode, no auto mode). The subagent tool itself is the tool-approval
//! table's `delegate` family, and the agent types a run holding it may start
//! are that table's `agent_types`; this file only bounds and defines what such
//! a run starts. `src/lib/policy/subagents.ts` reads the same bytes, refusal
//! for refusal, and both hash them against `subagents.v1.sha256`. There is no
//! runtime digest check (the policy.v3 precedent): the compiled bytes are
//! tested against the committed digest and the file on disk.

use std::sync::OnceLock;

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use crate::policy::tool_approval::{is_agent_type, WEB_AXIS};
use crate::policy::tools::{CliTool, Kind, ToolsManifest};

/// The artifact, bound at compile time.
pub const SUBAGENTS_JSON: &str = include_str!("../../../shared/policy/subagents.v1.json");

/// Repo-relative location, for refusals and the tests that read the file.
pub const SUBAGENTS_PATH: &str = "shared/policy/subagents.v1.json";

/// The committed SHA-256 of the artifact's bytes (`write_subagents_digest`).
pub const SUBAGENTS_DIGEST_PATH: &str = "shared/policy/subagents.v1.sha256";

/// The format this build reads.
pub const FORMAT: u64 = 1;

/// The longest value a variable may hold.
const VALUE_CHARS: usize = 64;

/// The longest sentence a preset describes itself with, in characters.
pub const DESCRIPTION_CHARS: usize = 300;

/// The one value each hardening setting takes: Claude Code's schema offers
/// no other.
const DISABLE: &str = "disable";

/// What every run but an internal one hands Claude Code.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Subagents {
    pub format: u64,
    /// The Claude Code these variables were measured on, `N.N.N`.
    pub cli_version: String,
    /// Variable to value, in ASCII order of the names. Each name is one of
    /// Claude Code's own (`CLAUDE_` and capitals), so the artifact cannot set
    /// a variable that steers anything else the CLI starts.
    pub env: IndexMap<String, String>,
    /// What a seated run adds to `env` (M91.2a), by the same rules, and none
    /// of `env`'s names: the todo list where a person watches it, never the
    /// task list other sessions share.
    pub seated_env: IndexMap<String, String>,
    /// The agent types Cerebro defines (M91.2a), in the order argv names
    /// them. The tool-approval table's `agent_types.allowed` names the same
    /// types.
    pub presets: Vec<Preset>,
    /// What every run's settings file hardens Claude Code with (M91.2a),
    /// spelled as Claude Code's settings schema spells it.
    pub settings: Settings,
}

/// One agent type Cerebro defines (M91.2a). It gathers and never acts: it
/// holds reading toolsets only, and the web only where its run holds it.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Preset {
    /// The type's name, as argv and an init carry it (`is_agent_type`).
    pub name: String,
    /// The one sentence the main model reads when it picks a type. It names
    /// no tool and no retired term.
    pub description: String,
    /// The manifest's toolsets it holds, each one of read_only rows on
    /// non-writing doors.
    pub toolsets: Vec<String>,
    /// The CLI's own tools it holds where its run holds them, by their rows'
    /// names: each one a tool the web ceiling holds, so none of them writes
    /// or runs anything.
    pub web_when_held: Vec<String>,
}

/// The hardening every run's settings file carries (M91.2a): Claude Code
/// may enter neither bypass mode nor auto mode, whatever the person's own
/// settings say.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    pub permissions: SettingsPermissions,
    #[serde(rename = "disableAutoMode")]
    pub disable_auto_mode: String,
}

/// The settings file's `permissions` (M91.2a).
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SettingsPermissions {
    #[serde(rename = "disableBypassPermissionsMode")]
    pub disable_bypass_permissions_mode: String,
}

fn refusal(subject: &str, field: &str, problem: impl std::fmt::Display) -> String {
    format!("{SUBAGENTS_PATH}: {subject}: `{field}` {problem}")
}

/// `CLAUDE_`, then capitals, digits and underscores.
fn is_claude_variable(name: &str) -> bool {
    name.strip_prefix("CLAUDE_").is_some_and(|rest| {
        !rest.is_empty()
            && rest
                .bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
    })
}

/// 1 to VALUE_CHARS letters, digits, dots, dashes and underscores.
fn is_plain_value(value: &str) -> bool {
    (1..=VALUE_CHARS).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
}

/// One sentence on one line: a capital letter first, a full stop last, at
/// most DESCRIPTION_CHARS characters, and no control character or line
/// separator anywhere.
fn is_sentence(text: &str) -> bool {
    (1..=DESCRIPTION_CHARS).contains(&text.chars().count())
        && text.starts_with(|c: char| c.is_ascii_uppercase())
        && text.ends_with('.')
        && !text
            .chars()
            .any(|c| c.is_control() || matches!(c, '\u{2028}' | '\u{2029}'))
}

/// `N.N.N`, each part digits.
fn is_version(text: &str) -> bool {
    let parts: Vec<&str> = text.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
}

/// The variables of `field` (`env` or `seated_env`): Claude Code's own names
/// in ASCII order with plain values, and none that `outer` already sets.
fn check_variables(
    field: &str,
    variables: &IndexMap<String, String>,
    outer: Option<&IndexMap<String, String>>,
) -> Result<(), String> {
    let mut previous: Option<&str> = None;
    for (name, value) in variables {
        let subject = format!("{field} {name}");
        if !is_claude_variable(name) {
            return Err(refusal(
                &subject,
                field,
                "must name a Claude Code variable: CLAUDE_, then capitals, digits and underscores",
            ));
        }
        if previous.is_some_and(|earlier| earlier >= name.as_str()) {
            return Err(refusal(&subject, field, "must follow ASCII order"));
        }
        if !is_plain_value(value) {
            return Err(refusal(
                &subject,
                field,
                format!("must be 1 to {VALUE_CHARS} letters, digits, dots, dashes or underscores"),
            ));
        }
        if outer.is_some_and(|outer| outer.contains_key(name)) {
            return Err(refusal(
                &subject,
                field,
                "must not name a variable env already sets",
            ));
        }
        previous = Some(name);
    }
    Ok(())
}

/// Is `tool` one the tool-approval table reads by the web ceiling (M57.7)?
/// No other CLI tool may ride with a preset: the shell and the subagent
/// tool write nothing a manifest row records, yet act.
fn held_by_the_web_switch(tool: &CliTool) -> bool {
    tool.family
        .as_deref()
        .and_then(|id| crate::policy::tool_approval::table().family(id))
        .is_some_and(|family| family.ceiling == WEB_AXIS)
}

/// Does every row of `toolset` read, on a door that writes nothing? The
/// generated proposals' toolset never does: its tools propose changes.
fn reads_only(manifest: &ToolsManifest, toolset: &str) -> bool {
    let mut rows = manifest
        .tools
        .iter()
        .filter(|row| row.toolset.as_deref() == Some(toolset))
        .peekable();
    rows.peek().is_some()
        && toolset != manifest.generated.toolset
        && rows.all(|row| {
            row.kind == Kind::ReadOnly && manifest.door(&row.door).is_some_and(|door| !door.writes)
        })
}

impl Subagents {
    /// Refuse an artifact whose facts disagree, naming the field. `manifest`
    /// is the tool manifest a preset's toolsets and tools must come from.
    pub fn validate(&self, manifest: &ToolsManifest) -> Result<(), String> {
        if self.format != FORMAT {
            return Err(refusal("table", "format", format!("must be {FORMAT}")));
        }
        if !is_version(&self.cli_version) {
            return Err(refusal("table", "cli_version", "must be N.N.N"));
        }
        check_variables("env", &self.env, None)?;
        check_variables("seated_env", &self.seated_env, Some(&self.env))?;
        for (at, preset) in self.presets.iter().enumerate() {
            self.check_preset(at, preset, manifest)?;
        }
        for (field, value) in [
            (
                "permissions.disableBypassPermissionsMode",
                &self.settings.permissions.disable_bypass_permissions_mode,
            ),
            ("disableAutoMode", &self.settings.disable_auto_mode),
        ] {
            if value != DISABLE {
                return Err(refusal("settings", field, format!("must be {DISABLE}")));
            }
        }
        Ok(())
    }

    /// One preset (M91.2a): a name argv carries whole, once; one sentence;
    /// reading toolsets the manifest declares, each once; and CLI tools the
    /// manifest has rows for, each once, each one the web ceiling holds.
    fn check_preset(
        &self,
        at: usize,
        preset: &Preset,
        manifest: &ToolsManifest,
    ) -> Result<(), String> {
        let subject = format!("preset {:?}", preset.name);
        let subject = subject.as_str();
        if !is_agent_type(&preset.name) {
            return Err(refusal(
                subject,
                "name",
                "must be one or more letters, digits, colons, dots, dashes or underscores",
            ));
        }
        if self.presets[..at]
            .iter()
            .any(|earlier| earlier.name == preset.name)
        {
            return Err(refusal(subject, "name", "is named twice"));
        }
        if !is_sentence(&preset.description) {
            return Err(refusal(
                subject,
                "description",
                format!(
                    "must be one sentence on one line: a capital letter first, a full stop last, \
                     at most {DESCRIPTION_CHARS} characters"
                ),
            ));
        }
        if preset.toolsets.is_empty() {
            return Err(refusal(
                subject,
                "toolsets",
                "must name at least one toolset",
            ));
        }
        for (at, id) in preset.toolsets.iter().enumerate() {
            let problem = if !manifest.toolsets.iter().any(|set| set.id == *id) {
                format!("names no declared toolset: {id:?}")
            } else if preset.toolsets[..at].contains(id) {
                format!("repeats toolset {id:?}")
            } else if !reads_only(manifest, id) {
                format!("must name toolsets of read_only rows on non-writing doors, not {id:?}")
            } else {
                continue;
            };
            return Err(refusal(subject, "toolsets", problem));
        }
        for (at, name) in preset.web_when_held.iter().enumerate() {
            let problem = match manifest.cli_tools.iter().find(|tool| tool.name == *name) {
                None => format!("names no CLI tool in the manifest: {name:?}"),
                Some(_) if preset.web_when_held[..at].contains(name) => {
                    format!("repeats {name:?}")
                }
                Some(tool) if !held_by_the_web_switch(tool) => {
                    format!("names a CLI tool the web switch does not hold: {name:?}")
                }
                Some(_) => continue,
            };
            return Err(refusal(subject, "web_when_held", problem));
        }
        Ok(())
    }
}

/// Parse and fully validate an artifact against `manifest`.
pub fn parse(raw: &str, manifest: &ToolsManifest) -> Result<Subagents, String> {
    let table: Subagents =
        serde_json::from_str(raw).map_err(|e| format!("{SUBAGENTS_PATH}: {e}"))?;
    table.validate(manifest)?;
    Ok(table)
}

/// The compiled-in artifact. `the_shipped_artifact_validates` loads the same
/// bytes, so a failure here is a build nobody tested.
pub fn table() -> &'static Subagents {
    static LOADED: OnceLock<Subagents> = OnceLock::new();
    LOADED.get_or_init(|| {
        parse(SUBAGENTS_JSON, crate::policy::tools::manifest())
            .expect("the compiled subagent bounds validate")
    })
}

/// The variables a run's Claude Code is started with, in the artifact's
/// order.
pub fn env() -> impl Iterator<Item = (&'static str, &'static str)> {
    table()
        .env
        .iter()
        .map(|(name, value)| (name.as_str(), value.as_str()))
}

/// The variables a seated run adds to `env` (M91.2a), in the artifact's
/// order.
pub fn seated_env() -> impl Iterator<Item = (&'static str, &'static str)> {
    table()
        .seated_env
        .iter()
        .map(|(name, value)| (name.as_str(), value.as_str()))
}

/// The agent types Cerebro defines (M91.2a), in the artifact's order.
pub fn presets() -> &'static [Preset] {
    &table().presets
}

/// The hardening a run's settings file carries (M91.2a), as the object
/// Claude Code reads.
pub fn settings() -> serde_json::Value {
    serde_json::to_value(&table().settings).expect("the hardening settings serialize")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::policy::tools::manifest;
    use serde_json::{json, Value};

    fn repo(rel: &str) -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join(rel)
    }

    #[test]
    fn the_loaded_bytes_match_the_committed_digest() {
        let committed = std::fs::read_to_string(repo(SUBAGENTS_DIGEST_PATH))
            .expect("read the committed subagents digest")
            .trim()
            .to_string();
        assert_eq!(
            crate::ledger::sha256_hex(SUBAGENTS_JSON.as_bytes()),
            committed,
            "the artifact changed without regenerating {SUBAGENTS_DIGEST_PATH} — run \
             `cargo test --lib policy::subagents::tests::write_subagents_digest -- --ignored`"
        );
    }

    /// Re-stamp the digest after a deliberate edit.
    #[test]
    #[ignore = "run explicitly after a deliberate subagents edit"]
    fn write_subagents_digest() {
        let digest = crate::ledger::sha256_hex(SUBAGENTS_JSON.as_bytes());
        std::fs::write(repo(SUBAGENTS_DIGEST_PATH), format!("{digest}\n")).unwrap();
    }

    #[test]
    fn the_compiled_artifact_is_the_file_on_disk() {
        let disk = std::fs::read_to_string(repo(SUBAGENTS_PATH)).unwrap();
        assert_eq!(disk, SUBAGENTS_JSON);
    }

    #[test]
    fn the_shipped_artifact_validates() {
        parse(SUBAGENTS_JSON, manifest()).unwrap();
        assert_eq!(table().format, FORMAT);
    }

    // M91.1: foreground only, one level deep, two at once, eight a session;
    // M91.2a: and none of Claude Code's built-in agent types.
    #[test]
    fn the_env_holds_the_measured_bounds() {
        assert_eq!(
            env().collect::<Vec<_>>(),
            [
                ("CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS", "1"),
                ("CLAUDE_CODE_DISABLE_BACKGROUND_TASKS", "1"),
                ("CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS", "2"),
                ("CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION", "8"),
                ("CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH", "1"),
            ]
        );
    }

    // M91.2a: a seated run keeps a todo list, and never the task list other
    // sessions share (measured: TodoWrite appears, TaskCreate and its kin
    // stay away).
    #[test]
    fn a_seated_run_adds_the_todo_list_alone() {
        assert_eq!(
            seated_env().collect::<Vec<_>>(),
            [
                ("CLAUDE_CODE_ENABLE_TASKS", "0"),
                ("CLAUDE_CODE_ENABLE_TODO_TOOLS", "1"),
            ]
        );
        for (name, _) in seated_env() {
            assert!(!table().env.contains_key(name), "{name}");
        }
    }

    // M91.2a: no bypass mode and no auto mode, in the object Claude Code's
    // settings file holds, spelled as its schema spells them.
    #[test]
    fn the_settings_harden_every_run() {
        assert_eq!(
            settings(),
            json!({
                "permissions": { "disableBypassPermissionsMode": "disable" },
                "disableAutoMode": "disable",
            })
        );
        let raw: Value = serde_json::from_str(SUBAGENTS_JSON).unwrap();
        assert_eq!(settings(), raw["settings"], "the artifact's own spelling");
    }

    // M91.2a: one preset, which reads the vault, and the web where its run
    // holds it, and changes nothing.
    #[test]
    fn the_researcher_reads_and_changes_nothing() {
        let [researcher] = presets() else {
            panic!("one preset: {:?}", presets());
        };
        assert_eq!(researcher.name, "cerebro-researcher");
        assert_eq!(researcher.toolsets, ["read"]);
        assert_eq!(researcher.web_when_held, ["WebSearch", "WebFetch"]);
        for name in &researcher.web_when_held {
            let tool = crate::policy::tools::cli_tool(name).expect("a CLI row");
            assert_eq!(&tool.name, name, "named by its row");
            assert!(!tool.writes, "{name}");
            assert!(held_by_the_web_switch(tool), "{name}");
        }
        for row in manifest()
            .tools
            .iter()
            .filter(|row| row.toolset.as_deref() == Some("read"))
        {
            assert_eq!(row.kind, Kind::ReadOnly, "{}", row.name);
            assert!(!row.confirmable, "{}", row.name);
        }
    }

    // M91.2a: the presets are exactly the agent types the tool-approval
    // table lets a run start, and none is one of Claude Code's own.
    #[test]
    fn the_presets_are_the_agent_types_a_run_may_start() {
        let names: Vec<&str> = presets().iter().map(|p| p.name.as_str()).collect();
        let types = &crate::policy::tool_approval::table().agent_types;
        assert_eq!(names, types.allowed);
        for name in names {
            assert!(!types.builtin.iter().any(|b| b == name), "{name}");
        }
    }

    /// Does `text` name `word` with no letter, digit or underscore on either
    /// side?
    fn names_word(text: &str, word: &str) -> bool {
        let edge = |c: Option<char>| !c.is_some_and(|c| c.is_alphanumeric() || c == '_');
        text.match_indices(word).any(|(at, _)| {
            edge(text[..at].chars().next_back()) && edge(text[at + word.len()..].chars().next())
        })
    }

    // CV-19/CV-20: the main model reads every preset's sentence whatever its
    // run holds, so it names no tool, Cerebro's or Claude Code's, under any
    // spelling, and no retired term.
    #[test]
    fn a_preset_names_no_tool_and_no_retired_term() {
        let manifest = manifest();
        let mut tools: Vec<String> = Vec::new();
        for row in &manifest.tools {
            tools.push(row.name.clone());
        }
        for tool in &manifest.cli_tools {
            tools.push(tool.name.clone());
            tools.extend(tool.aliases.iter().cloned());
        }
        assert!(names_word("then call `get_note`.", "get_note"));
        assert!(!names_word("get_notes", "get_note"));
        let retired: Value =
            serde_json::from_str(include_str!("../../../shared/prompt/retired-terms.json"))
                .expect("retired-terms.json parses");
        let terms: Vec<String> = retired["terms"]
            .as_array()
            .expect("a list of terms")
            .iter()
            .map(|term| term.as_str().unwrap().to_lowercase())
            .collect();
        assert!(!terms.is_empty());
        for preset in presets() {
            for tool in &tools {
                assert!(
                    !names_word(&preset.description, tool),
                    "{} names {tool}",
                    preset.name
                );
            }
            let lower = preset.description.to_lowercase();
            for term in &terms {
                assert!(
                    !lower.contains(term.as_str()),
                    "{} says {term}",
                    preset.name
                );
            }
        }
    }

    #[test]
    fn it_names_the_claude_code_the_tool_table_pins() {
        assert_eq!(
            table().cli_version,
            crate::policy::tool_approval::table().cli_version
        );
    }

    /// An edit of the shipped artifact a case refuses.
    type Mutation = Box<dyn FnOnce(&mut Value)>;

    fn refused(mutate: impl FnOnce(&mut Value)) -> String {
        let mut raw: Value = serde_json::from_str(SUBAGENTS_JSON).unwrap();
        mutate(&mut raw);
        parse(&raw.to_string(), manifest()).expect_err("the mutated artifact must not load")
    }

    /// The refusals, one negative control each, in the words
    /// `src/lib/policy/subagents.test.ts` expects too.
    #[test]
    fn every_refusal_names_the_field() {
        let path = SUBAGENTS_PATH;
        let not_claude = "must name a Claude Code variable: CLAUDE_, then capitals, digits and \
                          underscores";
        let not_plain = "must be 1 to 64 letters, digits, dots, dashes or underscores";
        let not_a_sentence = "must be one sentence on one line: a capital letter first, a full \
                              stop last, at most 300 characters";
        let preset = "preset \"cerebro-researcher\"";
        let cases: Vec<(Mutation, String)> = vec![
            (
                Box::new(|v| v["format"] = json!(2)),
                format!("{path}: table: `format` must be 1"),
            ),
            (
                Box::new(|v| v["cli_version"] = json!("2.1")),
                format!("{path}: table: `cli_version` must be N.N.N"),
            ),
            (
                Box::new(|v| v["env"]["PATH"] = json!("/tmp")),
                format!("{path}: env PATH: `env` {not_claude}"),
            ),
            (
                Box::new(|v| v["env"]["CLAUDE_code"] = json!("1")),
                format!("{path}: env CLAUDE_code: `env` {not_claude}"),
            ),
            (
                Box::new(|v| v["env"]["CLAUDE_"] = json!("1")),
                format!("{path}: env CLAUDE_: `env` {not_claude}"),
            ),
            (
                Box::new(|v| v["env"]["CLAUDE_A_FIRST"] = json!("1")),
                format!("{path}: env CLAUDE_A_FIRST: `env` must follow ASCII order"),
            ),
            (
                Box::new(|v| v["env"]["CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH"] = json!("1; rm")),
                format!("{path}: env CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: `env` {not_plain}"),
            ),
            (
                Box::new(|v| v["env"]["CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH"] = json!("")),
                format!("{path}: env CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: `env` {not_plain}"),
            ),
            // M91.2a: a seated run's variables, by the same rules, and none
            // that env sets already.
            (
                Box::new(|v| v["seated_env"]["HOME"] = json!("/tmp")),
                format!("{path}: seated_env HOME: `seated_env` {not_claude}"),
            ),
            (
                Box::new(|v| v["seated_env"]["CLAUDE_A_FIRST"] = json!("1")),
                format!("{path}: seated_env CLAUDE_A_FIRST: `seated_env` must follow ASCII order"),
            ),
            (
                Box::new(|v| v["seated_env"]["CLAUDE_CODE_ENABLE_TODO_TOOLS"] = json!("1 2")),
                format!(
                    "{path}: seated_env CLAUDE_CODE_ENABLE_TODO_TOOLS: `seated_env` {not_plain}"
                ),
            ),
            (
                Box::new(|v| v["seated_env"]["CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH"] = json!("3")),
                format!(
                    "{path}: seated_env CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: `seated_env` must \
                     not name a variable env already sets"
                ),
            ),
            // M91.2a: a preset's name, sentence, toolsets and web tools.
            (
                Box::new(|v| v["presets"][0]["name"] = json!("cerebro researcher")),
                format!(
                    "{path}: preset \"cerebro researcher\": `name` must be one or more letters, \
                     digits, colons, dots, dashes or underscores"
                ),
            ),
            (
                Box::new(|v| v["presets"][0]["name"] = json!("")),
                format!(
                    "{path}: preset \"\": `name` must be one or more letters, digits, colons, \
                     dots, dashes or underscores"
                ),
            ),
            (
                Box::new(|v| {
                    let copy = v["presets"][0].clone();
                    v["presets"].as_array_mut().unwrap().push(copy);
                }),
                format!("{path}: {preset}: `name` is named twice"),
            ),
            (
                Box::new(|v| v["presets"][0]["description"] = json!("")),
                format!("{path}: {preset}: `description` {not_a_sentence}"),
            ),
            (
                Box::new(|v| v["presets"][0]["description"] = json!("reads the vault.")),
                format!("{path}: {preset}: `description` {not_a_sentence}"),
            ),
            (
                Box::new(|v| v["presets"][0]["description"] = json!("Reads the vault")),
                format!("{path}: {preset}: `description` {not_a_sentence}"),
            ),
            (
                Box::new(|v| v["presets"][0]["description"] = json!("Reads.\nThen writes.")),
                format!("{path}: {preset}: `description` {not_a_sentence}"),
            ),
            (
                Box::new(|v| {
                    v["presets"][0]["description"] = json!(format!("R{}.", "e".repeat(299)))
                }),
                format!("{path}: {preset}: `description` {not_a_sentence}"),
            ),
            (
                Box::new(|v| v["presets"][0]["toolsets"] = json!([])),
                format!("{path}: {preset}: `toolsets` must name at least one toolset"),
            ),
            (
                Box::new(|v| v["presets"][0]["toolsets"] = json!(["search"])),
                format!("{path}: {preset}: `toolsets` names no declared toolset: \"search\""),
            ),
            (
                Box::new(|v| v["presets"][0]["toolsets"] = json!(["read", "read"])),
                format!("{path}: {preset}: `toolsets` repeats toolset \"read\""),
            ),
            (
                Box::new(|v| v["presets"][0]["toolsets"] = json!(["read", "write"])),
                format!(
                    "{path}: {preset}: `toolsets` must name toolsets of read_only rows on \
                     non-writing doors, not \"write\""
                ),
            ),
            (
                Box::new(|v| v["presets"][0]["toolsets"] = json!(["propose"])),
                format!(
                    "{path}: {preset}: `toolsets` must name toolsets of read_only rows on \
                     non-writing doors, not \"propose\""
                ),
            ),
            (
                Box::new(|v| v["presets"][0]["toolsets"] = json!(["proposals"])),
                format!(
                    "{path}: {preset}: `toolsets` must name toolsets of read_only rows on \
                     non-writing doors, not \"proposals\""
                ),
            ),
            (
                Box::new(|v| v["presets"][0]["web_when_held"] = json!(["WebBrowse"])),
                format!(
                    "{path}: {preset}: `web_when_held` names no CLI tool in the manifest: \
                     \"WebBrowse\""
                ),
            ),
            (
                Box::new(|v| v["presets"][0]["web_when_held"] = json!(["Task"])),
                format!(
                    "{path}: {preset}: `web_when_held` names no CLI tool in the manifest: \"Task\""
                ),
            ),
            (
                Box::new(|v| v["presets"][0]["web_when_held"] = json!(["WebFetch", "WebFetch"])),
                format!("{path}: {preset}: `web_when_held` repeats \"WebFetch\""),
            ),
            (
                Box::new(|v| v["presets"][0]["web_when_held"] = json!(["WebFetch", "Write"])),
                format!(
                    "{path}: {preset}: `web_when_held` names a CLI tool the web switch does not \
                     hold: \"Write\""
                ),
            ),
            // A tool that records no write may still act: the shell, the
            // subagent tool and the cross-session messenger never ride along.
            (
                Box::new(|v| v["presets"][0]["web_when_held"] = json!(["Bash"])),
                format!(
                    "{path}: {preset}: `web_when_held` names a CLI tool the web switch does not \
                     hold: \"Bash\""
                ),
            ),
            (
                Box::new(|v| v["presets"][0]["web_when_held"] = json!(["Agent"])),
                format!(
                    "{path}: {preset}: `web_when_held` names a CLI tool the web switch does not \
                     hold: \"Agent\""
                ),
            ),
            (
                Box::new(|v| v["presets"][0]["web_when_held"] = json!(["SendMessage"])),
                format!(
                    "{path}: {preset}: `web_when_held` names a CLI tool the web switch does not \
                     hold: \"SendMessage\""
                ),
            ),
            // M91.2a: each hardening setting takes the one value Claude
            // Code's schema offers.
            (
                Box::new(|v| v["settings"]["disableAutoMode"] = json!("enable")),
                format!("{path}: settings: `disableAutoMode` must be disable"),
            ),
            (
                Box::new(|v| {
                    v["settings"]["permissions"]["disableBypassPermissionsMode"] = json!("allow")
                }),
                format!(
                    "{path}: settings: `permissions.disableBypassPermissionsMode` must be disable"
                ),
            ),
        ];
        for (mutate, expected) in cases {
            assert_eq!(refused(mutate), expected);
        }
        // serde's half: an unknown or missing field, and a value of the wrong
        // type, fail the parse.
        let shapes: Vec<(Mutation, &str)> = vec![
            (
                Box::new(|v| v["agents"] = json!([])),
                "unknown field `agents`",
            ),
            (
                Box::new(|v| {
                    v.as_object_mut().unwrap().remove("env");
                }),
                "missing field `env`",
            ),
            (
                Box::new(|v| {
                    v.as_object_mut().unwrap().remove("seated_env");
                }),
                "missing field `seated_env`",
            ),
            (
                Box::new(|v| {
                    v.as_object_mut().unwrap().remove("presets");
                }),
                "missing field `presets`",
            ),
            (
                Box::new(|v| {
                    v.as_object_mut().unwrap().remove("settings");
                }),
                "missing field `settings`",
            ),
            (
                Box::new(|v| v["env"]["CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS"] = json!(2)),
                "invalid type",
            ),
            (
                Box::new(|v| v["seated_env"]["CLAUDE_CODE_ENABLE_TASKS"] = json!(false)),
                "invalid type",
            ),
            (
                Box::new(|v| v["presets"][0]["model"] = json!("haiku")),
                "unknown field `model`",
            ),
            (
                Box::new(|v| {
                    v["presets"][0]
                        .as_object_mut()
                        .unwrap()
                        .remove("web_when_held");
                }),
                "missing field `web_when_held`",
            ),
            (
                Box::new(|v| v["presets"][0]["toolsets"] = json!("read")),
                "invalid type",
            ),
            (
                Box::new(|v| v["settings"]["permissions"]["allow"] = json!(["Bash"])),
                "unknown field `allow`",
            ),
            (
                Box::new(|v| v["settings"]["env"] = json!({})),
                "unknown field `env`",
            ),
            (
                Box::new(|v| {
                    v["settings"]
                        .as_object_mut()
                        .unwrap()
                        .remove("disableAutoMode");
                }),
                "missing field `disableAutoMode`",
            ),
            (
                Box::new(|v| v["settings"]["disableAutoMode"] = json!(true)),
                "invalid type",
            ),
        ];
        for (mutate, fragment) in shapes {
            let err = refused(mutate);
            assert!(err.contains(fragment), "{fragment:?} missing from: {err}");
        }
        // No variable and no preset at all loads: the bounds and the types
        // are the artifact's to name.
        let mut raw: Value = serde_json::from_str(SUBAGENTS_JSON).unwrap();
        raw["env"] = json!({});
        raw["seated_env"] = json!({});
        raw["presets"] = json!([]);
        let none = parse(&raw.to_string(), manifest()).unwrap();
        assert!(none.env.is_empty() && none.seated_env.is_empty() && none.presets.is_empty());
        // A sentence of exactly the most characters, a multi-byte one
        // included, loads.
        let mut raw: Value = serde_json::from_str(SUBAGENTS_JSON).unwrap();
        raw["presets"][0]["description"] =
            json!(format!("R{}.", "é".repeat(DESCRIPTION_CHARS - 2)));
        parse(&raw.to_string(), manifest()).unwrap();
    }
}
