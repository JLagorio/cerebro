//! `shared/policy/tools.v1.json` — the one tool manifest (M54.1).
//!
//! Every tool cerebro's loopback serves is a row here: its title, the kind of
//! change it makes, the door it writes through, the grant axis that binds it
//! and by which argument, how a transcript renders it, its icon and search
//! hint, the phrase a run of its calls folds under (M56.8), and the
//! description and schema the model reads. The generated
//! `propose_<op>` tools take their facts from one `generated` block (their
//! names, descriptions and schemas stay policy.v3's), and the CLI's own
//! built-ins are one list, in argv order.
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
            TargetKind::Folder => "folder",
            TargetKind::Concept => "concept",
            TargetKind::SourceId => "source_id",
            TargetKind::Bundle => "bundle",
        }
    }
}

/// How a transcript shows a call (M56.8): a step in the run, a change card,
/// or one of the rows a cerebro tool owns: a concept to review, a handoff to
/// another agent, a commit of proposals.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Renderer {
    Step,
    Change,
    Concept,
    Handoff,
    Commit,
}

impl Renderer {
    pub fn as_str(self) -> &'static str {
        match self {
            Renderer::Step => "step",
            Renderer::Change => "change",
            Renderer::Concept => "concept",
            Renderer::Handoff => "handoff",
            Renderer::Commit => "commit",
        }
    }

    /// The door a cerebro tool's own row must go through, for the renderers
    /// that draw what that door does.
    fn door(self) -> Option<&'static str> {
        match self {
            Renderer::Concept => Some("concept"),
            Renderer::Handoff => Some("run"),
            Renderer::Commit => Some("ledger"),
            Renderer::Step | Renderer::Change => None,
        }
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
    /// A lucide icon name.
    pub icon: String,
    pub always_load: bool,
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
    pub search_hint: String,
}

/// One of the CLI's own built-in tools.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CliTool {
    pub name: String,
    pub writes: bool,
    pub denied_without_shell: bool,
    pub denied_when_read_scoped: bool,
    /// Granted, with the cerebro tools, to a run that holds shell.
    pub with_shell: bool,
    pub renderer: Renderer,
    /// Set only on a reader: what a run of its calls folds under.
    pub fold: Option<FoldPhrases>,
    pub icon: String,
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
    pub prefix_exceptions: Vec<PrefixException>,
    /// In served order, which is meaning: nothing sorts it.
    pub tools: Vec<ToolRow>,
    pub generated: Generated,
    /// In argv order, which is meaning too.
    pub cli_tools: Vec<CliTool>,
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
    if !fits(&fold.one, FOLD_LIMIT) || fold.one.contains(FOLD_COUNT) {
        return Err(refusal(
            subject,
            "fold.one",
            format!("must be 1 to {FOLD_LIMIT} characters, without {FOLD_COUNT}"),
        ));
    }
    if !fits(&fold.many, FOLD_LIMIT) || fold.many.matches(FOLD_COUNT).count() != 1 {
        return Err(refusal(
            subject,
            "fold.many",
            format!("must be 1 to {FOLD_LIMIT} characters, with exactly one {FOLD_COUNT}"),
        ));
    }
    for (field, phrase) in [("fold.one", &fold.one), ("fold.many", &fold.many)] {
        if phrase.chars().next().is_some_and(char::is_uppercase) {
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
            if !properties.contains(arg) || !required.contains(arg) {
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

    fn check_generated(&self) -> Result<(), String> {
        let generated = &self.generated;
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
            (Axis::ReadWrite, Some(TargetKind::Note)) => {}
            (Axis::ReadWrite, _) => {
                return Err(refusal(
                    subject,
                    "target",
                    "must name a note argument on the read_write axis",
                ));
            }
            (Axis::Read, Some(kind)) if !matches!(kind, TargetKind::Note | TargetKind::Bundle) => {
                return Err(refusal(
                    subject,
                    "target",
                    format!(
                        "on the read axis must be a note or the bundle, not {}",
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
        if facts.renderer == Renderer::Change {
            if !door.writes {
                return Err(refusal(
                    subject,
                    "renderer",
                    format!("change needs a door that writes, and {} does not", door.id),
                ));
            }
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
    check_fold(
        subject,
        tool.fold.as_ref(),
        tool.writes.then_some("a tool that writes"),
        tool.renderer,
    )?;
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
    if tool.with_shell && !tool.denied_without_shell && !tool.denied_when_read_scoped {
        return Err(refusal(
            subject,
            "with_shell",
            "grants a tool that neither denied_without_shell nor denied_when_read_scoped \
             withdraws",
        ));
    }
    if tool.denied_without_shell && tool.denied_when_read_scoped {
        return Err(refusal(
            subject,
            "denied_when_read_scoped",
            "is set on a tool denied_without_shell already, so a read-scoped run's one deny \
             list would name it twice",
        ));
    }
    if tool.writes && !tool.denied_without_shell {
        return Err(refusal(
            subject,
            "denied_without_shell",
            "must be set on a tool that writes",
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
    manifest()
        .cli_tools
        .iter()
        .find(|tool| tool.name == bare)
        .is_some_and(|tool| tool.writes)
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
    manifest()
        .cli_tools
        .iter()
        .find(|tool| tool.name == bare)
        .map_or(Renderer::Step, |tool| tool.renderer)
}

/// The phrases a run of calls to `name` folds under (M56.8), or `None` for a
/// tool that never folds: a writer, a generated tool, another server's tool.
pub fn fold(name: &str) -> Option<&'static FoldPhrases> {
    let bare = bare_name(name);
    if let Some(row) = row(bare) {
        return row.fold.as_ref();
    }
    manifest()
        .cli_tools
        .iter()
        .find(|tool| tool.name == bare)
        .and_then(|tool| tool.fold.as_ref())
}

/// The CLI built-ins `select` keeps, in argv order.
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
    fn the_cli_refusals_name_the_row_and_the_field() {
        let cases: Vec<Case> = vec![
            (
                Box::new(|v| cli(v, "Task")["name"] = json!("task")),
                &["cli tool task", "`name`", "[A-Z][A-Za-z]*"],
            ),
            (
                Box::new(|v| cli(v, "Read")["denied_when_read_scoped"] = json!(false)),
                &["cli tool Read", "`with_shell`"],
            ),
            (
                Box::new(|v| cli(v, "Bash")["denied_when_read_scoped"] = json!(true)),
                &["cli tool Bash", "`denied_when_read_scoped`"],
            ),
            (
                Box::new(|v| cli(v, "WebFetch")["writes"] = json!(true)),
                &["cli tool WebFetch", "`denied_without_shell`"],
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
        ];
        for (mutate, fragments) in cases {
            assert_names(&refused(mutate), fragments);
        }
        // Exactly 40 characters loads.
        let mut raw: Value = serde_json::from_str(TOOLS_JSON).unwrap();
        tool(&mut raw, "get_note")["fold"]["one"] = json!("r".repeat(40));
        parse(&raw.to_string()).expect("a 40-character phrase loads");
        // And an unknown field inside a fold fails the parse.
        let err = refused(|v| tool(v, "get_note")["fold"]["few"] = json!("read a few notes"));
        assert_names(&err, &[TOOLS_PATH, "few"]);
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
                Box::new(|v| cli(v, "Task")["renderer"] = json!("handoff")),
                &["cli tool Task", "`renderer`", "never a CLI tool"],
            ),
        ];
        for (mutate, fragments) in cases {
            assert_names(&refused(mutate), fragments);
        }
    }

    #[test]
    fn the_shipped_manifest_folds_exactly_the_reads() {
        // Every read folds, cerebro's and the CLI's own, and nothing else
        // does: a write keeps its path in view.
        let folded: BTreeSet<&str> = manifest()
            .tools
            .iter()
            .filter(|row| row.fold.is_some())
            .map(|row| row.name.as_str())
            .collect();
        let reads: BTreeSet<&str> = manifest()
            .tools
            .iter()
            .filter(|row| row.kind == Kind::ReadOnly)
            .map(|row| row.name.as_str())
            .collect();
        assert_eq!(folded, reads);
        assert_eq!(
            folded,
            BTreeSet::from([
                "get_vault_context",
                "search_notes",
                "get_note",
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
            ("MultiEdit", Renderer::Change),
            ("mcp__gmail__search", Renderer::Step),
        ] {
            assert_eq!(renderer(name), expected, "{name}");
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
}
