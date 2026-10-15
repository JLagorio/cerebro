//! Schema-checked field writes (M60.4): the planner under `set_fields`.
//!
//! An agent names the record and the fields: `set` replaces values, `add`
//! and `remove` change list fields item by item. The planner reads the
//! record's frontmatter as it is under the write's lock, checks every value
//! against the field its `type: Type` doc declares (`vault::schema`), and
//! answers the patch to write and a note per key, or every problem at once.
//!
//! Choices take an option's id or label and store the id; an unknown one is
//! kept as written (a ghost, M1) and named. Person and relation values are
//! stored as `[[links]]`, spelled as the agent spelled them; a link's type is
//! checked only for a declared `target:` and a page the run may read.
//! Option lists are named only when their source (the Type doc, or the
//! project page holding a `statuses:` override) is readable.
//!
//! Pure: no I/O. `vault::write::set_note_fields` holds the lock and the
//! bytes; `mcp.rs` scans and builds the context before it. Its TS twin is
//! `src/engine/setFields.ts`, and both replay
//! `src-tauri/fixtures/set-fields-cases.json`, which pins every word (D3).

use serde_json::{Map, Value};

use super::entry::Entry;
use super::link::TargetIndex;
use super::schema::{self, FieldDef, FieldKind, KindTable, StatusSource, VaultSchema};

/// A parsed request: the record and the three key maps, in their order.
#[derive(Debug, Clone, PartialEq)]
pub struct FieldsRequest {
    pub path: String,
    pub set: Map<String, Value>,
    pub add: Map<String, Value>,
    pub remove: Map<String, Value>,
}

const OPS: [&str; 3] = ["set", "add", "remove"];

/// Read `set_fields`' arguments, refusing a shape it cannot read in plain
/// words. `expect_hash` is the caller's (M55.3's parser).
pub fn parse_request(args: &Map<String, Value>) -> Result<FieldsRequest, String> {
    let path = match args.get("path") {
        Some(Value::String(path)) if !path.trim().is_empty() => path.clone(),
        _ => return Err("set_fields needs a path".into()),
    };
    let mut maps: Vec<Map<String, Value>> = Vec::new();
    for op in OPS {
        match args.get(op) {
            None | Some(Value::Null) => maps.push(Map::new()),
            Some(Value::Object(map)) => maps.push(map.clone()),
            Some(_) => return Err("set, add and remove must be objects".into()),
        }
    }
    if maps.iter().all(Map::is_empty) {
        return Err("set_fields needs set, add or remove".into());
    }
    for later in 1..OPS.len() {
        for key in maps[later].keys() {
            if let Some(earlier) = (0..later).find(|i| maps[*i].contains_key(key)) {
                return Err(format!(
                    "{key} appears in both {} and {}; send it once",
                    OPS[earlier], OPS[later]
                ));
            }
        }
    }
    let remove = maps.pop().unwrap_or_default();
    let add = maps.pop().unwrap_or_default();
    let set = maps.pop().unwrap_or_default();
    Ok(FieldsRequest {
        path,
        set,
        add,
        remove,
    })
}

/// What the planner reads besides the record: the field-kind table, the
/// vault's schema and corpus, the link index over that corpus, the record's
/// path and project, and which paths the run may read.
pub struct FieldsContext<'a> {
    pub table: &'a KindTable,
    pub schema: &'a VaultSchema,
    pub entries: &'a [Entry],
    pub links: &'a TargetIndex<'a>,
    pub record: &'a str,
    pub project: Option<&'a str>,
    pub may_read: &'a dyn Fn(&str) -> bool,
}

/// The patch to write (null removes a key) and a note per key, in order.
#[derive(Debug, Clone, PartialEq)]
pub struct FieldsPlan {
    pub patch: Map<String, Value>,
    pub notes: Vec<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Op {
    Set,
    Add,
    Remove,
}

const TYPE_KEY_PROBLEM: &str =
    "type is the record's database, not one of its fields; set_fields cannot change it";

/// A value as a note names it: text as written, a list as its items joined
/// by ", ", anything else as compact JSON.
fn display(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(items) => items.iter().map(display).collect::<Vec<_>>().join(", "),
        other => other.to_string(),
    }
}

fn display_all(items: &[Value]) -> String {
    display(&Value::Array(items.to_vec()))
}

/// A list field's items: a list as itself, a scalar as one item, nothing as
/// none.
fn items_of(value: Option<&Value>) -> Vec<Value> {
    match value {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => items.clone(),
        Some(other) => vec![other.clone()],
    }
}

/// The page a trimmed value names when it is exactly one `[[link]]`.
fn one_link(text: &str) -> Option<&str> {
    let inner = text.strip_prefix("[[")?.strip_suffix("]]")?;
    if inner.contains('[') || inner.contains(']') {
        return None;
    }
    let target = inner.split('|').next().unwrap_or("").trim();
    (!target.is_empty()).then_some(target)
}

/// A person or relation value as it is stored: one `[[link]]` byte for byte
/// (trimmed), a bracket-free name wrapped as `[[name]]`, and anything else
/// refused.
fn link_value(raw: &str) -> Option<String> {
    let text = raw.trim();
    if text.is_empty() {
        return None;
    }
    if one_link(text).is_some() {
        return Some(text.to_string());
    }
    if text.contains('[') || text.contains(']') {
        return None;
    }
    Some(format!("[[{text}]]"))
}

/// What a stored link (or a bare name already on disk) resolves by.
fn target_of(value: &str) -> String {
    let text = value.trim();
    one_link(text).unwrap_or(text).to_string()
}

/// `normalizeFieldName`'s rule: trimmed, whitespace runs one `_`,
/// lowercased, leading underscores dropped.
fn normalized_key(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut in_run = false;
    for c in raw.trim().chars() {
        if c.is_whitespace() {
            if !in_run {
                out.push('_');
            }
            in_run = true;
        } else {
            out.push(c);
            in_run = false;
        }
    }
    out.to_lowercase().trim_start_matches('_').to_string()
}

/// One choice: its id and label.
struct Choice {
    id: String,
    label: String,
}

/// The choices a field offers, and the file they come from (None for the
/// default statuses, which the app holds).
struct Choices {
    list: Vec<Choice>,
    source: Option<String>,
}

/// Exact id, then `option_id(input)` equal to an id, then the trimmed label
/// ignoring case: three passes over the whole list, in that order.
fn match_choice<'c>(choices: &'c [Choice], input: &str) -> Option<&'c Choice> {
    if let Some(hit) = choices.iter().find(|c| c.id == input) {
        return Some(hit);
    }
    let slug = schema::option_id(input);
    if let Some(hit) = choices.iter().find(|c| c.id == slug) {
        return Some(hit);
    }
    let lower = input.trim().to_lowercase();
    choices
        .iter()
        .find(|c| c.label.trim().to_lowercase() == lower)
}

/// One key's note under construction.
struct Line {
    key: String,
    base: String,
    clauses: Vec<String>,
}

impl Line {
    fn text(&self) -> String {
        let mut text = format!("{}: {}", self.key, self.base);
        for clause in &self.clauses {
            text.push_str("; ");
            text.push_str(clause);
        }
        text
    }
}

struct Planner<'c, 'a> {
    ctx: &'c FieldsContext<'a>,
    /// The record's type as its bytes declare it, when a Type doc declares it.
    declared: Option<(&'a str, &'a schema::TypeSchema)>,
    type_doc: Option<&'a str>,
    patch: Map<String, Value>,
    notes: Vec<String>,
    problems: Vec<String>,
}

impl<'c, 'a> Planner<'c, 'a> {
    fn readable(&self, source: &Option<String>) -> bool {
        source
            .as_deref()
            .is_none_or(|path| (self.ctx.may_read)(path))
    }

    fn same_link(&self, a: &str, b: &str) -> bool {
        let (ta, tb) = (target_of(a), target_of(b));
        match (self.ctx.links.resolve(&ta), self.ctx.links.resolve(&tb)) {
            (Some(x), Some(y)) => x.path == y.path,
            _ => ta.to_lowercase() == tb.to_lowercase(),
        }
    }

    fn same(&self, links: bool, a: &Value, b: &Value) -> bool {
        match (links, a.as_str(), b.as_str()) {
            (true, Some(a), Some(b)) => self.same_link(a, b),
            _ => a == b,
        }
    }

    /// A choice field's options: the status chain for a status kind, else
    /// the field's own options.
    fn choices(&self, def: &FieldDef, type_name: &str) -> Choices {
        if self.ctx.table.facts(def.kind).status_set {
            let probe = probe_entry(self.ctx.record, type_name, self.ctx.project);
            let (statuses, from) = self.ctx.schema.status_set_for(&probe);
            let source = match from {
                StatusSource::Project => self.ctx.project.map(str::to_string),
                StatusSource::Type => self.type_doc.map(str::to_string),
                StatusSource::Default => None,
            };
            return Choices {
                list: statuses
                    .into_iter()
                    .map(|s| Choice {
                        id: s.id,
                        label: s.label,
                    })
                    .collect(),
                source,
            };
        }
        Choices {
            list: def
                .options
                .iter()
                .flatten()
                .map(|o| Choice {
                    id: o.id.clone(),
                    label: o.label.clone(),
                })
                .collect(),
            source: self.type_doc.map(str::to_string),
        }
    }

    fn ghost_clause(&self, ghost: &str, choices: &Choices) -> String {
        let mut clause = format!("kept \"{ghost}\" as written, not one of its options");
        if !choices.list.is_empty() && self.readable(&choices.source) {
            let listed: Vec<String> = choices
                .list
                .iter()
                .map(|c| format!("{} \"{}\"", c.id, c.label))
                .collect();
            clause.push_str(&format!(" (options: {})", listed.join(", ")));
        }
        clause
    }

    fn run(&mut self, req: &FieldsRequest, current: &Map<String, Value>) {
        let ops = [
            (Op::Set, &req.set),
            (Op::Add, &req.add),
            (Op::Remove, &req.remove),
        ];
        for (op, map) in ops {
            for (key, value) in map {
                if key == "type" {
                    self.problems.push(TYPE_KEY_PROBLEM.into());
                    continue;
                }
                match self.declared {
                    Some((type_name, ty)) => match ty.fields.iter().find(|f| f.name == *key) {
                        Some(def) => self.declared_key(op, key, value, def, type_name, current),
                        None => {
                            let wanted = normalized_key(key);
                            if let Some(near) =
                                ty.fields.iter().find(|f| normalized_key(&f.name) == wanted)
                            {
                                self.problems.push(format!(
                                    "{key} is not a field of {type_name}; it declares {}",
                                    near.name
                                ));
                            } else {
                                self.undeclared_key(op, key, value, Some(type_name), current);
                            }
                        }
                    },
                    None => self.undeclared_key(op, key, value, None, current),
                }
            }
        }
    }

    /// Land `line` and, when the key changes, its patch entry.
    fn finish(&mut self, line: Line, change: Option<Value>) {
        if let Some(value) = change {
            self.patch.insert(line.key.clone(), value);
        }
        self.notes.push(line.text());
    }

    /// A list delta: `add` appends what is not held, `remove` drops what is.
    /// Returns the line, the change, and the items it added.
    fn delta(
        &self,
        op: Op,
        key: &str,
        items: Vec<Value>,
        links: bool,
        current: &Map<String, Value>,
    ) -> (Line, Option<Value>, Vec<Value>) {
        let mut list = items_of(current.get(key));
        let mut moved: Vec<Value> = Vec::new();
        let mut idle: Vec<Value> = Vec::new();
        for item in items {
            let held = list.iter().any(|h| self.same(links, h, &item));
            match (op, held) {
                (Op::Add, false) => {
                    list.push(item.clone());
                    moved.push(item);
                }
                (Op::Remove, true) => {
                    list.retain(|h| !self.same(links, h, &item));
                    moved.push(item);
                }
                _ => idle.push(item),
            }
        }
        let mut clauses = Vec::new();
        if !idle.is_empty() {
            let word = if op == Op::Add {
                "already held"
            } else {
                "did not hold"
            };
            clauses.push(format!("{word} {}", display_all(&idle)));
        }
        if moved.is_empty() {
            let line = Line {
                key: key.to_string(),
                base: "unchanged".into(),
                clauses,
            };
            return (line, None, moved);
        }
        let verb = if op == Op::Add { "added" } else { "removed" };
        let base = format!("{verb} {}", display_all(&moved));
        let change = if list.is_empty() {
            clauses.push("now empty, so the key is gone".into());
            Value::Null
        } else {
            Value::Array(list)
        };
        let added = if op == Op::Add { moved } else { Vec::new() };
        let line = Line {
            key: key.to_string(),
            base,
            clauses,
        };
        (line, Some(change), added)
    }

    /// A replacement: `set to …`, `removed`, or `unchanged`.
    fn replace(
        &self,
        key: &str,
        input: &Value,
        stored: Option<Value>,
        current: &Map<String, Value>,
    ) -> (Line, Option<Value>) {
        let line = |base: String| Line {
            key: key.to_string(),
            base,
            clauses: Vec::new(),
        };
        match stored {
            None if current.contains_key(key) => (line("removed".into()), Some(Value::Null)),
            None => (line("unchanged".into()), None),
            Some(value) if current.get(key) == Some(&value) => (line("unchanged".into()), None),
            Some(value) => {
                let shown = display(&value);
                let given = display(input);
                let base = if shown == given {
                    format!("set to {shown}")
                } else {
                    format!("set to {shown} (from \"{given}\")")
                };
                (line(base), Some(value))
            }
        }
    }

    fn undeclared_key(
        &mut self,
        op: Op,
        key: &str,
        value: &Value,
        type_name: Option<&str>,
        current: &Map<String, Value>,
    ) {
        let (mut line, change) = match op {
            Op::Set => {
                let stored = (!value.is_null()).then(|| value.clone());
                self.replace(key, value, stored, current)
            }
            _ => {
                let (line, change, _) = self.delta(op, key, items_of(Some(value)), false, current);
                (line, change)
            }
        };
        if let Some(type_name) = type_name {
            line.clauses
                .push(format!("not declared on {type_name}, written as given"));
        }
        self.finish(line, change);
    }

    fn declared_key(
        &mut self,
        op: Op,
        key: &str,
        value: &Value,
        def: &FieldDef,
        type_name: &str,
        current: &Map<String, Value>,
    ) {
        let facts = self.ctx.table.facts(def.kind);
        let derived = facts.links && def.from.is_some();
        let clears = op == Op::Set && value.is_null();
        if (facts.computed || derived) && !clears {
            let probe = match op {
                Op::Set => value.clone(),
                _ => Value::Array(items_of(Some(value))),
            };
            if let Err(problem) = schema::validate_value(def, &probe, self.ctx.table) {
                self.problems.push(problem);
            }
            return;
        }
        if op != Op::Set && !facts.multi {
            self.problems
                .push(format!("{key} holds one value; use set"));
            return;
        }
        let choice = matches!(
            def.kind,
            FieldKind::Select | FieldKind::Multiselect | FieldKind::Status
        );
        let choices = choice.then(|| self.choices(def, type_name));
        let mut ghosts: Vec<String> = Vec::new();
        let mut bad = false;
        let mut normalize = |item: &Value, problems: &mut Vec<String>| -> Value {
            let Some(text) = item.as_str() else {
                return item.clone();
            };
            if let Some(choices) = &choices {
                return match match_choice(&choices.list, text) {
                    Some(hit) => Value::String(hit.id.clone()),
                    None => {
                        let ghost = text.trim().to_string();
                        if op != Op::Remove && !ghosts.contains(&ghost) {
                            ghosts.push(ghost.clone());
                        }
                        Value::String(ghost)
                    }
                };
            }
            if facts.links {
                return match link_value(text) {
                    Some(link) => Value::String(link),
                    None => {
                        bad = true;
                        problems.push(format!(
                            "{key} takes page names or [[links]], one per value; \"{text}\" is neither"
                        ));
                        item.clone()
                    }
                };
            }
            item.clone()
        };
        let mut problems = Vec::new();
        let (mut line, change, checked) = match op {
            Op::Set if value.is_null() => {
                let (line, change) = self.replace(key, value, None, current);
                (line, change, Vec::new())
            }
            Op::Set if facts.multi => {
                let mut list: Vec<Value> = Vec::new();
                for item in items_of(Some(value)) {
                    let item = normalize(&item, &mut problems);
                    if !list.iter().any(|h| self.same(facts.links, h, &item)) {
                        list.push(item);
                    }
                }
                let checked = list.clone();
                let (line, change) = self.replace(key, value, Some(Value::Array(list)), current);
                (line, change, checked)
            }
            Op::Set => {
                let stored = match value {
                    Value::Array(items) => Value::Array(
                        items
                            .iter()
                            .map(|item| normalize(item, &mut problems))
                            .collect(),
                    ),
                    other => normalize(other, &mut problems),
                };
                let checked = items_of(Some(&stored));
                let (line, change) = self.replace(key, value, Some(stored), current);
                (line, change, checked)
            }
            _ => {
                let items: Vec<Value> = items_of(Some(value))
                    .iter()
                    .map(|item| normalize(item, &mut problems))
                    .collect();
                self.delta(op, key, items, facts.links, current)
            }
        };
        self.problems.append(&mut problems);
        if bad {
            return;
        }
        if let Some(choices) = &choices {
            for ghost in &ghosts {
                line.clauses.push(self.ghost_clause(ghost, choices));
            }
        }
        if let (true, Some(target)) = (facts.links, def.target.as_deref()) {
            for item in checked.iter().filter_map(Value::as_str) {
                let page = self
                    .ctx
                    .links
                    .resolve(&target_of(item))
                    .filter(|e| (self.ctx.may_read)(&e.path));
                match page.map(|e| e.entry_type.as_deref()) {
                    None => line.clauses.push(format!(
                        "{item} not checked: no page you can read answers to it"
                    )),
                    Some(None) => self
                        .problems
                        .push(format!("{key} takes {target} records; {item} has no type")),
                    Some(Some(ty)) if ty != target => self.problems.push(format!(
                        "{key} takes {target} records; {item} is typed {ty}"
                    )),
                    Some(Some(_)) => {}
                }
            }
        }
        if let Some(stored) = change.as_ref().filter(|v| !v.is_null()) {
            if let Err(problem) = schema::validate_value(def, stored, self.ctx.table) {
                self.problems.push(problem);
                return;
            }
        }
        self.finish(line, change);
    }
}

/// An entry standing for the record as its bytes declare it, for the status
/// chain: its own type and project.
fn probe_entry(record: &str, type_name: &str, project: Option<&str>) -> Entry {
    Entry {
        path: record.to_string(),
        filename: record.rsplit('/').next().unwrap_or(record).to_string(),
        folder: record
            .rsplit_once('/')
            .map(|(dir, _)| dir)
            .unwrap_or("")
            .to_string(),
        project: project.map(str::to_string),
        title: String::new(),
        entry_type: Some(type_name.to_string()),
        properties: Map::new(),
        relationships: Default::default(),
        outgoing_links: Vec::new(),
        snippet: String::new(),
        created_at: String::new(),
        modified_at: String::new(),
        parse_error: None,
        hash: None,
    }
}

/// Plan a `set_fields` call against `current`, the record's frontmatter as
/// its bytes hold it now: the patch and a note per key, or every problem.
///
/// The record's type comes from `current`'s `type:`, never the scan. A note
/// with no type, or a type no Type doc declares, is written unchecked, and
/// its first note says so.
pub fn plan(
    ctx: &FieldsContext<'_>,
    current: &Map<String, Value>,
    req: &FieldsRequest,
) -> Result<FieldsPlan, Vec<String>> {
    let type_name = current.get("type").and_then(Value::as_str);
    let mut notes = Vec::new();
    let declared = match type_name {
        None => {
            notes.push(format!("Nothing was checked: {} has no type.", req.path));
            None
        }
        Some(name) => match ctx.schema.type_named(name) {
            Some(ty) => Some((ty.name.as_str(), ty)),
            None => {
                notes.push(format!("Nothing was checked: no Type doc declares {name}."));
                None
            }
        },
    };
    let type_doc = declared.and_then(|(name, _)| {
        ctx.entries
            .iter()
            .rev()
            .find(|e| e.entry_type.as_deref() == Some("Type") && e.title == name)
            .map(|e| e.path.as_str())
    });
    let mut planner = Planner {
        ctx,
        declared,
        type_doc,
        patch: Map::new(),
        notes,
        problems: Vec::new(),
    };
    planner.run(req, current);
    if planner.problems.is_empty() {
        Ok(FieldsPlan {
            patch: planner.patch,
            notes: planner.notes,
        })
    } else {
        Err(planner.problems)
    }
}

/// What the model reads when the plan refused: nothing was written, and one
/// line per problem.
pub fn refusal_text(path: &str, problems: &[String]) -> String {
    let mut text = format!("schema_invalid: nothing was written to {path}.");
    for problem in problems {
        text.push_str("\n- ");
        text.push_str(problem);
    }
    text
}

/// What the model reads after a plan landed (or changed nothing): the
/// header, the notes, and the hash the record holds now (get_note's label).
pub fn report_text(path: &str, notes: &[String], hash: &str, changed: bool) -> String {
    let mut text = if changed {
        format!("Set fields on {path}.")
    } else {
        format!("Nothing changed on {path}.")
    };
    for note in notes {
        text.push('\n');
        text.push_str(note);
    }
    text.push_str(&format!("\nHash: {hash}"));
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const CASES: &str = include_str!("../../fixtures/set-fields-cases.json");

    fn file() -> Value {
        serde_json::from_str(CASES).expect("set-fields-cases.json parses")
    }

    fn corpus(file: &Value) -> Vec<Entry> {
        file["corpus"]
            .as_array()
            .expect("a corpus")
            .iter()
            .map(|raw| {
                let path = raw["path"].as_str().unwrap();
                let mut e = Entry::empty_for_test(path);
                e.title = raw["title"].as_str().unwrap().to_string();
                e.entry_type = raw["type"].as_str().map(str::to_string);
                e.properties = raw["properties"].as_object().cloned().unwrap_or_default();
                e
            })
            .collect()
    }

    fn table() -> &'static KindTable {
        schema::table().expect("the shipped table loads")
    }

    /// Run one case of the file: its parse, then its plan.
    fn outcome(entries: &[Entry], case: &Value) -> Value {
        let args = case["args"].as_object().cloned().unwrap_or_default();
        let req = match parse_request(&args) {
            Ok(req) => req,
            Err(error) => return json!({ "error": error }),
        };
        let vault = VaultSchema::from_entries(entries, table());
        let links = TargetIndex::build(entries);
        let unreadable: Vec<String> = case["unreadable"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p.as_str().unwrap().to_string())
            .collect();
        let may_read = |path: &str| !unreadable.iter().any(|u| u == path);
        let ctx = FieldsContext {
            table: table(),
            schema: &vault,
            entries,
            links: &links,
            record: case["record"].as_str().unwrap(),
            project: case["project"].as_str(),
            may_read: &may_read,
        };
        let current = case["frontmatter"].as_object().cloned().unwrap();
        match plan(&ctx, &current, &req) {
            Ok(planned) => json!({ "patch": planned.patch, "notes": planned.notes }),
            Err(problems) => json!({ "refused": problems }),
        }
    }

    fn expected(case: &Value) -> Value {
        let mut want = Map::new();
        for key in ["patch", "notes", "refused", "error"] {
            if let Some(value) = case.get(key) {
                want.insert(key.to_string(), value.clone());
            }
        }
        Value::Object(want)
    }

    fn named(fragment: &str) -> (Value, Value) {
        let file = file();
        let entries = corpus(&file);
        let case = file["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"].as_str().unwrap().contains(fragment))
            .unwrap_or_else(|| panic!("a case named like {fragment}"))
            .clone();
        (outcome(&entries, &case), expected(&case))
    }

    fn holds(fragment: &str) -> Value {
        let (got, want) = named(fragment);
        assert_eq!(got, want, "{fragment}");
        got
    }

    #[test]
    fn replays_the_shared_set_fields_cases() {
        let file = file();
        let entries = corpus(&file);
        let cases = file["cases"].as_array().expect("cases");
        assert!(cases.len() >= 40);
        for case in cases {
            let name = case["name"].as_str().expect("a name");
            assert_eq!(outcome(&entries, case), expected(case), "{name}");
        }
        for case in file["texts"]["reports"].as_array().unwrap() {
            let notes: Vec<String> = case["notes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|n| n.as_str().unwrap().to_string())
                .collect();
            assert_eq!(
                report_text(
                    case["path"].as_str().unwrap(),
                    &notes,
                    case["hash"].as_str().unwrap(),
                    case["changed"].as_bool().unwrap(),
                ),
                case["text"].as_str().unwrap()
            );
        }
        for case in file["texts"]["refusals"].as_array().unwrap() {
            let problems: Vec<String> = case["problems"]
                .as_array()
                .unwrap()
                .iter()
                .map(|n| n.as_str().unwrap().to_string())
                .collect();
            assert_eq!(
                refusal_text(case["path"].as_str().unwrap(), &problems),
                case["text"].as_str().unwrap()
            );
        }
    }

    #[test]
    fn a_label_is_stored_as_its_option_id() {
        let got = holds("A status label is stored as its id");
        assert_eq!(got["patch"]["status"], "in-progress");
        assert_eq!(
            holds("A select takes its label")["patch"]["priority"],
            "med"
        );
        let disagree = holds("where the passes disagree");
        assert_eq!(disagree["patch"]["phase"], "later");
    }

    #[test]
    fn the_project_override_decides_a_status() {
        assert_eq!(
            holds("The project's statuses override wins")["patch"]["status"],
            "shipping"
        );
        assert_eq!(holds("A type's own statuses")["patch"]["status"], "shipped");
    }

    #[test]
    fn unknown_options_are_kept_and_named() {
        let got = holds("An unknown select value is kept");
        assert_eq!(got["patch"]["priority"], "Critical");
        assert!(got["notes"][0]
            .as_str()
            .unwrap()
            .contains("kept \"Critical\""));
    }

    #[test]
    fn options_are_listed_only_when_their_source_is_readable() {
        let open = holds("a default status is a ghost, kept and named");
        assert!(open["notes"][0]
            .as_str()
            .unwrap()
            .contains("(options: planned"));
        let closed = holds("Under a project override the run cannot read");
        assert!(!closed["notes"][0].as_str().unwrap().contains("options:"));
        let hidden = holds("whose Type doc the run cannot read");
        assert!(!hidden["notes"][0].as_str().unwrap().contains("options:"));
    }

    #[test]
    fn person_and_relation_values_are_stored_as_links() {
        assert_eq!(
            holds("A person value names a page")["patch"]["owner"],
            json!(["[[alice]]"])
        );
        let kept = holds("One exact link is kept byte for byte");
        assert_eq!(kept["patch"]["owner"], json!(["[[Alice Smith|Al]]"]));
        holds("an open bracket, an empty value and an empty link");
    }

    #[test]
    fn a_link_to_another_database_is_refused_naming_the_one_expected() {
        let got = holds("A link to a record of another type is refused");
        assert_eq!(
            got["refused"][0],
            "epic takes Epic records; [[write-copy]] is typed Task"
        );
        holds("A link to an untyped page is refused");
    }

    #[test]
    fn a_link_no_readable_page_answers_is_kept_unchecked() {
        let got = holds("is kept and noted, not checked");
        assert_eq!(
            got["patch"]["related"],
            json!(["[[nowhere]]", "[[secret-plan]]"])
        );
        holds("A field with no target takes a link to any page");
    }

    #[test]
    fn computed_and_derived_fields_are_refused() {
        holds("are computed and refused");
        holds("The other side of a relation stores nothing");
        holds("add on the other side of a relation");
    }

    #[test]
    fn add_skips_held_items_and_remove_ignores_absent_ones() {
        holds("add appends what is not held");
        holds("another spelling of a held page is held");
        holds("remove drops what is held");
        holds("add with nothing new");
        holds("add on a scalar current value");
    }

    #[test]
    fn an_emptied_list_removes_the_key() {
        let got = holds("remove that empties a list");
        assert_eq!(got["patch"]["tags"], Value::Null);
    }

    #[test]
    fn single_value_fields_refuse_add_and_remove() {
        holds("add and remove apply only to list fields");
    }

    #[test]
    fn a_limit_one_field_refuses_a_second_link() {
        holds("A limit: 1 relation refuses a second link");
        holds("add on a limit: 1 relation");
    }

    #[test]
    fn undeclared_keys_pass_and_are_named() {
        holds("Undeclared keys pass as given");
    }

    #[test]
    fn a_near_miss_key_names_the_declared_field() {
        holds("A key that matches a declared field ignoring case");
    }

    #[test]
    fn the_type_key_is_refused() {
        holds("The type key is refused");
    }

    #[test]
    fn a_note_without_a_type_doc_is_written_unchecked() {
        holds("A note with no type is written unchecked");
        holds("A type no Type doc declares");
    }

    #[test]
    fn every_problem_is_reported_at_once() {
        let got = holds("Every problem is reported at once");
        assert_eq!(got["refused"].as_array().unwrap().len(), 4);
    }

    #[test]
    fn a_set_that_changes_nothing_plans_an_empty_patch() {
        let got = holds("A set that changes nothing");
        assert_eq!(got["patch"], json!({}));
    }
}
