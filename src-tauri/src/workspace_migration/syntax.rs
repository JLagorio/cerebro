//! Bounded YAML event evidence, before aliases or duplicate keys can disappear.
use serde::Serialize;
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Issue {
    pub kind: String,
    pub detail: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Scalar {
    pub text: String,
    pub plain: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum SyntaxNode {
    Scalar(Scalar),
    Sequence(Vec<SyntaxNode>),
    Mapping(Vec<(SyntaxNode, SyntaxNode)>),
    Alias,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationError {
    pub code: &'static str,
    pub kind: &'static str,
    pub detail: String,
}
use serde::Deserialize;
use std::{collections::BTreeSet, mem::MaybeUninit, sync::OnceLock};
use unsafe_libyaml as unsafe_yaml;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Limits {
    pub max_files: usize,
    pub max_file_bytes: usize,
    pub max_total_bytes: usize,
    pub max_yaml_bytes: usize,
    pub max_events: usize,
    pub max_depth: usize,
    pub max_decoded_scalar_bytes: usize,
}
pub(crate) fn limits() -> &'static Limits {
    static LIMITS: OnceLock<Limits> = OnceLock::new();
    LIMITS.get_or_init(|| {
        #[derive(Deserialize)]
        struct Artifact {
            version: u32,
            limits: Limits,
        }
        let artifact: Artifact = serde_json::from_str(include_str!(
            "../../../shared/workspace/migration-cases.v1.json"
        ))
        .expect("migration syntax limits");
        assert_eq!(artifact.version, 1);
        artifact.limits
    })
}
pub(crate) fn failure(kind: &'static str, detail: impl Into<String>) -> MigrationError {
    MigrationError {
        code: "schema_invalid",
        kind,
        detail: detail.into(),
    }
}
pub(crate) fn issue(kind: &str, detail: impl Into<String>) -> Issue {
    Issue {
        kind: kind.into(),
        detail: detail.into(),
    }
}

/// Heap address stays stable from initialize through delete. The input borrow
/// outlives every parse call; neither parser nor input is exposed to a caller.
struct Parser<'a> {
    raw: Box<unsafe_yaml::yaml_parser_t>,
    _input: &'a [u8],
}
impl<'a> Parser<'a> {
    fn new(input: &'a [u8]) -> Result<Self, MigrationError> {
        let mut raw = Box::<unsafe_yaml::yaml_parser_t>::new_uninit();
        // SAFETY: raw is aligned writable storage at a stable heap address.
        // On success libyaml initializes it; on failure no initialized parser
        // is assumed. Input is immutable and borrowed for the parser lifetime.
        unsafe {
            if unsafe_yaml::yaml_parser_initialize(raw.as_mut_ptr()).fail {
                return Err(failure(
                    "parser_unavailable",
                    "YAML parser could not initialize.",
                ));
            }
            let mut parser = Self {
                raw: raw.assume_init(),
                _input: input,
            };
            unsafe_yaml::yaml_parser_set_encoding(
                &mut *parser.raw,
                unsafe_yaml::YAML_UTF8_ENCODING,
            );
            unsafe_yaml::yaml_parser_set_input_string(
                &mut *parser.raw,
                input.as_ptr(),
                input.len() as u64,
            );
            Ok(parser)
        }
    }
    fn next(&mut self) -> Result<Event, MigrationError> {
        let mut raw = MaybeUninit::<unsafe_yaml::yaml_event_t>::uninit();
        // SAFETY: parser is initialized, uniquely borrowed, and retains input.
        // parse initializes one event only on success; failed parse has no owned
        // event to delete. Event's Drop releases success payloads on every exit.
        unsafe {
            if unsafe_yaml::yaml_parser_parse(&mut *self.raw, raw.as_mut_ptr()).fail {
                return Err(failure("malformed_yaml", "YAML syntax could not be read."));
            }
            Ok(Event(raw.assume_init()))
        }
    }
}
impl Drop for Parser<'_> {
    fn drop(&mut self) {
        // SAFETY: this initialized parser has one owner; events are released
        // before their parser. Delete runs on success and every error path.
        unsafe { unsafe_yaml::yaml_parser_delete(&mut *self.raw) }
    }
}
struct Event(unsafe_yaml::yaml_event_t);
impl Drop for Event {
    fn drop(&mut self) {
        // SAFETY: parse initialized this event and ownership is never cloned.
        unsafe { unsafe_yaml::yaml_event_delete(&mut self.0) }
    }
}
#[derive(Debug)]
enum Token {
    Scalar(Scalar),
    MapStart,
    MapEnd,
    SequenceStart,
    SequenceEnd,
    Alias,
}

fn tokens(source: &str, issues: &mut Vec<Issue>) -> Result<Vec<Token>, MigrationError> {
    let cap = limits();
    if source.len() > cap.max_yaml_bytes {
        return Err(failure("yaml_limit", "YAML byte limit exceeded."));
    }
    let mut parser = Parser::new(source.as_bytes())?;
    let (mut events, mut depth, mut scalar_bytes, mut documents) =
        (0_usize, 0_usize, 0_usize, 0_usize);
    let mut tokens = Vec::new();
    loop {
        let event = parser.next()?;
        events += 1;
        if events > cap.max_events {
            return Err(failure("yaml_limit", "YAML event limit exceeded."));
        }
        // SAFETY: branch on the event discriminant before reading its union.
        // Anchor/tag presence needs no pointer dereference. Scalar data is
        // checked for representable bounded length and nonnull pointer before
        // creating a slice, and copied while its event guard remains alive.
        let token = unsafe {
            match event.0.type_ {
                unsafe_yaml::YAML_STREAM_END_EVENT => break,
                unsafe_yaml::YAML_DOCUMENT_START_EVENT => {
                    let data = event.0.data.document_start;
                    if !data.version_directive.is_null()
                        || data.tag_directives.start != data.tag_directives.end
                    {
                        issues.push(issue(
                            "yaml_directive",
                            "YAML dialect/tag directives require a separate codec.",
                        ));
                    }
                    documents += 1;
                    if documents > 1 {
                        return Err(failure(
                            "multiple_documents",
                            "Multiple YAML documents require a separate codec.",
                        ));
                    }
                    None
                }
                unsafe_yaml::YAML_SCALAR_EVENT => {
                    let data = event.0.data.scalar;
                    if !data.anchor.is_null() {
                        issues.push(issue("anchor", "An anchor is retained, not expanded."));
                    }
                    if !data.tag.is_null() {
                        issues.push(issue(
                            "explicit_tag",
                            "An explicit YAML tag requires a separate codec.",
                        ));
                    }
                    let len = usize::try_from(data.length).map_err(|_| {
                        failure("yaml_limit", "Scalar length is not representable.")
                    })?;
                    scalar_bytes = scalar_bytes
                        .checked_add(len)
                        .filter(|n| *n <= cap.max_decoded_scalar_bytes)
                        .ok_or_else(|| {
                            failure("yaml_limit", "Decoded scalar byte limit exceeded.")
                        })?;
                    let bytes = if len == 0 {
                        &[][..]
                    } else {
                        if data.value.is_null() {
                            return Err(failure(
                                "malformed_yaml",
                                "YAML returned an invalid scalar pointer.",
                            ));
                        }
                        std::slice::from_raw_parts(data.value, len)
                    };
                    let text = std::str::from_utf8(bytes)
                        .map_err(|_| failure("malformed_yaml", "YAML scalar is not UTF-8."))?
                        .to_owned();
                    Some(Token::Scalar(Scalar {
                        text,
                        plain: data.style == unsafe_yaml::YAML_PLAIN_SCALAR_STYLE,
                    }))
                }
                unsafe_yaml::YAML_MAPPING_START_EVENT => {
                    let data = event.0.data.mapping_start;
                    if !data.anchor.is_null() {
                        issues.push(issue(
                            "anchor",
                            "An anchored map is retained, not expanded.",
                        ));
                    }
                    if !data.tag.is_null() {
                        issues.push(issue(
                            "explicit_tag",
                            "A tagged map requires a separate codec.",
                        ));
                    }
                    depth += 1;
                    Some(Token::MapStart)
                }
                unsafe_yaml::YAML_SEQUENCE_START_EVENT => {
                    let data = event.0.data.sequence_start;
                    if !data.anchor.is_null() {
                        issues.push(issue(
                            "anchor",
                            "An anchored sequence is retained, not expanded.",
                        ));
                    }
                    if !data.tag.is_null() {
                        issues.push(issue(
                            "explicit_tag",
                            "A tagged sequence requires a separate codec.",
                        ));
                    }
                    depth += 1;
                    Some(Token::SequenceStart)
                }
                unsafe_yaml::YAML_MAPPING_END_EVENT => {
                    depth = depth.saturating_sub(1);
                    Some(Token::MapEnd)
                }
                unsafe_yaml::YAML_SEQUENCE_END_EVENT => {
                    depth = depth.saturating_sub(1);
                    Some(Token::SequenceEnd)
                }
                unsafe_yaml::YAML_ALIAS_EVENT => {
                    issues.push(issue("alias", "An alias is retained, not resolved."));
                    Some(Token::Alias)
                }
                unsafe_yaml::YAML_STREAM_START_EVENT | unsafe_yaml::YAML_DOCUMENT_END_EVENT => None,
                _ => return Err(failure("malformed_yaml", "Unsupported YAML event.")),
            }
        };
        if depth > cap.max_depth {
            return Err(failure("yaml_limit", "YAML nesting limit exceeded."));
        }
        if let Some(token) = token {
            tokens.push(token);
        }
    }
    Ok(tokens)
}

fn key_is_string(scalar: &Scalar) -> bool {
    // Only key-kind classification uses the existing YAML scalar resolver.
    // Values never go through it; exact numeric value lexemes remain text.
    !scalar.plain
        || matches!(
            serde_yaml::from_str::<serde_yaml::Value>(&scalar.text),
            Ok(serde_yaml::Value::String(_))
        )
}
fn node(
    tokens: &mut std::iter::Peekable<std::vec::IntoIter<Token>>,
    issues: &mut Vec<Issue>,
) -> Result<SyntaxNode, MigrationError> {
    Ok(match tokens.next() {
        Some(Token::Scalar(value)) => SyntaxNode::Scalar(value),
        Some(Token::Alias) => SyntaxNode::Alias,
        Some(Token::SequenceStart) => {
            let mut values = Vec::new();
            while !matches!(tokens.peek(), Some(Token::SequenceEnd)) {
                values.push(node(tokens, issues)?);
            }
            tokens.next();
            SyntaxNode::Sequence(values)
        }
        Some(Token::MapStart) => {
            let (mut values, mut keys) = (Vec::new(), BTreeSet::new());
            while !matches!(tokens.peek(), Some(Token::MapEnd)) {
                let key = node(tokens, issues)?;
                if let SyntaxNode::Scalar(scalar) = &key {
                    if !key_is_string(scalar) {
                        issues.push(issue("non_string_key", "A metadata key is not a string."));
                    }
                    if !keys.insert(scalar.text.clone()) {
                        issues.push(issue(
                            "duplicate_key",
                            format!("Duplicate decoded key: {}", scalar.text),
                        ));
                    }
                } else {
                    issues.push(issue(
                        "non_string_key",
                        "A metadata key is a collection or alias.",
                    ));
                }
                let value = node(tokens, issues)?;
                values.push((key, value));
            }
            tokens.next();
            SyntaxNode::Mapping(values)
        }
        _ => {
            return Err(failure(
                "malformed_yaml",
                "YAML node structure is incomplete.",
            ))
        }
    })
}

pub(crate) fn inspect(source: &str) -> Result<(SyntaxNode, Vec<Issue>), MigrationError> {
    let mut issues = Vec::new();
    let mut tokens = tokens(source, &mut issues)?.into_iter().peekable();
    if tokens.peek().is_none() {
        return Ok((SyntaxNode::Mapping(Vec::new()), issues));
    }
    let node = node(&mut tokens, &mut issues)?;
    if tokens.next().is_some() {
        return Err(failure(
            "malformed_yaml",
            "Unexpected YAML nodes after the root.",
        ));
    }
    if !matches!(node, SyntaxNode::Mapping(_)) {
        issues.push(issue("non_mapping_metadata", "Metadata must be a mapping."));
    }
    Ok((node, issues))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn syntax_evidence_retains_decoded_duplicate_keys_and_lexical_numbers() {
        let (node, issues) = inspect("x: 1\n\"x\": 9007199254740993.125\n").unwrap();
        assert!(issues.iter().any(|i| i.kind == "duplicate_key"));
        let SyntaxNode::Mapping(rows) = node else {
            panic!("mapping")
        };
        assert_eq!(rows.len(), 2);
        let SyntaxNode::Scalar(value) = &rows[1].1 else {
            panic!("scalar")
        };
        assert_eq!(value.text, "9007199254740993.125");
    }
    #[test]
    fn syntax_events_distinguish_tags_anchors_aliases_and_quoted_punctuation() {
        let (_, issues) = inspect("x: &keep !!str 007\ny: *keep\n").unwrap();
        for kind in ["explicit_tag", "anchor", "alias"] {
            assert!(issues.iter().any(|i| i.kind == kind));
        }
        assert!(inspect("x: \"!tag &anchor *alias\"\n")
            .unwrap()
            .1
            .is_empty());
    }
    #[test]
    fn dialect_and_tag_directives_are_explicit_unsupported_syntax() {
        for source in [
            "%YAML 1.1\n---\nx: yes\n",
            "%TAG !local! tag:example.test,2026:\n---\nx: yes\n",
        ] {
            assert!(inspect(source)
                .unwrap()
                .1
                .iter()
                .any(|i| i.kind == "yaml_directive"));
        }
    }
    #[test]
    fn preserves_independent_review_tag_key_document_and_depth_probes() {
        for (source, expected) in [
            ("x: ! 007\n", Some("explicit_tag")),
            ("x: ! [1, 2]\n", Some("explicit_tag")),
            ("x: !!map {a: 1}\n", Some("explicit_tag")),
            ("x: &unused [a]\n", Some("anchor")),
            ("x: {\"\\u0061\": 1, a: 2}\n", Some("duplicate_key")),
            ("null: value\n", Some("non_string_key")),
            ("\"null\": value\n", None),
            ("x: \"foo\\n!bar &baz *qux\"\n", None),
            ("x: 1\n...\n", None),
        ] {
            let (_, issues) = inspect(source).unwrap();
            if let Some(kind) = expected {
                assert!(
                    issues.iter().any(|issue| issue.kind == kind),
                    "{source}: {issues:?}"
                );
            } else {
                assert!(issues.is_empty(), "{source}: {issues:?}");
            }
        }
        for source in [
            "---\nx: 1\n---\nx: 2\n",
            "x: &a [1,\n",
            "%TAG !local! tag:example.com,2000:\n---\nx: !local!thing 1\n",
        ] {
            assert!(inspect(source).map_or(true, |(_, issues)| !issues.is_empty()));
        }
        for depth in [31, 32] {
            let source = format!("x: {}0{}", "[".repeat(depth), "]".repeat(depth));
            // The root mapping also consumes one depth level.
            assert_eq!(inspect(&source).is_ok(), depth == 31);
        }
    }

    #[test]
    fn bounded_errors_and_repeated_malformed_sources_do_not_poison_later_reads() {
        for _ in 0..100 {
            assert!(inspect("x: [").is_err());
            assert!(inspect("x: valid\n").is_ok());
        }
        assert!(inspect(&format!("x: {}", "a".repeat(65536))).is_err());
        assert!(inspect(&format!("x: {}0{}", "[".repeat(34), "]".repeat(34))).is_err());
        assert!(inspect(&format!("x: [{}]", vec!["0"; 8192].join(","))).is_err());
        // YAML \L is two source bytes and three decoded UTF-8 bytes.
        assert!(inspect(&format!("x: \"{}\"\n", "\\L".repeat(30_000))).is_err());
    }
}
