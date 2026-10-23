//! `shared/policy/tools.v1.json` — the one tool manifest (M54.1).
//!
//! Every tool cerebro's loopback serves is a row here: its title, the kind of
//! change it makes, the door it writes through, the grant axis that binds it
//! and by which argument, how a transcript renders it, its icon and search
//! hint, the phrase a run of its calls folds under (M56.8), and the
//! description and schema the model reads. The generated
//! `propose_<op>` tools take their facts from one `generated` block (their
//! names, descriptions and schemas stay policy.v3's), and the CLI's own
//! built-ins are one list, in argv order, each under its name and any aliases
//! Claude Code also spells it by (M91.1).
//!
//! `mcp.rs` serves `tools/list` from these rows, and derives the scope
//! targets, the announcements and the read-to-replace guard from them;
//! `agent/mod.rs` derives the CLI allow and deny lists. A tool list typed out
//! beside this file is the twin inventory `shared/policy/README.md` exists to
//! prevent.
//!
//! Load is STRICT: an unknown field fails the parse, and `validate` refuses a
//! manifest whose facts disagree, naming the row and the field. There is no
//! runtime digest check (the policy.v3 precedent): the compiled bytes are
//! tested against the committed digest and against the file on disk.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

use serde::Deserialize;
use serde_json::Value;

use crate::policy::table::PolicyTable;

/// The manifest, bound at compile time like the policy table.
pub const TOOLS_JSON: &str = include_str!("../../../shared/policy/tools.v1.json");

/// Repo-relative location, for the tests that read the file on disk.
pub const TOOLS_PATH: &str = "shared/policy/tools.v1.json";

/// The committed SHA-256 of the manifest's bytes. Regenerate it deliberately
/// after an edit (see `write_tools_digest`).
pub const TOOLS_DIGEST_PATH: &str = "shared/policy/tools.v1.sha256";

/// The format this build reads.
pub const FORMAT: u64 = 1;

/// The longest name a tool may have as the CLI spells it,
/// `mcp__<server>__<name>`, and the longest title.
const NAME_LIMIT: usize = 64;
const TITLE_LIMIT: usize = 64;

/// A summary this short, or one that only repeats the name, tells the person
/// picking tools nothing.
const SUMMARY_FLOOR: usize = 10;

/// Search hints are plain search words, not a second description.
const SEARCH_HINT_LIMIT: usize = 80;

/// The roadmap's bounds on a served description: a thinner one is how an
/// agent picks the wrong tool, and 2048 is the most one may carry.
const DESCRIPTION_CHARS: std::ops::RangeInclusive<usize> = 21..=2048;

/// A fold phrase is a row label, not a sentence (M56.8).
const FOLD_LIMIT: usize = 40;

/// Where a fold phrase's count goes.
const FOLD_COUNT: &str = "{n}";

/// The door the comment tools go through (M70.3): they write a page's
/// comment sidecar, never the page, so the door writes nothing, and its rows
/// are reads of one note (a refusal lists where a quote appears).
pub const COMMENT_DOOR: &str = "comment";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Surface {
    /// Served on every run.
    Base,
    /// Served beside the generated tools, only when the proposal surface is on.
    Proposals,
}

/// What a call changes, as the annotations say it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    ReadOnly,
    Additive,
    Destructive,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::ReadOnly => "read_only",
            Kind::Additive => "additive",
            Kind::Destructive => "destructive",
        }
    }
}

/// Which folder list in a run's grant binds the tool.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Axis {
    /// `RunGrant.scope`, checked against the target before the tool runs.
    Write,
    /// `RunGrant.read_scope`: the target is checked before the tool runs, and
    /// a reader with no target filters inside its own body.
    Read,
    /// Both, on one note target (M55.5): a writer whose answers quote the
    /// note back, so it reads what it writes and a write-only run cannot use
    /// it to probe a note.
    ReadWrite,
    /// Neither; the row's `exempt` says why.
    None,
}

impl Axis {
    pub fn as_str(self) -> &'static str {
        match self {
            Axis::Write => "write",
            Axis::Read => "read",
            Axis::ReadWrite => "read_write",
            Axis::None => "none",
        }
    }
}

/// What a tool's target argument names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TargetKind {
    Note,
    /// Any contained, visible file; only a read with no write door.
    File,
    /// A JSON Canvas board, judged by the board door before a bounded read.
    Canvas,
    Folder,
    Concept,
    SourceId,
    /// The knowledge bundle as a whole; it takes no argument.
    Bundle,
}

impl TargetKind {
    pub fn as_str(self) -> &'static str {
        match self {
            TargetKind::Note => "note",
            TargetKind::File => "file",
            TargetKind::Canvas => "canvas",
            TargetKind::Folder => "folder",
            TargetKind::Concept => "concept",
            TargetKind::SourceId => "source_id",
            TargetKind::Bundle => "bundle",
        }
    }
}

/// How a transcript shows a call (M56.8): a step in the run, a change card,
/// or one of the rows a cerebro tool owns: a concept to review, a handoff to
/// another agent, a commit of proposals, or a checked view suggestion. Since
/// M91.1 two draw one of the CLI's own tools: a subagent's work and a todo
/// list.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Renderer {
    Step,
    Change,
    Concept,
    Handoff,
    Commit,
    View,
    Subagent,
    Todo,
}

impl Renderer {
    pub fn as_str(self) -> &'static str {
        match self {
            Renderer::Step => "step",
            Renderer::Change => "change",
            Renderer::Concept => "concept",
            Renderer::Handoff => "handoff",
            Renderer::Commit => "commit",
            Renderer::View => "view",
            Renderer::Subagent => "subagent",
            Renderer::Todo => "todo",
        }
    }

    /// The door a cerebro tool's own row must go through, for the renderers
    /// that draw what that door does.
    fn door(self) -> Option<&'static str> {
        match self {
            Renderer::Concept => Some("concept"),
            Renderer::Handoff => Some("run"),
            Renderer::Commit => Some("ledger"),
            Renderer::View => Some("none"),
            Renderer::Step | Renderer::Change | Renderer::Subagent | Renderer::Todo => None,
        }
    }

    /// Does it draw what one of the CLI's own tools does (M91.1), so that no
    /// cerebro row may take it?
    fn cli_only(self) -> bool {
        matches!(self, Renderer::Subagent | Renderer::Todo)
    }
}

/// How consecutive calls to one read fold into a single transcript row
/// (M56.8): `one` names a single call and `many` a count of them, `{n}`
/// standing for the count. Owner-read copy, lowercase: the row capitalizes
/// the label it joins them into.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FoldPhrases {
    pub one: String,
    pub many: String,
    /// The same row while its calls still run (M91.1): "reading a note",
    /// "reading {n} notes". Optional; the shipped manifest names it beside
    /// every fold.
    pub running: Option<RunningFold>,
}

/// A fold's words while its calls run (M91.1), held to the rules `one` and
/// `many` are.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunningFold {
    pub one: String,
    pub many: String,
}

/// How one call's row reads by its status (M91.1): while it runs, once it is
/// done, and when it failed. Optional on a row; owner-read copy, lowercase,
/// one call each, so no `{n}`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StatusPhrases {
    pub running: String,
    pub done: String,
    pub failed: String,
}

/// The text a `{{name}}` in a description or schema stands for.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Token {
    pub why: String,
}

/// A way a tool reaches the world, and what that allows.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Door {
    pub id: String,
    /// True when a call through this door changes something on disk.
    pub writes: bool,
    pub kinds: Vec<Kind>,
    pub axes: Vec<Axis>,
}

/// One group in the tool picker.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Toolset {
    pub id: String,
    pub label: String,
    pub hint: String,
}

/// A hand-written tool allowed to carry the generated prefix.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrefixException {
    pub name: String,
    pub why: String,
}

/// The argument a tool is aimed by, and what it names.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Target {
    pub arg: Option<String>,
    pub kind: TargetKind,
}

/// One hand-written tool.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolRow {
    pub name: String,
    pub surface: Surface,
    /// Served as `annotations.title`.
    pub title: String,
    /// The picker's one plain line.
    pub summary: String,
    /// `None` is never offered in a picker.
    pub toolset: Option<String>,
    pub kind: Kind,
    pub idempotent: bool,
    pub open_world: bool,
    pub door: String,
    pub axis: Axis,
    pub target: Option<Target>,
    /// Why no folder axis binds the tool; set exactly when `axis` is none.
    pub exempt: Option<String>,
    pub renderer: Renderer,
    /// Set only on a read: what a run of its calls folds under.
    pub fold: Option<FoldPhrases>,
    /// How one call reads by its status (M91.1); optional.
    pub phrases: Option<StatusPhrases>,
    /// A lucide icon name.
    pub icon: String,
    pub always_load: bool,
    /// Does an agent whose record says `ask-first: true` wait for the
    /// person's Allow before this call lands (M57.4)? Only a tool that
    /// writes the person's own pages: a door that writes, on the write or
    /// read_write axis. Which runs ask, and how, is `tool-approval.v1.json`'s
    /// `confirmable` family.
    pub confirmable: bool,
    pub search_hint: String,
    pub description: String,
    pub input_schema: Value,
}

/// The facts every generated `propose_<op>` tool shares.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Generated {
    pub prefix: String,
    /// A generated title is this, then the op with spaces for underscores.
    pub title_prefix: String,
    pub toolset: String,
    pub kind: Kind,
    pub idempotent: bool,
    pub open_world: bool,
    pub door: String,
    pub axis: Axis,
    pub exempt: Option<String>,
    pub renderer: Renderer,
    pub icon: String,
    pub always_load: bool,
    /// Always false (M57.4): a proposal is decided by policy.v3, never by an
    /// ask-first card.
    pub confirmable: bool,
    pub search_hint: String,
}

/// One of the CLI's own built-in tools.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CliTool {
    pub name: String,
    /// The other names Claude Code spells this tool by (M91.1): 2.1.250's
    /// init lists `Task` for the subagent tool its calls name `Agent`. Each
    /// answers with this row's facts (`cli_tool`); argv names the row by
    /// `name` alone. Optional, absent reads as none.
    #[serde(default)]
    pub aliases: Vec<String>,
    /// Its tool-approval family (M57.2): the row of
    /// `shared/policy/tool-approval.v1.json` that decides whether it runs,
    /// asks or is refused. Required: a row with none fails the load.
    pub family: Option<String>,
    /// The input field a person's card names it by (M57.2): a command, a
    /// path, a URL. None names it by its whole input.
    pub subject: Option<String>,
    pub writes: bool,
    pub renderer: Renderer,
    /// Set only on a reader: what a run of its calls folds under.
    pub fold: Option<FoldPhrases>,
    /// How one call reads by its status (M91.1); optional.
    pub phrases: Option<StatusPhrases>,
    pub icon: String,
}

/// Which toolsets a personal token may hold (D17 (b), M62.5).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Clients {
    pub default: String,
    pub grantable: Vec<String>,
    pub why: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NeverCallTool {
    pub name: String,
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NeverCall {
    pub why: String,
    pub tools: Vec<NeverCallTool>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolsManifest {
    pub format: u64,
    pub artifact_version: u64,
    pub rule_version: String,
    pub server: String,
    pub tokens: BTreeMap<String, Token>,
    pub doors: Vec<Door>,
    pub toolsets: Vec<Toolset>,
    pub clients: Clients,
    pub prefix_exceptions: Vec<PrefixException>,
    /// In served order, which is meaning: nothing sorts it.
    pub tools: Vec<ToolRow>,
    pub generated: Generated,
    /// In argv order, which is meaning too.
    pub cli_tools: Vec<CliTool>,
    /// Exact connector send spellings, in ASCII order, with checked sources.
    pub never_call: NeverCall,
}

/// The facts a row and the generated block share, checked by one function.
struct Facts<'a> {
    toolset: Option<&'a str>,
    kind: Kind,
    idempotent: bool,
    door: &'a str,
    axis: Axis,
    target: Option<&'a Target>,
    exempt: Option<&'a str>,
    renderer: Renderer,
    icon: &'a str,
    search_hint: &'a str,
}

/// A refusal, naming what it is about and the field that is wrong.
fn refusal(subject: &str, field: &str, problem: impl std::fmt::Display) -> String {
    format!("{TOOLS_PATH}: {subject}: `{field}` {problem}")
}

/// `[a-z][a-z_]*`
fn is_snake(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c == '_')
}

/// `[A-Z][A-Za-z]*`
fn is_pascal(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_uppercase()) && chars.all(|c| c.is_ascii_alphabetic())
}

/// `[a-z][a-z0-9-]*`: no underscore, so a server name cannot fake the `__`
/// the CLI joins it with.
fn is_server_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// `[a-z0-9]+(-[a-z0-9]+)*`, the shape of a lucide icon name.
fn is_kebab(name: &str) -> bool {
    !name.is_empty()
        && name.split('-').all(|part| {
            !part.is_empty()
                && part
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        })
}

/// Every `{{name}}` in `text`, in order.
fn tokens_in(text: &str) -> Vec<&str> {
    let mut found = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("{{") {
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else {
            break;
        };
        found.push(&after[..end]);
        rest = &after[end + 2..];
    }
    found
}

/// Every string value inside `value`, depth first.
fn strings_in<'a>(value: &'a Value, out: &mut Vec<&'a str>) {
    match value {
        Value::String(text) => out.push(text),
        Value::Array(items) => items.iter().for_each(|item| strings_in(item, out)),
        Value::Object(map) => map.values().for_each(|item| strings_in(item, out)),
        _ => {}
    }
}

/// Is `text` within `limit` characters, and not blank?
fn fits(text: &str, limit: usize) -> bool {
    !text.trim().is_empty() && text.chars().count() <= limit
}

/// A row's fold phrases (M56.8), for a row that may fold: it reads, and it
/// renders as a step. `writer` says why a row may not, in the row's terms.
fn check_fold(
    subject: &str,
    fold: Option<&FoldPhrases>,
    writer: Option<&str>,
    renderer: Renderer,
) -> Result<(), String> {
    let Some(fold) = fold else {
        return Ok(());
    };
    if let Some(why) = writer {
        return Err(refusal(
            subject,
            "fold",
            format!("is set on {why}; only a read folds, so a write keeps its path in view"),
        ));
    }
    if renderer != Renderer::Step {
        return Err(refusal(
            subject,
            "fold",
            format!("is set on a {} row; only a step folds", renderer.as_str()),
        ));
    }
    check_fold_pair(subject, "fold", &fold.one, &fold.many)?;
    match &fold.running {
        Some(running) => check_fold_pair(subject, "fold.running", &running.one, &running.many),
        None => Ok(()),
    }
}

/// One fold's `one` and `many` under `at` (`fold`, or `fold.running` since
/// M91.1): `one` without the count, `many` with it once, both short and
/// lowercase.
fn check_fold_pair(subject: &str, at: &str, one: &str, many: &str) -> Result<(), String> {
    if !fits(one, FOLD_LIMIT) || one.contains(FOLD_COUNT) {
        return Err(refusal(
            subject,
            &format!("{at}.one"),
            format!("must be 1 to {FOLD_LIMIT} characters, without {FOLD_COUNT}"),
        ));
    }
    if !fits(many, FOLD_LIMIT) || many.matches(FOLD_COUNT).count() != 1 {
        return Err(refusal(
            subject,
            &format!("{at}.many"),
            format!("must be 1 to {FOLD_LIMIT} characters, with exactly one {FOLD_COUNT}"),
        ));
    }
    for (field, phrase) in [("one", one), ("many", many)] {
        if starts_uppercase(phrase) {
            return Err(refusal(
                subject,
                &format!("{at}.{field}"),
                "must start lowercase; the row capitalizes the label it joins",
            ));
        }
    }
    Ok(())
}

fn starts_uppercase(phrase: &str) -> bool {
    phrase.chars().next().is_some_and(char::is_uppercase)
}

/// A row's status phrases (M91.1): each names one call, so it is as short
/// as a fold's `one`, has no count, and starts lowercase.
fn check_phrases(subject: &str, phrases: Option<&StatusPhrases>) -> Result<(), String> {
    let Some(phrases) = phrases else {
        return Ok(());
    };
    for (field, phrase) in [
        ("phrases.running", &phrases.running),
        ("phrases.done", &phrases.done),
        ("phrases.failed", &phrases.failed),
    ] {
        if !fits(phrase, FOLD_LIMIT) || phrase.contains(FOLD_COUNT) {
            return Err(refusal(
                subject,
                field,
                format!("must be 1 to {FOLD_LIMIT} characters, without {FOLD_COUNT}"),
            ));
        }
        if starts_uppercase(phrase) {
            return Err(refusal(
                subject,
                field,
                "must start lowercase; the row capitalizes the label it joins",
            ));
        }
    }
    Ok(())
}

impl ToolsManifest {
    /// `mcp__<server>__`, the prefix the CLI addresses these tools by.
    pub fn server_prefix(&self) -> String {
        format!("mcp__{}__", self.server)
    }

    pub fn door(&self, id: &str) -> Option<&Door> {
        self.doors.iter().find(|door| door.id == id)
    }

    fn validate(&self) -> Result<(), String> {
        const MANIFEST: &str = "manifest";
        if self.format != FORMAT {
            return Err(refusal(
                MANIFEST,
                "format",
                format!("must be {FORMAT}, not {}", self.format),
            ));
        }
        if self.artifact_version == 0 {
            return Err(refusal(MANIFEST, "artifact_version", "must be positive"));
        }
        if self.rule_version.trim().is_empty() {
            return Err(refusal(MANIFEST, "rule_version", "is empty"));
        }
        if !is_server_name(&self.server) {
            return Err(refusal(
                MANIFEST,
                "server",
                format!(
                    "must be lowercase letters, digits and hyphens, starting with a letter, \
                     not {:?}",
                    self.server
                ),
            ));
        }
        self.check_unique()?;
        for door in &self.doors {
            if door.writes && door.kinds.contains(&Kind::ReadOnly) {
                return Err(refusal(
                    &format!("door {}", door.id),
                    "kinds",
                    "allows read_only on a door that writes",
                ));
            }
        }
        for row in &self.tools {
            self.check_row(row)?;
        }
        self.check_generated()?;
        self.check_clients()?;
        self.check_never_call()?;
        for token in self.tokens.keys() {
            let marker = format!("{{{{{token}}}}}");
            let used = self.tools.iter().any(|row| {
                let mut texts = vec![row.description.as_str()];
                strings_in(&row.input_schema, &mut texts);
                texts.iter().any(|text| text.contains(&marker))
            });
            if !used {
                return Err(refusal(
                    &format!("token {token}"),
                    "tokens",
                    "declares it, and no tool uses it",
                ));
            }
        }
        for exception in &self.prefix_exceptions {
            if !self.tools.iter().any(|row| row.name == exception.name) {
                return Err(refusal(
                    &format!("prefix exception {}", exception.name),
                    "name",
                    "names no tool",
                ));
            }
        }
        for toolset in &self.toolsets {
            let used = self.generated.toolset == toolset.id
                || self
                    .tools
                    .iter()
                    .any(|row| row.toolset.as_deref() == Some(toolset.id.as_str()));
            if !used {
                return Err(refusal(
                    &format!("toolset {}", toolset.id),
                    "id",
                    "is used by no tool",
                ));
            }
        }
        for tool in &self.cli_tools {
            check_cli(tool)?;
        }
        self.check_aliases()
    }

    /// The CLI rows' names and aliases are one namespace (M91.1): a spelling
    /// answers with exactly one row's facts, so none is held twice.
    fn check_aliases(&self) -> Result<(), String> {
        let mut held: BTreeSet<&str> = self.cli_tools.iter().map(|t| t.name.as_str()).collect();
        for tool in &self.cli_tools {
            for alias in &tool.aliases {
                if !held.insert(alias.as_str()) {
                    return Err(refusal(
                        &format!("cli tool {}", tool.name),
                        "aliases",
                        format!("names {alias}, which a CLI row already answers to"),
                    ));
                }
            }
        }
        Ok(())
    }

    fn check_never_call(&self) -> Result<(), String> {
        if self.never_call.why.trim().is_empty() {
            return Err(refusal("never_call", "why", "is empty"));
        }
        let mut seen = std::collections::BTreeSet::new();
        let mut previous = "";
        for row in &self.never_call.tools {
            let subject = format!("never_call tool {}", row.name);
            if !(1..=64).contains(&row.name.len())
                || !row
                    .name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            {
                return Err(refusal(&subject, "name", "must match [A-Za-z0-9_-]{1,64}"));
            }
            if !seen.insert(row.name.as_str()) {
                return Err(refusal(&subject, "name", "is repeated"));
            }
            if previous > row.name.as_str() {
                return Err(refusal(&subject, "name", "must be in ASCII order"));
            }
            if self.tools.iter().any(|tool| tool.name == row.name) {
                return Err(refusal(&subject, "name", "names a cerebro tool"));
            }
            if row.source.trim().is_empty() {
                return Err(refusal(&subject, "source", "is empty"));
            }
            previous = &row.name;
        }
        Ok(())
    }

    fn check_clients(&self) -> Result<(), String> {
        let clients = &self.clients;
        if clients.why.trim().is_empty() {
            return Err(refusal("clients", "why", "is empty"));
        }
        if !self.toolsets.iter().any(|set| set.id == clients.default) {
            return Err(refusal(
                "clients",
                "default",
                format!("names no declared toolset: {:?}", clients.default),
            ));
        }
        let rows: Vec<_> = self
            .tools
            .iter()
            .filter(|row| row.toolset.as_deref() == Some(clients.default.as_str()))
            .collect();
        if rows.is_empty()
            || rows.iter().any(|row| {
                row.kind != Kind::ReadOnly || self.door(&row.door).is_none_or(|door| door.writes)
            })
            || clients.default == self.generated.toolset
        {
            return Err(refusal(
                "clients",
                "default",
                "must name a toolset of read_only rows on non-writing doors",
            ));
        }
        let mut seen = BTreeSet::new();
        for id in &clients.grantable {
            let problem =
                if !self.toolsets.iter().any(|set| set.id == *id) {
                    Some(format!("names no declared toolset: {id:?}"))
                } else if !seen.insert(id) {
                    Some(format!("repeats toolset {id:?}"))
                } else if *id == clients.default {
                    Some(format!("includes the default toolset {id:?}"))
                } else if *id == self.generated.toolset {
                    Some(format!("includes the generated toolset {id:?}"))
                } else if self.tools.iter().any(|row| {
                    row.toolset.as_deref() == Some(id.as_str()) && row.axis == Axis::None
                }) {
                    Some(format!(
                        "toolset {id:?} contains a row no folder scope bounds"
                    ))
                } else {
                    None
                };
            if let Some(problem) = problem {
                return Err(refusal("clients", "grantable", problem));
            }
        }
        Ok(())
    }

    /// No door, toolset, tool or CLI tool is declared twice.
    fn check_unique(&self) -> Result<(), String> {
        let groups: [(&str, &str, Vec<&str>); 4] = [
            (
                "door",
                "id",
                self.doors.iter().map(|d| d.id.as_str()).collect(),
            ),
            (
                "toolset",
                "id",
                self.toolsets.iter().map(|t| t.id.as_str()).collect(),
            ),
            (
                "tool",
                "name",
                self.tools.iter().map(|r| r.name.as_str()).collect(),
            ),
            (
                "cli tool",
                "name",
                self.cli_tools.iter().map(|c| c.name.as_str()).collect(),
            ),
        ];
        for (what, field, names) in groups {
            let mut seen = BTreeSet::new();
            for name in names {
                if !seen.insert(name) {
                    return Err(refusal(
                        &format!("{what} {name}"),
                        field,
                        "is declared twice",
                    ));
                }
            }
        }
        Ok(())
    }

    fn check_row(&self, row: &ToolRow) -> Result<(), String> {
        let subject = format!("tool {}", row.name);
        let subject = subject.as_str();
        if !is_snake(&row.name) {
            return Err(refusal(subject, "name", "must match [a-z][a-z_]*"));
        }
        let full = format!("{}{}", self.server_prefix(), row.name);
        if full.chars().count() > NAME_LIMIT {
            return Err(refusal(
                subject,
                "name",
                format!("is over {NAME_LIMIT} characters as {full}"),
            ));
        }
        if !fits(&row.title, TITLE_LIMIT) {
            return Err(refusal(
                subject,
                "title",
                format!("must be 1 to {TITLE_LIMIT} characters"),
            ));
        }
        if row.summary.chars().count() <= SUMMARY_FLOOR || row.summary == row.name {
            return Err(refusal(
                subject,
                "summary",
                format!("must be longer than {SUMMARY_FLOOR} characters and more than the name"),
            ));
        }
        if row.name.starts_with(&self.generated.prefix)
            && !self.prefix_exceptions.iter().any(|e| e.name == row.name)
        {
            return Err(refusal(
                subject,
                "name",
                format!(
                    "carries the generated prefix {}, and prefix_exceptions does not list it",
                    self.generated.prefix
                ),
            ));
        }
        check_fold(
            subject,
            row.fold.as_ref(),
            (row.kind != Kind::ReadOnly)
                .then(|| format!("a tool whose kind is {}", row.kind.as_str()))
                .as_deref(),
            row.renderer,
        )?;
        check_phrases(subject, row.phrases.as_ref())?;
        check_comment_door(subject, row)?;
        self.check_facts(
            subject,
            &Facts {
                toolset: row.toolset.as_deref(),
                kind: row.kind,
                idempotent: row.idempotent,
                door: &row.door,
                axis: row.axis,
                target: row.target.as_ref(),
                exempt: row.exempt.as_deref(),
                renderer: row.renderer,
                icon: &row.icon,
                search_hint: &row.search_hint,
            },
        )?;
        self.check_confirmable(subject, row)?;
        if row.renderer == Renderer::Commit && row.surface != Surface::Proposals {
            return Err(refusal(
                subject,
                "renderer",
                "commit needs the proposals surface",
            ));
        }
        let chars = row.description.chars().count();
        if !DESCRIPTION_CHARS.contains(&chars) {
            return Err(refusal(
                subject,
                "description",
                format!(
                    "must be {} to {} characters, not {chars}",
                    DESCRIPTION_CHARS.start(),
                    DESCRIPTION_CHARS.end()
                ),
            ));
        }
        let (properties, required) = schema_root(&row.input_schema)
            .map_err(|problem| refusal(subject, "input_schema", problem))?;
        if let Some(arg) = row.target.as_ref().and_then(|t| t.arg.as_deref()) {
            let property = &row.input_schema["properties"][arg];
            let root_folder = row
                .target
                .as_ref()
                .is_some_and(|target| target.kind == TargetKind::Folder)
                && property["type"] == "string"
                && property["default"].as_str() == Some("");
            if !properties.contains(arg) || (!required.contains(arg) && !root_folder) {
                return Err(refusal(
                    subject,
                    "target",
                    format!("names {arg}, which input_schema must declare and require"),
                ));
            }
        }
        let mut schema_texts = Vec::new();
        strings_in(&row.input_schema, &mut schema_texts);
        for (field, texts) in [
            ("description", vec![row.description.as_str()]),
            ("input_schema", schema_texts),
        ] {
            for text in texts {
                if let Some(token) = tokens_in(text)
                    .into_iter()
                    .find(|token| !self.tokens.contains_key(*token))
                {
                    return Err(refusal(
                        subject,
                        field,
                        format!("names {{{{{token}}}}}, which tokens does not declare"),
                    ));
                }
            }
        }
        Ok(())
    }

    /// `confirmable` sits only on a tool that writes the person's pages
    /// (M57.4): a door that writes, and the write or read_write axis, so the
    /// write has a note or folder a card can name.
    fn check_confirmable(&self, subject: &str, row: &ToolRow) -> Result<(), String> {
        if !row.confirmable {
            return Ok(());
        }
        if !self.door(&row.door).is_some_and(|door| door.writes) {
            return Err(refusal(
                subject,
                "confirmable",
                format!("is true on door {}, which writes nothing", row.door),
            ));
        }
        if !matches!(row.axis, Axis::Write | Axis::ReadWrite) {
            return Err(refusal(
                subject,
                "confirmable",
                format!(
                    "needs the write or read_write axis, not {}",
                    row.axis.as_str()
                ),
            ));
        }
        Ok(())
    }

    fn check_generated(&self) -> Result<(), String> {
        let generated = &self.generated;
        if generated.confirmable {
            return Err(refusal(
                "generated",
                "confirmable",
                "must be false: policy.v3 decides a proposal",
            ));
        }
        if !fits(&generated.title_prefix, TITLE_LIMIT) {
            return Err(refusal(
                "generated",
                "title_prefix",
                format!("must be 1 to {TITLE_LIMIT} characters"),
            ));
        }
        self.check_facts(
            "generated",
            &Facts {
                toolset: Some(&generated.toolset),
                kind: generated.kind,
                idempotent: generated.idempotent,
                door: &generated.door,
                axis: generated.axis,
                target: None,
                exempt: generated.exempt.as_deref(),
                renderer: generated.renderer,
                icon: &generated.icon,
                search_hint: &generated.search_hint,
            },
        )
    }

    /// The rules a row and the generated block both answer to.
    fn check_facts(&self, subject: &str, facts: &Facts) -> Result<(), String> {
        if facts.target.is_some_and(|t| t.kind == TargetKind::Canvas)
            && !((facts.axis == Axis::Read && facts.door == "none")
                || (facts.axis == Axis::ReadWrite && facts.door == "canvas"))
        {
            return Err(refusal(
                subject,
                "target",
                "canvas targets require read with door none or read_write with door canvas",
            ));
        }
        if facts.door == "canvas"
            && !((facts.axis == Axis::ReadWrite
                && facts.target.is_some_and(|t| t.kind == TargetKind::Canvas))
                || (facts.axis == Axis::Write
                    && facts.target.is_some_and(|t| t.kind == TargetKind::Folder)))
        {
            return Err(refusal(
                subject,
                "target",
                "door canvas needs a canvas target on read_write or a folder target on write",
            ));
        }
        if facts.target.is_some_and(|t| t.kind == TargetKind::File)
            && (facts.axis != Axis::Read || facts.door != "none")
        {
            return Err(refusal(
                subject,
                "target",
                "file targets require the read axis and door none",
            ));
        }
        if let Some(toolset) = facts.toolset {
            if !self.toolsets.iter().any(|t| t.id == toolset) {
                return Err(refusal(
                    subject,
                    "toolset",
                    format!("names {toolset}, which no toolset declares"),
                ));
            }
        }
        let door = self.door(facts.door).ok_or_else(|| {
            refusal(
                subject,
                "door",
                format!("names {}, which no door declares", facts.door),
            )
        })?;
        if !door.kinds.contains(&facts.kind) {
            return Err(refusal(
                subject,
                "kind",
                format!(
                    "{} is not a kind door {} allows",
                    facts.kind.as_str(),
                    door.id
                ),
            ));
        }
        if facts.kind == Kind::ReadOnly && !facts.idempotent {
            return Err(refusal(
                subject,
                "idempotent",
                "must be true for a read_only tool",
            ));
        }
        if !door.axes.contains(&facts.axis) {
            return Err(refusal(
                subject,
                "axis",
                format!(
                    "{} is not an axis door {} allows",
                    facts.axis.as_str(),
                    door.id
                ),
            ));
        }
        if let Some(target) = facts.target {
            match (target.kind, target.arg.as_deref()) {
                (TargetKind::Bundle, Some(_)) => {
                    return Err(refusal(subject, "target", "bundle takes no argument"));
                }
                (TargetKind::Bundle, None) => {}
                (kind, None | Some("")) => {
                    return Err(refusal(
                        subject,
                        "target",
                        format!("{} needs an argument", kind.as_str()),
                    ));
                }
                (_, Some(_)) => {}
            }
        }
        match (facts.axis, facts.target.map(|t| t.kind)) {
            (Axis::Write, Some(TargetKind::Note | TargetKind::Folder)) => {}
            (Axis::Write, _) => {
                return Err(refusal(
                    subject,
                    "target",
                    "must name a note or folder argument on the write axis",
                ));
            }
            (Axis::ReadWrite, Some(TargetKind::Note | TargetKind::Canvas)) => {}
            (Axis::ReadWrite, _) => {
                return Err(refusal(
                    subject,
                    "target",
                    "must name a note or canvas argument on the read_write axis",
                ));
            }
            (Axis::Read, Some(kind))
                if !matches!(
                    kind,
                    TargetKind::Note | TargetKind::File | TargetKind::Canvas | TargetKind::Bundle
                ) =>
            {
                return Err(refusal(
                    subject,
                    "target",
                    format!(
                        "on the read axis must be a note, file, canvas or the bundle, not {}",
                        kind.as_str()
                    ),
                ));
            }
            _ => {}
        }
        match (facts.axis, facts.exempt) {
            (Axis::None, Some(why)) if !why.trim().is_empty() => {}
            (Axis::None, _) => {
                return Err(refusal(
                    subject,
                    "exempt",
                    "must say why no folder axis binds the tool",
                ));
            }
            (axis, Some(_)) => {
                return Err(refusal(
                    subject,
                    "exempt",
                    format!("is set, but the {} axis binds the tool", axis.as_str()),
                ));
            }
            (_, None) => {}
        }
        if facts.renderer == Renderer::Change && !door.writes {
            return Err(refusal(
                subject,
                "renderer",
                format!("change needs a door that writes, and {} does not", door.id),
            ));
        }
        // A change card shows the path it changed, and a concept row opens
        // the concept to review: both need the argument that names it.
        if matches!(facts.renderer, Renderer::Change | Renderer::Concept) && facts.target.is_none()
        {
            return Err(refusal(
                subject,
                "renderer",
                format!("{} needs a target", facts.renderer.as_str()),
            ));
        }
        if let Some(needed) = facts.renderer.door() {
            if door.id != needed {
                return Err(refusal(
                    subject,
                    "renderer",
                    format!(
                        "{} needs door {needed}, not {}",
                        facts.renderer.as_str(),
                        door.id
                    ),
                ));
            }
        }
        if facts.renderer.cli_only() {
            return Err(refusal(
                subject,
                "renderer",
                format!(
                    "{} draws one of the CLI's own tools, never a cerebro tool",
                    facts.renderer.as_str()
                ),
            ));
        }
        if !is_kebab(facts.icon) {
            return Err(refusal(
                subject,
                "icon",
                format!("must be a kebab-case name, not {:?}", facts.icon),
            ));
        }
        if !fits(facts.search_hint, SEARCH_HINT_LIMIT) {
            return Err(refusal(
                subject,
                "search_hint",
                format!("must be 1 to {SEARCH_HINT_LIMIT} characters"),
            ));
        }
        Ok(())
    }
}

/// Door `comment` holds one shape of row (M70.3): a read of one note, which
/// posts beside it and draws as a step. Judged before the door's own lists,
/// so a misplaced row hears this one sentence whatever else it breaks.
fn check_comment_door(subject: &str, row: &ToolRow) -> Result<(), String> {
    // File targets have one cross-loader refusal, checked by check_facts.
    if row
        .target
        .as_ref()
        .is_some_and(|t| matches!(t.kind, TargetKind::File | TargetKind::Canvas))
    {
        return Ok(());
    }
    let shaped = row.axis == Axis::Read
        && row
            .target
            .as_ref()
            .is_some_and(|target| target.kind == TargetKind::Note)
        && row.kind == Kind::Additive
        && row.renderer == Renderer::Step;
    if row.door == COMMENT_DOOR && !shaped {
        return Err(refusal(
            subject,
            "door",
            "comment takes only axis read, a note target, kind additive and renderer step",
        ));
    }
    Ok(())
}

/// A schema root's property names and its required list, or what is wrong
/// with it: the root must be an object type with properties, and `required`
/// must list only properties it declares.
fn schema_root(schema: &Value) -> Result<(BTreeSet<&str>, BTreeSet<&str>), String> {
    let root = schema
        .as_object()
        .filter(|root| root.get("type").and_then(Value::as_str) == Some("object"))
        .ok_or("must be an object type")?;
    let properties: BTreeSet<&str> = root
        .get("properties")
        .and_then(Value::as_object)
        .ok_or("must declare its properties")?
        .keys()
        .map(String::as_str)
        .collect();
    let required: Vec<&str> = root
        .get("required")
        .and_then(Value::as_array)
        .ok_or("must list what it requires")?
        .iter()
        .map(|name| name.as_str().ok_or("requires a name that is not a string"))
        .collect::<Result<_, _>>()?;
    if let Some(missing) = required.iter().find(|name| !properties.contains(*name)) {
        return Err(format!("requires {missing}, which it does not declare"));
    }
    Ok((properties, required.into_iter().collect()))
}

fn check_cli(tool: &CliTool) -> Result<(), String> {
    let subject = format!("cli tool {}", tool.name);
    let subject = subject.as_str();
    if !is_pascal(&tool.name) {
        return Err(refusal(subject, "name", "must match [A-Z][A-Za-z]*"));
    }
    if !tool.aliases.iter().all(|alias| is_pascal(alias)) {
        return Err(refusal(
            subject,
            "aliases",
            "must each match [A-Z][A-Za-z]*",
        ));
    }
    check_fold(
        subject,
        tool.fold.as_ref(),
        tool.writes.then_some("a tool that writes"),
        tool.renderer,
    )?;
    check_phrases(subject, tool.phrases.as_ref())?;
    if tool.renderer.door().is_some() {
        return Err(refusal(
            subject,
            "renderer",
            format!(
                "{} draws a cerebro tool's own door, never a CLI tool",
                tool.renderer.as_str()
            ),
        ));
    }
    if !tool.family.as_deref().is_some_and(is_snake) {
        return Err(refusal(
            subject,
            "family",
            "must name a tool-approval family, [a-z][a-z_]*",
        ));
    }
    if tool
        .subject
        .as_deref()
        .is_some_and(|field| !is_snake(field))
    {
        return Err(refusal(
            subject,
            "subject",
            "must be null or an input field, [a-z][a-z_]*",
        ));
    }
    if tool.renderer == Renderer::Change && !tool.writes {
        return Err(refusal(
            subject,
            "renderer",
            "change needs a tool that writes",
        ));
    }
    if !is_kebab(&tool.icon) {
        return Err(refusal(
            subject,
            "icon",
            format!("must be a kebab-case name, not {:?}", tool.icon),
        ));
    }
    Ok(())
}

/// Parse and fully validate a manifest.
pub fn parse(raw: &str) -> Result<ToolsManifest, String> {
    let manifest: ToolsManifest =
        serde_json::from_str(raw).map_err(|e| format!("{TOOLS_PATH}: {e}"))?;
    manifest.validate()?;
    Ok(manifest)
}

/// The compiled-in manifest. The bytes are compiled in and
/// `the_shipped_manifest_validates` loads them, so a failure here is a build
/// nobody tested.
pub fn manifest() -> &'static ToolsManifest {
    static LOADED: OnceLock<ToolsManifest> = OnceLock::new();
    LOADED.get_or_init(|| parse(TOOLS_JSON).expect("the compiled tool manifest validates"))
}

/// `name` without the `mcp__<server>__` prefix, or as given.
pub fn bare_name(name: &str) -> &str {
    name.strip_prefix("mcp__")
        .and_then(|rest| rest.strip_prefix(manifest().server.as_str()))
        .and_then(|rest| rest.strip_prefix("__"))
        .unwrap_or(name)
}

/// The hand-written tool `name` names, in its short or its
/// `mcp__<server>__` spelling.
pub fn row(name: &str) -> Option<&'static ToolRow> {
    let bare = bare_name(name);
    manifest().tools.iter().find(|row| row.name == bare)
}

/// The rows served on `surface`, in served order.
pub fn rows(surface: Surface) -> impl Iterator<Item = &'static ToolRow> {
    manifest()
        .tools
        .iter()
        .filter(move |row| row.surface == surface)
}

pub fn generated() -> &'static Generated {
    &manifest().generated
}

pub fn clients() -> &'static Clients {
    &manifest().clients
}

/// Every loaded connector is denied these exact tool spellings.
pub fn never_call_names() -> impl Iterator<Item = &'static str> {
    manifest()
        .never_call
        .tools
        .iter()
        .map(|row| row.name.as_str())
}

pub fn toolset_writes(id: &str) -> bool {
    manifest()
        .tools
        .iter()
        .any(|row| row.toolset.as_deref() == Some(id) && door(&row.door).is_some_and(|d| d.writes))
}

/// A token holds its default and only the explicit grantable sets. Names
/// stay in served order, regardless of the order of the person's checkboxes.
pub fn client_tool_names(toolsets: &[String]) -> Result<Vec<String>, String> {
    let clients = clients();
    if !toolsets.contains(&clients.default) {
        return Err(format!(
            "A token must include the {:?} toolset.",
            clients.default
        ));
    }
    let mut seen = BTreeSet::new();
    for id in toolsets {
        if !seen.insert(id) {
            return Err(format!(
                "A token can't repeat the {} toolset.",
                serde_json::to_string(id).expect("a string serializes")
            ));
        }
        if *id != clients.default && !clients.grantable.contains(id) {
            return Err(format!(
                "A token can't hold the {} toolset.",
                serde_json::to_string(id).expect("a string serializes")
            ));
        }
    }
    Ok(manifest()
        .tools
        .iter()
        .filter(|row| row.toolset.as_ref().is_some_and(|id| toolsets.contains(id)))
        .map(|row| row.name.clone())
        .collect())
}

/// A declared door.
pub fn door(id: &str) -> Option<&'static Door> {
    manifest().door(id)
}

/// The op a generated tool name proposes, or `None`. The prefix alone is not
/// enough: the table must carry the op as agent-facing, which is what keeps
/// `propose_organize` (a row, not an op) off the mutation boundary.
pub fn generated_op<'a>(name: &'a str, table: &PolicyTable) -> Option<&'a str> {
    let op = name.strip_prefix(generated().prefix.as_str())?;
    table.agent_facing_ops().contains(&op).then_some(op)
}

/// Does a successful call to `name` change something on disk? From the row's
/// door, the generated door for an agent-facing op, or the CLI row; false for
/// a name the manifest does not know.
pub fn writes_disk(name: &str) -> bool {
    let bare = bare_name(name);
    if let Some(row) = row(bare) {
        return door(&row.door).is_some_and(|door| door.writes);
    }
    if bare.starts_with(generated().prefix.as_str()) {
        return door(&generated().door).is_some_and(|door| door.writes)
            && PolicyTable::load().is_ok_and(|table| generated_op(bare, &table).is_some());
    }
    cli_tool(bare).is_some_and(|tool| tool.writes)
}

/// How a transcript draws a call to `name` (M56.8): the row's renderer, the
/// generated block's for an agent-facing op, or the CLI row's; a step for a
/// name the manifest does not know (another server's tool).
pub fn renderer(name: &str) -> Renderer {
    let bare = bare_name(name);
    if let Some(row) = row(bare) {
        return row.renderer;
    }
    if bare.starts_with(generated().prefix.as_str())
        && PolicyTable::load().is_ok_and(|table| generated_op(bare, &table).is_some())
    {
        return generated().renderer;
    }
    cli_tool(bare).map_or(Renderer::Step, |tool| tool.renderer)
}

/// The phrases a run of calls to `name` folds under (M56.8), or `None` for a
/// tool that never folds: a writer, a generated tool, another server's tool.
pub fn fold(name: &str) -> Option<&'static FoldPhrases> {
    let bare = bare_name(name);
    if let Some(row) = row(bare) {
        return row.fold.as_ref();
    }
    cli_tool(bare).and_then(|tool| tool.fold.as_ref())
}

/// Does `name` name a confirmable tool (M57.4)? Spelled any way the one
/// name test takes (`agent::names_tool`): trimmed, ignoring ASCII case, and
/// with or without the `mcp__<server>__` prefix.
pub fn confirmable(name: &str) -> bool {
    let wanted = name.trim().to_ascii_lowercase();
    let bare = bare_name(&wanted);
    manifest()
        .tools
        .iter()
        .any(|row| row.confirmable && row.name == bare)
}

/// The confirmable rows' names, as the CLI spells them, in served order.
pub fn confirmable_names() -> Vec<String> {
    let prefix = manifest().server_prefix();
    manifest()
        .tools
        .iter()
        .filter(|row| row.confirmable)
        .map(|row| format!("{prefix}{}", row.name))
        .collect()
}

/// The words a JSON type takes in a refusal of an edited draft (M57.4b).
fn type_words(json_type: &str) -> &str {
    match json_type {
        "string" => "a string",
        "boolean" => "true or false",
        "integer" => "a whole number",
        "number" => "a number",
        "object" => "an object",
        "array" => "a list",
        "null" => "null",
        other => other,
    }
}

/// Does `value` have JSON type `json_type`? An integer is a number too.
fn has_type(value: &Value, json_type: &str) -> bool {
    match json_type {
        "string" => value.is_string(),
        "boolean" => value.is_boolean(),
        "integer" => value.is_i64() || value.is_u64(),
        "number" => value.is_number(),
        "object" => value.is_object(),
        "array" => value.is_array(),
        "null" => value.is_null(),
        _ => true,
    }
}

/// Is `input` the shape tool `name`'s schema declares (M57.4b)? A person's
/// edited draft is checked here at the answer, before anything is recorded:
/// it must be an object, hold every required key, hold no key the schema
/// does not declare, and give each key a value of its declared `type` (an
/// array of types allows any of them, `null` among them). A property with
/// no `type` takes any value; the tool body judges the rest. Each refusal
/// names the key. A name with no hand-written row takes no draft. The
/// renderer's form (`src/engine/writeDraft.ts`'s `draftRefusal`) speaks the
/// same words, for the mock's book.
pub fn validate_input(name: &str, input: &Value) -> Result<(), String> {
    let row = row(name).ok_or_else(|| format!("{} takes no edited draft.", bare_name(name)))?;
    let object = input
        .as_object()
        .ok_or("The edited draft must be a JSON object.")?;
    let schema = &row.input_schema;
    let properties = schema.get("properties").and_then(Value::as_object);
    let required = schema
        .get("required")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str);
    for key in required {
        if !object.contains_key(key) {
            return Err(format!(
                "The edited draft leaves out {key}, which this tool requires."
            ));
        }
    }
    for (key, value) in object {
        let Some(declared) = properties.and_then(|p| p.get(key)) else {
            return Err(format!(
                "The edited draft has {key}, which this tool does not take."
            ));
        };
        let types: Vec<&str> = match declared.get("type") {
            Some(Value::String(one)) => vec![one.as_str()],
            Some(Value::Array(many)) => many.iter().filter_map(Value::as_str).collect(),
            _ => continue,
        };
        if !types.iter().any(|t| has_type(value, t)) {
            let words: Vec<&str> = types.iter().map(|t| type_words(t)).collect();
            return Err(format!(
                "The edited draft's {key} must be {}.",
                words.join(" or ")
            ));
        }
    }
    Ok(())
}

/// The CLI built-in named `name`, as the CLI spells it: its row's name or one
/// of its aliases (M91.1), so `Task` and `Agent` answer with one row's facts.
/// The one lookup every reader of a built-in's facts goes through.
pub fn cli_tool(name: &str) -> Option<&'static CliTool> {
    manifest()
        .cli_tools
        .iter()
        .find(|tool| tool.name == name || tool.aliases.iter().any(|alias| alias == name))
}

/// The CLI built-ins `select` keeps, in argv order, by their names.
pub fn cli_names(select: impl Fn(&CliTool) -> bool) -> Vec<&'static str> {
    manifest()
        .cli_tools
        .iter()
        .filter(|tool| select(tool))
        .map(|tool| tool.name.as_str())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn repo(rel: &str) -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join(rel)
    }

    #[test]
    fn the_loaded_bytes_match_the_committed_digest() {
        let committed = std::fs::read_to_string(repo(TOOLS_DIGEST_PATH))
            .expect("read the committed tool-manifest digest")
            .trim()
            .to_string();
        assert_eq!(
            crate::ledger::sha256_hex(TOOLS_JSON.as_bytes()),
            committed,
            "the manifest changed without regenerating {TOOLS_DIGEST_PATH} — run \
             `cargo test --lib policy::tools::tests::write_tools_digest -- --ignored`"
        );
    }

    /// Re-stamp the digest after a deliberate manifest edit.
    #[test]
    #[ignore = "run explicitly after a deliberate tool-manifest edit"]
    fn write_tools_digest() {
        let digest = crate::ledger::sha256_hex(TOOLS_JSON.as_bytes());
        std::fs::write(repo(TOOLS_DIGEST_PATH), format!("{digest}\n")).unwrap();
    }

    #[test]
    fn the_compiled_manifest_is_the_file_on_disk() {
        // `include_str!` binds at compile time; a stale build that disagreed
        // with the tree would make every other manifest test meaningless.
        let disk = std::fs::read_to_string(repo(TOOLS_PATH)).expect("read the tool manifest");
        assert_eq!(disk, TOOLS_JSON);
    }

    #[test]
    fn the_shipped_manifest_validates() {
        let manifest = parse(TOOLS_JSON).expect("the committed tool manifest must load");
        assert_eq!(manifest.format, FORMAT);
        assert!(!manifest.tools.is_empty());
        assert!(!manifest.cli_tools.is_empty());
    }

    #[test]
    fn no_tool_reaches_outside_the_app() {
        // Every row and every generated tool stays inside the vault and the
        // app, so none is served with openWorldHint. Connector tools reach
        // the world; these do not.
        for row in &manifest().tools {
            assert!(!row.open_world, "{} reaches outside the app", row.name);
        }
        assert!(!generated().open_world, "the generated tools reach outside");
    }

    // --- What the load refuses -------------------------------------------
    //
    // One negative control per refusal, each on a mutated copy of the
    // shipped bytes, and each message names what it refused and the field.

    /// A mutation of the shipped manifest, and what its refusal must name.
    type Case = (Box<dyn FnOnce(&mut Value)>, &'static [&'static str]);

    fn refused(mutate: impl FnOnce(&mut Value)) -> String {
        let mut raw: Value = serde_json::from_str(TOOLS_JSON).unwrap();
        mutate(&mut raw);
        parse(&raw.to_string()).expect_err("the mutated manifest must not load")
    }

    fn tool<'a>(raw: &'a mut Value, name: &str) -> &'a mut Value {
        raw["tools"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|row| row["name"] == name)
            .unwrap_or_else(|| panic!("the manifest has a {name} row"))
    }

    fn cli<'a>(raw: &'a mut Value, name: &str) -> &'a mut Value {
        raw["cli_tools"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|row| row["name"] == name)
            .unwrap_or_else(|| panic!("the manifest has a {name} CLI row"))
    }

    fn assert_names(err: &str, fragments: &[&str]) {
        for fragment in fragments {
            assert!(err.contains(fragment), "{fragment:?} missing from: {err}");
        }
    }

    // --- The confirmable column (M57.4) ------------------------------------

    #[test]
    fn confirmable_sits_only_on_note_writers() {
        let cases: Vec<Case> = vec![
            (
                Box::new(|v| tool(v, "get_note")["confirmable"] = json!(true)),
                &[
                    "tool get_note",
                    "`confirmable`",
                    "door none, which writes nothing",
                ],
            ),
            (
                Box::new(|v| tool(v, "write_concept")["confirmable"] = json!(true)),
                &[
                    "tool write_concept",
                    "`confirmable`",
                    "write or read_write axis, not none",
                ],
            ),
            (
                Box::new(|v| v["generated"]["confirmable"] = json!(true)),
                &["generated", "`confirmable`", "policy.v3"],
            ),
        ];
        for (mutate, fragments) in cases {
            assert_names(&refused(mutate), fragments);
        }
        // A row without the column fails the parse, naming the field.
        let missing = refused(|v| {
            tool(v, "create_note")
                .as_object_mut()
                .unwrap()
                .remove("confirmable");
        });
        assert_names(&missing, &["missing field `confirmable`"]);
    }

    #[test]
    fn the_shipped_manifest_confirms_exactly_the_page_and_board_writers() {
        let rows: Vec<&str> = manifest()
            .tools
            .iter()
            .filter(|row| row.confirmable)
            .map(|row| row.name.as_str())
            .collect();
        assert_eq!(
            rows,
            [
                "create_note",
                "update_frontmatter",
                "set_fields",
                "append_to_note",
                "edit_note",
                "edit_sheet",
                "create_canvas",
                "edit_canvas"
            ]
        );
        assert!(!generated().confirmable);
        assert_eq!(
            confirmable_names(),
            [
                "mcp__cerebro__create_note",
                "mcp__cerebro__update_frontmatter",
                "mcp__cerebro__set_fields",
                "mcp__cerebro__append_to_note",
                "mcp__cerebro__edit_note",
                "mcp__cerebro__edit_sheet",
                "mcp__cerebro__create_canvas",
                "mcp__cerebro__edit_canvas"
            ]
        );
        // Every spelling the one name test takes, and nothing else.
        for name in [
            "create_note",
            " Create_Note ",
            "mcp__cerebro__create_note",
            "MCP__CEREBRO__EDIT_NOTE",
        ] {
            assert!(confirmable(name), "{name}");
        }
        for name in [
            "get_note",
            "write_concept",
            "propose_organize",
            "Write",
            "mcp__other__create_note",
            "",
        ] {
            assert!(!confirmable(name), "{name}");
        }
    }

    // --- Door comment (M70.3) ------------------------------------------------

    /// The one refusal a misplaced comment row hears, in src/lib/policy/
    /// tools.ts's words too.
    fn comment_door_refusal(name: &str) -> String {
        format!(
            "{TOOLS_PATH}: tool {name}: `door` comment takes only axis read, a note target, kind \
             additive and renderer step"
        )
    }

    #[test]
    fn door_comment_holds_only_reads_of_one_note_drawn_as_steps() {
        type Named = (&'static str, Box<dyn FnOnce(&mut Value)>);
        let cases: Vec<Named> = vec![
            (
                "comment_on_note",
                Box::new(|v| tool(v, "comment_on_note")["axis"] = json!("read_write")),
            ),
            (
                "reply_to_comment",
                Box::new(|v| {
                    tool(v, "reply_to_comment")["target"] = json!({ "arg": null, "kind": "bundle" })
                }),
            ),
            (
                "resolve_comment",
                Box::new(|v| tool(v, "resolve_comment")["renderer"] = json!("change")),
            ),
            (
                "comment_on_note",
                Box::new(|v| tool(v, "comment_on_note")["kind"] = json!("destructive")),
            ),
            (
                "get_note",
                Box::new(|v| tool(v, "get_note")["door"] = json!("comment")),
            ),
        ];
        for (name, mutate) in cases {
            assert_eq!(refused(mutate), comment_door_refusal(name));
        }
        // A comment row is never confirmable: its door writes nothing.
        assert_names(
            &refused(|v| tool(v, "comment_on_note")["confirmable"] = json!(true)),
            &["tool comment_on_note", "`confirmable`", "door comment"],
        );
    }

    #[test]
    fn the_comment_door_writes_nothing_and_holds_the_three_comment_tools() {
        let door = door(COMMENT_DOOR).expect("door comment is declared");
        assert!(!door.writes);
        let rows: Vec<&str> = manifest()
            .tools
            .iter()
            .filter(|row| row.door == COMMENT_DOOR)
            .map(|row| row.name.as_str())
            .collect();
        assert_eq!(
            rows,
            ["comment_on_note", "reply_to_comment", "resolve_comment"]
        );
        for name in rows {
            assert!(!writes_disk(name), "{name}");
            assert_eq!(row(name).unwrap().toolset.as_deref(), Some("comment"));
        }
    }

    // --- An edited draft's shape (M57.4b) -----------------------------------

    /// A value of the first type a property declares.
    fn sample_of(schema: &Value) -> Value {
        let first = match schema.get("type") {
            Some(Value::String(one)) => one.as_str(),
            Some(Value::Array(many)) => many.first().and_then(Value::as_str).unwrap_or("string"),
            _ => "string",
        };
        match first {
            "boolean" => json!(true),
            "integer" => json!(1),
            "number" => json!(1.5),
            "object" => json!({}),
            "array" => json!([]),
            "null" => Value::Null,
            _ => json!("x"),
        }
    }

    #[test]
    fn every_confirmable_row_accepts_a_valid_sample() {
        for row in manifest().tools.iter().filter(|row| row.confirmable) {
            let properties = row.input_schema["properties"].as_object().unwrap();
            let full: serde_json::Map<String, Value> = properties
                .iter()
                .map(|(key, schema)| (key.clone(), sample_of(schema)))
                .collect();
            let required: serde_json::Map<String, Value> = full
                .iter()
                .filter(|(key, _)| {
                    row.input_schema["required"]
                        .as_array()
                        .unwrap()
                        .contains(&json!(key))
                })
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect();
            for sample in [Value::Object(full), Value::Object(required)] {
                assert_eq!(validate_input(&row.name, &sample), Ok(()), "{}", row.name);
                let spelled = format!("mcp__cerebro__{}", row.name);
                assert_eq!(validate_input(&spelled, &sample), Ok(()), "{spelled}");
            }
        }
    }

    #[test]
    fn validate_input_refuses_a_misshapen_draft_naming_the_key() {
        let create = |value: Value| validate_input("create_note", &value);
        let good = json!({ "folder": "records/risks", "slug": "v", "body": "# V\n" });
        assert_eq!(create(good.clone()), Ok(()));
        assert_eq!(
            create(json!(["not", "an", "object"])),
            Err("The edited draft must be a JSON object.".into())
        );
        assert_eq!(
            create(json!("{\"folder\": \"\"}")),
            Err("The edited draft must be a JSON object.".into())
        );
        assert_eq!(
            create(json!({ "folder": "", "body": "# V\n" })),
            Err("The edited draft leaves out slug, which this tool requires.".into())
        );
        let mut undeclared = good.clone();
        undeclared["path"] = json!("records/risks/other.md");
        assert_eq!(
            create(undeclared),
            Err("The edited draft has path, which this tool does not take.".into())
        );
        let mut wrong = good.clone();
        wrong["body"] = json!(7);
        assert_eq!(
            create(wrong),
            Err("The edited draft's body must be a string.".into())
        );
        let mut nulled = good;
        nulled["frontmatter"] = Value::Null;
        assert_eq!(
            create(nulled),
            Err("The edited draft's frontmatter must be an object.".into())
        );
        let hashed = |hash: Value| {
            validate_input(
                "edit_note",
                &json!({ "path": "a.md", "edits": [], "expect_hash": hash }),
            )
        };
        assert_eq!(
            hashed(json!(2)),
            Err("The edited draft's expect_hash must be a string.".into())
        );
        // M60.4: a set_fields draft takes its three key maps as objects.
        let fields = json!({
            "path": "records/risks/r-1.md",
            "set": { "status": "Closed" },
            "add": { "owners": ["ana"] },
            "remove": { "tags": "stale" },
            "expect_hash": "a".repeat(64),
        });
        assert_eq!(validate_input("set_fields", &fields), Ok(()));
        assert_eq!(
            validate_input("set_fields", &json!({ "path": "r.md", "set": ["status"] })),
            Err("The edited draft's set must be an object.".into())
        );
        assert_eq!(
            validate_input("get_vault_context_nope", &json!({})),
            Err("get_vault_context_nope takes no edited draft.".into())
        );
        // A whole number is a number too; a fraction is no whole number.
        assert!(has_type(&Value::Null, "null") && has_type(&json!(3), "number"));
        assert!(!has_type(&json!(1.5), "integer"));
    }

    #[test]
    fn the_manifest_level_refusals_name_the_field() {
        let cases: Vec<Case> = vec![
            (
                Box::new(|v| v["format"] = json!(2)),
                &["manifest", "`format`"],
            ),
            (
                Box::new(|v| v["artifact_version"] = json!(0)),
                &["manifest", "`artifact_version`"],
            ),
            (
                Box::new(|v| v["rule_version"] = json!(" ")),
                &["manifest", "`rule_version`"],
            ),
            (
                Box::new(|v| v["server"] = json!("cere__bro")),
                &["manifest", "`server`"],
            ),
            (
                Box::new(|v| {
                    let first = v["doors"][0].clone();
                    v["doors"].as_array_mut().unwrap().push(first);
                }),
                &["door none", "`id`", "twice"],
            ),
            (
                Box::new(|v| {
                    let first = v["toolsets"][0].clone();
                    v["toolsets"].as_array_mut().unwrap().push(first);
                }),
                &["toolset read", "`id`", "twice"],
            ),
            (
                Box::new(|v| {
                    let first = v["tools"][0].clone();
                    v["tools"].as_array_mut().unwrap().push(first);
                }),
                &["tool get_vault_context", "`name`", "twice"],
            ),
            (
                Box::new(|v| {
                    let first = v["cli_tools"][0].clone();
                    v["cli_tools"].as_array_mut().unwrap().push(first);
                }),
                &["cli tool Write", "`name`", "twice"],
            ),
            (
                Box::new(|v| {
                    v["doors"][1]["kinds"]
                        .as_array_mut()
                        .unwrap()
                        .push(json!("read_only"));
                }),
                &["door note", "`kinds`", "read_only"],
            ),
            (
                Box::new(|v| {
                    v["toolsets"].as_array_mut().unwrap().push(json!({
                        "id": "spare",
                        "label": "Spare",
                        "hint": "Holds nothing."
                    }));
                }),
                &["toolset spare", "`id`", "no tool"],
            ),
        ];
        for (mutate, fragments) in cases {
            assert_names(&refused(mutate), fragments);
        }
    }

    #[test]
    fn the_row_refusals_name_the_row_and_the_field() {
        let cases: Vec<Case> = vec![
            (
                Box::new(|v| tool(v, "get_note")["name"] = json!("Get_note")),
                &["tool Get_note", "`name`", "[a-z][a-z_]*"],
            ),
            (
                Box::new(|v| tool(v, "get_note")["name"] = json!("get_note_".repeat(6))),
                &["tool get_note_get_note_", "`name`", "over 64"],
            ),
            (
                Box::new(|v| tool(v, "get_note")["title"] = json!("")),
                &["tool get_note", "`title`"],
            ),
            (
                Box::new(|v| tool(v, "get_note")["title"] = json!("t".repeat(65))),
                &["tool get_note", "`title`"],
            ),
            (
                Box::new(|v| tool(v, "get_note")["summary"] = json!("Read it")),
                &["tool get_note", "`summary`"],
            ),
            (
                Box::new(|v| tool(v, "search_notes")["summary"] = json!("search_notes")),
                &["tool search_notes", "`summary`"],
            ),
            (
                Box::new(|v| tool(v, "get_note")["toolset"] = json!("reading")),
                &["tool get_note", "`toolset`", "names reading"],
            ),
            (
                Box::new(|v| tool(v, "get_note")["door"] = json!("window")),
                &["tool get_note", "`door`", "names window"],
            ),
            (
                Box::new(|v| tool(v, "write_concept")["kind"] = json!("additive")),
                &["tool write_concept", "`kind`", "door concept allows"],
            ),
            (
                Box::new(|v| tool(v, "get_note")["idempotent"] = json!(false)),
                &["tool get_note", "`idempotent`", "read_only"],
            ),
            (
                Box::new(|v| tool(v, "hand_to")["axis"] = json!("write")),
                &["tool hand_to", "`axis`", "door run allows"],
            ),
            (
                Box::new(|v| tool(v, "get_note")["axis"] = json!("read_write")),
                &["tool get_note", "`axis`", "read_write", "door none allows"],
            ),
        ];
        for (mutate, fragments) in cases {
            assert_names(&refused(mutate), fragments);
        }
    }

    #[test]
    fn the_target_refusals_name_the_row_and_the_field() {
        let cases: Vec<Case> = vec![
            (
                Box::new(|v| tool(v, "create_note")["target"] = Value::Null),
                &["tool create_note", "`target`", "write axis"],
            ),
            (
                Box::new(|v| tool(v, "create_note")["target"]["kind"] = json!("concept")),
                &["tool create_note", "`target`", "write axis"],
            ),
            (
                Box::new(|v| tool(v, "get_note")["target"]["kind"] = json!("concept")),
                &["tool get_note", "`target`", "read axis"],
            ),
            (
                Box::new(|v| tool(v, "edit_note")["target"]["kind"] = json!("folder")),
                &["tool edit_note", "`target`", "read_write axis"],
            ),
            (
                Box::new(|v| tool(v, "get_note")["target"]["arg"] = json!("note_path")),
                &["tool get_note", "`target`", "names note_path"],
            ),
            (
                Box::new(|v| {
                    tool(v, "create_note")["input_schema"]["required"] = json!(["slug", "body"]);
                }),
                &["tool create_note", "`target`", "names folder"],
            ),
            (
                Box::new(|v| tool(v, "knowledge_about")["target"]["arg"] = json!("target")),
                &["tool knowledge_about", "`target`", "bundle"],
            ),
            (
                Box::new(|v| tool(v, "cache_source")["target"]["arg"] = Value::Null),
                &["tool cache_source", "`target`", "source_id"],
            ),
            (
                Box::new(|v| tool(v, "navigate")["exempt"] = Value::Null),
                &["tool navigate", "`exempt`"],
            ),
            (
                Box::new(|v| tool(v, "navigate")["exempt"] = json!("  ")),
                &["tool navigate", "`exempt`"],
            ),
            (
                Box::new(|v| tool(v, "search_notes")["exempt"] = json!("reads")),
                &["tool search_notes", "`exempt`", "read axis"],
            ),
        ];
        for (mutate, fragments) in cases {
            assert_names(&refused(mutate), fragments);
        }
    }

    #[test]
    fn the_content_refusals_name_the_row_and_the_field() {
        let cases: Vec<Case> = vec![
            (
                Box::new(|v| tool(v, "open_note")["renderer"] = json!("change")),
                &["tool open_note", "`renderer`", "door that writes"],
            ),
            (
                Box::new(|v| tool(v, "write_concept")["target"] = Value::Null),
                &["tool write_concept", "`renderer`", "target"],
            ),
            (
                Box::new(|v| tool(v, "get_note")["icon"] = json!("FileText")),
                &["tool get_note", "`icon`", "FileText"],
            ),
            (
                Box::new(|v| tool(v, "get_note")["search_hint"] = json!("")),
                &["tool get_note", "`search_hint`"],
            ),
            (
                Box::new(|v| tool(v, "get_note")["search_hint"] = json!("w ".repeat(41))),
                &["tool get_note", "`search_hint`"],
            ),
            (
                Box::new(|v| tool(v, "get_note")["description"] = json!("Read a note.")),
                &["tool get_note", "`description`", "12"],
            ),
            (
                Box::new(|v| tool(v, "get_note")["description"] = json!("d".repeat(2049))),
                &["tool get_note", "`description`", "2049"],
            ),
            (
                Box::new(|v| tool(v, "get_note")["input_schema"]["type"] = json!("array")),
                &["tool get_note", "`input_schema`", "object"],
            ),
            (
                Box::new(|v| {
                    tool(v, "get_note")["input_schema"]["required"] = json!(["path", "depth"]);
                }),
                &["tool get_note", "`input_schema`", "depth"],
            ),
            (
                Box::new(|v| {
                    tool(v, "get_note")["description"] =
                        json!("Read one note in full, typed as {{note_kinds}}.");
                }),
                &["tool get_note", "`description`", "{{note_kinds}}"],
            ),
            (
                Box::new(|v| {
                    tool(v, "get_note")["input_schema"]["properties"]["path"]["description"] =
                        json!("A path under {{folders}}");
                }),
                &["tool get_note", "`input_schema`", "{{folders}}"],
            ),
            (
                Box::new(|v| v["tokens"]["spare"] = json!({ "why": "used by nothing" })),
                &["token spare", "`tokens`"],
            ),
            (
                Box::new(|v| {
                    v["prefix_exceptions"]
                        .as_array_mut()
                        .unwrap()
                        .push(json!({ "name": "propose_nothing", "why": "a row that is gone" }));
                }),
                &["prefix exception propose_nothing", "`name`"],
            ),
        ];
        for (mutate, fragments) in cases {
            assert_names(&refused(mutate), fragments);
        }
    }

    #[test]
    fn a_hand_written_propose_name_fails_the_load() {
        // The generated namespace is the policy table's. A hand-written
        // `propose_` tool other than the one listed exception would be a
        // second door into it, so it never loads.
        let err = refused(|v| tool(v, "open_note")["name"] = json!("propose_open_note"));
        assert_names(
            &err,
            &["tool propose_open_note", "`name`", "prefix_exceptions"],
        );
        // And the one exception is the one row it names.
        assert_eq!(
            manifest()
                .prefix_exceptions
                .iter()
                .map(|e| e.name.as_str())
                .collect::<Vec<_>>(),
            ["propose_organize"]
        );
    }

    #[test]
    fn the_generated_block_answers_to_the_row_rules() {
        let cases: Vec<Case> = vec![
            (
                Box::new(|v| v["generated"]["title_prefix"] = json!("")),
                &["generated", "`title_prefix`"],
            ),
            (
                Box::new(|v| v["generated"]["door"] = json!("vault")),
                &["generated", "`door`", "names vault"],
            ),
            (
                Box::new(|v| v["generated"]["exempt"] = Value::Null),
                &["generated", "`exempt`"],
            ),
            (
                Box::new(|v| v["generated"]["renderer"] = json!("change")),
                &["generated", "`renderer`", "target"],
            ),
        ];
        for (mutate, fragments) in cases {
            assert_names(&refused(mutate), fragments);
        }
    }

    #[test]
    fn cli_rows_carry_family_and_subject() {
        let families: Vec<(&str, Option<&str>, Option<&str>)> = manifest()
            .cli_tools
            .iter()
            .map(|t| (t.name.as_str(), t.family.as_deref(), t.subject.as_deref()))
            .collect();
        assert_eq!(
            families,
            [
                ("Write", Some("file_write"), Some("file_path")),
                ("Edit", Some("file_write"), Some("file_path")),
                ("MultiEdit", Some("file_write"), Some("file_path")),
                ("NotebookEdit", Some("file_write"), Some("notebook_path")),
                ("Bash", Some("shell"), Some("command")),
                ("Read", Some("file_read"), Some("file_path")),
                ("Glob", Some("file_read"), Some("pattern")),
                ("Grep", Some("file_read"), Some("pattern")),
                ("WebFetch", Some("web"), Some("url")),
                ("WebSearch", Some("web"), Some("query")),
                ("Agent", Some("delegate"), Some("description")),
                ("AskUserQuestion", Some("question"), None),
                ("ExitPlanMode", Some("plan"), None),
                ("EnterPlanMode", Some("plan"), None),
                ("TodoWrite", Some("todo"), None),
                ("TaskCreate", Some("task_list"), None),
                ("TaskGet", Some("task_list"), None),
                ("TaskList", Some("task_list"), None),
                ("TaskUpdate", Some("task_list"), None),
                ("TaskOutput", Some("background"), None),
                ("TaskStop", Some("background"), None),
                ("SendMessage", Some("cross_session"), None),
                ("ListAgents", Some("cross_session"), None),
                ("CronCreate", Some("schedule"), None),
                ("CronDelete", Some("schedule"), None),
                ("CronList", Some("schedule"), None),
                ("ScheduleWakeup", Some("schedule"), None),
                ("RemoteTrigger", Some("schedule"), None),
                ("Artifact", Some("outside"), None),
                ("PushNotification", Some("outside"), None),
                ("DesignSync", Some("outside"), None),
                ("ReportFindings", Some("outside"), None),
                ("Workflow", Some("outside"), None),
                ("EnterWorktree", Some("outside"), None),
                ("ExitWorktree", Some("outside"), None),
                ("SendUserMessage", Some("outside"), None),
                ("REPL", Some("outside"), None),
                ("ListMcpResourcesTool", Some("outside"), None),
                ("ReadMcpResourceTool", Some("outside"), None),
                ("ReadMcpResourceDirTool", Some("outside"), None),
                ("LSP", Some("outside"), None),
                ("Monitor", Some("outside"), None),
                ("Skill", Some("skill"), None),
                ("ToolSearch", Some("meta"), None),
            ]
        );
        assert_eq!(cli_tool("Bash").unwrap().icon, "terminal");
        assert!(cli_tool("bash").is_none(), "the CLI's spelling, exactly");
        for tool in [
            "AskUserQuestion",
            "ExitPlanMode",
            "EnterPlanMode",
            "ToolSearch",
        ] {
            assert!(!writes_disk(tool));
            assert_eq!(renderer(tool), Renderer::Step);
        }
        assert_eq!(renderer("TodoWrite"), Renderer::Todo);
        assert!(
            !writes_disk("TodoWrite"),
            "its list is Claude Code's, not a file"
        );
    }

    // M91.1: the subagent tool is `Agent` in a call and `Task` in an init.
    // The manifest says so as data, and every reader of a built-in's facts
    // asks the one lookup, so both spellings answer with one row.
    #[test]
    fn agent_and_task_answer_with_one_row() {
        let agent = cli_tool("Agent").expect("the subagent row");
        assert_eq!(agent.aliases, ["Task"]);
        assert!(std::ptr::eq(cli_tool("Task").unwrap(), agent));
        assert_eq!(agent.family.as_deref(), Some("delegate"));
        assert_eq!(agent.icon, "bot");
        for name in ["Agent", "Task"] {
            assert_eq!(renderer(name), Renderer::Subagent, "{name}");
            assert!(!writes_disk(name), "{name}");
            assert!(fold(name).is_none(), "{name}");
        }
        // Spelled the CLI's way only, and never as a cerebro tool.
        for name in ["task", "agent", "mcp__cerebro__Task", "Tasks"] {
            assert!(cli_tool(name).is_none(), "{name}");
        }
        // argv names the row by its name alone.
        assert!(cli_names(|_| true).contains(&"Agent"));
        assert!(!cli_names(|_| true).contains(&"Task"));
        // Every other row answers to its name alone.
        let aliased: Vec<&str> = manifest()
            .cli_tools
            .iter()
            .filter(|tool| !tool.aliases.is_empty())
            .map(|tool| tool.name.as_str())
            .collect();
        assert_eq!(aliased, ["Agent"]);
    }

    #[test]
    fn an_alias_is_a_cli_spelling_held_by_one_row() {
        let cases: Vec<Case> = vec![
            (
                Box::new(|v| cli(v, "Agent")["aliases"] = json!(["task"])),
                &[
                    "cli tool Agent",
                    "`aliases`",
                    "must each match [A-Z][A-Za-z]*",
                ],
            ),
            (
                Box::new(|v| cli(v, "Agent")["aliases"] = json!(["Bash"])),
                &[
                    "cli tool Agent",
                    "`aliases`",
                    "names Bash, which a CLI row already answers to",
                ],
            ),
            (
                Box::new(|v| cli(v, "Agent")["aliases"] = json!(["Task", "Task"])),
                &["cli tool Agent", "`aliases`", "names Task"],
            ),
            (
                Box::new(|v| cli(v, "Read")["aliases"] = json!(["Task"])),
                &["cli tool Agent", "`aliases`", "names Task"],
            ),
            (
                Box::new(|v| cli(v, "Agent")["aliases"] = json!(["Agent"])),
                &["cli tool Agent", "`aliases`", "names Agent"],
            ),
        ];
        for (mutate, fragments) in cases {
            assert_names(&refused(mutate), fragments);
        }
        // A list it must be, as serde reads it; absent reads as none.
        assert_names(
            &refused(|v| cli(v, "Agent")["aliases"] = Value::Null),
            &[TOOLS_PATH, "invalid type"],
        );
        let mut raw: Value = serde_json::from_str(TOOLS_JSON).unwrap();
        cli(&mut raw, "Agent")
            .as_object_mut()
            .unwrap()
            .remove("aliases");
        let loaded = parse(&raw.to_string()).expect("a row with no aliases loads");
        let agent = loaded.cli_tools.iter().find(|t| t.name == "Agent").unwrap();
        assert!(agent.aliases.is_empty());
    }

    #[test]
    fn the_cli_refusals_name_the_row_and_the_field() {
        let cases: Vec<Case> = vec![
            (
                Box::new(|v| cli(v, "Agent")["name"] = json!("agent")),
                &["cli tool agent", "`name`", "[A-Z][A-Za-z]*"],
            ),
            (
                Box::new(|v| cli(v, "Read")["family"] = json!(null)),
                &["cli tool Read", "`family`", "tool-approval family"],
            ),
            (
                Box::new(|v| cli(v, "Bash")["subject"] = json!("Command")),
                &["cli tool Bash", "`subject`", "null or an input field"],
            ),
            (
                Box::new(|v| cli(v, "WebFetch")["renderer"] = json!("change")),
                &[
                    "cli tool WebFetch",
                    "`renderer`",
                    "change needs a tool that writes",
                ],
            ),
            (
                Box::new(|v| cli(v, "Grep")["icon"] = json!("search_icon")),
                &["cli tool Grep", "`icon`"],
            ),
        ];
        for (mutate, fragments) in cases {
            assert_names(&refused(mutate), fragments);
        }
    }

    #[test]
    fn fold_phrases_live_only_on_read_rows() {
        let cases: Vec<Case> = vec![
            (
                Box::new(|v| {
                    tool(v, "create_note")["fold"] =
                        json!({ "one": "made a note", "many": "made {n} notes" });
                }),
                &[
                    "tool create_note",
                    "`fold`",
                    "whose kind is additive",
                    "only a read folds",
                ],
            ),
            (
                Box::new(|v| {
                    cli(v, "Write")["fold"] =
                        json!({ "one": "wrote a file", "many": "wrote {n} files" });
                }),
                &["cli tool Write", "`fold`", "a tool that writes"],
            ),
            (
                Box::new(|v| tool(v, "get_note")["renderer"] = json!("change")),
                &[
                    "tool get_note",
                    "`fold`",
                    "a change row",
                    "only a step folds",
                ],
            ),
            (
                Box::new(|v| tool(v, "get_note")["fold"]["many"] = json!("read notes")),
                &["tool get_note", "`fold.many`", "exactly one {n}"],
            ),
            (
                Box::new(|v| tool(v, "get_note")["fold"]["many"] = json!("read {n} of {n} notes")),
                &["tool get_note", "`fold.many`", "exactly one {n}"],
            ),
            (
                Box::new(|v| tool(v, "get_note")["fold"]["one"] = json!("read {n} note")),
                &["tool get_note", "`fold.one`", "without {n}"],
            ),
            (
                Box::new(|v| tool(v, "get_note")["fold"]["one"] = json!(" ")),
                &["tool get_note", "`fold.one`"],
            ),
            (
                Box::new(|v| tool(v, "get_note")["fold"]["one"] = json!("Read a note")),
                &["tool get_note", "`fold.one`", "lowercase"],
            ),
            (
                Box::new(|v| tool(v, "get_note")["fold"]["many"] = json!("Read {n} notes")),
                &["tool get_note", "`fold.many`", "lowercase"],
            ),
            (
                Box::new(|v| tool(v, "get_note")["fold"]["one"] = json!("r".repeat(41))),
                &["tool get_note", "`fold.one`", "1 to 40"],
            ),
            (
                Box::new(|v| {
                    tool(v, "get_note")["fold"]["many"] = json!(format!("{}{{n}}", "r".repeat(38)))
                }),
                &["tool get_note", "`fold.many`", "1 to 40"],
            ),
            // M91.1: a fold's running words answer to the same rules.
            (
                Box::new(|v| tool(v, "get_note")["fold"]["running"]["one"] = json!("reading {n}")),
                &["tool get_note", "`fold.running.one`", "without {n}"],
            ),
            (
                Box::new(|v| {
                    tool(v, "get_note")["fold"]["running"]["many"] = json!("reading notes")
                }),
                &["tool get_note", "`fold.running.many`", "exactly one {n}"],
            ),
            (
                Box::new(|v| cli(v, "Read")["fold"]["running"]["one"] = json!("Reading a file")),
                &["cli tool Read", "`fold.running.one`", "lowercase"],
            ),
            (
                Box::new(|v| {
                    cli(v, "Grep")["fold"]["running"]["many"] =
                        json!(format!("{}{{n}}", "s".repeat(38)))
                }),
                &["cli tool Grep", "`fold.running.many`", "1 to 40"],
            ),
        ];
        for (mutate, fragments) in cases {
            assert_names(&refused(mutate), fragments);
        }
        // Exactly 40 characters loads.
        let mut raw: Value = serde_json::from_str(TOOLS_JSON).unwrap();
        tool(&mut raw, "get_note")["fold"]["one"] = json!("r".repeat(40));
        parse(&raw.to_string()).expect("a 40-character phrase loads");
        // A fold may leave its running words out, absent or null.
        let mut raw: Value = serde_json::from_str(TOOLS_JSON).unwrap();
        tool(&mut raw, "get_note")["fold"]
            .as_object_mut()
            .unwrap()
            .remove("running");
        cli(&mut raw, "Read")["fold"]["running"] = Value::Null;
        let loaded = parse(&raw.to_string()).expect("a fold without running words loads");
        let note = loaded
            .tools
            .iter()
            .find(|row| row.name == "get_note")
            .unwrap();
        assert_eq!(note.fold.as_ref().unwrap().running, None);
        // And an unknown field inside a fold, or inside its running words,
        // fails the parse.
        let err = refused(|v| tool(v, "get_note")["fold"]["few"] = json!("read a few notes"));
        assert_names(&err, &[TOOLS_PATH, "few"]);
        let err = refused(|v| tool(v, "get_note")["fold"]["running"]["all"] = json!("reading"));
        assert_names(&err, &[TOOLS_PATH, "all"]);
    }

    // M91.1: a row's status words, optional on any row, are one call's.
    #[test]
    fn status_phrases_name_one_call_in_lowercase() {
        let phrases = json!({
            "running": "running a command",
            "done": "ran a command",
            "failed": "failed to run a command"
        });
        let mut raw: Value = serde_json::from_str(TOOLS_JSON).unwrap();
        cli(&mut raw, "Bash")["phrases"] = phrases.clone();
        tool(&mut raw, "create_note")["phrases"] = json!({
            "running": "making a note",
            "done": "made a note",
            "failed": "failed to make a note"
        });
        let loaded = parse(&raw.to_string()).expect("phrases on a reader and a writer load");
        let bash = loaded.cli_tools.iter().find(|t| t.name == "Bash").unwrap();
        assert_eq!(bash.phrases.as_ref().unwrap().done, "ran a command");
        // M91.13: the rows a conversation names ship them; a read keeps its
        // name on a line of its own, and its fold words a run of it.
        let shipped = manifest();
        let shipped_bash = shipped.cli_tools.iter().find(|t| t.name == "Bash").unwrap();
        assert_eq!(shipped_bash.phrases.as_ref().unwrap().done, "ran a command");
        assert!(shipped
            .tools
            .iter()
            .filter(|row| row.fold.is_some())
            .all(|row| row.phrases.is_none()));
        let cases: Vec<Case> = vec![
            (
                Box::new(|v| {
                    cli(v, "Bash")["phrases"] = json!({
                        "running": "running {n} commands", "done": "ran it", "failed": "failed"
                    })
                }),
                &["cli tool Bash", "`phrases.running`", "without {n}"],
            ),
            (
                Box::new(|v| {
                    tool(v, "get_note")["phrases"] = json!({
                        "running": "reading", "done": "Read a note", "failed": "failed to read"
                    })
                }),
                &["tool get_note", "`phrases.done`", "lowercase"],
            ),
            (
                Box::new(|v| {
                    tool(v, "get_note")["phrases"] = json!({
                        "running": "reading", "done": "read", "failed": " "
                    })
                }),
                &["tool get_note", "`phrases.failed`", "1 to 40"],
            ),
            (
                Box::new(|v| {
                    tool(v, "get_note")["phrases"] =
                        json!({ "running": "r".repeat(41), "done": "read", "failed": "failed" })
                }),
                &["tool get_note", "`phrases.running`", "1 to 40"],
            ),
        ];
        for (mutate, fragments) in cases {
            assert_names(&refused(mutate), fragments);
        }
        for err in [
            refused(|v| cli(v, "Bash")["phrases"] = json!({ "running": "running", "done": "ran" })),
            refused(|v| {
                cli(v, "Bash")["phrases"] =
                    json!({ "running": "a", "done": "b", "failed": "c", "paused": "d" })
            }),
        ] {
            assert_names(&err, &[TOOLS_PATH]);
        }
    }

    #[test]
    fn renderers_sit_on_their_doors() {
        let cases: Vec<Case> = vec![
            (
                Box::new(|v| tool(v, "create_note")["renderer"] = json!("concept")),
                &[
                    "tool create_note",
                    "`renderer`",
                    "concept needs door concept, not note",
                ],
            ),
            (
                Box::new(|v| tool(v, "open_note")["renderer"] = json!("view")),
                &[
                    "tool open_note",
                    "`renderer`",
                    "view needs door none, not ui",
                ],
            ),
            (
                Box::new(|v| tool(v, "open_note")["renderer"] = json!("handoff")),
                &[
                    "tool open_note",
                    "`renderer`",
                    "handoff needs door run, not ui",
                ],
            ),
            (
                Box::new(|v| tool(v, "write_concept")["renderer"] = json!("commit")),
                &[
                    "tool write_concept",
                    "`renderer`",
                    "commit needs door ledger, not concept",
                ],
            ),
            (
                Box::new(|v| tool(v, "commit_proposals")["surface"] = json!("base")),
                &[
                    "tool commit_proposals",
                    "`renderer`",
                    "commit needs the proposals surface",
                ],
            ),
            (
                Box::new(|v| v["generated"]["renderer"] = json!("handoff")),
                &[
                    "generated",
                    "`renderer`",
                    "handoff needs door run, not ledger",
                ],
            ),
            (
                Box::new(|v| cli(v, "Write")["renderer"] = json!("concept")),
                &[
                    "cli tool Write",
                    "`renderer`",
                    "concept draws a cerebro tool's own door",
                ],
            ),
            (
                Box::new(|v| cli(v, "Agent")["renderer"] = json!("handoff")),
                &["cli tool Agent", "`renderer`", "never a CLI tool"],
            ),
            // M91.1: the two renderers that draw the CLI's own work sit on
            // its rows alone.
            (
                Box::new(|v| tool(v, "hand_to")["renderer"] = json!("subagent")),
                &[
                    "tool hand_to",
                    "`renderer`",
                    "subagent draws one of the CLI's own tools, never a cerebro tool",
                ],
            ),
            (
                Box::new(|v| tool(v, "open_note")["renderer"] = json!("todo")),
                &[
                    "tool open_note",
                    "`renderer`",
                    "todo draws one of the CLI's own tools",
                ],
            ),
            (
                Box::new(|v| v["generated"]["renderer"] = json!("subagent")),
                &["generated", "`renderer`", "never a cerebro tool"],
            ),
        ];
        for (mutate, fragments) in cases {
            assert_names(&refused(mutate), fragments);
        }
        // Either sits on any CLI row that does not write.
        let mut raw: Value = serde_json::from_str(TOOLS_JSON).unwrap();
        cli(&mut raw, "Bash")["renderer"] = json!("subagent");
        cli(&mut raw, "WebSearch")["renderer"] = json!("todo");
        parse(&raw.to_string()).expect("a CLI row may draw a subagent or a todo list");
    }

    #[test]
    fn the_shipped_manifest_folds_exactly_the_step_reads() {
        // Step-rendered reads fold; owned cards keep their own rows, and a
        // write keeps its path in view.
        let folded: BTreeSet<&str> = manifest()
            .tools
            .iter()
            .filter(|row| row.fold.is_some())
            .map(|row| row.name.as_str())
            .collect();
        let reads: BTreeSet<&str> = manifest()
            .tools
            .iter()
            .filter(|row| row.kind == Kind::ReadOnly && row.renderer == Renderer::Step)
            .map(|row| row.name.as_str())
            .collect();
        assert_eq!(folded, reads);
        assert_eq!(
            folded,
            BTreeSet::from([
                "get_vault_context",
                "search_notes",
                "list_notes",
                "read_activity",
                "describe_database",
                "query_records",
                "list_agenda",
                "get_note",
                "read_document",
                "read_sheet",
                "calculate_sheet",
                "read_canvas",
                "knowledge_about",
                "list_inbox"
            ])
        );
        assert_eq!(
            cli_names(|tool| tool.fold.is_some()),
            ["Read", "Glob", "Grep"]
        );
        let note = fold("mcp__cerebro__get_note").expect("get_note folds");
        assert_eq!(
            (note.one.as_str(), note.many.as_str()),
            ("read a note", "read {n} notes")
        );
        // M91.1: every fold the manifest ships names its running words too.
        let running = note.running.as_ref().expect("get_note's running words");
        assert_eq!(
            (running.one.as_str(), running.many.as_str()),
            ("reading a note", "reading {n} notes")
        );
        let folds = manifest()
            .tools
            .iter()
            .filter_map(|row| row.fold.as_ref())
            .chain(manifest().cli_tools.iter().filter_map(|t| t.fold.as_ref()));
        for fold in folds {
            assert!(fold.running.is_some(), "{} has no running words", fold.one);
        }
        for name in [
            "create_note",
            "Write",
            "Bash",
            "propose_create_belief",
            "mcp__gmail__search",
        ] {
            assert!(fold(name).is_none(), "{name}");
        }
        // The renderers the transcript draws by.
        for (name, expected) in [
            ("write_concept", Renderer::Concept),
            ("recheck_concept", Renderer::Concept),
            ("mcp__cerebro__hand_to", Renderer::Handoff),
            ("commit_proposals", Renderer::Commit),
            ("create_note", Renderer::Change),
            ("propose_create_belief", Renderer::Step),
            ("propose_organize", Renderer::Step),
            ("suggest_view", Renderer::View),
            ("MultiEdit", Renderer::Change),
            ("mcp__gmail__search", Renderer::Step),
            ("Agent", Renderer::Subagent),
            ("Task", Renderer::Subagent),
            ("TodoWrite", Renderer::Todo),
        ] {
            assert_eq!(renderer(name), expected, "{name}");
        }
    }

    #[test]
    fn the_client_default_is_one_toolset_that_only_reads() {
        let default = &clients().default;
        let rows: Vec<_> = manifest()
            .tools
            .iter()
            .filter(|r| r.toolset.as_ref() == Some(default))
            .collect();
        assert!(!rows.is_empty());
        assert!(rows
            .iter()
            .all(|r| r.kind == Kind::ReadOnly && !door(&r.door).unwrap().writes));
        assert!(!toolset_writes(default));
        assert!(toolset_writes("write"));
        assert!(!toolset_writes("comment"));
    }

    #[test]
    fn grantable_toolsets_hold_only_rows_a_folder_scope_bounds() {
        for id in &clients().grantable {
            assert!(manifest()
                .tools
                .iter()
                .filter(|row| row.toolset.as_ref() == Some(id))
                .all(|row| row.axis != Axis::None));
        }
    }

    #[test]
    fn the_proposal_toolset_is_never_a_clients() {
        assert!(!clients().grantable.contains(&generated().toolset));
    }

    #[test]
    fn client_tool_names_needs_the_default_and_only_grantable_sets() {
        let default = clients().default.clone();
        let names = client_tool_names(std::slice::from_ref(&default)).unwrap();
        assert_eq!(
            names,
            manifest()
                .tools
                .iter()
                .filter(|row| row.toolset.as_ref() == Some(&default))
                .map(|row| row.name.clone())
                .collect::<Vec<_>>()
        );
        assert_eq!(
            client_tool_names(&[]).unwrap_err(),
            "A token must include the \"read\" toolset."
        );
        assert_eq!(
            client_tool_names(&[default.clone(), "knowledge".into()]).unwrap_err(),
            "A token can't hold the \"knowledge\" toolset."
        );
        assert_eq!(
            client_tool_names(&[default.clone(), default]).unwrap_err(),
            "A token can't repeat the \"read\" toolset."
        );
    }

    #[test]
    fn client_manifest_refusals_name_the_field_in_shared_words() {
        for (field, value, problem) in [
            ("why", json!(" "), "is empty"),
            (
                "default",
                json!("missing"),
                "names no declared toolset: \"missing\"",
            ),
            (
                "default",
                json!("write"),
                "must name a toolset of read_only rows on non-writing doors",
            ),
            (
                "default",
                json!("comment"),
                "must name a toolset of read_only rows on non-writing doors",
            ),
            (
                "grantable",
                json!(["missing"]),
                "names no declared toolset: \"missing\"",
            ),
            (
                "grantable",
                json!(["write", "write"]),
                "repeats toolset \"write\"",
            ),
            (
                "grantable",
                json!(["read"]),
                "includes the default toolset \"read\"",
            ),
            (
                "grantable",
                json!(["proposals"]),
                "includes the generated toolset \"proposals\"",
            ),
            (
                "grantable",
                json!(["knowledge"]),
                "toolset \"knowledge\" contains a row no folder scope bounds",
            ),
        ] {
            assert_eq!(
                refused(|v| v["clients"][field] = value),
                refusal("clients", field, problem)
            );
        }
    }

    #[test]
    fn never_call_names_follow_the_manifest_order() {
        let names: Vec<_> = never_call_names().collect();
        assert!(!names.is_empty());
        assert_eq!(
            names,
            manifest()
                .never_call
                .tools
                .iter()
                .map(|row| row.name.as_str())
                .collect::<Vec<_>>()
        );
        assert!(names.windows(2).all(|pair| pair[0] < pair[1]));
    }

    #[test]
    fn never_call_refusals_name_the_row_and_field() {
        assert_eq!(
            refused(|v| v["never_call"]["why"] = json!(" ")),
            refusal("never_call", "why", "is empty")
        );
        for name in ["", "send mail", "send,Read", "send\n", "é", &"x".repeat(65)] {
            assert_eq!(
                refused(
                    |v| v["never_call"]["tools"] = json!([{ "name": name, "source": "checked" }])
                ),
                refusal(
                    &format!("never_call tool {name}"),
                    "name",
                    "must match [A-Za-z0-9_-]{1,64}"
                )
            );
        }
        for (rows, subject, field, problem) in [
            (
                json!([{ "name": "send", "source": " " }]),
                "send",
                "source",
                "is empty",
            ),
            (
                json!([{ "name": "send", "source": "a" }, { "name": "send", "source": "b" }]),
                "send",
                "name",
                "is repeated",
            ),
            (
                json!([{ "name": "z", "source": "a" }, { "name": "a", "source": "b" }]),
                "a",
                "name",
                "must be in ASCII order",
            ),
            (
                json!([{ "name": "get_note", "source": "a" }]),
                "get_note",
                "name",
                "names a cerebro tool",
            ),
        ] {
            assert_eq!(
                refused(|v| v["never_call"]["tools"] = rows),
                refusal(&format!("never_call tool {subject}"), field, problem)
            );
        }
        for err in [
            refused(|v| v["never_call"]["allow"] = json!(true)),
            refused(|v| v["never_call"]["tools"][0]["alias"] = json!("send")),
        ] {
            assert!(err.contains("unknown field"), "{err}");
        }
    }

    #[test]
    fn never_call_text_uses_unicode_white_space() {
        for field in ["why", "source"] {
            for (value, empty) in [("\u{0085}", true), ("\u{feff}", false)] {
                let mut raw: Value = serde_json::from_str(TOOLS_JSON).unwrap();
                if field == "why" {
                    raw["never_call"][field] = json!(value);
                } else {
                    raw["never_call"]["tools"][0][field] = json!(value);
                }
                let result = parse(&serde_json::to_string(&raw).unwrap());
                if empty {
                    assert!(result.unwrap_err().contains(&format!("`{field}` is empty")));
                } else {
                    assert!(result.is_ok());
                }
            }
        }
    }

    #[test]
    fn an_unknown_field_fails_the_parse_rather_than_being_dropped() {
        let err = refused(|v| tool(v, "get_note")["readonly"] = json!(true));
        assert_names(&err, &[TOOLS_PATH, "readonly"]);
    }

    #[test]
    fn a_row_answers_to_both_spellings_and_nothing_else() {
        let short = row("get_note").expect("get_note is a row");
        assert_eq!(row("mcp__cerebro__get_note"), Some(short));
        assert_eq!(row("mcp__other__get_note"), None);
        assert_eq!(row("Get_note"), None);
    }
    #[test]
    fn a_file_target_sits_only_on_reads() {
        assert_eq!(
            row("read_document").unwrap().target.as_ref().unwrap().kind,
            TargetKind::File
        );
        for (field, value) in [("axis", json!("write")), ("door", json!("comment"))] {
            assert_names(
                &refused(|v| tool(v, "read_document")[field] = value),
                &[
                    "tool read_document",
                    "target",
                    "file targets require the read axis and door none",
                ],
            );
        }
        assert_names(
            &refused(|v| tool(v, "read_document")["target"]["arg"] = Value::Null),
            &["tool read_document", "target", "file needs an argument"],
        );
    }
    #[test]
    fn an_optional_folder_requires_its_explicit_root_default() {
        assert_eq!(row("create_canvas").unwrap().kind, Kind::Additive);
        for value in [Value::Null, json!("boards"), json!(0)] {
            assert_names(
                &refused(|v| {
                    tool(v, "create_canvas")["input_schema"]["properties"]["folder"]["default"] =
                        value
                }),
                &["input_schema must declare and require"],
            );
        }
    }
    #[test]
    fn a_canvas_target_sits_only_on_its_read_and_write_doors() {
        assert_eq!(
            row("read_canvas").unwrap().target.as_ref().unwrap().kind,
            TargetKind::Canvas
        );
        for (field, value) in [("axis", json!("write")), ("door", json!("comment"))] {
            assert_names(
                &refused(|v| tool(v, "read_canvas")[field] = value),
                &[
                    "tool read_canvas",
                    "target",
                    "canvas targets require read with door none or read_write with door canvas",
                ],
            );
        }
        assert_names(
            &refused(|v| tool(v, "read_canvas")["target"]["arg"] = Value::Null),
            &["tool read_canvas", "target", "canvas needs an argument"],
        );
        assert_names(
            &refused(|v| tool(v, "edit_canvas")["target"]["kind"] = json!("note")),
            &[
                "tool edit_canvas",
                "target",
                "door canvas needs a canvas target on read_write or a folder target on write",
            ],
        );
    }
}
