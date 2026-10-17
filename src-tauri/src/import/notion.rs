//! Notion's documented enhanced markdown, normalized into Cerebro's disk
//! carriers (M69.5). Unknown structure refuses; fetched text is never executed.
use super::capture::Capture;
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::{BTreeMap, HashMap, HashSet};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Refusal {
    pub reason: &'static str,
    pub words: String,
}
impl Refusal {
    pub fn new(reason: &'static str, words: impl Into<String>) -> Self {
        Self {
            reason,
            words: words.into(),
        }
    }
    pub fn composable(&self) -> bool {
        matches!(self.reason, "truncated" | "narrated" | "unhandled_markup")
    }
    pub fn reply(&self) -> String {
        let mut reply = format!(
            "import_refused: {} — {} Nothing was written.",
            self.reason, self.words
        );
        if self.composable() {
            reply.push_str(" You may compose the page yourself from what the fetch returned and call again with it as body; it will be marked as composed by you.");
        }
        reply
    }
}
fn markup(name: &str) -> Refusal {
    Refusal::new(
        "unhandled_markup",
        format!("The fetch holds <{name}> markup this importer cannot carry."),
    )
}
#[derive(Debug, Clone, Serialize)]
pub struct Page {
    pub title: String,
    pub url: String,
    pub properties: Map<String, Value>,
    pub body: String,
    pub icon: Option<String>,
}
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct Counts {
    pub linked: usize,
    pub media: usize,
    pub databases: usize,
}
#[derive(Debug, Clone, Serialize)]
pub struct Normalized {
    pub markdown: String,
    pub counts: Counts,
}

/// The page envelope is distinct from its content. A summary, search result,
/// database, or a different page never becomes this requested page's bytes.
/// Synthetic fixtures follow the documented enhanced-markdown envelope until
/// the owner's isolated connector recording establishes any additional shape.
pub fn parse(capture: &Capture, page: &str) -> Result<Page, Refusal> {
    if capture.is_error {
        return Err(Refusal::new(
            "fetch_failed",
            "The connector reported that its fetch failed.",
        ));
    }
    if capture.truncated {
        return Err(Refusal::new(
            "truncated",
            "The fetch exceeded the capture limit.",
        ));
    }
    let raw = capture.text.trim();
    if raw.is_empty() {
        return Err(Refusal::new("empty", "The fetch returned no page text."));
    }
    let json = serde_json::from_str::<Value>(raw).ok();
    let kind = json
        .as_ref()
        .and_then(|v| v.pointer("/metadata/type").or_else(|| v.get("object")))
        .and_then(Value::as_str);
    if matches!(kind, Some("database" | "data_source")) {
        return Err(Refusal::new(
            "database_first",
            "The fetch returned a database. Fetch one page instead.",
        ));
    }
    if json
        .as_ref()
        .is_some_and(|v| v.get("truncated") == Some(&Value::Bool(true)))
    {
        return Err(Refusal::new(
            "truncated",
            "The connector marked this page as truncated.",
        ));
    }
    let text = json
        .as_ref()
        .and_then(|v| v.get("text"))
        .and_then(Value::as_str)
        .unwrap_or(raw)
        .trim();
    if text.starts_with("<database") {
        return Err(Refusal::new(
            "database_first",
            "The fetch returned a database. Fetch one page instead.",
        ));
    }
    let Some((tag, end)) = tag_at(text, 0)? else {
        return Err(Refusal::new(
            "narrated",
            "The fetch returned prose instead of a complete page envelope.",
        ));
    };
    if tag.name != "page" || tag.closing || tag.empty {
        return Err(Refusal::new(
            "not_a_page",
            "The fetch did not return a page.",
        ));
    }
    let url = tag.attrs.get("url").cloned().or_else(|| {
        json.as_ref()
            .and_then(|v| v.get("url"))
            .and_then(Value::as_str)
            .map(str::to_owned)
    });
    let url = url
        .filter(|url| notion_id(url).as_deref() == Some(page))
        .ok_or_else(|| {
            Refusal::new(
                "not_a_page",
                "The fetched page's identity does not match the page requested.",
            )
        })?;
    let rest = text[end..].trim();
    let rest = rest
        .strip_suffix("</page>")
        .ok_or_else(|| Refusal::new("truncated", "The page envelope has no end."))?;
    let mut properties = Map::new();
    if let Some((_, tail)) = rest.split_once("<properties>") {
        let (raw_props, _) = tail
            .split_once("</properties>")
            .ok_or_else(|| Refusal::new("truncated", "The page properties have no end."))?;
        properties = serde_json::from_str::<Value>(raw_props.trim())
            .ok()
            .and_then(|v| v.as_object().cloned())
            .ok_or_else(|| markup("properties"))?;
    }
    let (before, tail) = rest
        .split_once("<content>")
        .ok_or_else(|| Refusal::new("not_a_page", "The fetch has no page content."))?;
    let (body, after) = tail
        .rsplit_once("</content>")
        .ok_or_else(|| Refusal::new("truncated", "The page content has no end."))?;
    // Content must be the final envelope field; unfamiliar material cannot be
    // silently discarded. Ancestry and property metadata precede it.
    if !after.trim().is_empty() || before.contains("<content>") {
        return Err(markup("page"));
    }
    if body.trim().is_empty() {
        return Err(Refusal::new("empty", "The fetched page has no body."));
    }
    let title = json
        .as_ref()
        .and_then(|v| v.get("title"))
        .and_then(Value::as_str)
        .or_else(|| properties.get("title").and_then(Value::as_str))
        .or_else(|| properties.get("Name").and_then(Value::as_str))
        .filter(|title| !title.trim().is_empty())
        .unwrap_or("Untitled Notion page")
        .trim()
        .to_owned();
    Ok(Page {
        title,
        url,
        properties,
        body: body.trim().to_owned(),
        icon: json
            .as_ref()
            .and_then(|v| v.pointer("/icon/emoji").or_else(|| v.get("icon")))
            .and_then(Value::as_str)
            .or_else(|| tag.attrs.get("icon").map(String::as_str))
            .filter(|s| {
                !s.is_ascii() && s.chars().count() <= 16 && !s.chars().any(char::is_control)
            })
            .map(str::to_owned),
    })
}

/// Only exact Notion HTTPS hosts establish an imported-page relationship.
pub fn notion_id(url: &str) -> Option<String> {
    let parsed = tauri::Url::parse(url).ok()?;
    if parsed.scheme() != "https"
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.port().is_some()
        || !matches!(
            parsed.host_str(),
            Some("notion.so" | "www.notion.so" | "notion.site" | "www.notion.site")
        )
    {
        return None;
    }
    super::canonical_record_id("notion", parsed.path()).ok()
}

#[derive(Debug)]
struct Tag {
    name: String,
    attrs: BTreeMap<String, String>,
    closing: bool,
    empty: bool,
}
#[derive(Debug)]
enum Node {
    Text(String),
    Code(String),
    Element(Tag, Vec<Node>),
}
fn name_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_')
}
fn decode(text: &str) -> Result<String, Refusal> {
    // Keep entity decoding behind the same outside-bytes boundary as Office
    // XML. The captured envelope is bounded before this scanner runs.
    crate::files::extract::xml::unescape(text).map_err(|_| markup("entity"))
}
/// A small quote-aware tag scanner. Ordinary comparisons and autolinks stay
/// text; real but unsupported tags get a typed refusal during rendering.
fn tag_at(text: &str, at: usize) -> Result<Option<(Tag, usize)>, Refusal> {
    let bytes = text.as_bytes();
    if bytes.get(at) != Some(&b'<') {
        return Ok(None);
    }
    let mut pos = at + 1;
    let closing = bytes.get(pos) == Some(&b'/');
    if closing {
        pos += 1;
    }
    let start = pos;
    while bytes.get(pos).is_some_and(|b| name_byte(*b)) {
        pos += 1;
    }
    if start == pos || !bytes[start].is_ascii_alphabetic() {
        return Ok(None);
    }
    if bytes
        .get(pos)
        .is_some_and(|b| !b.is_ascii_whitespace() && !matches!(b, b'/' | b'>'))
    {
        return Ok(None);
    }
    let name = text[start..pos].to_owned();
    let mut attrs = BTreeMap::new();
    loop {
        while bytes.get(pos).is_some_and(u8::is_ascii_whitespace) {
            pos += 1;
        }
        if bytes.get(pos) == Some(&b'>') {
            return Ok(Some((
                Tag {
                    name,
                    attrs,
                    closing,
                    empty: false,
                },
                pos + 1,
            )));
        }
        if bytes.get(pos..pos + 2) == Some(b"/>") {
            return Ok(Some((
                Tag {
                    name,
                    attrs,
                    closing,
                    empty: true,
                },
                pos + 2,
            )));
        }
        if closing {
            return Err(markup(&name));
        }
        let start = pos;
        while bytes.get(pos).is_some_and(|b| name_byte(*b)) {
            pos += 1;
        }
        if start == pos {
            return Err(markup(&name));
        }
        let key = &text[start..pos];
        while bytes.get(pos).is_some_and(u8::is_ascii_whitespace) {
            pos += 1;
        }
        if bytes.get(pos) != Some(&b'=') {
            return Err(markup(&name));
        }
        pos += 1;
        while bytes.get(pos).is_some_and(u8::is_ascii_whitespace) {
            pos += 1;
        }
        let quote = *bytes
            .get(pos)
            .filter(|b| matches!(b, b'\'' | b'"'))
            .ok_or_else(|| markup(&name))?;
        pos += 1;
        let start = pos;
        while bytes.get(pos).is_some_and(|b| *b != quote) {
            pos += 1;
        }
        if bytes.get(pos) != Some(&quote) {
            return Err(markup(&name));
        }
        if attrs
            .insert(key.to_owned(), decode(&text[start..pos])?)
            .is_some()
        {
            return Err(markup(&name));
        }
        pos += 1;
    }
}
fn fence_end(text: &str, at: usize) -> Option<usize> {
    if at > 0 && text.as_bytes()[at - 1] != b'\n' {
        return None;
    }
    let line_end = text[at..].find('\n').map_or(text.len(), |i| at + i + 1);
    let line = text[at..line_end].trim_start_matches([' ', '\t']);
    let marker = *line.as_bytes().first()?;
    if !matches!(marker, b'`' | b'~') {
        return None;
    }
    let size = line.bytes().take_while(|b| *b == marker).count();
    if size < 3 {
        return None;
    }
    let mut pos = line_end;
    while pos < text.len() {
        let end = text[pos..].find('\n').map_or(text.len(), |i| pos + i + 1);
        let line = text[pos..end].trim();
        if line.bytes().take_while(|b| *b == marker).count() >= size
            && line.bytes().all(|b| b == marker)
        {
            return Some(end);
        }
        pos = end;
    }
    Some(text.len())
}
fn nodes(text: &str) -> Result<Vec<Node>, Refusal> {
    let mut stack: Vec<(Tag, Vec<Node>)> = Vec::new();
    let mut out = Vec::new();
    let mut pos = 0;
    let mut plain = String::new();
    let mut count = 0;
    fn add(stack: &mut [(Tag, Vec<Node>)], out: &mut Vec<Node>, node: Node) {
        if let Some((_, nodes)) = stack.last_mut() {
            nodes.push(node);
        } else {
            out.push(node);
        }
    }
    while pos < text.len() {
        let code_end = fence_end(text, pos).or_else(|| {
            if text.as_bytes()[pos] != b'`' {
                return None;
            }
            let n = text[pos..].bytes().take_while(|b| *b == b'`').count();
            text[pos + n..]
                .find(&"`".repeat(n))
                .map(|i| pos + n + i + n)
        });
        if let Some(end) = code_end {
            if !plain.is_empty() {
                add(&mut stack, &mut out, Node::Text(std::mem::take(&mut plain)));
            }
            add(&mut stack, &mut out, Node::Code(text[pos..end].into()));
            pos = end;
            continue;
        }
        if text.as_bytes()[pos] == b'\\' {
            plain.push('\\');
            pos += 1;
            if let Some(c) = text[pos..].chars().next() {
                plain.push(c);
                pos += c.len_utf8();
            }
            continue;
        }
        if let Some((tag, end)) = tag_at(text, pos)? {
            count += 1;
            if count > 100_000 || stack.len() >= 64 {
                return Err(markup("nesting-limit"));
            }
            if !plain.is_empty() {
                add(&mut stack, &mut out, Node::Text(std::mem::take(&mut plain)));
            }
            if tag.closing {
                let (open, children) = stack
                    .pop()
                    .filter(|(open, _)| open.name == tag.name)
                    .ok_or_else(|| markup(&tag.name))?;
                add(&mut stack, &mut out, Node::Element(open, children));
            } else if tag.empty || matches!(tag.name.as_str(), "br" | "hr" | "col") {
                add(&mut stack, &mut out, Node::Element(tag, vec![]));
            } else {
                stack.push((tag, vec![]));
            }
            pos = end;
            continue;
        }
        let c = text[pos..].chars().next().expect("character");
        plain.push(c);
        pos += c.len_utf8();
    }
    if !stack.is_empty() {
        return Err(markup(&stack[0].0.name));
    }
    if !plain.is_empty() {
        out.push(Node::Text(plain));
    }
    Ok(out)
}

/// One bounded ordinary Markdown link. A new bracket or line ends this
/// candidate; an existing wikilink can never borrow a later link's closer.
fn markdown_link(text: &str, start: usize) -> Option<(usize, usize, &str)> {
    let mut pos = start + 1;
    while pos < text.len() {
        let c = text[pos..].chars().next()?;
        match c {
            '[' | '\n' | '\r' | '`' => return None,
            '\\' => {
                pos += 1;
                pos += text[pos..].chars().next()?.len_utf8();
            }
            ']' => {
                if text.as_bytes().get(pos + 1) != Some(&b'(') {
                    return None;
                }
                let tail = &text[pos + 2..];
                let end = tail.find([')', '\n', '\r'])?;
                if tail.as_bytes()[end] != b')' {
                    return None;
                }
                return Some((pos, pos + 2 + end, &tail[..end]));
            }
            _ => pos += c.len_utf8(),
        }
    }
    None
}

fn inline_media(text: &str, count: &mut usize) -> String {
    let mut out = String::new();
    let mut pos = 0;
    while pos < text.len() {
        if text[pos..].starts_with("![") && (pos == 0 || text.as_bytes()[pos - 1] != b'\\') {
            if let Some((mid, end, raw)) = markdown_link(text, pos + 1) {
                if let Some(url) = safe_url(raw) {
                    let label = &text[pos + 2..mid];
                    out.push_str(&format!(
                        "[{}]({url})",
                        if label.is_empty() { "Image" } else { label }
                    ));
                    *count += 1;
                    pos = end + 1;
                    continue;
                }
            }
        }
        let c = text[pos..].chars().next().expect("character");
        out.push(c);
        pos += c.len_utf8();
    }
    out
}
/// v1 heading attributes and tab-indented toggle children become the same
/// structural node as v2 details/summary. Fenced source is copied untouched.
fn prepare_headings(body: &str) -> Result<String, Refusal> {
    let lines: Vec<&str> = body.split_inclusive('\n').collect();
    let mut out = String::new();
    let mut i = 0;
    let mut offset = 0;
    while i < lines.len() {
        if let Some(end) = fence_end(body, offset) {
            out.push_str(&body[offset..end]);
            while i < lines.len() && offset < end {
                offset += lines[i].len();
                i += 1;
            }
            continue;
        }
        let line = lines[i];
        let trimmed = line.trim();
        let heading = trimmed.bytes().take_while(|b| *b == b'#').count();
        if (1..=4).contains(&heading)
            && trimmed.as_bytes().get(heading) == Some(&b' ')
            && trimmed.ends_with('}')
        {
            if let Some(open) = trimmed.rfind(" {") {
                let attrs = &trimmed[open + 2..trimmed.len() - 1];
                let attr_source = format!("<heading {attrs}>");
                if let Some((tag, _)) = tag_at(&attr_source, 0)? {
                    if tag
                        .attrs
                        .keys()
                        .any(|key| !matches!(key.as_str(), "toggle" | "color"))
                    {
                        return Err(markup("heading"));
                    }
                    let title = &trimmed[..open];
                    if tag.attrs.get("toggle").is_some_and(|v| v == "true") {
                        out.push_str(&format!("<details><summary>{title}</summary>\n"));
                        offset += line.len();
                        i += 1;
                        while i < lines.len() {
                            let next = lines[i];
                            if !next.trim().is_empty()
                                && !next.starts_with('\t')
                                && !next.starts_with("    ")
                            {
                                break;
                            }
                            out.push_str(
                                next.strip_prefix('\t')
                                    .or_else(|| next.strip_prefix("    "))
                                    .unwrap_or(next),
                            );
                            offset += next.len();
                            i += 1;
                        }
                        out.push_str("\n</details>\n");
                        continue;
                    }
                    out.push_str(title);
                    out.push('\n');
                    offset += line.len();
                    i += 1;
                    continue;
                }
            }
        }
        out.push_str(line);
        offset += line.len();
        i += 1;
    }
    Ok(out)
}

fn block(text: &str) -> String {
    format!("\n\n{}\n\n", text.trim())
}
fn carrier(name: &str, body: &str, depth: usize) -> String {
    let colon = ":".repeat(depth);
    block(&format!("{colon}{name}\n\n{}\n\n{colon}", body.trim()))
}
fn escape_markers(text: &str) -> String {
    text.split_inclusive('\n')
        .map(|line| {
            let trimmed = line.trim_start_matches([' ', '\t']);
            if trimmed.starts_with(":::") {
                format!("{}\\{}", &line[..line.len() - trimmed.len()], trimmed)
            } else {
                line.to_owned()
            }
        })
        .collect()
}
fn plain(nodes: &[Node]) -> String {
    nodes
        .iter()
        .map(|n| match n {
            Node::Text(t) | Node::Code(t) => t.clone(),
            Node::Element(_, c) => plain(c),
        })
        .collect()
}
fn safe_label(text: &str) -> String {
    text.replace(['\n', '\r'], " ").replace(['[', ']'], "")
}
fn label_without_address(text: &str) -> String {
    let text = text.trim();
    if text.contains('@') || text.to_ascii_lowercase().starts_with("mailto:") {
        "Person".into()
    } else {
        safe_label(text)
    }
}
fn safe_url(raw: &str) -> Option<String> {
    let url = tauri::Url::parse(raw).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    Some(
        raw.replace('(', "%28")
            .replace(')', "%29")
            .replace(['\n', '\r'], ""),
    )
}
struct Render<'a> {
    links: &'a HashMap<String, String>,
    counts: Counts,
}
impl Render<'_> {
    fn link(&mut self, label: &str, url: &str) -> String {
        if let Some(stem) = notion_id(url).and_then(|id| self.links.get(&id)) {
            self.counts.linked += 1;
            return format!("[[{stem}]]");
        }
        safe_url(url).map_or_else(
            || safe_label(label),
            |url| format!("[{}]({url})", safe_label(label)),
        )
    }
    fn render(&mut self, nodes: &[Node], depth: usize) -> Result<String, Refusal> {
        let mut out = String::new();
        for node in nodes {
            let text = match node {
                Node::Code(text) => text.clone(),
                Node::Text(text) => {
                    let text = inline_media(text, &mut self.counts.media);
                    escape_markers(&relink(&text, self.links, &mut self.counts.linked))
                }
                Node::Element(tag, children) => {
                    let attr = |key: &str| tag.attrs.get(key).map(String::as_str);
                    match tag.name.as_str() {
                        "span" | "u" | "b" | "strong" | "em" | "i" | "s" | "del" => {
                            let content = self.render(children, depth)?;
                            match tag.name.as_str() {
                                "b" | "strong" => format!("**{content}**"),
                                "i" | "em" => format!("*{content}*"),
                                "s" | "del" => format!("~~{content}~~"),
                                _ => content,
                            }
                        }
                        "br" => "\n".into(),
                        "hr" => block("---"),
                        "empty-block" | "table_of_contents" | "table-of-contents" => "\n\n".into(),
                        "p" => block(&self.render(children, depth)?),
                        "quote" => block(
                            &self
                                .render(children, depth)?
                                .trim()
                                .lines()
                                .map(|l| format!("> {l}"))
                                .collect::<Vec<_>>()
                                .join("\n"),
                        ),
                        "h1" | "h2" | "h3" | "h4" => block(&format!(
                            "{} {}",
                            "#".repeat(tag.name[1..].parse::<usize>().unwrap_or(1)),
                            self.render(children, depth)?.trim()
                        )),
                        "ul" | "ol" => {
                            let mut lines = vec![];
                            for (i, child) in children
                                .iter()
                                .filter(|n| !matches!(n,Node::Text(t) if t.trim().is_empty()))
                                .enumerate()
                            {
                                let Node::Element(li, body) = child else {
                                    return Err(markup(&tag.name));
                                };
                                if li.name != "li" {
                                    return Err(markup(&li.name));
                                }
                                let text = self.render(body, depth)?;
                                let prefix = if tag.name == "ol" {
                                    format!("{}. ", i + 1)
                                } else {
                                    "- ".into()
                                };
                                lines
                                    .push(format!("{prefix}{}", text.trim().replace('\n', "\n  ")));
                            }
                            block(&lines.join("\n"))
                        }
                        "todo" => block(&format!(
                            "- [{}] {}",
                            if attr("checked") == Some("true") {
                                "x"
                            } else {
                                " "
                            },
                            self.render(children, depth)?.trim()
                        )),
                        "callout" => {
                            let kind =
                                match attr("color").unwrap_or("").trim_end_matches("_background") {
                                    "red" => "danger",
                                    "yellow" | "orange" => "warning",
                                    "green" => "tip",
                                    _ => "note",
                                };
                            let content = self.render(children, depth + 1)?;
                            let mut parts = content.trim().splitn(2, "\n\n");
                            let first = parts.next().unwrap_or("");
                            let head = format!(
                                "> [!{kind}]\n{}",
                                first
                                    .lines()
                                    .map(|l| format!("> {l}"))
                                    .collect::<Vec<_>>()
                                    .join("\n")
                            );
                            let rest = parts
                                .next()
                                .filter(|s| !s.trim().is_empty())
                                .map(|s| carrier("indent", s, depth))
                                .unwrap_or_default();
                            format!("{}{rest}", block(&head))
                        }
                        "columns" => {
                            let mut body = String::new();
                            for child in children {
                                if matches!(child,Node::Text(t) if t.trim().is_empty()) {
                                    continue;
                                }
                                let Node::Element(column, items) = child else {
                                    return Err(markup("columns"));
                                };
                                if column.name != "column" {
                                    return Err(markup(&column.name));
                                }
                                body.push_str(&carrier(
                                    "column",
                                    &self.render(items, depth + 2)?,
                                    depth + 1,
                                ));
                            }
                            carrier("columns", &body, depth)
                        }
                        "details" => {
                            let mut content: Vec<&Node> = children
                                .iter()
                                .filter(|n| !matches!(n,Node::Text(t) if t.trim().is_empty()))
                                .collect();
                            let Some(Node::Element(summary, items)) = content.first().copied()
                            else {
                                return Err(markup("details"));
                            };
                            if summary.name != "summary" {
                                return Err(markup("details"));
                            }
                            let title = self.render(items, depth + 1)?;
                            content.remove(0);
                            let mut body = String::new();
                            for child in content {
                                body.push_str(
                                    &self.render(std::slice::from_ref(child), depth + 1)?,
                                );
                            }
                            if title.trim_start().starts_with('#') {
                                carrier(
                                    "toggle-heading",
                                    &format!("{}\n\n{}", title.trim(), body.trim()),
                                    depth,
                                )
                            } else {
                                carrier(
                                    &format!("toggle {}", title.trim().replace('\n', " ")),
                                    &body,
                                    depth,
                                )
                            }
                        }
                        "table" => self.table(children, depth)?,
                        "page" => block(
                            &self
                                .link(&plain(children), attr("url").ok_or_else(|| markup("page"))?),
                        ),
                        "database" | "data-source" => {
                            self.counts.databases += 1;
                            String::new()
                        }
                        "mention-user" | "mention-agent" => label_without_address(&plain(children)),
                        "mention-page" => self.link(&plain(children), attr("url").unwrap_or("")),
                        "mention-database" | "mention-data-source" => safe_label(&plain(children)),
                        "mention-date" => {
                            let start = attr("start").unwrap_or("");
                            let end = attr("end").unwrap_or("");
                            if start.is_empty() {
                                safe_label(&plain(children))
                            } else if end.is_empty() || end == start {
                                start.into()
                            } else {
                                format!("{start} – {end}")
                            }
                        }
                        "image" | "file" | "pdf" | "audio" | "video" | "bookmark" | "embed" => {
                            let url = attr("src")
                                .or_else(|| attr("source"))
                                .or_else(|| attr("url"))
                                .ok_or_else(|| markup(&tag.name))?;
                            let url = safe_url(url).ok_or_else(|| markup(&tag.name))?;
                            self.counts.media += 1;
                            let label = plain(children);
                            let label = if label.trim().is_empty() {
                                tag.name.as_str()
                            } else {
                                label.trim()
                            };
                            block(&format!("[{}]({url})", safe_label(label)))
                        }
                        _ => return Err(markup(&tag.name)),
                    }
                }
            };
            out.push_str(&text);
        }
        Ok(out)
    }
    fn table(&mut self, nodes: &[Node], depth: usize) -> Result<String, Refusal> {
        let mut rows: Vec<Vec<String>> = vec![];
        for node in nodes {
            if matches!(node,Node::Text(t) if t.trim().is_empty()) {
                continue;
            }
            let Node::Element(tag, children) = node else {
                return Err(markup("table"));
            };
            if tag.name == "colgroup" {
                continue;
            }
            if tag.name != "tr" {
                return Err(markup(&tag.name));
            }
            let mut row = vec![];
            for cell in children {
                if matches!(cell,Node::Text(t) if t.trim().is_empty()) {
                    continue;
                }
                let Node::Element(tag, body) = cell else {
                    return Err(markup("table"));
                };
                if !matches!(tag.name.as_str(), "td" | "th")
                    || tag.attrs.contains_key("colspan")
                    || tag.attrs.contains_key("rowspan")
                {
                    return Err(markup(&tag.name));
                }
                row.push(
                    self.render(body, depth)?
                        .trim()
                        .replace('|', "\\|")
                        .replace('\n', " "),
                );
            }
            rows.push(row);
        }
        let width = rows.iter().map(Vec::len).max().unwrap_or(0);
        if width == 0 {
            return Ok(String::new());
        }
        let mut lines = vec![];
        for (i, row) in rows.iter_mut().enumerate() {
            row.resize(width, String::new());
            lines.push(format!("| {} |", row.join(" | ")));
            if i == 0 {
                lines.push(format!("| {} |", vec!["---"; width].join(" | ")));
            }
        }
        Ok(block(&lines.join("\n")))
    }
}

/// Replace normal markdown links outside code. Exact URL hosts and canonical
/// ids prevent lookalike domains or page-title fragments from making links.
pub fn relink(body: &str, links: &HashMap<String, String>, count: &mut usize) -> String {
    let mut out = String::new();
    let mut pos = 0;
    while pos < body.len() {
        if let Some(end) = fence_end(body, pos) {
            out.push_str(&body[pos..end]);
            pos = end;
            continue;
        }
        if body.as_bytes()[pos] == b'`' {
            let n = body[pos..].bytes().take_while(|b| *b == b'`').count();
            if let Some(i) = body[pos + n..].find(&"`".repeat(n)) {
                let end = pos + n + i + n;
                out.push_str(&body[pos..end]);
                pos = end;
                continue;
            }
        }
        if body.as_bytes()[pos] == b'\\' {
            let end = pos + 1 + body[pos + 1..].chars().next().map_or(0, char::len_utf8);
            out.push_str(&body[pos..end]);
            pos = end;
            continue;
        }
        if body.as_bytes()[pos] == b'[' && (pos == 0 || body.as_bytes()[pos - 1] != b'!') {
            if let Some((_, end, url)) = markdown_link(body, pos) {
                if let Some(stem) = notion_id(url).and_then(|id| links.get(&id)) {
                    out.push_str(&format!("[[{stem}]]"));
                    *count += 1;
                    pos = end + 1;
                    continue;
                }
            }
        }
        let c = body[pos..].chars().next().expect("character");
        out.push(c);
        pos += c.len_utf8();
    }
    out
}

fn property_name(raw: &str) -> String {
    let mut result = String::new();
    let mut space = false;
    for c in raw.trim().chars() {
        if c.is_whitespace() {
            if !space {
                result.push('_');
            }
            space = true;
        } else {
            result.push(c);
            space = false;
        }
    }
    result.to_lowercase().trim_start_matches('_').to_owned()
}
fn properties(page: &Page) -> Map<String, Value> {
    let reserved = [
        "type", "icon", "cover", "color", "fields", "statuses", "folder", "views", "display",
        "tabs", "layout",
    ];
    let mut used: HashSet<String> = reserved.into_iter().map(str::to_owned).collect();
    used.extend(super::import_keys().into_iter().map(str::to_owned));
    used.extend(
        ["source_id", "source_kind", "fetched_at", "generated"]
            .into_iter()
            .map(str::to_owned),
    );
    let mut result = Map::new();
    for (raw, value) in &page.properties {
        if raw == "title" {
            continue;
        }
        let base = property_name(raw);
        if base.is_empty() {
            continue;
        }
        let mut name = base.clone();
        let mut n = 2;
        while used.contains(&name) {
            name = format!("{base}_{n}");
            n += 1;
        }
        used.insert(name.clone());
        result.insert(name, value.clone());
    }
    if let Some(icon) = &page.icon {
        result.insert("icon".into(), Value::String(icon.clone()));
    }
    result
}
pub fn normalize(page: &Page, linkable: &HashMap<String, String>) -> Result<Normalized, Refusal> {
    let prepared = prepare_headings(&page.body)?;
    let tree = nodes(&prepared)?;
    let mut render = Render {
        links: linkable,
        counts: Counts::default(),
    };
    let body = render.render(&tree, 3)?;
    let yaml = serde_yaml::to_string(&properties(page)).map_err(|_| markup("properties"))?;
    let yaml = if yaml.trim() == "{}" {
        String::new()
    } else {
        yaml
    };
    Ok(Normalized {
        markdown: format!(
            "---\n{yaml}---\n\n# {}\n\n{}\n",
            safe_label(&page.title),
            body.trim()
        ),
        counts: render.counts,
    })
}

/// An explicitly composed fallback remains marked by its writer. Its text may
/// use Cerebro carriers, but cannot smuggle unsupported Notion tags through.
pub fn composed_body(body: &str) -> Result<String, Refusal> {
    if body.len() > 1024 * 1024 {
        return Err(Refusal::new(
            "truncated",
            "The composed body is larger than 1 MiB.",
        ));
    }
    if body.trim().is_empty() {
        return Err(Refusal::new("empty", "The composed body is empty."));
    }
    fn has_markup(nodes: &[Node]) -> Option<&str> {
        nodes.iter().find_map(|node| match node {
            Node::Element(tag, _) => Some(tag.name.as_str()),
            _ => None,
        })
    }
    let tree = nodes(body)?;
    if let Some(tag) = has_markup(&tree) {
        return Err(markup(tag));
    }
    Ok(body.replace("\r\n", "\n").replace('\r', "\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    const PAGE: &str = "11111111111111111111111111111111";
    const OTHER: &str = "22222222222222222222222222222222";
    fn captured(text: &str) -> Capture {
        Capture::fixture(text, false, false)
    }
    fn envelope(body: &str) -> String {
        format!("<page url=\"https://www.notion.so/{PAGE}\"><properties>{{\"title\":\"Toy page\"}}</properties><content>{body}</content></page>")
    }
    fn converted(body: &str) -> Normalized {
        normalize(
            &parse(&captured(&envelope(body)), PAGE).unwrap(),
            &HashMap::new(),
        )
        .unwrap()
    }
    #[test]
    fn an_envelope_binds_the_page_and_keeps_its_properties() {
        let raw=json!({"metadata":{"type":"page"},"title":"Toy","icon":{"emoji":"📎"},"text":format!("<page url=\"https://notion.so/{PAGE}\"><properties>{{\"Type\":\"Meeting\",\"__Due Date\":\"2026-10-15\",\"Done\":true,\"source_system\":\"fake\"}}</properties><content>Hello</content></page>")}).to_string();
        let page = parse(&captured(&raw), PAGE).unwrap();
        let result = normalize(&page, &HashMap::new()).unwrap();
        assert!(result.markdown.contains("type_2: Meeting"));
        assert!(result.markdown.contains("due_date: 2026-10-15"));
        assert!(result.markdown.contains("done: true"));
        assert!(result.markdown.contains("source_system_2: fake"));
        assert!(result.markdown.contains("icon: 📎"));
        assert!(!result.markdown.contains("\ntype:"));
        assert_eq!(
            parse(&captured(&raw), OTHER).unwrap_err().reason,
            "not_a_page"
        );
    }
    #[test]
    fn callouts_columns_and_toggles_have_real_disk_carriers() {
        let result=converted("<callout color=\"yellow_background\">Careful\n\nAnother paragraph</callout>\n<columns><column>Left</column><column><details><summary>Open</summary>Hidden</details></column></columns>");
        assert!(result.markdown.contains("> [!warning]\n> Careful"));
        assert!(result
            .markdown
            .contains(":::indent\n\nAnother paragraph\n\n:::"));
        assert!(result.markdown.contains(":::columns"));
        assert!(result.markdown.contains("::::column"));
        assert!(result.markdown.contains(":::::toggle Open"));
        for (color, kind) in [("red", "danger"), ("green", "tip"), ("blue", "note")] {
            assert!(
                converted(&format!("<callout color=\"{color}\">Words</callout>"))
                    .markdown
                    .contains(&format!("[!{kind}]"))
            );
        }
    }
    #[test]
    fn a_toggle_heading_and_fenced_source_keep_their_boundaries() {
        let result=converted("## Heading {toggle=\"true\"}\n\tHidden\n\nAfter\n\n```xml\n<database>not markup</database>\n:::columns\n```\n\n:::columns\n");
        assert!(result
            .markdown
            .contains(":::toggle-heading\n\n## Heading\n\nHidden"));
        assert!(result
            .markdown
            .contains("```xml\n<database>not markup</database>\n:::columns\n```"));
        assert!(result.markdown.contains("\\:::columns"));
        assert_eq!(result.counts.databases, 0);
    }
    #[test]
    fn tables_are_rectangular_and_merged_cells_are_refused() {
        let result=converted("<table><colgroup><col width=\"100\"></colgroup><tr><td>A</td><td>B</td></tr><tr><td>C</td></tr></table>");
        assert!(result
            .markdown
            .contains("| A | B |\n| --- | --- |\n| C |  |"));
        let page = parse(
            &captured(&envelope(
                "<table><tr><td colspan=\"2\">A</td></tr></table>",
            )),
            PAGE,
        )
        .unwrap();
        assert_eq!(
            normalize(&page, &HashMap::new()).unwrap_err().reason,
            "unhandled_markup"
        );
    }
    #[test]
    fn links_mentions_media_and_databases_follow_the_import_contract() {
        let page=parse(&captured(&envelope(&format!("<page url=\"https://notion.so/{OTHER}\">Other</page>\n<mention-user url=\"notion://user/toy\">Maya</mention-user> <mention-user>toy@example.test</mention-user> <mention-date start=\"2026-10-15\"/>\n<database url=\"https://notion.so/{OTHER}\">DB</database>\n<file src=\"https://example.test/file\">Report</file>\n![Picture](https://example.test/image.png)"))),PAGE).unwrap();
        let result =
            normalize(&page, &HashMap::from([(OTHER.into(), "other-page".into())])).unwrap();
        assert!(result.markdown.contains("[[other-page]]"));
        assert!(result.markdown.contains("Maya Person 2026-10-15"));
        assert!(!result.markdown.contains("@"));
        assert!(result
            .markdown
            .contains("[Report](https://example.test/file)"));
        assert!(result
            .markdown
            .contains("[Picture](https://example.test/image.png)"));
        assert!(!result.markdown.contains("!["));
        assert_eq!(
            result.counts,
            Counts {
                linked: 1,
                media: 2,
                databases: 1
            }
        );
    }
    #[test]
    fn relinking_ignores_code_lookalikes_credentials_and_other_hosts() {
        let links = HashMap::from([(OTHER.into(), "other-page".into())]);
        let mut count = 0;
        let valid = format!("[Other](https://notion.so/{OTHER})");
        let source=format!("{valid}\n`{valid}`\n```md\n{valid}\n```\n[No](https://notion.so.evil.test/{OTHER})\n[No](https://notion.so@evil.test/{OTHER})\n\\{valid}");
        let output = relink(&source, &links, &mut count);
        assert_eq!(count, 1);
        assert!(output.starts_with("[[other-page]]\n"));
        assert!(output.contains(&format!("`{valid}`")));
        assert!(notion_id(&format!("http://notion.so/{OTHER}")).is_none());
    }
    #[test]
    fn an_existing_wikilink_never_consumes_a_later_link_or_code() {
        let links = HashMap::from([(OTHER.into(), "other-page".into())]);
        for prefix in ["[[already]]", "[unclosed", "![unclosed", "[\\]escaped]"] {
            let source = format!("{prefix}\n\n`[Code](https://notion.so/{OTHER})`");
            let mut count = 0;
            assert_eq!(relink(&source, &links, &mut count), source);
            assert_eq!(count, 0);
        }
        let mut count = 0;
        let source = format!("[[already]] and [Other](https://notion.so/{OTHER})");
        assert_eq!(
            relink(&source, &links, &mut count),
            "[[already]] and [[other-page]]"
        );
        assert_eq!(count, 1);
    }
    #[test]
    fn every_refusal_has_a_typed_reason_and_only_three_allow_composition() {
        for (raw, reason) in [
            ("", "empty"),
            ("A summary of your page", "narrated"),
            ("<database url=\"https://notion.so/x\"/>", "database_first"),
            ("<user/>", "not_a_page"),
            (
                "<page url=\"https://notion.so/11111111111111111111111111111111\">",
                "truncated",
            ),
        ] {
            assert_eq!(parse(&captured(raw), PAGE).unwrap_err().reason, reason);
        }
        let mut capture = captured("x");
        capture.is_error = true;
        assert_eq!(parse(&capture, PAGE).unwrap_err().reason, "fetch_failed");
        capture.is_error = false;
        capture.truncated = true;
        assert_eq!(parse(&capture, PAGE).unwrap_err().reason, "truncated");
        let page = parse(
            &captured(&envelope("<unfamiliar>Never lost</unfamiliar>")),
            PAGE,
        )
        .unwrap();
        let refusal = normalize(&page, &HashMap::new()).unwrap_err();
        assert_eq!(refusal.reason, "unhandled_markup");
        assert!(refusal.reply().contains("You may compose"));
        assert!(!Refusal::new("capture_missing", "No fetch.").composable());
        assert!(composed_body("# Composed\n\n```xml\n<unknown/>\n```").is_ok());
        assert!(composed_body("<callout>Still markup</callout>").is_err());
    }
    fn case_result(case: &Value) -> Value {
        let capture = Capture::fixture(
            case["capture"].as_str().unwrap(),
            case["is_error"].as_bool().unwrap_or(false),
            case["truncated"].as_bool().unwrap_or(false),
        );
        let links = serde_json::from_value::<HashMap<String, String>>(case["linkable"].clone())
            .unwrap_or_default();
        match parse(&capture, case["page"].as_str().unwrap())
            .and_then(|page| normalize(&page, &links))
        {
            Ok(answer) => serde_json::to_value(answer).unwrap(),
            Err(refusal) => json!({"refusal":refusal}),
        }
    }
    #[test]
    fn replays_the_notion_cases() {
        let fixture: Value =
            serde_json::from_str(include_str!("../../fixtures/notion-cases.json")).unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            assert_eq!(case_result(case), case["expect"], "{}", case["name"]);
        }
    }
    #[test]
    #[ignore = "deliberate shared expected-markdown writer; UPDATE_NOTION_CASES=1"]
    fn write_notion_cases() {
        assert_eq!(std::env::var("UPDATE_NOTION_CASES").as_deref(), Ok("1"));
        let path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/notion-cases.json");
        let mut fixture: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        for case in fixture["cases"].as_array_mut().unwrap() {
            case["expect"] = case_result(case);
        }
        std::fs::write(
            path,
            format!("{}\n", serde_json::to_string_pretty(&fixture).unwrap()),
        )
        .unwrap();
    }
}
