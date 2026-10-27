//! The agent types one run's Claude Code may start (M91.2b).
//!
//! A run that holds Claude Code's subagent tool (the tool-approval table's
//! delegate ceiling, only on a run whose gate a person answers) may start
//! only Cerebro's own types, `subagents.v1.json`'s presets. Each is defined
//! in the run's `--agents` with the reading tools of the run's own grant it
//! names, the web where the run's plan allows it, and nothing else: no
//! permission mode, servers, hooks, skills, memory or isolation of its own,
//! and never in the background. Every other type Claude Code could start is
//! denied by name in `--disallowedTools`, as `Agent(<type>)`:
//!
//! - its built-in ones, the table's `agent_types.builtin`, which
//!   `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS` switches off already;
//! - a preset left undefined because it would hold no tool, so a definition
//!   of the person's by that name cannot stand in for it;
//! - the person's own, which `--setting-sources user` still loads
//!   (`person_agents`): every definition under `<config>/agents/`, and every
//!   installed plugin's, named as Claude Code 2.1.250 names them.
//!
//! The enumeration fails closed. A definition, a folder or a list Cerebro
//! cannot read, a name an `Agent(<type>)` rule cannot carry, a symlink in the
//! person's folder that leads outside it, or more definitions than it reads,
//! withdraws the subagent tool from the run (`Withdrawn`), and so does a run
//! whose presets would all hold no tool. Cerebro reads only those files, and
//! of each only its frontmatter's name; nothing it reads is logged.
//!
//! What the enumeration cannot see (an organization's managed agents, a
//! definition added while the run is under way) has two more lines: the init
//! gate stops a run whose init lists a type neither list names
//! (`agent::InitGate`), and a seated run's gate denies a call for any type
//! the run may not start (`agent::interaction`).
//!
//! Every subagent of such a run also hears what its main thread hears about
//! the app (`subagent_brief`): the product brief, the server instructions and
//! the subagent line, composed here from `shared/prompt/` and copied nowhere.

use std::collections::BTreeSet;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};
use unicode_normalization::UnicodeNormalization;

use crate::policy::subagents::Preset;
use crate::policy::tool_approval::{is_agent_type, Decision, RunApproval, DELEGATE_AXIS};
use crate::policy::tools::CliTool;

const PRODUCT_BRIEF: &str = include_str!("../../../shared/prompt/product-brief.md");
const SERVER_INSTRUCTIONS: &str = include_str!("../../../shared/prompt/server-instructions.md");
const SUBAGENT_LINE: &str = include_str!("../../../shared/prompt/subagent-line.md");

/// Each preset's standing prompt, by the preset's name. `subagents.v1.json`
/// names the types and holds no prose; `every_preset_has_its_prompt` holds
/// this table to its presets, so a preset without a prompt is never defined.
const PRESET_PROMPTS: [(&str, &str); 1] = [(
    "cerebro-researcher",
    include_str!("../../../shared/prompt/subagents/researcher.md"),
)];

/// How many folders below a scan root, and how many folders and definitions
/// across one run's scopes, the enumeration reads before it gives up and
/// withdraws the tool. Claude Code scans a plugin to the same depth.
const MAX_DEPTH: usize = 32;
const MAX_DIRS: usize = 4096;
const MAX_DEFINITIONS: usize = 4096;

/// The most of one definition, manifest or plugin list the enumeration
/// reads, in bytes: Claude Code's own cap on a plugin agent's file. A larger
/// one is unreadable.
const MAX_BYTES: u64 = 1024 * 1024;

/// The person's own definitions, under the config home.
const USER_AGENTS: &str = "agents";
/// The installed plugins' list, under the config home.
const INSTALLED_PLUGINS: [&str; 2] = ["plugins", "installed_plugins.json"];
/// A plugin's manifest, under its install path.
const PLUGIN_MANIFEST: [&str; 2] = [".claude-plugin", "plugin.json"];
/// A plugin's default agents folder, under its install path.
const PLUGIN_AGENTS: &str = "agents";

/// The subagent prose every subagent of a run that holds the tool hears
/// (`--append-subagent-system-prompt`): the product brief, the server
/// instructions and the subagent line, each trimmed, a blank line apart.
pub(crate) fn subagent_brief() -> String {
    [PRODUCT_BRIEF, SERVER_INSTRUCTIONS, SUBAGENT_LINE]
        .map(str::trim)
        .join("\n\n")
}

/// The standing prompt of the preset named `name`, trimmed.
pub(crate) fn preset_prompt(name: &str) -> Option<&'static str> {
    PRESET_PROMPTS
        .iter()
        .find(|(preset, _)| *preset == name)
        .map(|(_, prompt)| prompt.trim())
}

/// Is `family` one the delegate ceiling reads, the subagent tool's?
fn reads_delegate(family: &str) -> bool {
    crate::policy::tool_approval::table()
        .family(family)
        .is_some_and(|family| family.ceiling == DELEGATE_AXIS)
}

/// The subagent tool: the CLI row whose family the delegate ceiling reads.
pub(crate) fn delegate_tool() -> Option<&'static CliTool> {
    crate::policy::tools::manifest()
        .cli_tools
        .iter()
        .find(|tool| tool.family.as_deref().is_some_and(reads_delegate))
}

/// An agent type as `--disallowedTools` spells its rule: `Agent(<type>)`,
/// the subagent tool's row around the type.
pub(crate) fn agent_type_rule(agent_type: &str) -> String {
    let tool = delegate_tool().map_or("", |tool| tool.name.as_str());
    format!("{tool}({agent_type})")
}

/// The CLI rows the delegate ceiling reads that `approval` holds: allowed,
/// asked for or left to the CLI. Empty on a run that holds no subagent tool.
pub(crate) fn delegate_rows(approval: &RunApproval) -> Vec<&'static CliTool> {
    approval
        .decisions
        .iter()
        .filter(|row| {
            matches!(
                row.decision,
                Decision::Allow | Decision::Ask | Decision::Cli
            )
        })
        .filter(|row| reads_delegate(&row.family))
        .filter_map(|row| crate::policy::tools::cli_tool(&row.tool))
        .collect()
}

/// A tool name a definition may hold: what Claude Code's grammar for one
/// tool allows, so no comma, space or parenthesis can split or widen it.
fn is_tool_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// What a run's argv carries of the agent types (M91.2b).
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct RunAgents {
    /// The types the run may start, Cerebro's own, each defined in
    /// `definitions`. Empty on a run that holds no subagent tool.
    pub(crate) allowed: Vec<String>,
    /// The types its argv denies by name, once each: Claude Code's built-in
    /// ones, any preset left undefined, then the person's own.
    pub(crate) denied: Vec<String>,
    /// `--agents`: each allowed type's definition, by its name.
    pub(crate) definitions: Map<String, Value>,
}

impl RunAgents {
    /// Does the run hold the subagent tool and a type to start with it?
    pub(crate) fn holds(&self) -> bool {
        !self.allowed.is_empty()
    }

    /// Every type the run's argv names, allowed or denied: what its init may
    /// list (`agent::InitGate`). None on a run that holds no subagent tool.
    pub(crate) fn known(&self) -> Option<Vec<String>> {
        self.holds()
            .then(|| self.allowed.iter().chain(&self.denied).cloned().collect())
    }

    /// `--disallowedTools`' rule for each denied type: `Agent(<type>)`.
    pub(crate) fn deny_rules(&self) -> Vec<String> {
        self.denied
            .iter()
            .map(|name| agent_type_rule(name))
            .collect()
    }

    /// `--agents`' value: the definitions as one JSON object.
    pub(crate) fn definitions_json(&self) -> String {
        Value::Object(self.definitions.clone()).to_string()
    }
}

/// Where the enumeration found what withdrew the tool.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Scope {
    /// The person's own folder, `<config>/agents/`.
    User,
    /// The installed plugins and their list.
    Plugins,
}

/// Why a run that would hold the subagent tool is planned without it. The
/// words name a kind of problem, never a path or a name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Withdrawn {
    /// No type Cerebro defines would hold a tool in this run.
    Untooled,
    /// A definition, a folder or a list could not be read, or a symlink in
    /// the person's folder leads outside it.
    Unreadable(Scope),
    /// A name an `Agent(<type>)` rule cannot carry.
    Unnameable(Scope),
    /// More folders or definitions than the enumeration reads.
    TooMany(Scope),
}

impl std::fmt::Display for Withdrawn {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let place = |scope: &Scope| match scope {
            Scope::User => "in the person's own Claude Code agents",
            Scope::Plugins => "in an installed Claude Code plugin",
        };
        match self {
            Withdrawn::Untooled => {
                f.write_str("no agent type Cerebro defines would hold a tool in this run")
            }
            Withdrawn::Unreadable(scope) => {
                write!(f, "an agent definition {} could not be read", place(scope))
            }
            Withdrawn::Unnameable(scope) => write!(
                f,
                "an agent's name {} holds a character a deny rule cannot carry",
                place(scope)
            ),
            Withdrawn::TooMany(scope) => write!(
                f,
                "there are more agent definitions {} than Cerebro reads",
                place(scope)
            ),
        }
    }
}

/// The agent types of a run planned as `approval`, whose grant (its
/// `--allowedTools` before the gate takes its asks out) is `granted`.
/// `person` names the person's own types, and is asked only when the run
/// holds the subagent tool. A run that holds none gets nothing. Err says the
/// run must be planned without the tool: no preset would hold a tool, or the
/// person's types could not be named.
pub(crate) fn for_run(
    approval: &RunApproval,
    granted: &[String],
    person: impl FnOnce() -> Result<Vec<String>, Withdrawn>,
) -> Result<RunAgents, Withdrawn> {
    if delegate_rows(approval).is_empty() {
        return Ok(RunAgents::default());
    }
    let mut agents = RunAgents::default();
    let mut undefined: Vec<String> = Vec::new();
    for name in &approval.allowed_agent_types {
        let preset = crate::policy::subagents::presets()
            .iter()
            .find(|preset| preset.name == *name);
        match preset.and_then(|preset| definition(preset, approval, granted)) {
            Some(defined) => {
                agents.allowed.push(name.clone());
                agents.definitions.insert(name.clone(), defined);
            }
            None => undefined.push(name.clone()),
        }
    }
    if agents.allowed.is_empty() {
        return Err(Withdrawn::Untooled);
    }
    let person = person()?;
    for name in approval
        .denied_agent_types
        .iter()
        .chain(&undefined)
        .chain(&person)
    {
        if agents.allowed.contains(name) || agents.denied.contains(name) {
            continue;
        }
        if !is_agent_type(name) {
            return Err(Withdrawn::Unnameable(Scope::User));
        }
        agents.denied.push(name.clone());
    }
    Ok(agents)
}

/// `preset`'s definition for one run, or None when it would hold no tool:
/// its toolsets' rows the run's grant holds, by the names the CLI calls
/// them, then the web tools it names that the run's plan allows and its
/// grant keeps. It never sets a permission mode, servers, hooks, skills,
/// memory or isolation, and never runs in the background.
fn definition(preset: &Preset, approval: &RunApproval, granted: &[String]) -> Option<Value> {
    let prompt = preset_prompt(&preset.name)?;
    let manifest = crate::policy::tools::manifest();
    let prefix = manifest.server_prefix();
    let mut tools: Vec<String> = manifest
        .tools
        .iter()
        .filter(|row| {
            row.toolset
                .as_ref()
                .is_some_and(|set| preset.toolsets.contains(set))
        })
        .map(|row| format!("{prefix}{}", row.name))
        .filter(|name| granted.contains(name))
        .collect();
    tools.extend(
        preset
            .web_when_held
            .iter()
            .filter(|name| {
                approval
                    .decision_of(name)
                    .is_some_and(|row| row.decision == Decision::Allow)
                    && granted.contains(name)
            })
            .cloned(),
    );
    if tools.is_empty() || !tools.iter().all(|name| is_tool_name(name)) {
        return None;
    }
    Some(json!({
        "description": preset.description,
        "prompt": prompt,
        "tools": tools,
        "background": false,
    }))
}

// ---------------------------------------------------------------------------
// The person's own agent types
// ---------------------------------------------------------------------------

/// What one enumeration has read so far, against its caps.
#[derive(Debug, Default)]
struct Budget {
    dirs: usize,
    definitions: usize,
}

/// The person's agent types for a run in `vault`: `person_agents` under the
/// config home the run's Claude Code reads (`CLAUDE_CONFIG_DIR`, resolved
/// against the vault, else `~/.claude`), the one transcripts are found in.
/// A config home nobody can name withdraws the tool.
pub(crate) fn person_agents_of(vault: &Path) -> Result<Vec<String>, Withdrawn> {
    let real = std::fs::canonicalize(vault).unwrap_or_else(|_| vault.to_path_buf());
    let env = super::transcript::CliEnv::from_process();
    let config =
        super::transcript::config_home(&env, &real).ok_or(Withdrawn::Unreadable(Scope::User))?;
    person_agents(&config)
}

/// The agent types Claude Code 2.1.250 loads from the person's config home
/// `config` under `--setting-sources user`: the user scope's definitions,
/// then every installed plugin's, each named as the CLI names it.
pub(crate) fn person_agents(config: &Path) -> Result<Vec<String>, Withdrawn> {
    let mut budget = Budget::default();
    let mut names = user_agents(&config.join(USER_AGENTS), &mut budget)?;
    names.extend(plugin_agents(
        &INSTALLED_PLUGINS
            .iter()
            .fold(config.to_path_buf(), |path, part| path.join(part)),
        &mut budget,
    )?);
    let mut seen = BTreeSet::new();
    names.retain(|name| seen.insert(name.clone()));
    Ok(names)
}

/// The user scope: every `.md` file under `dir` and its folders, symlinks
/// followed as Claude Code follows them, as long as they lead nowhere
/// outside `dir`. A definition is loaded only with a name: a string that
/// does not start with `-` and holds no `:`.
fn user_agents(dir: &Path, budget: &mut Budget) -> Result<Vec<String>, Withdrawn> {
    let scope = Scope::User;
    let Some(root) = canonical_dir(dir, scope)? else {
        return Ok(Vec::new());
    };
    let mut names = Vec::new();
    for found in scan(&root, Follow::Inside, budget, scope)? {
        let text = read_capped(&found.path, scope)?;
        let Some(frontmatter) = frontmatter(&text) else {
            continue;
        };
        for value in name_values(&frontmatter) {
            let Some(name) = value.as_str() else {
                continue;
            };
            if name.is_empty() || name.starts_with('-') || name.nfkc().any(|c| c == ':') {
                continue;
            }
            if !is_agent_type(name) {
                return Err(Withdrawn::Unnameable(scope));
            }
            names.push(name.to_string());
        }
    }
    Ok(names)
}

/// Every installed plugin's agent types, from the list at `list`: each
/// install's default `agents/` folder, or the paths its manifest names
/// instead, named `<plugin>:<folder>:…:<name or file stem>`. An install whose
/// folder is gone, or whose manifest Claude Code would refuse, loads none.
fn plugin_agents(list: &Path, budget: &mut Budget) -> Result<Vec<String>, Withdrawn> {
    let scope = Scope::Plugins;
    let raw = match read_file(list, scope)? {
        Some(raw) => raw,
        None => return Ok(Vec::new()),
    };
    let listed: Value = serde_json::from_str(&raw).map_err(|_| Withdrawn::Unreadable(scope))?;
    let Some(plugins) = listed.get("plugins").and_then(Value::as_object) else {
        return Err(Withdrawn::Unreadable(scope));
    };
    let mut names = Vec::new();
    for (key, installs) in plugins {
        let installs: Vec<&Value> = match installs {
            Value::Array(installs) => installs.iter().collect(),
            Value::Object(_) => vec![installs],
            _ => return Err(Withdrawn::Unreadable(scope)),
        };
        let fallback = key.split('@').next().unwrap_or(key);
        for install in installs {
            let Some(path) = install.get("installPath").and_then(Value::as_str) else {
                continue;
            };
            names.extend(one_plugin(Path::new(path), fallback, budget)?);
        }
    }
    Ok(names)
}

/// One install's agent types: its manifest's name (or the list's, with no
/// manifest), then each definition under the folders its agents come from.
fn one_plugin(path: &Path, fallback: &str, budget: &mut Budget) -> Result<Vec<String>, Withdrawn> {
    let scope = Scope::Plugins;
    if !path.is_absolute() {
        return Ok(Vec::new());
    }
    let Some(root) = canonical_dir(path, scope)? else {
        return Ok(Vec::new());
    };
    let manifest_path = PLUGIN_MANIFEST
        .iter()
        .fold(root.clone(), |path, part| path.join(part));
    let manifest: Option<Value> = match read_file(&manifest_path, scope)? {
        None => None,
        Some(raw) => match serde_json::from_str::<Value>(&raw) {
            Ok(value) => Some(value),
            // Claude Code refuses the plugin, so none of its agents load.
            Err(_) => return Ok(Vec::new()),
        },
    };
    let plugin = match &manifest {
        None => fallback.to_string(),
        Some(manifest) => match manifest.get("name").and_then(Value::as_str) {
            Some(name) if !name.is_empty() => name.to_string(),
            _ => return Ok(Vec::new()),
        },
    };
    let declared = manifest.as_ref().and_then(|m| m.get("agents"));
    let falsy = match declared {
        None | Some(Value::Null) | Some(Value::Bool(false)) => true,
        Some(Value::String(path)) => path.is_empty(),
        Some(Value::Number(n)) => n.as_f64() == Some(0.0),
        Some(_) => false,
    };
    let mut names = Vec::new();
    if falsy {
        let dir = root.join(PLUGIN_AGENTS);
        if let Some(dir) = canonical_dir(&dir, scope)? {
            names.extend(plugin_folder(&dir, &plugin, &root, budget)?);
        }
        return Ok(names);
    }
    let paths: Vec<&str> = match declared {
        Some(Value::Array(paths)) => paths.iter().filter_map(Value::as_str).collect(),
        Some(Value::String(path)) => vec![path.as_str()],
        _ => Vec::new(),
    };
    for declared in paths {
        let target = match std::fs::canonicalize(root.join(declared)) {
            Ok(target) => target,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err(Withdrawn::Unreadable(scope)),
        };
        // Claude Code refuses a path that leaves the plugin.
        if !target.starts_with(&root) {
            continue;
        }
        let meta = std::fs::metadata(&target).map_err(|_| Withdrawn::Unreadable(scope))?;
        if meta.is_dir() {
            names.extend(plugin_folder(&target, &plugin, &root, budget)?);
        } else if meta.is_file() && declared.ends_with(".md") {
            budget.definitions += 1;
            if budget.definitions > MAX_DEFINITIONS {
                return Err(Withdrawn::TooMany(scope));
            }
            names.extend(plugin_agent(&target, &plugin, &[], scope)?);
        }
    }
    Ok(names)
}

/// The agent types under one plugin folder `dir`, inside the plugin `root`.
/// Claude Code reads a plugin's folders by their entries' own types, so a
/// symlink there is neither a folder nor a definition.
fn plugin_folder(
    dir: &Path,
    plugin: &str,
    root: &Path,
    budget: &mut Budget,
) -> Result<Vec<String>, Withdrawn> {
    let scope = Scope::Plugins;
    if !dir.starts_with(root) {
        return Ok(Vec::new());
    }
    let mut names = Vec::new();
    for found in scan(dir, Follow::Never, budget, scope)? {
        names.extend(plugin_agent(&found.path, plugin, &found.folders, scope)?);
    }
    Ok(names)
}

/// One plugin definition's type: `<plugin>:<folder>:…:<name>`, its
/// frontmatter's name as text, else its file's stem. A definition that names
/// itself under more than one spelling of the key gives each, so whichever
/// Claude Code reads is denied.
fn plugin_agent(
    path: &Path,
    plugin: &str,
    folders: &[String],
    scope: Scope,
) -> Result<Vec<String>, Withdrawn> {
    let text = read_capped(path, scope)?;
    let mut names: Vec<String> = frontmatter(&text)
        .map(|frontmatter| {
            name_values(&frontmatter)
                .into_iter()
                .filter_map(scalar_text)
                .filter(|name| !name.is_empty())
                .collect()
        })
        .unwrap_or_default();
    if names.is_empty() {
        let file = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        names.push(file.strip_suffix(".md").map(str::to_string).unwrap_or(file));
    }
    names
        .into_iter()
        .map(|name| {
            let mut parts: Vec<&str> = vec![plugin];
            parts.extend(folders.iter().map(String::as_str));
            parts.push(&name);
            let id = parts.join(":");
            if is_agent_type(&id) {
                Ok(id)
            } else {
                Err(Withdrawn::Unnameable(scope))
            }
        })
        .collect()
}

/// A scalar frontmatter value as text, the way JavaScript's `String` spells
/// it; a list or a map spells as no agent type at all, which no deny rule
/// can carry.
fn scalar_text(value: &serde_yaml::Value) -> Option<String> {
    match value {
        serde_yaml::Value::Null => None,
        serde_yaml::Value::String(text) => Some(text.clone()),
        serde_yaml::Value::Bool(flag) => Some(flag.to_string()),
        serde_yaml::Value::Number(number) => Some(number.to_string()),
        _ => Some("[object Object]".into()),
    }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/// `dir` resolved, when it is a folder; None when it is missing or not a
/// folder, as Claude Code finds nothing there either.
fn canonical_dir(dir: &Path, scope: Scope) -> Result<Option<PathBuf>, Withdrawn> {
    match std::fs::canonicalize(dir) {
        Ok(real) if real.is_dir() => Ok(Some(real)),
        Ok(_) => Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(Withdrawn::Unreadable(scope)),
    }
}

/// `path`'s text, None when it does not exist. Anything but a regular file
/// there is unreadable, so no read waits on a pipe.
fn read_file(path: &Path, scope: Scope) -> Result<Option<String>, Withdrawn> {
    match std::fs::metadata(path) {
        Ok(meta) if meta.is_file() => read_capped(path, scope).map(Some),
        Ok(_) => Err(Withdrawn::Unreadable(scope)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(Withdrawn::Unreadable(scope)),
    }
}

/// At most MAX_BYTES of `path`, lossily as text; more is unreadable.
fn read_capped(path: &Path, scope: Scope) -> Result<String, Withdrawn> {
    let unreadable = |_| Withdrawn::Unreadable(scope);
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .map_err(unreadable)?
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(unreadable)?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(Withdrawn::Unreadable(scope));
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// How a scan treats a symlink.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Follow {
    /// As Claude Code's user scope does, to a file or a folder, as long as
    /// it leads nowhere outside the scan's root; one that does withdraws.
    Inside,
    /// As Claude Code's plugin scan does: never, so a symlink is skipped.
    Never,
}

/// One definition a scan found: its path, and the folders between the scan's
/// root and it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Found {
    path: PathBuf,
    folders: Vec<String>,
}

/// Every definition under the canonical folder `root`, in name order: a
/// regular file named `*.md` (any case of `.md` for a plugin, as Claude Code
/// matches them; exactly `.md` in the user scope), hidden ones included.
fn scan(
    root: &Path,
    follow: Follow,
    budget: &mut Budget,
    scope: Scope,
) -> Result<Vec<Found>, Withdrawn> {
    let mut found = Vec::new();
    let mut visited: BTreeSet<PathBuf> = BTreeSet::new();
    visited.insert(root.to_path_buf());
    let mut pending: Vec<(PathBuf, Vec<String>)> = vec![(root.to_path_buf(), Vec::new())];
    while let Some((dir, folders)) = pending.pop() {
        budget.dirs += 1;
        if budget.dirs > MAX_DIRS || folders.len() > MAX_DEPTH {
            return Err(Withdrawn::TooMany(scope));
        }
        let mut entries: Vec<(String, PathBuf, std::fs::FileType)> = Vec::new();
        for entry in std::fs::read_dir(&dir).map_err(|_| Withdrawn::Unreadable(scope))? {
            let entry = entry.map_err(|_| Withdrawn::Unreadable(scope))?;
            let kind = entry
                .file_type()
                .map_err(|_| Withdrawn::Unreadable(scope))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            entries.push((name, entry.path(), kind));
        }
        entries.sort_by(|a, b| a.0.cmp(&b.0));
        let mut below: Vec<(PathBuf, Vec<String>)> = Vec::new();
        for (name, path, kind) in entries {
            let (path, is_dir, is_file) = if kind.is_symlink() {
                if follow == Follow::Never {
                    continue;
                }
                let target = match std::fs::canonicalize(&path) {
                    Ok(target) => target,
                    // A dangling link is no definition to Claude Code either.
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(_) => return Err(Withdrawn::Unreadable(scope)),
                };
                if !target.starts_with(root) {
                    return Err(Withdrawn::Unreadable(scope));
                }
                let meta = std::fs::metadata(&target).map_err(|_| Withdrawn::Unreadable(scope))?;
                (target, meta.is_dir(), meta.is_file())
            } else {
                (path, kind.is_dir(), kind.is_file())
            };
            if is_dir {
                if visited.insert(path.clone()) {
                    let mut deeper = folders.clone();
                    deeper.push(name);
                    below.push((path, deeper));
                }
            } else if is_file && is_definition(&name, follow) {
                budget.definitions += 1;
                if budget.definitions > MAX_DEFINITIONS {
                    return Err(Withdrawn::TooMany(scope));
                }
                found.push(Found {
                    path,
                    folders: folders.clone(),
                });
            }
        }
        pending.extend(below.into_iter().rev());
    }
    Ok(found)
}

/// Is a file named `name` a definition? A plugin's matches `.md` in any case,
/// the user scope's exactly.
fn is_definition(name: &str, follow: Follow) -> bool {
    match follow {
        Follow::Inside => name.ends_with(".md"),
        Follow::Never => name.to_ascii_lowercase().ends_with(".md"),
    }
}

// ---------------------------------------------------------------------------
// Frontmatter, read as Claude Code reads it
// ---------------------------------------------------------------------------

/// The text between a definition's opening `---` and the first `---` after
/// it, as 2.1.250 cuts it (`^---\s*\n([\s\S]*?)---`): the opening fence's
/// trailing space runs through its last newline, and the block ends at the
/// next `---` wherever it falls.
fn frontmatter_block(text: &str) -> Option<&str> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let rest = text.strip_prefix("---")?;
    let blank = rest.len() - rest.trim_start().len();
    let opening = rest[..blank].rfind('\n')?;
    let block = &rest[opening + 1..];
    let end = block.find("---")?;
    Some(&block[..end])
}

/// A definition's frontmatter as a map: the block as YAML, else the block
/// with the values Claude Code quotes before its second try, else none.
fn frontmatter(text: &str) -> Option<serde_yaml::Mapping> {
    let block = frontmatter_block(text)?;
    crate::vault::parse::parse_frontmatter(block)
        .or_else(|_| crate::vault::parse::parse_frontmatter(&requoted(block)))
        .ok()
}

/// The block as 2.1.250 retries it: on each `key: value` line whose value is
/// not quoted already (nor a flow list) and holds a character YAML would
/// read as syntax, the value wrapped in double quotes; then every leading
/// tab as two spaces.
fn requoted(block: &str) -> String {
    block
        .split('\n')
        .map(|line| {
            let line = quoted_line(line);
            let tabs = line.len() - line.trim_start_matches('\t').len();
            format!("{}{}", "  ".repeat(tabs), &line[tabs..])
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// One line of `requoted`, before its tabs: `^([a-zA-Z_-]+):\s+(.+)$`.
fn quoted_line(line: &str) -> String {
    let unchanged = || line.to_string();
    let Some((key, rest)) = line.split_once(':') else {
        return unchanged();
    };
    let keyed = !key.is_empty()
        && key
            .bytes()
            .all(|b| b.is_ascii_alphabetic() || b == b'_' || b == b'-');
    let value = rest.trim_start();
    let spaced = value.len() < rest.len();
    // JavaScript's `.` stops at a line terminator, so such a line is left be.
    let one_line = !value.contains(['\r', '\u{2028}', '\u{2029}']);
    if !keyed || !spaced || value.is_empty() || !one_line {
        return unchanged();
    }
    let wrapped = |q: char| value.starts_with(q) && value.ends_with(q);
    if wrapped('"') || wrapped('\'') {
        return unchanged();
    }
    if value.starts_with('[')
        && value.ends_with(']')
        && matches!(
            serde_yaml::from_str::<serde_yaml::Value>(value),
            Ok(serde_yaml::Value::Sequence(_))
        )
    {
        return unchanged();
    }
    let syntax = value.contains([
        '{', '}', '[', ']', '*', '&', '#', '!', '|', '>', '%', '@', '`',
    ]) || value.contains(": ");
    if !syntax {
        return unchanged();
    }
    let escaped = value.replace('\\', "\\\\").replace('"', "\\\"");
    format!("{key}: \"{escaped}\"")
}

/// The values of every key Claude Code reads as `name`: its case, dashes and
/// underscores aside, in the block's order.
fn name_values(frontmatter: &serde_yaml::Mapping) -> Vec<&serde_yaml::Value> {
    frontmatter
        .iter()
        .filter(|(key, _)| {
            key.as_str().is_some_and(|key| {
                key.chars()
                    .filter(|c| *c != '-' && *c != '_')
                    .flat_map(char::to_lowercase)
                    .eq("name".chars())
            })
        })
        .map(|(_, value)| value)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::AgentRequest;
    use crate::policy::tool_approval::{plan_for, DelegateCeiling, WebCeiling};
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A fresh, empty folder of the system's temp dir, for one test.
    fn temp_config(label: &str) -> PathBuf {
        static SEQ: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "cerebro-cli-agents-{label}-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::canonicalize(&dir).unwrap()
    }

    fn put(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn definition_named(name: &str) -> String {
        format!("---\nname: {name}\ndescription: Reads things.\n---\nYou read.\n")
    }

    fn attended(delegate: DelegateCeiling, web: bool) -> AgentRequest {
        serde_json::from_value(json!({
            "message": "hi", "attended": true, "web": web, "delegate": delegate.as_str()
        }))
        .unwrap()
    }

    /// The run's grant as `agent::stream` computes it before connectors.
    fn granted(req: &AgentRequest, approval: &RunApproval) -> Vec<String> {
        crate::agent::run_grant(req, approval)
    }

    #[test]
    fn every_preset_has_its_prompt() {
        let presets: Vec<&str> = crate::policy::subagents::presets()
            .iter()
            .map(|preset| preset.name.as_str())
            .collect();
        let prompted: Vec<&str> = PRESET_PROMPTS.iter().map(|(name, _)| *name).collect();
        assert_eq!(prompted, presets);
        for (name, prompt) in PRESET_PROMPTS {
            assert!(!prompt.trim().is_empty(), "{name}");
            assert_eq!(preset_prompt(name), Some(prompt.trim()));
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

    fn retired_terms() -> Vec<String> {
        let retired: Value =
            serde_json::from_str(include_str!("../../../shared/prompt/retired-terms.json"))
                .unwrap();
        retired["terms"]
            .as_array()
            .unwrap()
            .iter()
            .map(|term| term.as_str().unwrap().to_lowercase())
            .collect()
    }

    // CV-19/CV-20: every subagent of a run that holds the tool hears the
    // composed brief, whatever its definition holds, so it names no tool
    // Cerebro serves and no retired term; the subagent line and each preset's
    // prompt, which are new prose, name none of Claude Code's tools either.
    #[test]
    fn the_subagent_prose_names_no_tool_and_no_retired_term() {
        let brief = subagent_brief();
        assert_eq!(
            brief,
            format!(
                "{}\n\n{}\n\n{}",
                PRODUCT_BRIEF.trim(),
                SERVER_INSTRUCTIONS.trim(),
                SUBAGENT_LINE.trim()
            ),
            "composed from the three files, copied nowhere"
        );
        let manifest = crate::policy::tools::manifest();
        let mut cerebro: Vec<String> = crate::mcp::tool_catalog(true)
            .iter()
            .filter_map(|tool| tool["name"].as_str().map(str::to_string))
            .collect();
        cerebro.extend(manifest.tools.iter().map(|row| row.name.clone()));
        let mut cli: Vec<String> = Vec::new();
        for tool in &manifest.cli_tools {
            cli.push(tool.name.clone());
            cli.extend(tool.aliases.iter().cloned());
        }
        // A tool is named bare at a word's edges, or behind the prefix the
        // CLI calls Cerebro's tools by.
        let names = |text: &str, tool: &str| {
            names_word(text, tool) || text.contains(&format!("{}{tool}", manifest.server_prefix()))
        };
        assert!(names("then get_note.", "get_note"));
        assert!(names("then `mcp__cerebro__get_note`.", "get_note"));
        assert!(!names("get_notes", "get_note"));
        let terms = retired_terms();
        assert!(!terms.is_empty());
        let mut texts: Vec<(&str, String)> = vec![("brief", brief.clone())];
        texts.push(("subagent line", SUBAGENT_LINE.to_string()));
        for (name, prompt) in PRESET_PROMPTS {
            texts.push((name, prompt.to_string()));
        }
        for (label, text) in &texts {
            for tool in &cerebro {
                assert!(!names(text, tool), "{label} names {tool}");
            }
            let lower = text.to_lowercase();
            for term in &terms {
                assert!(!lower.contains(term.as_str()), "{label} says {term}");
            }
        }
        for (label, text) in &texts[1..] {
            for tool in &cli {
                assert!(!names_word(text, tool), "{label} names {tool}");
            }
        }
        // The line says what a subagent can't do and how it reports.
        let line = SUBAGENT_LINE.trim();
        assert!(line.contains("can't ask the person"), "{line}");
        assert!(line.contains("[[wikilink]]"), "{line}");
        assert!(!line.contains('\n'), "one paragraph");
    }

    // M91.2b: the researcher holds the reading rows of its run's grant, by
    // the names the CLI calls them, and the web only where its run's plan
    // allows it; never a permission mode, servers, hooks, skills, memory or
    // isolation, and never the background.
    #[test]
    fn the_researcher_holds_only_what_its_run_reads() {
        let reads: Vec<String> = crate::policy::tools::manifest()
            .tools
            .iter()
            .filter(|row| row.toolset.as_deref() == Some("read"))
            .map(|row| format!("mcp__cerebro__{}", row.name))
            .collect();
        assert!(reads.iter().any(|t| t == "mcp__cerebro__get_note"));
        for web in [false, true] {
            let req = attended(DelegateCeiling::On, web);
            let approval = plan_for(&req, true);
            let agents = for_run(&approval, &granted(&req, &approval), || Ok(vec![]))
                .expect("the researcher holds a tool");
            assert_eq!(agents.allowed, ["cerebro-researcher"]);
            let defined = &agents.definitions["cerebro-researcher"];
            let keys: Vec<&str> = defined
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect();
            assert_eq!(keys, ["description", "prompt", "tools", "background"]);
            assert_eq!(defined["background"], json!(false));
            assert_eq!(
                defined["description"],
                crate::policy::subagents::presets()[0].description
            );
            assert_eq!(
                defined["prompt"],
                preset_prompt("cerebro-researcher").unwrap()
            );
            let mut expected = reads.clone();
            if web {
                expected.extend(["WebSearch".to_string(), "WebFetch".to_string()]);
            }
            assert_eq!(defined["tools"], json!(expected), "web={web}");
            // The value argv carries is the one object, by type.
            let parsed: Value = serde_json::from_str(&agents.definitions_json()).unwrap();
            assert_eq!(parsed, json!({ "cerebro-researcher": defined }));
        }
    }

    // M91.2b: a record that narrows its run keeps the researcher to the
    // reading tools it names, and one that names none leaves it nothing to
    // hold, so the run is planned without the subagent tool.
    #[test]
    fn a_narrowed_run_narrows_the_researcher_or_withdraws_it() {
        let mut req = attended(DelegateCeiling::On, true);
        req.allowed_tools = Some(vec!["Agent".into(), "get_note".into(), "WebFetch".into()]);
        let approval = plan_for(&req, true);
        let agents = for_run(&approval, &granted(&req, &approval), || Ok(vec![])).unwrap();
        assert_eq!(
            agents.definitions["cerebro-researcher"]["tools"],
            json!(["mcp__cerebro__get_note", "WebFetch"])
        );
        req.allowed_tools = Some(vec!["Agent".into(), "create_note".into()]);
        let approval = plan_for(&req, true);
        assert_eq!(
            for_run(&approval, &granted(&req, &approval), || Ok(vec![])),
            Err(Withdrawn::Untooled)
        );
    }

    // M91.2b: a run that holds no subagent tool has no agent types, and the
    // person's are never read for it.
    #[test]
    fn a_run_without_the_tool_reads_nothing() {
        for req in [
            attended(DelegateCeiling::Off, false),
            serde_json::from_value(json!({ "message": "hi", "attended": false })).unwrap(),
        ] {
            for seated in [false, true] {
                let approval = plan_for(&req, seated);
                let agents = for_run(&approval, &granted(&req, &approval), || {
                    panic!("the person's agents are read only for a run that holds the tool")
                })
                .unwrap();
                assert_eq!(agents, RunAgents::default());
                assert!(!agents.holds());
                assert_eq!(agents.known(), None);
                assert!(agents.deny_rules().is_empty());
            }
        }
        // Unseated, an attended request is planned as one nobody answers.
        let req = attended(DelegateCeiling::On, false);
        let approval = plan_for(&req, false);
        assert!(delegate_rows(&approval).is_empty());
        assert!(delegate_rows(&plan_for(&req, true))
            .iter()
            .any(|row| row.name == "Agent"));
    }

    // M91.2b: the deny list is the built-in types, then the person's, once
    // each, and never a type the run may start: a definition of the
    // person's by that name is outranked by the run's own.
    #[test]
    fn the_deny_list_is_the_built_ins_then_the_persons() {
        let req = attended(DelegateCeiling::On, false);
        let approval = plan_for(&req, true);
        let person = vec![
            "gsd-planner".to_string(),
            "Explore".to_string(),
            "cerebro-researcher".to_string(),
            "tools:review:security".to_string(),
        ];
        let agents = for_run(&approval, &granted(&req, &approval), || Ok(person)).unwrap();
        let builtin = &crate::policy::tool_approval::table().agent_types.builtin;
        let mut expected: Vec<String> = builtin.clone();
        expected.extend([
            "gsd-planner".to_string(),
            "tools:review:security".to_string(),
        ]);
        assert_eq!(agents.denied, expected);
        assert_eq!(agents.deny_rules()[0], format!("Agent({})", builtin[0]));
        assert!(agents
            .deny_rules()
            .contains(&"Agent(tools:review:security)".to_string()));
        let known = agents.known().unwrap();
        assert_eq!(known[0], "cerebro-researcher");
        assert_eq!(known.len(), 1 + expected.len());
        // The person's types that could not be named withdraw the tool.
        let failed = for_run(&approval, &granted(&req, &approval), || {
            Err(Withdrawn::Unreadable(Scope::User))
        });
        assert_eq!(failed, Err(Withdrawn::Unreadable(Scope::User)));
        // A name a rule cannot carry is refused even if a reader let it by.
        let odd = for_run(&approval, &granted(&req, &approval), || {
            Ok(vec!["two words".to_string()])
        });
        assert!(matches!(odd, Err(Withdrawn::Unnameable(_))));
    }

    // --- The person's own definitions ----------------------------------------

    // M91.2b: the user scope reads every `.md` below `agents/`, nested ones
    // included, and loads a definition only with a name; plugins are named
    // `<plugin>:<folder>:<name or stem>`.
    #[test]
    fn the_persons_agents_are_named_as_claude_code_names_them() {
        let config = temp_config("named");
        let agents = config.join("agents");
        put(&agents.join("planner.md"), &definition_named("gsd-planner"));
        put(
            &agents.join("team").join("deep").join("reviewer.md"),
            &definition_named("reviewer"),
        );
        put(
            &agents.join("nameless.md"),
            "---\ndescription: No name.\n---\nBody.\n",
        );
        put(&agents.join("no-frontmatter.md"), "Just text.\n");
        put(
            &agents.join("notes.txt"),
            &definition_named("not-a-definition"),
        );
        put(
            &agents.join("UPPER.MD"),
            &definition_named("upper-case-ending"),
        );
        put(&agents.join(".hidden.md"), &definition_named("hidden-one"));
        put(&agents.join("dash.md"), &definition_named("-dashed"));
        put(
            &agents.join("colon.md"),
            "---\nname: \"has:colon\"\ndescription: x\n---\n",
        );
        // A description Claude Code's YAML would choke on, which it quotes
        // and reads again.
        put(
            &agents.join("lenient.md"),
            "---\nname: lenient\ndescription: Use when: the person asks # for it\n---\nBody.\n",
        );
        // The plugins: one with a manifest name, nested definitions and a
        // nameless one; one without a manifest; one whose manifest names its
        // own agent paths; and one whose install is gone.
        let cache = config.join("plugins").join("cache");
        let alpha = cache.join("market").join("alpha").join("1.0.0");
        put(
            &alpha.join(".claude-plugin").join("plugin.json"),
            r#"{"name": "alpha-tools", "version": "1.0.0"}"#,
        );
        put(
            &alpha.join("agents").join("review").join("security.md"),
            &definition_named("security-sentinel"),
        );
        put(
            &alpha.join("agents").join("helper.md"),
            "---\ndescription: No name, so its stem.\n---\n",
        );
        // A plugin's `.md` matches in any case, and its stem keeps the case
        // the CLI's suffix rule does not strip.
        put(
            &alpha.join("agents").join("Loud.MD"),
            "---\ndescription: No name either.\n---\n",
        );
        let beta = cache.join("market").join("beta").join("2.0.0");
        put(
            &beta.join("agents").join("scout.md"),
            &definition_named("scout"),
        );
        // Two spellings of the key: whichever Claude Code reads is denied.
        put(
            &beta.join("agents").join("twice.md"),
            "---\nname: first\nNAME: second\n---\n",
        );
        let gamma = cache.join("market").join("gamma").join("0.1.0");
        put(
            &gamma.join(".claude-plugin").join("plugin.json"),
            r#"{"name": "gamma", "agents": ["./custom/one.md", "./more/", "../outside.md"]}"#,
        );
        put(
            &gamma.join("custom").join("one.md"),
            &definition_named("one"),
        );
        put(
            &gamma.join("more").join("sub").join("two.md"),
            &definition_named("two"),
        );
        put(
            &gamma.join("agents").join("shadowed.md"),
            &definition_named("shadowed"),
        );
        put(
            &gamma.parent().unwrap().join("outside.md"),
            &definition_named("outside"),
        );
        let list = json!({
            "version": 2,
            "plugins": {
                "alpha@market": [{ "scope": "user", "installPath": alpha }],
                "beta@market": [{ "scope": "user", "installPath": beta }],
                "gamma@market": [{ "scope": "project", "installPath": gamma }],
                "gone@market": [{ "scope": "user", "installPath": cache.join("gone") }],
            }
        });
        put(
            &config.join("plugins").join("installed_plugins.json"),
            &list.to_string(),
        );
        let names = person_agents(&config).unwrap();
        assert_eq!(
            names,
            [
                "hidden-one",
                "lenient",
                "gsd-planner",
                "reviewer",
                "alpha-tools:Loud.MD",
                "alpha-tools:helper",
                "alpha-tools:review:security-sentinel",
                "beta:scout",
                "beta:first",
                "beta:second",
                "gamma:one",
                "gamma:sub:two",
            ]
        );
        let _ = std::fs::remove_dir_all(&config);
    }

    // M91.2b: nothing to read is no agent at all: no folder, no plugin list.
    #[test]
    fn a_config_without_agents_names_none() {
        let config = temp_config("empty");
        assert_eq!(person_agents(&config).unwrap(), Vec::<String>::new());
        assert_eq!(
            person_agents(&config.join("not-there")).unwrap(),
            Vec::<String>::new()
        );
        let _ = std::fs::remove_dir_all(&config);
    }

    // M91.2b: a name a deny rule cannot carry, a list that does not parse
    // and an unreadable definition all fail closed.
    #[test]
    fn what_cannot_be_named_or_read_withdraws_the_tool() {
        let config = temp_config("bad-name");
        put(
            &config.join("agents").join("spaced.md"),
            &definition_named("\"two words\""),
        );
        assert_eq!(
            person_agents(&config),
            Err(Withdrawn::Unnameable(Scope::User))
        );
        let _ = std::fs::remove_dir_all(&config);

        let config = temp_config("bad-plugin-name");
        let plugin = config.join("plugins").join("cache").join("p");
        put(
            &plugin.join("agents").join("ok.md"),
            &definition_named("ok"),
        );
        put(
            &config.join("plugins").join("installed_plugins.json"),
            &json!({ "plugins": { "my plugin@m": [{ "installPath": plugin }] } }).to_string(),
        );
        assert_eq!(
            person_agents(&config),
            Err(Withdrawn::Unnameable(Scope::Plugins))
        );
        let _ = std::fs::remove_dir_all(&config);

        let config = temp_config("bad-list");
        put(
            &config.join("plugins").join("installed_plugins.json"),
            "{ not json",
        );
        assert_eq!(
            person_agents(&config),
            Err(Withdrawn::Unreadable(Scope::Plugins))
        );
        let _ = std::fs::remove_dir_all(&config);

        let config = temp_config("too-large");
        put(
            &config.join("agents").join("huge.md"),
            &format!(
                "{}{}",
                definition_named("huge"),
                "x".repeat(MAX_BYTES as usize)
            ),
        );
        assert_eq!(
            person_agents(&config),
            Err(Withdrawn::Unreadable(Scope::User))
        );
        let _ = std::fs::remove_dir_all(&config);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let config = temp_config("unreadable");
            let file = config.join("agents").join("locked.md");
            put(&file, &definition_named("locked"));
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o000)).unwrap();
            // A root user reads it anyway; the refusal is the point only
            // where the read fails.
            if std::fs::read(&file).is_err() {
                assert_eq!(
                    person_agents(&config),
                    Err(Withdrawn::Unreadable(Scope::User))
                );
            }
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
            let _ = std::fs::remove_dir_all(&config);
        }
    }

    // M91.2b: the user scope follows a symlink as Claude Code does, as long
    // as it stays inside the folder; one that leads outside withdraws the
    // tool, and a dangling one is no definition. A plugin's symlinks are
    // skipped, as Claude Code skips them.
    #[cfg(unix)]
    #[test]
    fn symlinks_are_read_without_following_them_outside() {
        use std::os::unix::fs::symlink;
        let config = temp_config("links");
        let agents = config.join("agents");
        put(
            &agents.join("real").join("inner.md"),
            &definition_named("inner"),
        );
        symlink(agents.join("real"), agents.join("linked-dir")).unwrap();
        symlink(
            agents.join("real").join("inner.md"),
            agents.join("alias.md"),
        )
        .unwrap();
        symlink(config.join("nowhere.md"), agents.join("dangling.md")).unwrap();
        // The folder and the file it links to are each read once.
        assert_eq!(person_agents(&config).unwrap(), ["inner"]);

        let outside = config.join("elsewhere").join("theirs.md");
        put(&outside, &definition_named("theirs"));
        symlink(&outside, agents.join("theirs.md")).unwrap();
        assert_eq!(
            person_agents(&config),
            Err(Withdrawn::Unreadable(Scope::User))
        );
        std::fs::remove_file(agents.join("theirs.md")).unwrap();

        // The whole folder may be a link: it is read where it leads.
        let moved = temp_config("links-moved");
        put(&moved.join("a.md"), &definition_named("from-dotfiles"));
        let config2 = temp_config("links-config");
        symlink(&moved, config2.join("agents")).unwrap();
        assert_eq!(person_agents(&config2).unwrap(), ["from-dotfiles"]);

        let plugin = config.join("plugins").join("cache").join("p");
        put(
            &plugin.join("agents").join("kept.md"),
            &definition_named("kept"),
        );
        symlink(&outside, plugin.join("agents").join("linked.md")).unwrap();
        put(
            &config.join("plugins").join("installed_plugins.json"),
            &json!({ "plugins": { "p@m": [{ "installPath": plugin }] } }).to_string(),
        );
        assert_eq!(person_agents(&config).unwrap(), ["inner", "p:kept"]);
        for dir in [config, moved, config2] {
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    // The frontmatter is cut and retried as 2.1.250 does.
    #[test]
    fn frontmatter_is_read_as_claude_code_reads_it() {
        assert_eq!(
            frontmatter_block("---\nname: a\n---\nbody"),
            Some("name: a\n")
        );
        assert_eq!(
            frontmatter_block("\u{feff}---  \n\nname: a\n---"),
            Some("name: a\n")
        );
        assert_eq!(frontmatter_block("--- x\nname: a\n---"), None);
        assert_eq!(frontmatter_block("---\nname: a"), None);
        assert_eq!(frontmatter_block("text\n---\nname: a\n---"), None);
        // The block ends at the next `---`, wherever it falls.
        assert_eq!(
            frontmatter_block("---\nname: a---b\n---\n"),
            Some("name: a")
        );
        assert_eq!(
            quoted_line("description: Use when: asked"),
            "description: \"Use when: asked\""
        );
        assert_eq!(
            quoted_line("description: say \"hi\" # now"),
            "description: \"say \\\"hi\\\" # now\""
        );
        for kept in [
            "name: plain",
            "name: \"quoted: yes\"",
            "tools: [Read, Grep]",
            "name:tight",
            "  nested: a: b",
            "line: ends\r",
        ] {
            assert_eq!(quoted_line(kept), kept, "{kept:?}");
        }
        assert_eq!(requoted("\tname: a"), "  name: a");
        let mapping = frontmatter("---\nName: Upper\nna_me: snake\n---\n").unwrap();
        let names: Vec<&str> = name_values(&mapping)
            .into_iter()
            .filter_map(|value| value.as_str())
            .collect();
        assert_eq!(names, ["Upper", "snake"]);
        assert_eq!(
            scalar_text(&serde_yaml::Value::Number(42.into())).as_deref(),
            Some("42")
        );
        assert_eq!(scalar_text(&serde_yaml::Value::Null), None);
    }

    #[test]
    fn the_withdrawal_words_name_no_path() {
        for why in [
            Withdrawn::Untooled,
            Withdrawn::Unreadable(Scope::User),
            Withdrawn::Unnameable(Scope::Plugins),
            Withdrawn::TooMany(Scope::User),
        ] {
            let words = why.to_string();
            assert!(!words.contains('/'), "{words}");
            assert!(!words.is_empty());
        }
    }

    #[test]
    fn the_web_switch_alone_never_puts_the_web_in_a_definition() {
        // The web ceiling off denies both web tools, so no definition holds
        // one, whatever the preset names.
        let req = attended(DelegateCeiling::On, false);
        let approval = plan_for(&req, true);
        assert_eq!(WebCeiling::of(req.web), WebCeiling::Off);
        let agents = for_run(&approval, &granted(&req, &approval), || Ok(vec![])).unwrap();
        let tools = agents.definitions["cerebro-researcher"]["tools"]
            .as_array()
            .unwrap()
            .clone();
        assert!(tools
            .iter()
            .all(|tool| tool.as_str().unwrap().starts_with("mcp__cerebro__")));
    }
}
